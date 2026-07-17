"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const ROOT_DIR = path.resolve(__dirname, "..");
const SITE_DIR = path.resolve(__dirname, process.env.SITE_DIR || "..");
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || "data");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.jsonl");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const QUOTE_WEBHOOK_URL = process.env.QUOTE_WEBHOOK_URL || "";
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 20);
const rateBuckets = new Map();

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"],
  [".ico", "image/x-icon"],
]);

function corsOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return origin;
  return "";
}

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, {
    "Content-Length": payload.length,
    ...headers,
  });
  res.end(payload);
}

function sendJson(req, res, status, body) {
  const origin = corsOrigin(req);
  send(res, status, body, {
    "Content-Type": "application/json; charset=utf-8",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
  });
}

async function readJson(req, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error("Request body is too large.");
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("Invalid JSON body.");
    err.status = 400;
    throw err;
  }
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function isRateLimited(req) {
  if (!RATE_LIMIT_PER_HOUR) return false;
  const hour = Math.floor(Date.now() / (60 * 60 * 1000));
  const key = `${clientIp(req)}:${hour}`;
  const count = (rateBuckets.get(key) || 0) + 1;
  rateBuckets.set(key, count);

  if (rateBuckets.size > 5000) {
    for (const bucketKey of rateBuckets.keys()) {
      if (!bucketKey.endsWith(`:${hour}`)) rateBuckets.delete(bucketKey);
    }
  }

  return count > RATE_LIMIT_PER_HOUR;
}

function clean(value, max = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function validateQuote(body) {
  const quote = {
    name: clean(body.name, 120),
    email: clean(body.email, 160),
    phone: clean(body.phone, 80),
    projectType: clean(body.projectType, 160),
    message: clean(body.message, 3000),
    page: clean(body.page, 500),
    source: clean(body.source, 80) || "gci-portfolio",
    submittedAt: new Date().toISOString(),
    id: crypto.randomUUID(),
  };

  const errors = [];
  if (!quote.name) errors.push("Name is required.");
  if (!quote.email && !quote.phone) errors.push("Email or phone is required.");
  if (quote.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(quote.email)) errors.push("Email is invalid.");
  if (clean(body.website, 200)) errors.push("Spam check failed.");

  return { quote, errors };
}

async function storeQuote(quote) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(SUBMISSIONS_FILE, `${JSON.stringify(quote)}\n`, "utf8");
}

async function forwardWebhook(quote) {
  if (!QUOTE_WEBHOOK_URL) return;
  const response = await fetch(QUOTE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(quote),
  });
  if (!response.ok) {
    throw new Error(`Webhook failed with ${response.status}`);
  }
}

function safeStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = decoded === "/" ? "/index.html" : decoded;
  if (normalized !== "/index.html" && !normalized.startsWith("/assets/")) return "";
  const fullPath = path.resolve(SITE_DIR, `.${normalized}`);
  if (!fullPath.startsWith(SITE_DIR)) return "";
  return fullPath;
}

async function serveStatic(req, res) {
  const filePath = safeStaticPath(req.url || "/");
  if (!filePath) return sendJson(req, res, 403, { ok: false, error: "Forbidden" });

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, file, {
      "Content-Type": MIME.get(ext) || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
    });
  } catch {
    sendJson(req, res, 404, { ok: false, error: "Not found" });
  }
}

async function handleQuote(req, res) {
  if (isRateLimited(req)) {
    return sendJson(req, res, 429, { ok: false, error: "Too many requests. Please try again later." });
  }

  const body = await readJson(req);
  const { quote, errors } = validateQuote(body);
  if (errors.length) return sendJson(req, res, 400, { ok: false, errors });

  await storeQuote(quote);
  try {
    await forwardWebhook(quote);
  } catch (error) {
    console.warn(error.message);
  }

  return sendJson(req, res, 201, { ok: true, id: quote.id });
}

const server = http.createServer(async (req, res) => {
  try {
    const origin = corsOrigin(req);
    if (req.method === "OPTIONS") {
      return send(res, 204, "", {
        ...(origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(req, res, 200, { ok: true, service: "gci-backend" });
    }
    if (req.method === "POST" && url.pathname === "/api/quote") {
      return handleQuote(req, res);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res);
    }
    return sendJson(req, res, 405, { ok: false, error: "Method not allowed" });
  } catch (error) {
    return sendJson(req, res, error.status || 500, {
      ok: false,
      error: error.message || "Server error",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`GCI backend running on http://${HOST}:${PORT}`);
});

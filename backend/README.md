# GCI Backend

Small Node backend for the GCI website quotation form.

## What it does

- Serves the static portfolio site.
- Accepts quote requests at `POST /api/quote`.
- Validates required fields.
- Applies a simple per-IP rate limit.
- Stores submissions in `backend/data/submissions.jsonl`.
- Optionally forwards submissions to `QUOTE_WEBHOOK_URL` for email/CRM automation.

## Local Run

```sh
cd /Users/cy/Documents/gci-portfolio-site/backend
cp .env.example .env
npm start
```

Open `http://127.0.0.1:8080`.

For hosted providers that require public binding, set:

```sh
HOST=0.0.0.0
```

## API

`POST /api/quote`

```json
{
  "name": "Client name",
  "email": "client@example.com",
  "phone": "+961...",
  "projectType": "Renovation",
  "message": "Project details"
}
```

The request must include a name and at least one contact method: email or phone.

## Security Notes

- Static serving is limited to `index.html` and `assets/`.
- Submission logs are ignored by git.
- Set `ALLOWED_ORIGINS` to your final website domain before production.
- Keep `.env` private.

## Deploying

GitHub Pages cannot run this backend. Deploy the `backend/` folder to Render, Railway, Fly.io, a VPS, or another Node host. After deployment, set `window.GCI_API_URL` in `index.html` to the backend URL, or host the full site from this backend so `/api/quote` is same-origin.

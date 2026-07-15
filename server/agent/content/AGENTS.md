# Presio agent brief

## What you can do

1. **Start a local presentation** from a PDF via `POST /api/present` or MCP tool `present_pdf`.
2. **Validate** Presio notes/media sidecars via `POST /api/check` or MCP tool `check_pdf`.

## Preferred workflow

1. Read `BASE/llms-full.txt` if you need more detail.
2. Call present or check.
3. For present: tell the user to open the returned `url` (or open it if you have a browser tool). Do not invent session codes.

## Limits

- PDF ≤ 50MB, ≤ 3000 pages
- No auth required for present/check
- Present creates a **local** session after the browser opens the link (PDF leaves the server)
- Cross-device sync is not available from the API alone

## Do not

- Scrape the SPA HTML for API docs — use `/api.md`, `/openapi.json`, or `/llms-full.txt`
- Assume the PDF stays on the server after handoff

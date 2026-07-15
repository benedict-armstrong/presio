---
title: Presio API
description: REST reference for starting local PDF presentations and validating sidecars, with curl examples.
canonical: BASE/api.md
last_updated: 2026-07-15
---

# Presio API

Base URL: `BASE`

## POST /api/present

Upload a PDF to start a local presentation. Returns a URL to open in a browser (skips share).

- Content-Type: `multipart/form-data`
- Field: `file` (PDF)
- Auth: optional Bearer

```bash
curl -s -F file=@deck.pdf BASE/api/present
```

**200:** `{ id, url, filename, totalSlides, next }`

- `url` — handoff link. Open it → PDF moves into the browser as a local session; the server copy is then deleted and the link stops working. Fetching the URL without completing handoff does not consume it.
- Unclaimed handoffs expire after **24 hours** (7 days when authenticated).
- `filename` — display title: the uploaded filename with its `.pdf` extension stripped.

## POST /api/check

Validate Presio sidecar attachments (notes + media).

```bash
curl -s -F file=@deck.pdf BASE/api/check
```

**200:** CheckReport JSON (see `BASE/schema/check-report.schema.json`)

## Handoff (used by the start page)

- `GET /api/sessions/:id/handoff?t=TOKEN` — download staged PDF
- `POST /api/sessions/:id/handoff/complete` — header `x-controller-token` — clear server copy

## OpenAPI

Machine-readable: `BASE/openapi.json`

## MCP

`BASE/mcp` — tools `present_pdf`, `check_pdf`

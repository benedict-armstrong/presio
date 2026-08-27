---
title: Presio API
description: REST reference for starting local PDF presentations and validating sidecars, with curl examples.
canonical: BASE/api.md
last_updated: 2026-08-27
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

## Updating an existing presentation

To replace an existing presentation's deck instead of creating a new one, repeat `POST /api/present` with two extra multipart fields:

- `session_id` — the presentation's id (`id` from the original create response)
- `controller_token` — that presentation's controller token, taken from the **`t=` query parameter of the `url` returned when it was created**. The same value may instead be sent as an `x-controller-token` header.

The deck is replaced in place: the response keeps the **same `id` and the same link** (token included), and no additional concurrent-presentation slot is used — you can iterate on slides without minting a fresh URL each pass or hitting the concurrent cap. If the browser has already completed handoff for this session, resending the link pulls the updated deck into it.

```bash
curl -s -F file=@deck-v2.pdf \
  -F session_id=ABC123 -F controller_token=TOKEN \
  BASE/api/present
```

**200:** `{ id, url, filename, totalSlides, next, updated: true }` — `url` is unchanged from the original response.

Errors: **401** if `session_id` is given without a token, **403** on a wrong token (you cannot overwrite someone else's presentation), **404** when the id is unknown or the session has expired — no new presentation is silently created in any of these cases.

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

`present_pdf` accepts the same update flow: pass `session_id` + `controller_token` (the `t=` parameter of the url from the original create response) to replace that deck in place and get the same link back.

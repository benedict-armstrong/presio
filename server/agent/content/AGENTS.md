---
title: Presio agent brief
description: What AI agents can do with Presio — capabilities, setup, limits, and examples.
canonical: BASE/AGENTS.md
last_updated: 2026-07-15
---

# Presio agent brief

## What you can do

1. **Start a local presentation** from a PDF via `POST /api/present` or MCP tool `present_pdf`.
2. **Validate** Presio notes/media sidecars via `POST /api/check` or MCP tool `check_pdf`.

## Preferred workflow

1. Read `BASE/llms-full.txt` if you need more detail.
2. Call present or check.
3. For present: tell the user to open the returned `url` (or open it if you have a browser tool). Do not invent session codes.

## Installation

Nothing to install — the REST API and MCP server are hosted at `BASE`.

- REST: `POST BASE/api/present`, `POST BASE/api/check` (see `BASE/api.md`)
- MCP (streamable HTTP): endpoint `BASE/mcp`, server card `BASE/.well-known/mcp.json`
- Claude Code: `claude mcp add --transport http presio BASE/mcp`

## Configuration

No API key or configuration required. Optional: send `Authorization: Bearer <token>` (Presio login JWT) with `POST /api/present` to attach the presentation to a user account.

## Usage examples

```bash
# Start a local presentation — returns a handoff URL to open in a browser
curl -s -F file=@deck.pdf BASE/api/present

# Validate notes/media sidecar attachments
curl -s -F file=@deck.pdf BASE/api/check
```

## Limits

- PDF ≤ 50MB, ≤ 3000 pages
- No auth required for present/check
- Handoff `url` works until a browser claims it (then the server copy is deleted); unclaimed handoffs expire after 24 hours (7 days when authenticated)
- Present creates a **local** session after the browser opens the link (PDF leaves the server)
- Cross-device sync is not available from the API alone

## Do not

- Scrape the SPA HTML for API docs — use `/api.md`, `/openapi.json`, or `/llms-full.txt`
- Assume the PDF stays on the server after handoff

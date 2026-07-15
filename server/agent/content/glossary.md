---
title: Presio glossary
description: Terminology used across Presio — sessions, controllers, viewers, sidecars, and handoff.
canonical: BASE/glossary.md
last_updated: 2026-07-15
---

# Glossary

- **Controller** — the presenter's window: slide navigation, speaker notes, media controls, and timer.
- **Viewer** — a window that mirrors the controller's current slide. Local viewers sync on-device; online viewers follow over WebSockets.
- **Local session** — the default mode: the PDF lives only in the presenter's browser (IndexedDB), synced to viewers on the same device via BroadcastChannel. Works offline; kept up to 7 days.
- **Online session** — a synced presentation with a **session code** viewers can join from other devices. Requires login.
- **Session code** — a 6-character code identifying an online session; viewers enter it on the home page.
- **Sidecar** — a JSON (and optionally binary media) attachment embedded in the PDF that carries speaker notes (`notes-slide-{N}.json`) or media (`media-slide-{N}-{id}.json`) for a slide. Validate with the [checker](BASE/check.md).
- **Handoff** — the flow behind `POST /api/present`: the PDF is staged on the server, the returned URL is opened in a browser, the browser downloads the PDF into a local session, and the server copy is deleted.
- **Controller token** — a secret held by the presenter's browser that authorizes controlling a session.
- **Markdown mirror** — a plain-markdown version of an HTML page (e.g. `/about` → `/about.md`), for agents and crawlers.

## Sitemap

- [Home](BASE/)
- [About](BASE/about)
- [Checker](BASE/check)
- [Full index](BASE/sitemap.md)

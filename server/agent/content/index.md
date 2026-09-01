---
title: Presio
description: Present PDF slideshows locally or live across devices — local by default, your PDF stays in the browser.
canonical: BASE/
last_updated: 2026-07-15
---

# Presio

Present PDF slideshows with a controller window and a mirrored viewer. Local by default: the PDF stays in your browser. Optionally log in and sync to share a session code across devices.

- Upload on the home page, or use `POST /api/present` for agents
- Validate sidecars: BASE/check.md
- Agent index: BASE/llms.txt

## How it works

1. Upload a PDF. By default it stays in your browser — nothing is uploaded (or use `POST /api/present` for a brief handoff into local mode).
2. You land on the controller view: navigate slides, speaker notes, and media.
3. A viewer window mirrors the controller.
4. Recent presentations appear on the home page.

## Local by default

New presentations are **local**: the PDF lives only in this browser. Controller and viewer sync on-device via BroadcastChannel. Works offline. Local decks are kept up to 7 days.

## Presenting across devices

Log in and sync from the share screen to get a 6-character session code. Viewers join on the home page and follow live over WebSockets.

## Sitemap

- [Home](BASE/)
- [Checker](BASE/check)
- [Glossary](BASE/glossary.md)
- [Full index](BASE/sitemap.md)

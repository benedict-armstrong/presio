# About Presio

A simple tool for presenting PDFs — locally or shared live across devices.

## How it works

1. Upload a PDF. By default it stays in your browser — nothing is uploaded (or use `POST /api/present` for a brief handoff into local mode).
2. You land on the controller view: navigate slides, speaker notes, and media.
3. A viewer window mirrors the controller.
4. Recent presentations appear on the home page.

## Local by default

New presentations are **local**: the PDF lives only in this browser. Controller and viewer sync on-device via BroadcastChannel. Works offline. Local decks are kept up to 7 days.

## Presenting across devices

Log in and sync from the share screen to get a 6-character session code. Viewers join on the home page and follow live over WebSockets.

## Agent APIs

- Start: `POST BASE/api/present` — see BASE/api.md
- Check sidecars: `POST BASE/api/check`
- Discovery: BASE/llms.txt

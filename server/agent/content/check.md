---
title: Presio PDF sidecar checker
description: Validate Presio speaker-notes and media sidecar attachments embedded in a PDF.
canonical: BASE/check
---

# PDF sidecar checker

Upload a Presio PDF to validate embedded speaker notes and media sidecars.

## UI

Open BASE/check for thumbnails and per-page validity.

## API

```bash
curl -s -F file=@deck.pdf BASE/api/check | jq .
```

Schema: BASE/schema/check-report.schema.json

Notes attachments: `notes-slide-{N}.json`
Media: `media-slide-{N}-{id}.json` plus optional binary `media-*.{gif,mp4,webm}`

# Presio

Present PDFs from your browser — try it at **[presio.xyz](https://presio.xyz)**.

Upload a PDF presentation, get a short link, and control the slideshow from one browser window while viewers watch in another. Presio is a hosted service; this repository is its source code.

## Use it from an AI agent

Nothing to install — agents talk to the hosted service directly:

- **MCP** — connect to `https://presio.xyz/mcp` (streamable HTTP, no auth). Tools: `present_pdf`, `check_pdf`.
  - Claude Code: `claude mcp add --transport http presio https://presio.xyz/mcp`
  - Claude.ai, ChatGPT, Cursor, …: add a custom connector / MCP server with that URL
- **REST** — `curl -F file=@deck.pdf https://presio.xyz/api/present` returns a link; opening it in a browser starts the presentation.
- **Agent docs** — [llms.txt](https://presio.xyz/llms.txt) · [AGENTS.md](https://presio.xyz/AGENTS.md) · [api.md](https://presio.xyz/api.md) · [OpenAPI](https://presio.xyz/openapi.json)

![Demo](https://github.com/benedict-armstrong/presio/releases/download/demo/presio.gif)

![Demo](example/diagram.png)

## Features

- **Local by default** — your PDF stays in the browser and is never uploaded. Works offline; local presentations are kept for up to 7 days.
- **Controller + viewer** — drive slides from the controller window while a viewer window mirrors it, kept perfectly in sync.
- **Present across devices** — log in and sync online to get a 6-character session code. Viewers enter it on the home page and follow along live over WebSockets.
- **Shared control** — hand out a controller passphrase to let someone else drive.
- **Speaker notes** — written next to your current and next slide, rendered as markdown.
- **Embedded media** — local videos and GIFs, direct video URLs, and YouTube/Vimeo. Playback, autoplay, and seeking all stay in sync with viewers.
- **Presentation timer** — track how long you've been talking.
- **Customizable controller** — rearrange the layout and remap keyboard shortcuts.
- **Recent presentations** — pick up where you left off from the home page.
- **Download** — anyone can grab the PDF from the presentation view.
- **Agent APIs** — MCP server and REST API for AI agents; see [Use it from an AI agent](#use-it-from-an-ai-agent).

## Adding videos and speaker notes

The easiest way to attach videos and speaker notes is the [Presio Typst package](https://github.com/benedict-armstrong/presio-typst-package):

```typst
#import "@preview/presio:0.2.1": media, speaker-notes

= Introduction

Hello world.

#speaker-notes[
  Remember to mention the demo before moving on.
]

#media("https://www.youtube.com/watch?v=dQw4w9WgXcQ", width: 60%, aspect-ratio: 16/9)
```

Presio reads the attached media and notes from the PDF automatically. Notes can also be embedded by hand from plain Typst or LaTeX. See the about page for details.

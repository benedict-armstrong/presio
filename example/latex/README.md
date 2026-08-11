# LaTeX spike

Proof of concept for a LaTeX equivalent of the
[Presio Typst package](https://github.com/benedict-armstrong/presio-typst-package).
**Not the shipping package** — that is
[presio-latex-package](https://github.com/benedict-armstrong/presio-latex-package).
See [`SCOPE.md`](SCOPE.md) for the design this spike was written to de-risk.

What it proves, on TeX Live 2025 / pdfLaTeX / beamer:

- speaker notes and media placements can be emitted as byte-identical
  `notes-slide-<N>.json` / `media-slide-<N>-<id>.json` sidecars and attached to
  the PDF, with no change to the Presio client
- pdf.js (the client's own PDF stack) reads the attachments back and parses them
- page numbers resolve to real shipout pages, including one note per beamer
  overlay
- a media placeholder's position can be captured and flipped into Presio's
  top-left origin

Build:

```sh
TEXINPUTS=.: latexmk -pdf spike.tex
```

Two passes are required — page and position data round-trip through the `.aux`
file, so a single `pdflatex` run emits zeros.

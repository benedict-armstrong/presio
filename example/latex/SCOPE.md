# LaTeX support for Presio — scope

Goal: give LaTeX authors what `presio-typst-package` gives Typst authors —
speaker notes and embedded media written from the source document and read back
by Presio automatically — plus a distribution story that ends at "it works in
Overleaf".

**Headline: the Presio client needs no changes.** The sidecar format is the
contract, and LaTeX can produce it exactly. I built a working spike
(`example/latex/`) that compiles a beamer deck to a PDF whose attachments the
client's own pdf.js stack reads back correctly. The remaining work is package
engineering and distribution, not app work.

> **Status.** Milestones 1–2 below are done. The package now lives in its own
> repository at `~/Projects/presio-latex-package` (v0.1.0), with a demo deck, an
> Overleaf-ready starter project, and notes/media working on pdfLaTeX and
> LuaLaTeX. The spike in this directory is kept only as the minimal record of
> what was proven; use the package repo for real work.

---

## 1. The contract

Presio reads two things out of a PDF (`client/src/lib/pdf.ts`,
`inspectAttachments.ts`):

| Attachment | Shape |
|---|---|
| `notes-slide-<N>.json` | `{"slide": N, "notes": "<markdown string>"}` |
| `media-slide-<N>-<id>.json` | `{slide, id, kind, mime, x_pt, y_pt, w_pt, h_pt, autoplay, loop}` + `filename` (kind `file`) or `url`/`video_id` (kind `url`/`youtube`/`vimeo`) |
| `media-<id>.{gif,mp4,webm}` | raw bytes, referenced by a `kind: "file"` sidecar |

Two details that matter for a LaTeX port:

- `notes` may be a **plain string** as well as a Typst AST. LaTeX should always
  emit a string, and the string is rendered as markdown. No AST work needed.
- `x_pt`/`y_pt` are **top-left origin** — `pdf.ts` divides them straight into
  page width/height to get CSS-style percentages. LaTeX's coordinate source
  (`zref-savepos`) is bottom-left, so the package must flip:
  `y_pt = paperheight_pt − zposy_pt`.

There is also an older, undocumented-ish LaTeX path already live: `\href{note:...}`
link annotations, read by `extractNotesFromAnnotations`. It survives as a
zero-dependency fallback but is inferior (no media, no markdown newlines, URL
encoding). The new package supersedes it; keep the annotation reader.

---

## 2. What the spike proves

`example/latex/presio.sty` + `spike.tex`, built on TeX Live 2025 with pdfLaTeX
and beamer. Verified by `pdfdetach -list` and by loading the PDF through the
client's own `pdfjs-dist` build:

```
pages: 4
[notes-slide-1.json] {"slide":1,"notes":"Remember to mention the demo. \n\nA second paragraph with \\_underscores\\_ and a \"quoted\" phrase."}
[notes-slide-2.json] {"slide":2,"notes":"This note is written on the frame, which produces two PDF pages."}
[notes-slide-3.json] {"slide":3,"notes":"This note is written on the frame, which produces two PDF pages."}
[notes-slide-4.json] {"slide":4,"notes":"Play the video here."}
[media-slide-4-m1.json] {"slide":4,"id":"m1","kind":"url","url":"…","x_pt":28.45,"y_pt":139.5,"w_pt":184.38,"h_pt":103.71,…}
page 4 size pt: 362.83 x 272.13
```

Mechanisms confirmed working:

1. **Attachment writing.** `\iow_open`/`\iow_now` writes the JSON to disk, then
   `embedfile` attaches it (v2.13, Oct 2025). Its name tree is read correctly by
   pdf.js. **Correction to an earlier draft of this document:** `embedfile` is
   *not* engine-agnostic — it requires pdfTeX or LuaTeX in PDF mode and errors
   out under XeLaTeX, which has no dvipdfmx backend for embedded files.
   Supporting XeLaTeX means moving to `l3pdffile`/`\DocumentMetadata`, which
   costs support for older TeX Live. See §3.
2. **Page resolution.** `zref-abspage` gives the true shipout page — `\thepage`
   is wrong under beamer, and wrong in general because notes are captured before
   the output routine fires.
3. **Beamer overlays come out right for free.** A frame with `<1->`/`<2->`
   overlays is typeset once per overlay, so one `\presionote` in the frame body
   produced *separate* notes on PDF pages 2 and 3 — exactly the replication
   Presio wants, with no special-casing. (Verified above.)
4. **Position capture and the y-flip.** The media box on page 4 reported
   `x_pt: 28.45` (= beamer's 1cm left margin) and a sane top-origin y.
5. **JSON escaping in TeX.** Stringify the argument with `\tl_to_str:n`, then
   substitute `\par`→`\n\n`, `\`→`\\`, `"`→`\"`. Stringifying first also means
   `#` reaches `\write` as category 12, so TeX does not double it.

Three bugs the spike hit that the real package must not re-introduce (all fixed
in the spike, all non-obvious):

- `\zsavepos{L}` and `\zref@labelbyprops{L}{abspage}` under the **same label
  name** silently clobber each other. Add `abspage` to the `savepos` property
  list instead: `\zref@addprops{savepos}{abspage}`.
- The page-lookup helper must be **expandable** (`\cs_new:Npn`, not
  `\cs_new_protected:Npn`) or the label name lands in the filename literally.
- `embedfile` registers `\embedfilefinish` in `\AtEndDocument` at *load* time, so
  a later `\AtEndDocument` runs after the name tree is sealed and the
  attachments vanish. Hook with `\pretocmd\embedfilefinish` instead.

**Two compilation passes are mandatory** (page/position data round-trips through
`.aux`). latexmk and Overleaf both do this by default; a bare single `pdflatex`
emits zeros. The package should warn on pass 1.

---

## 3. Package design

### Notes API

```latex
\presionote{Remember to mention the demo.}     % short, inline

\begin{presionotes}                            % verbatim, full markdown
- bullet one
- bullet two
\end{presionotes}
```

`\presionote` takes a `+m` (long) argument and stringifies it, so `_`, `#`, `&`,
`$` survive and blank lines become `\n\n`. Its limits, which motivate the
environment: braces must balance, and single newlines collapse to spaces — so
markdown lists and hard line breaks don't work. The `presionotes` environment
captures verbatim lines (via the `verbatim` package's `\verbatim@processline`
hook, escaping each line as it is read) and is the recommended form for anything
structured. Caveat to document: **inside beamer it needs `\begin{frame}[fragile]`**.

Also worth doing: an opt-in hook so beamer's own `\note{...}` feeds Presio, so
existing decks get notes with a one-line package load and no rewriting.

### Media API

```latex
\presiomedia[width=0.6\linewidth, autoplay, loop]{https://youtu.be/…}
\presiomedia[width=8cm, poster=frame.png]{clips/demo.mp4}
```

- URL vs. local path detected from the argument; YouTube/Vimeo IDs extracted with
  a string match so `kind`/`video_id` are set (the spike stubs this to `url`).
- Local files: embed the bytes with `\embedfile` as `media-<id>.<ext>`, set
  `kind: "file"` and `filename`, and derive `mime` from the extension.
- Draws a placeholder box: `poster=` image if given, otherwise a framed play
  glyph, so the printed PDF isn't a hole.
- Sizing options mirror the Typst package: `width`, `height`, `aspect-ratio`
  (default 16:9).

### Engine and backend support

pdfLaTeX and LuaLaTeX only, and this is a hard constraint rather than a
priority order: `embedfile` refuses to run anywhere else, so XeLaTeX and the
dvips route cannot carry the sidecars at all. Both supported engines were
tested and produce identical coordinates.

XeLaTeX support would mean re-doing the embedding on top of
`l3pdffile`/`\DocumentMetadata`, which is backend-independent but requires a
recent TeX Live and interacts with beamer and hyperref in ways that need their
own testing. Worth doing only if XeLaTeX users actually turn up; the package
detects the engine and fails with a clear message meanwhile.

### Compatibility surface to test

beamer (plain, plus overlays and `\only`/`\uncover`), powerdot, plain
`article`+`\newpage`, and `\includegraphics`-heavy decks. Also: hyperref load
order, `\usepackage[fragile]` interactions, and UTF-8 note text (non-ASCII must
land in the file as UTF-8 bytes — verify, this is engine-dependent).

### Known rough edge

LaTeX escapes leak into the markdown: `\_foo\_` in the source arrives at the
notes panel as the literal `\_foo\_`. Options are to unescape a small set of
common sequences (`\_ \& \% \#`) on the way out, or to document the environment
form as the place to write markdown. Recommend the former for the common four.

---

## 4. Distribution

### CTAN → TeX Live → Overleaf

The path is real but **slow**, and the timing is currently bad:

- CTAN upload needs: the source (a `.dtx`/`.ins`, or the `.sty` with derivable
  docs), a PDF manual, README, and a license — LPPL 1.3c, matching the ecosystem.
  Generated files must not be in the upload.
- CTAN mirrors sync daily, and TeX Live users can `tlmgr install presio` within
  days of acceptance.
- **Overleaf cannot.** It runs frozen TeX Live images and gives users no
  `tlmgr`. Overleaf upgrades "shortly after" each TeX Live release — but TeX Live
  2026 already shipped on 1 March 2026, so a package uploaded now waits for
  TL 2027, i.e. roughly **spring 2027** before it is on Overleaf natively.

So CTAN is worth doing for the long game, but it cannot be the launch plan.

### What actually makes it work in Overleaf on day one

1. **Ship a single self-contained `presio.sty`.** Users drag it into their
   Overleaf project and `\usepackage{presio}` works immediately, on any TeX Live
   version Overleaf offers. This should be the documented primary install path
   until CTAN propagation catches up. It constrains the design: no exotic
   dependencies beyond what's already in every TeX Live (`embedfile`, `zref-*`,
   `etoolbox`, `graphicx` all qualify).
2. **An "Open in Overleaf" button.** Overleaf's documented API
   (`https://www.overleaf.com/docs?snip_uri=<url-to-zip>`) creates a project from
   a hosted zip. Ship a starter zip (deck + `presio.sty`) at a stable URL and put
   the button on the Presio about page. One click, working deck, notes and media
   already wired.
3. **A template in the Overleaf gallery**, submitted once the package is on CTAN.

**Verify before promising:** that Overleaf permits the `\iow_open` →
`\embedfile` round-trip (writing a file and reading it back within the same
compile). It's ordinary aux-file behaviour and should be fine, but it is the one
assumption I could not test without an Overleaf account, and the whole design
rests on it. Test it first — it's a ten-minute check.

### The "live link" tie-in

Assessed, and my recommendation is **don't build it**:

- Overleaf has no plugin/extension API and no public per-project PDF URL. A
  read-only `overleaf.com/read/<token>` link serves the editor UI, not the PDF.
- Fetching a project's `output.pdf` server-side means driving Overleaf's private
  endpoints with a scraped session — unofficial, ToS-questionable, and it breaks
  whenever they change anything.
- The Git bridge is a premium feature and would require Presio to run a LaTeX
  compiler, which is a different product.

The honest options are the manual one (compile in Overleaf, download the PDF,
drop it on Presio — already a two-step flow) or, if the friction really bites, a
small browser extension that grabs the compiled PDF from the page the user is
already looking at and hands it to Presio. That is a separate project with its
own maintenance burden; worth revisiting only if users ask.

---

## 5. Presio-side work

Small, and independent of the package:

- `client/src/pages/About.tsx` — the "Videos & speaker notes with Typst" section
  becomes tabbed Typst/LaTeX; replace the hand-rolled `\href{note:...}` snippet
  with the package, keeping the annotation trick as a fallback note.
- `README.md` — mention the LaTeX package alongside the Typst one.
- `/check` (`CheckerPage`) — no logic change; the sidecars are identical. Worth
  a copy pass so the error messages don't say "fix your Typst source".
- `llms.txt` / `api.md` — mention the LaTeX package.

---

## 6. Milestones

| # | Deliverable | Notes |
|---|---|---|
| 0 | Overleaf write-then-embed check | Blocking assumption; ten minutes. **Still open** |
| 1 | Notes only, pdfLaTeX + beamer | **Done** — v0.1.0 |
| 2 | Media: URL, YouTube/Vimeo, local file embedding | **Done** — v0.1.0 |
| 3 | Class matrix (powerdot, plain, overlay tricks) | Where surprises live |
| 4 | Docs, PDF manual, `.dtx`, LPPL, own repo | Mirrors `presio-typst-package` |
| 5 | Starter zip + "Open in Overleaf" button + about-page rewrite | Launch |
| 6 | CTAN upload | Overleaf-native ~spring 2027 |

Milestones 1–2 are the substance; 3 is the one that expands unpredictably, since
every deck class fails in its own way.

---

## Sources

- [Overleaf API / "Open in Overleaf"](https://www.overleaf.com/devs)
- [TeX Live versions on Overleaf](https://docs.overleaf.com/troubleshooting-and-support/tex-live)
- [CTAN upload requirements](https://ctan.org/help/upload-pkg?lang=en)
- [TeX Live package contributions](https://tug.org/texlive/pkgcontrib.html)
- [TeX Live 2026 released, 1 March 2026](https://www.preining.info/blog/2026/03/tex-live-2026-released/)
- [embedfile package](https://texdoc.org/serve/embedfile.pdf/0)

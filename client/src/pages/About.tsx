import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/CodeBlock";

const PACKAGE_URL = "https://github.com/benedict-armstrong/presio-typst-package";

export default function About() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-3xl">
        <CardContent className="pt-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">About Presio</h1>
              <p className="text-sm text-muted-foreground">
                A simple tool for presenting PDFs — locally or shared live across devices.
              </p>
            </div>
            <a
              href="https://github.com/benedict-armstrong/slides"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
            >
              GitHub
            </a>
          </div>

          <div className="rounded-md border border-amber-500/10 bg-amber-500/20 px-3 py-2 text-sm text-amber-900 dark:text-amber-500">
            🚧 Presio is under active development
            <br />
            <br />
            Please report bugs, features or reach out <a className="font-medium underline underline-offset-2" href="https://github.com/benedict-armstrong/presio/issues">here</a>.
          </div>

          <div className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">How it works</h2>
              <ol className="list-decimal list-inside space-y-1">
                <li>Upload a PDF on the home page. By default it stays in your browser — nothing is uploaded.</li>
                <li>You land on the controller view, where you navigate slides, see speaker notes, and control media.</li>
                <li>A viewer window opens automatically and mirrors the controller, kept in sync as you present.</li>
                <li>Recent presentations are listed on the home page so you can pick up where you left off.</li>
              </ol>
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">Local by default</h2>
              <p>
                New presentations are <span className="text-foreground font-medium">local</span>: the PDF lives only
                in this browser and is never sent to a server. The controller and viewer windows sync directly on
                your device, so it works offline and keeps your slides private. Local presentations stay available
                for up to 7 days.
              </p>
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">Presenting across devices</h2>
              <p>
                To let an audience follow along from their own devices, log in and sync the presentation online from
                the share screen. You'll get a 6-character session code to share — viewers enter it on the home page
                and see your slides update in real time. You can also share a controller passphrase to let someone
                else drive. Logged-in users see their presentations on the home page; online presentations expire
                automatically.
              </p>
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">Details</h2>
              <ul className="list-disc list-inside space-y-1">
                <li>Slide changes sync instantly — locally between windows, or live via WebSockets when shared.</li>
                <li>Customizable controller layout, a presentation timer, and remappable keyboard shortcuts.</li>
                <li>Embedded videos, GIFs, and YouTube/Vimeo — playback (including autoplay and seeking) stays in sync with viewers.</li>
                <li>Anyone can download the PDF from the presentation view.</li>
              </ul>
            </div>
          </div>

          <div className="space-y-4 text-sm text-muted-foreground">
            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">Videos &amp; speaker notes with Typst</h2>
              <p>
                The easiest way to add videos and speaker notes is the{" "}
                <a
                  href={PACKAGE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
                >
                  Presio Typst package
                </a>
                . It attaches the media and notes to your PDF in a format Presio reads automatically — no manual
                annotation wiring needed. Import it at the top of your document:
              </p>
              <CodeBlock code={`#import "@preview/presio:0.2.1": media, speaker-notes`} />

              <p className="pt-2">Add speaker notes to any slide:</p>
              <CodeBlock code={`= Introduction

Hello world.

#speaker-notes[
  Remember to mention the demo before moving on.
]`} />

              <p className="pt-2">Embed a local video or GIF, a direct video URL, or a YouTube/Vimeo link:</p>
              <CodeBlock code={`// Local file — wrap the path with Typst's path() type
#media(path("figures/demo.gif"), width: 60%)

// Direct URL with a poster image
#media(
  "https://example.com/video.mp4",
  width: 40%,
  aspect-ratio: 16/9,
  placeholder: image("poster.png"),
)

// YouTube / Vimeo are detected automatically
#media("https://www.youtube.com/watch?v=dQw4w9WgXcQ", width: 60%, aspect-ratio: 16/9)`} />
              <p className="pt-2">
                <code className="bg-muted px-1 rounded text-xs">media</code> also accepts{" "}
                <code className="bg-muted px-1 rounded text-xs">name</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">height</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">autoplay</code>, and{" "}
                <code className="bg-muted px-1 rounded text-xs">loop</code> (autoplay and loop
                default to true). Supported local types are{" "}
                <code className="bg-muted px-1 rounded text-xs">.gif</code>,{" "}
                <code className="bg-muted px-1 rounded text-xs">.mp4</code>, and{" "}
                <code className="bg-muted px-1 rounded text-xs">.webm</code>.
              </p>
              <p className="text-xs">
                Works with plain Typst, Polylux, or Touying. The <code className="bg-muted px-1 rounded">path()</code>{" "}
                syntax requires Typst 0.15+; on Typst 0.13–0.14 use presio 0.1.0 with the bytes-based API.
              </p>
            </div>

            <div className="space-y-1 pt-2">
              <h2 className="text-base font-medium text-foreground">Adding notes manually</h2>
              <p>
                Prefer not to use the package? Speaker notes can also be embedded by hand. Presio reads them from
                JSON files attached to the PDF (Typst) or from <code className="bg-muted px-1 rounded text-xs">note:</code>{" "}
                link annotations (LaTeX), and renders them as markdown in the controller's notes panel.
              </p>

              <h3 className="text-sm font-medium text-foreground pt-2">Typst</h3>
              <p>Define a helper and call it on each slide:</p>
              <CodeBlock code={`// Define the speaker-notes function
#let speaker-notes(notes) = context {
  // 1. Get the current page number to ensure a unique filename per slide
  let page-num = counter(page).display()
  let filename = "notes-slide-" + page-num + ".json"

  // 2. Structure the data as a dictionary and encode it to a JSON string
  let note-data = (
    slide: page-num,
    notes: notes,
  )
  let json-string = json.encode(note-data)

  // 3. Attach the JSON file to the PDF
  pdf.attach(
    filename,
    bytes(json-string), // Pass the raw bytes of the JSON string
    description: "Speaker notes for slide " + page-num,
    mime-type: "application/json",
  )
}
`} />
              <p>Example usage:</p>
              <CodeBlock code={`#speaker-notes("Remember to mention the demo.")`} />

              <h3 className="text-sm font-medium text-foreground pt-2">LaTeX (hyperref)</h3>
              <p>Use the <code className="bg-muted px-1 rounded text-xs">hyperref</code> package to create an invisible link:</p>
              <CodeBlock lang="latex" code={`\\usepackage{hyperref}

\\newcommand{\\speakernote}[1]{%
  \\href{note:#1}{\\phantom{n}}%
}

% Usage on a slide:
\\speakernote{Remember to mention the demo.}
`} />
            </div>
          </div>

          <div className="rounded-md border px-3 py-2.5 text-sm text-muted-foreground">
            Validate your compiled PDF's sidecar attachments at{" "}
            <Link
              to="/check"
              className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
            >
              presio.xyz/check
            </Link>
            {" "}— upload a PDF to see per-page thumbnails and check that notes and media sidecars are valid.
          </div>

          <div className="rounded-md border px-3 py-2.5 text-sm text-muted-foreground space-y-1">
            <p className="text-foreground font-medium">For AI agents</p>
            <p>
              Start at{" "}
              <a
                href="/llms.txt"
                className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
              >
                /llms.txt
              </a>
              {" "}or{" "}
              <a
                href="/api.md"
                className="text-foreground underline underline-offset-4 hover:text-muted-foreground"
              >
                /api.md
              </a>
              . Upload a PDF with{" "}
              <code className="bg-muted px-1 rounded text-xs">POST /api/present</code>
              {" "}to open a local presentation (skips share).
            </p>
          </div>

          <div className="flex items-center justify-between pt-2">
            <Button variant="outline" asChild>
              <Link to="/">Back to Home</Link>
            </Button>
            <a
              href="https://github.com/benedict-armstrong/slides"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
            >
              GitHub
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

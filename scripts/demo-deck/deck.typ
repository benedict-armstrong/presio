// The deck recorded for the homepage hero (scripts/record-demo.mts).
//
// Deliberately not example/example.typ: that one is the media test fixture,
// and its colour-cycling test GIF reads as a rendering bug on a marketing
// page. This deck is about Presio itself — the hero shows Presio presenting
// its own feature tour — with real speaker notes, so the controller's notes
// pane and next-slide preview have something to show.
//
// The recorder choreographs against this page order, so slides cannot be
// added or reordered without re-timing scripts/record-demo.mts:
//   1 cover · 2 title · 3 laser target · 4 pen target · 5 list
//   6 media (the j6 jump lands here) · 7 payoff · 8 close
//
// Compile with: typst compile scripts/demo-deck/deck.typ
#import "@preview/touying:0.7.4": *
#import themes.simple: *
#import "@preview/presio:0.2.3": media, speaker-notes

#show: simple-theme.with(aspect-ratio: "16-9")

#set text(size: 22pt)

= Presio

#v(0.4em)
Present PDFs from your browser — this deck included.

#v(0.3em)
#text(size: 16pt, fill: gray)[A five-minute tour · presio.xyz]

#speaker-notes[
  Open by pointing at the screen: this deck is a PDF, and it is being driven
  by the thing it is describing. Keep the tour to five minutes.
]

== Two windows, one deck

#v(0.6em)

#grid(
  columns: (1fr, 1fr),
  gutter: 2em,
  [
    - You drive the controller
    - A viewer window mirrors it
    - Or share a 6-character code
  ],
  [
    #let win(w, c) = block(width: w, radius: 3pt, stroke: 1pt + c, inset: 0pt, clip: true)[
      #block(width: 100%, height: 0.42em, fill: c)
      #block(width: 100%, height: 1.25em)
    ]
    #stack(
      spacing: 0.7em,
      win(100%, rgb("#1f2937")),
      win(88%, rgb("#6b7280")),
      win(60%, rgb("#d1d5db")),
    )
    #text(size: 14pt, fill: gray)[controller · projector · the back row]
  ],
)

#speaker-notes[
  The code is the part people miss: viewers type it on the home page and
  follow along on their own screens. No install, no account.
]

== Your PDF stays in the browser

#v(0.8em)

The file is opened and rendered locally, never uploaded. Sync online only when
you want people on other devices to follow along.

#speaker-notes[
  Worth saying plainly for anyone presenting something confidential: local
  presentations never leave the machine, and they expire after seven days.
]

== While you are talking

#v(0.6em)

+ A laser pointer and a pen, live on the slide
+ Speaker notes beside the current and next slide
+ A timer, and j+number to jump anywhere

#speaker-notes[
  Demonstrate rather than read the list — the laser and the pen are already
  on screen by now, so just call out the timer and the jump.
]

== Video and GIFs, in sync

#v(0.4em)

#grid(
  columns: (1fr, 1fr),
  gutter: 1.6em,
  [
    #media(path("demo-sync.gif"), width: 100%)
    #text(size: 13pt, fill: gray)[an embedded GIF]
  ],
  [
    #media(
      "https://www.youtube.com/watch?v=YE7VzlLtp-4",
      width: 100%,
      aspect-ratio: 16 / 9,
    )
    #text(size: 13pt, fill: gray)[a YouTube link]
  ],
)

#speaker-notes[
  Both play in place — the GIF rides along inside the PDF, the YouTube one is
  fetched at presentation time. Play, pause and seek all reach the viewers.
]

== Try it on your own deck

#v(0.8em)

#align(center)[
  #text(size: 44pt, weight: "bold")[presio.xyz]
  #v(0.5em)
  #text(size: 16pt, fill: gray)[
    notes and media come from one Typst or LaTeX import — any PDF works without
    them
  ]
]

#speaker-notes[
  Land on this slide. The packages only add notes and media; a deck with
  neither needs nothing beyond the PDF itself.
]

== Questions

#speaker-notes[
  Expect: where the file goes, whether viewers need an account, and
  self-hosting.
]

// The deck recorded for the homepage hero (scripts/record-demo.mts).
//
// Deliberately not example/example.typ: that one is the media test fixture,
// and its colour-cycling test GIF reads as a rendering bug on a marketing
// page. This is plain, legible slide content with real speaker notes, so the
// controller's notes pane and next-slide preview have something to show.
//
// Compile with: typst compile scripts/demo-deck/deck.typ
#import "@preview/touying:0.7.4": *
#import themes.simple: *
#import "@preview/presio:0.2.2": speaker-notes

#show: simple-theme.with(aspect-ratio: "16-9")

#set text(size: 22pt)

= Cutting our p99 in half

#v(0.4em)
Ben Armstrong · Platform team

#speaker-notes[
  Thank the room, then set the frame: this is the story of one regression,
  not a general performance talk. Keep it to 20 minutes.
]

== Where the time went

#v(0.6em)

#grid(
  columns: (1fr, 1fr),
  gutter: 2em,
  [
    - Serialising on a single writer
    - Retries with no jitter
    - A cache that never warmed
  ],
  [
    #let bar(w, c) = rect(width: w, height: 1.1em, fill: c, radius: 2pt)
    #stack(
      spacing: 0.7em,
      bar(100%, rgb("#1f2937")),
      bar(62%, rgb("#6b7280")),
      bar(31%, rgb("#d1d5db")),
    )
    #text(size: 14pt, fill: gray)[db · queue · cache]
  ],
)

#speaker-notes[
  The single writer is the headline. Everything else is a rounding error
  next to it — don't let questions pull you into the retry logic yet.
]

== One writer, many waiters

#v(0.8em)

Every request queued behind the same lock, so throughput was flat no matter
how many replicas we added.

#speaker-notes[
  If someone asks why we didn't catch this in staging: staging ran one
  replica, so the contention never showed up.
]

== What we changed

#v(0.6em)

+ Sharded the writer by tenant
+ Added jitter to every retry path
+ Warmed the cache on deploy

#speaker-notes[
  Sharding was the only risky one. Mention the migration took two weeks and
  shipped behind a flag.
]

== The result

#v(0.8em)

#align(center)[
  #text(size: 54pt, weight: "bold")[840ms → 390ms]
  #v(0.3em)
  #text(size: 16pt, fill: gray)[p99, measured over four weeks]
]

#speaker-notes[
  Land on this slide. If you are short on time, skip straight here from the
  problem statement.
]

== Questions

#speaker-notes[
  Expect: cost, rollback story, whether the flag is still there.
]

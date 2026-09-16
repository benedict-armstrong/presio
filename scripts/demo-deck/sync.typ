// Frames for demo-sync.gif, the animated figure embedded in the demo deck.
// One page per frame; scripts/make-gif.sh rasterises them and stitches the GIF.
//
// Deliberately on-theme with the deck (two windows stepping together) rather
// than a stock clip: the hero recording shows this playing inside a slide, so
// it has to look like something the deck would actually contain.
#set page(width: 480pt, height: 270pt, margin: (x: 26pt, y: 20pt), fill: white)
#set text(font: "Libertinus Serif", size: 11pt)

#let slides = 4
#let hold = 8 // frames each slide is held
#let frames = slides * hold

#let ink = rgb("#1f2937")
#let mid = rgb("#6b7280")
#let pale = rgb("#d1d5db")
#let paler = rgb("#e5e7eb")

// A miniature slide: a title rule and a few body lines, different per slide so
// the step is unmistakable even at this size.
#let body(n) = {
  let lines = ((90%, 62%), (100%, 44%, 70%), (80%, 80%), (55%,))
  stack(
    dir: ttb,
    spacing: 11pt,
    rect(width: 46%, height: 9pt, fill: ink, radius: 1pt),
    ..lines.at(n - 1).map(w => rect(width: w, height: 6pt, fill: paler, radius: 1pt)),
  )
}

// `lit` marks the two frames right after a step, where both windows flash at
// once — that simultaneity is the whole point of the figure.
#let window(label, n, lit) = stack(
  dir: ttb,
  spacing: 5pt,
  text(size: 9pt, fill: mid)[#label],
  rect(
    width: 100%,
    height: 150pt,
    radius: 3pt,
    inset: 10pt,
    stroke: if lit { 1.5pt + ink } else { 0.5pt + pale },
  )[
    #body(n)
    #place(bottom + right, text(size: 10pt, fill: mid)[#n\/#slides])
  ],
)

#for i in range(frames) {
  let n = calc.div-euclid(i, hold) + 1
  let lit = calc.rem(i, hold) < 2

  block(width: 100%)[
    #text(size: 12pt, weight: "bold", fill: ink)[One deck, two windows]

    #v(8pt)

    #grid(
      columns: (1fr, 1fr),
      gutter: 18pt,
      window("controller", n, lit),
      window("viewer", n, lit),
    )

    #v(7pt)
    #text(size: 10pt, fill: mid)[Every move is mirrored — slides, media, annotations.]
  ]

  if i < frames - 1 { pagebreak() }
}

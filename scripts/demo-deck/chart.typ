// Frames for demo-chart.gif, the animated figure embedded in the demo deck.
// One page per frame; scripts/make-gif.sh rasterises them and stitches the GIF.
//
// Deliberately on-theme with the deck (a p99 coming down) rather than a stock
// clip: the hero recording shows this playing inside a slide, so it has to look
// like something a real deck would contain.
#set page(width: 480pt, height: 270pt, margin: (x: 28pt, y: 22pt), fill: white)
#set text(font: "Libertinus Serif", size: 11pt)

#let frames = 28
#let ink = rgb("#1f2937")
#let mid = rgb("#6b7280")
#let pale = rgb("#d1d5db")

// Ease-in-out so the loop does not visibly snap at either end.
#let ease(t) = if t < 0.5 { 2 * t * t } else { 1 - calc.pow(-2 * t + 2, 2) / 2 }

#for i in range(frames) {
  let p = ease(i / (frames - 1))
  let ms = calc.round(840 - 450 * p)

  block(width: 100%)[
    #text(size: 13pt, weight: "bold", fill: ink)[p99 latency]
    #v(-4pt)
    #text(size: 9pt, fill: mid)[rolling four-week window]

    #v(10pt)

    // Three bars retreating as the fix lands.
    #let bar(label, from, to, colour) = {
      let w = from - (from - to) * p
      stack(
        dir: ttb,
        spacing: 3pt,
        text(size: 8pt, fill: mid)[#label],
        rect(width: w * 1pt, height: 13pt, fill: colour, radius: 2pt),
      )
    }
    #stack(
      dir: ttb,
      spacing: 9pt,
      bar("db", 360, 150, ink),
      bar("queue", 250, 110, mid),
      bar("cache", 150, 60, pale),
    )

    #v(12pt)
    #align(right)[
      #text(size: 26pt, weight: "bold", fill: ink)[#ms#text(size: 15pt)[ms]]
    ]
  ]

  if i < frames - 1 { pagebreak() }
}

// Drawing: a pen, a highlighter and a laser pointer on the presenter's current
// slide, followed live on every screen. Presio itself knows nothing about
// drawing — this plugin runs on two surfaces: the slide itself, everywhere
// (slide.ts), and the presenter's background (background.ts). What's drawn
// and how it travels is in model.ts.

import "./drawing.css";

// Each surface loads only its own code (a separate chunk, see
// plugins/build.ts): viewers never download the presenter's background.
if (presio.surface === "background") void import("./background").then((m) => m.runBackground());
else if (presio.surface === "slide") void import("./slide").then((m) => m.runSlide());

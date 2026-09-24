// Drawing: a pen, a highlighter and a laser pointer on the presenter's current
// slide, followed live on every screen. Presio itself knows nothing about
// drawing — this plugin runs on two surfaces: the slide itself, everywhere
// (slide.ts), and the presenter's background (background.ts). What's drawn
// and how it travels is in model.ts.

import { runBackground } from "./background";
import { runSlide } from "./slide";
import "./drawing.css";

if (presio.surface === "background") runBackground();
else if (presio.surface === "slide") runSlide();

// Media: the GIFs, videos and YouTube / Vimeo embeds a deck carries, played on
// their slides and kept in time on every screen. Presio itself knows nothing
// about media — this plugin reads it out of the PDF (placements.ts) and runs
// on two surfaces: the presenter's background (background.ts) and the slide
// itself, everywhere (slide.ts).

import { runBackground } from "./background";
import { runSlide } from "./slide";
import "./media.css";

if (presio.surface === "background") runBackground();
else if (presio.surface === "slide") runSlide();

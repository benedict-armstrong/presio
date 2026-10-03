// Media: the GIFs, videos and YouTube / Vimeo embeds a deck carries, played on
// their slides and kept in time on every screen. Presio itself knows nothing
// about media — this plugin reads it out of the PDF (placements.ts) and runs
// on two surfaces: the presenter's background (background.ts) and the slide
// itself, everywhere (slide.ts).

import "./media.css";

// Each surface loads only its own code (a separate chunk, see
// plugins/build.ts): viewers never download the presenter's background.
if (presio.surface === "background") void import("./background").then((m) => m.runBackground());
else if (presio.surface === "slide") void import("./slide").then((m) => m.runSlide());

// The presenter's hidden surface: a still of each slide's drawing for Next
// Slide and the thumbnails, the keyboard shortcuts and the buttons (the
// header's, and saving or loading the drawing from its Settings page), and
// baking the drawing into a downloaded PDF. It keeps the same model as the
// slide surface, from the same messages (see model.ts).

import { Drawing, parseFile, publish, serializeFile, type Tool } from "./model";
import { drawStrokes } from "./render";

// How wide previews are drawn, and how long a slide's drawing has to settle
// before its preview is redrawn — a preview per stroke would be wasted work.
const PREVIEW_WIDTH = 640;
const PREVIEW_DELAY_MS = 250;

export function runBackground() {
  const drawing = new Drawing();
  let pages: { width: number; height: number }[] = [];
  const previews = new Map<number, string>();
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  // Saving to a file needs something drawn.
  const showSaveFile = () => presio.ui.setButton("saveFile", { disabled: drawing.drawnSlides().length === 0 });

  // --- Previews (presio.layers) ---

  const preview = async (slide: number) => {
    pending.delete(slide);
    const strokes = drawing.strokes(slide);
    const old = previews.get(slide);
    if (!strokes.length) {
      presio.layers.set(slide, []);
      previews.delete(slide);
    } else {
      const size = pages[slide - 1] ?? pages[0] ?? { width: 16, height: 9 };
      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_WIDTH;
      canvas.height = Math.max(1, Math.round((PREVIEW_WIDTH * size.height) / size.width));
      drawStrokes(canvas.getContext("2d")!, strokes, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      if (!blob || drawing.strokes(slide) !== strokes) return;
      const url = URL.createObjectURL(blob);
      previews.set(slide, url);
      presio.layers.set(slide, [{ x: 0, y: 0, w: 1, h: 1, image: url, fit: "cover" }]);
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  };

  const schedulePreview = (slide: number) => {
    clearTimeout(pending.get(slide));
    pending.set(slide, setTimeout(() => void preview(slide), PREVIEW_DELAY_MS));
  };

  presio.onMessage(({ type, payload }) => {
    const slide = drawing.apply(type, payload);
    if (slide !== null) {
      schedulePreview(slide);
      showSaveFile();
    }
  });

  const loadPages = async () => {
    pages = await presio.deck.pages().catch(() => pages);
    for (const slide of drawing.drawnSlides()) schedulePreview(slide);
  };
  presio.deck.onChange((kind) => {
    if (kind === "replace") {
      drawing.reset();
      showSaveFile();
      presio.layers.clear();
      for (const url of previews.values()) URL.revokeObjectURL(url);
      previews.clear();
    }
    void loadPages();
  });
  void loadPages();

  // --- Tools, from the keyboard ---

  // The tool is this device's, shared with the slide surface through storage.
  // A reload starts with none, so the slide takes clicks again.
  presio.storage.set("tool", "none");
  const setTool = (tool: Tool) => {
    if (tool !== "none" && presio.settings.get("toolbar") === false) void presio.settings.set("toolbar", true);
    presio.storage.set("tool", tool);
  };
  presio.onCommand("pen", () => setTool("pen"));
  presio.onCommand("highlighter", () => setTool("highlighter"));
  presio.onCommand("laser", () => setTool("laser"));
  presio.onCommand("pointer", () => setTool("none"));
  presio.onCommand("undo", () => publish(drawing.undo(presio.slide.current)));
  presio.onCommand("clear", () => publish(drawing.clear(presio.slide.current)));

  // --- The palette's button in the current slide's header ---

  const showButton = () => presio.ui.setButton("palette", { active: presio.settings.get("toolbar") !== false });
  presio.onButton("palette", () => void presio.settings.set("toolbar", presio.settings.get("toolbar") === false));
  presio.settings.onChange(showButton);
  showButton();

  // --- Saving and loading, from its page in Settings ---

  presio.onButton("saveFile", () => {
    const url = URL.createObjectURL(new Blob([serializeFile(drawing)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "slides-drawing.json";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  presio.onButton("loadFile", (_id, file) => {
    if (!file) return;
    try {
      const loaded = parseFile(new TextDecoder().decode(file.bytes), presio.slide.total);
      const changed = new Set([...drawing.drawnSlides(), ...loaded.keys()]);
      publish(drawing.replaceAll(loaded));
      changed.forEach(schedulePreview);
      showSaveFile();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to load the drawing");
    }
  });
  showSaveFile();

  // pdf-lib only loads when a download asks for it.
  presio.deck.onExport(async (bytes) => (await import("./bake")).bakeDrawing(bytes, drawing));
}

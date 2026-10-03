// Where media sits in the deck, read from the sidecars the presio Typst and
// LaTeX packages embed: `media-slide-{n}-{id}.json` (a box in PDF points,
// top-left origin) plus, for files, the `media-{id}.{gif|mp4|webm}` bytes.
// The format is shared with the checker (src/lib/inspectAttachments.ts) and
// schema/media-sidecar.schema.json.

export type MediaKind = "file" | "url" | "youtube" | "vimeo";

export interface Placement {
  slide: number;
  id: string;
  kind: MediaKind;
  mime: string;
  /** The box, as fractions of the page, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  autoplay: boolean;
  loop: boolean;
  /** What a <video> or <img> loads: a blob URL for a file, the URL itself
   *  for a url. Empty for embeds, which are addressed by videoId. */
  src: string;
  /** The media's own address, for links in a downloaded PDF: a url's, or an
   *  embed's watch page. */
  url?: string;
  videoId?: string;
  filename?: string;
}

/** Placements by slide; no entry = no media. */
export type Placements = Map<number, Placement[]>;

export const isVideo = (p: Placement) => p.mime.startsWith("video/");
export const isEmbed = (p: Placement) => p.kind === "youtube" || p.kind === "vimeo";
/** Has a timeline to play, pause and hear — unlike a GIF. */
export const isPlayable = (p: Placement) => isVideo(p) || isEmbed(p);

interface Sidecar {
  slide: number;
  id: string;
  kind?: MediaKind;
  filename?: string;
  url?: string;
  video_id?: string;
  mime: string;
  x_pt: number;
  y_pt: number;
  w_pt: number;
  h_pt: number;
  autoplay: boolean;
  loop: boolean;
}

const SIDECAR_RE = /^media-slide-\d+-.+\.json$/;
const BINARY_RE = /^media-.+\.(gif|mp4|webm)$/i;

// Sidecars come out of the PDF, which is untrusted input — a deck can be
// handed over or downloaded from anywhere. These keep a malformed or hostile
// sidecar from producing a broken embed or an unexpected request.

// A video id is interpolated into the embed URL's path (embeds.ts), so it's
// held to the characters both providers use: no slashes or "..".
function isValidVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// A url is loaded as a <video>/<img> source, or linked from a download.
function isValidMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const mimeFor = (name: string) =>
  /\.gif$/i.test(name) ? "image/gif" : /\.mp4$/i.test(name) ? "video/mp4" : /\.webm$/i.test(name) ? "video/webm" : "application/octet-stream";

/**
 * Every slide's media in the deck on screen. File media become blob URLs of
 * this document; hand the result to release() once it's no longer shown.
 */
export async function readPlacements(): Promise<Placements> {
  const [attachments, pages] = await Promise.all([presio.deck.attachments(), presio.deck.pages()]);
  const binaries = new Map<string, string>();
  const sidecars: Sidecar[] = [];
  for (const { filename, bytes } of attachments) {
    if (SIDECAR_RE.test(filename)) {
      try {
        sidecars.push(JSON.parse(new TextDecoder().decode(bytes)));
      } catch { /* skip malformed */ }
    } else if (BINARY_RE.test(filename) && !binaries.has(filename)) {
      const blob = new Blob([bytes as BlobPart], { type: mimeFor(filename) });
      binaries.set(filename, URL.createObjectURL(blob));
    }
  }

  const out: Placements = new Map();
  for (const m of sidecars) {
    const page = pages[m.slide - 1];
    if (!page || !page.width || !page.height) continue;
    const kind: MediaKind = m.kind ?? (m.url ? "url" : "file");
    let src: string | undefined;
    if (kind === "youtube" || kind === "vimeo") {
      // Addressed by id; one without a usable id can't play at all.
      if (!isValidVideoId(m.video_id)) continue;
      src = "";
    } else if (kind === "url") {
      if (!isValidMediaUrl(m.url)) continue;
      src = m.url;
    } else if (m.filename) {
      src = binaries.get(m.filename);
    }
    if (src === undefined) continue;
    const placement: Placement = {
      slide: m.slide,
      id: String(m.id),
      kind,
      mime: typeof m.mime === "string" ? m.mime : "",
      x: m.x_pt / page.width,
      y: m.y_pt / page.height,
      w: m.w_pt / page.width,
      h: m.h_pt / page.height,
      autoplay: !!m.autoplay,
      loop: !!m.loop,
      src,
      url: kind !== "file" && isValidMediaUrl(m.url) ? m.url : undefined,
      videoId: kind === "youtube" || kind === "vimeo" ? m.video_id : undefined,
      filename: m.filename,
    };
    if (![placement.x, placement.y, placement.w, placement.h].every(Number.isFinite) || placement.w <= 0 || placement.h <= 0) continue;
    const list = out.get(m.slide) ?? [];
    list.push(placement);
    out.set(m.slide, list);
  }
  return out;
}

/** Free the blob URLs of placements no longer on screen. */
export function release(placements: Placements) {
  for (const list of placements.values()) {
    for (const p of list) if (p.src.startsWith("blob:")) URL.revokeObjectURL(p.src);
  }
}

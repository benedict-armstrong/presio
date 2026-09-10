export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const EMPTY_RECT: Rect = { left: 0, top: 0, width: 0, height: 0 };

// Where an `object-fit: contain` child actually lands inside its box. Overlays
// (media players, media posters) position themselves in page fractions, so they
// need the letterboxed content rect rather than the container's own box —
// anywhere the container's aspect ratio can differ from the page's.
export function containedRect(
  containerW: number,
  containerH: number,
  intrinsicW: number,
  intrinsicH: number
): Rect {
  if (!containerW || !containerH || !intrinsicW || !intrinsicH) return EMPTY_RECT;
  const scale = Math.min(containerW / intrinsicW, containerH / intrinsicH);
  const width = intrinsicW * scale;
  const height = intrinsicH * scale;
  return {
    left: (containerW - width) / 2,
    top: (containerH - height) / 2,
    width,
    height,
  };
}

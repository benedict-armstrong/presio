// Shared types and geometry helpers for the slide annotation layer (laser
// pointer, drawing tools). Coordinates are normalized to the *slide content
// rect* — the letterboxed area the PDF page actually occupies inside its
// container — so a point means the same spot on every screen size.

export type Tool = "none" | "laser";

export interface LaserPoint {
  x: number;
  y: number;
}

export interface ContentRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Contain-fit a page of the given aspect ratio (w/h) into a container box,
// centered — mirroring what `object-fit: contain` does to the slide canvas.
export function contentRectFor(
  containerWidth: number,
  containerHeight: number,
  aspect: number
): ContentRect {
  if (containerWidth <= 0 || containerHeight <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { left: 0, top: 0, width: containerWidth, height: containerHeight };
  }
  const width = Math.min(containerWidth, containerHeight * aspect);
  const height = width / aspect;
  return {
    left: (containerWidth - width) / 2,
    top: (containerHeight - height) / 2,
    width,
    height,
  };
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

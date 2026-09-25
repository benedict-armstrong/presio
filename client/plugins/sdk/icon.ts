// Presio's own icons (Lucide, ISC) as inline SVG, for plugins drawn in plain DOM.

/** An icon's inner SVG markup (paths, circles) as a 24×24 Lucide-style icon. */
export function svgIcon(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

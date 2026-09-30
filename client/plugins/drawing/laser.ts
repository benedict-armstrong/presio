// The laser: a dot that follows the pointer (a mouse's even hovering), or a
// fading line drawn while pressed. "l" carries { x, y, s: size, t: 1 for the
// line }; null hides it.

import type { LaserStyle } from "./palette";
import type { PageBox } from "./layers";
import { REFERENCE_WIDTH } from "./model";
import { LaserTrail } from "./trail";

// How long a viewer keeps showing a laser dot that stopped moving (covers a
// lost "hide").
const LASER_HIDE_MS = 3000;

const laserSizeOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(48, Math.max(4, v)) : 16);

export const laserStyle = (): LaserStyle => ({
  size: laserSizeOf(presio.settings.get("laserSize")),
  trail: presio.settings.get("laserTrail") === true,
});

export class Laser {
  private dot: HTMLElement;
  private page: PageBox;
  private presenter: boolean;
  private schedule: () => void;
  private trail: LaserTrail;
  /** The presenter's laser, and what of it was last sent. */
  private at: { x: number; y: number } | null = null;
  private sent: { x: number; y: number } | null = null;
  private size = 16;
  // Whether the presenter's laser is drawing a line now, rather than the dot.
  private line = false;
  // A viewer's dot glides from where it is to each new position over about
  // the time between updates, so a 60 Hz stream reads as motion, not steps.
  private remote: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; at: number } | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteTrail = false;

  constructor(dot: HTMLElement, trailCanvas: HTMLCanvasElement, page: PageBox, presenter: boolean, schedule: () => void) {
    this.dot = dot;
    this.page = page;
    this.presenter = presenter;
    this.schedule = schedule;
    this.trail = new LaserTrail(trailCanvas, () => ({ w: page.w, h: page.h, resolution: window.devicePixelRatio || 1 }));
  }

  /** Whether the presenter's laser is showing. */
  get active() {
    return !!this.at;
  }

  private sizeDot(size: number) {
    const d = Math.max(6, (size / REFERENCE_WIDTH) * this.page.w);
    Object.assign(this.dot.style, { width: `${d}px`, height: `${d}px`, margin: `${-d / 2}px 0 0 ${-d / 2}px` });
  }

  private show(x: number, y: number) {
    this.dot.hidden = false;
    this.dot.style.transform = `translate(${x * this.page.w}px, ${y * this.page.h}px)`;
  }

  /** The presenter's laser, once a frame. */
  send() {
    const laser = this.at;
    if (!laser || (this.sent && this.sent.x === laser.x && this.sent.y === laser.y)) return;
    this.sent = laser;
    const { size } = laserStyle();
    presio.send("l", { x: Math.round(laser.x * 1e4) / 1e4, y: Math.round(laser.y * 1e4) / 1e4, s: size, ...(this.line && { t: 1 }) }, { volatile: true });
  }

  hide() {
    this.dot.hidden = true;
    if (this.presenter && (this.at || this.sent)) presio.send("l", null);
    if (this.at) this.trail.push(null);
    this.at = null;
    this.sent = null;
  }

  /** The presenter's laser at (x, y): the dot, or the line. */
  move(x: number, y: number, line: boolean) {
    if (this.line !== line && this.at) {
      if (this.line) this.trail.push(null);
      this.sent = null;
    }
    this.line = line;
    this.at = { x, y };
    const { size } = laserStyle();
    if (line) {
      this.dot.hidden = true;
      this.trail.push({ x, y, size });
    } else {
      this.sizeDot(size);
      this.show(x, y);
    }
    this.schedule();
  }

  /** A viewer's dot, a frame on its way; whether it has further to go. */
  glide() {
    const r = this.remote;
    if (!r) return false;
    const k = Math.min(1, (performance.now() - r.t0) / r.dur);
    this.show(r.fx + (r.tx - r.fx) * k, r.fy + (r.ty - r.fy) * k);
    return k < 1;
  }

  /** The presenter's laser, as a viewer receives it. */
  receive(payload: unknown) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const p = payload as { x?: unknown; y?: unknown; s?: unknown; t?: unknown } | null;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
      this.remote = null;
      this.dot.hidden = true;
      if (this.remoteTrail) this.trail.push(null);
      this.remoteTrail = false;
      return;
    }
    const size = laserSizeOf(p.s);
    if (p.t === 1) {
      this.remote = null;
      this.dot.hidden = true;
      this.remoteTrail = true;
      this.trail.push({ x: p.x, y: p.y, size });
      return;
    }
    if (this.remoteTrail) this.trail.push(null);
    this.remoteTrail = false;
    if (size !== this.size) this.sizeDot((this.size = size));
    const now = performance.now();
    const prev = this.remote;
    const k = prev ? Math.min(1, (now - prev.t0) / prev.dur) : 1;
    const fx = prev && !this.dot.hidden ? prev.fx + (prev.tx - prev.fx) * k : p.x;
    const fy = prev && !this.dot.hidden ? prev.fy + (prev.ty - prev.fy) * k : p.y;
    const dur = prev ? Math.min(60, Math.max(8, now - prev.at)) : 16;
    this.remote = { fx, fy, tx: p.x, ty: p.y, t0: now, dur, at: now };
    this.hideTimer = setTimeout(() => {
      this.remote = null;
      this.dot.hidden = true;
    }, LASER_HIDE_MS);
    this.schedule();
  }
}

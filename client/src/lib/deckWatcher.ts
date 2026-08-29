// Watching a presentation's deck file on disk for recompiles, via the File
// System Access API (Chromium only). Someone iterating with Typst or latexmk
// rebuilds the same PDF dozens of times; the watcher notices and the
// controller offers the new version with one click. Detection is deliberately
// separate from applying: nothing swaps until the presenter acts.
//
// There is no change event in the platform, so the file is polled for its
// modification time + size (metadata only, never a read). Because those tools
// rewrite the file in place, a poll can land mid-write — a candidate change
// must hold steady across two consecutive polls and then parse successfully
// before it is reported. A parse failure means the write probably isn't done:
// keep waiting silently.

import { getDocument } from "pdfjs-dist";
import "@/lib/pdf"; // ensure the pdf.js worker is configured before parsing

// lib.dom.d.ts stops short of the picker / permission / drag-drop surface of
// the File System Access API; declare the pieces used here. They are optional
// so unsupported browsers fail soft (the `in window` check gates everything).
declare global {
  interface FileSystemHandle {
    queryPermission?(descriptor?: { mode: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission?(descriptor?: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  }
  interface Window {
    showOpenFilePicker?(options?: {
      types?: readonly { description?: string; accept: Record<string, readonly string[]> }[];
      excludeAcceptAllOption?: boolean;
      multiple?: boolean;
    }): Promise<FileSystemFileHandle[]>;
  }
  interface DataTransferItem {
    getAsFileSystemHandle?(): Promise<FileSystemHandle | null>;
  }
}

// Shared picker options so every PDF pick (create, replace) can capture a
// handle where the platform allows it.
export const PDF_PICKER_OPTIONS = {
  types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
  // Without this the picker still offers an "All Files" filter, and a
  // non-PDF pick would skip the type check the drop path does and only fail
  // deep inside pdf.js.
  excludeAcceptAllOption: true,
  multiple: false,
} as const;

export function isDeckWatchSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

export type DeckWatchStatus = "watching" | "updated" | "needs-permission" | "stopped";

/**
 * What the presenter wants watching to do for this deck.
 *
 *  - `off`    — don't look at the file at all.
 *  - `prompt` — watch, and ask before swapping the new version in (the default:
 *               a deck changing under a live audience is never automatic).
 *  - `auto`   — watch and apply every recompile as it lands. For rehearsing
 *               against a build loop, where the confirmation is just friction.
 */
export type DeckWatchMode = "off" | "prompt" | "auto";

export const DECK_WATCH_MODES: DeckWatchMode[] = ["off", "prompt", "auto"];

export function isDeckWatchMode(value: unknown): value is DeckWatchMode {
  return value === "off" || value === "prompt" || value === "auto";
}

/** The mode after clicking the control: off -> prompt -> auto -> off. */
export function nextDeckWatchMode(mode: DeckWatchMode): DeckWatchMode {
  return mode === "off" ? "prompt" : mode === "prompt" ? "auto" : "off";
}

export interface FileMeta {
  lastModified: number;
  size: number;
}

const POLL_MS = 2000;

// How many times a steady-but-unparseable candidate is retried before it is
// written off. A tool rewriting the file in place resolves within a poll or
// two; a file that is simply not a valid PDF never will, and re-reading and
// re-parsing it every POLL_MS for the rest of a talk is pure waste.
const MAX_PARSE_ATTEMPTS = 10;

export class DeckWatcher {
  private handle: FileSystemFileHandle;
  private callbacks: {
    onStatus: (status: DeckWatchStatus) => void;
    onUpdate: () => void;
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  // Permanently dead (file gone or watcher stopped) — no resume is possible.
  private dead = false;
  // A poll's metadata read + parse can outlast one interval; never overlap.
  private busy = false;
  // Last metadata reported as applied — the "unchanged" reference point.
  private baseline: FileMeta | null = null;
  // First sighting of a change, waiting for a second poll to confirm it held.
  private candidate: FileMeta | null = null;
  // Failed parses of the current candidate (see MAX_PARSE_ATTEMPTS).
  private parseAttempts = 0;

  constructor(
    handle: FileSystemFileHandle,
    callbacks: {
      onStatus: (status: DeckWatchStatus) => void;
      onUpdate: () => void;
    }
  ) {
    this.handle = handle;
    this.callbacks = callbacks;
  }

  /** Start watching if access is already granted; otherwise surface
   * needs-permission so the UI can offer an explicit resume. The handle
   * survives a reload but the grant usually doesn't, and re-granting needs a
   * user gesture — begin() runs from an effect, so it must never prompt. */
  async begin(): Promise<void> {
    if (this.dead) return;
    const permission = await this.queryPermission().catch(() => "denied");
    if (this.dead) return;
    if (permission !== "granted") {
      this.callbacks.onStatus("needs-permission");
      return;
    }
    this.startPolling();
  }

  /** Re-grant access and start watching. Must be called from a click handler:
   * requestPermission() only prompts inside a user gesture. */
  async resume(): Promise<void> {
    if (this.dead || this.polling) return;
    // Call requestPermission synchronously so the gesture is still valid.
    const request = this.handle.requestPermission?.({ mode: "read" });
    if (!request) return;
    try {
      const permission = await request;
      if (this.dead || this.polling) return;
      if (permission === "granted") this.startPolling();
    } catch {
      // Denied or the prompt failed: stay in needs-permission.
    }
  }

  stop(): void {
    this.dead = true;
    this.stopPolling();
  }

  /**
   * Read the watched file for applying. The `File` seen at detection time is
   * only a reference to what was on disk then, so by the time the presenter
   * clicks the pill a watch-mode build has usually rewritten it and reading
   * those bytes throws. Re-reading here is the only way to get bytes that are
   * still valid, and it hands over what is genuinely on disk *now*.
   *
   * Returns null while a write is still in flight (unreadable or unparseable),
   * so the caller can leave the update pending rather than failing the swap.
   * The caller confirms with `adopt()` once the replace actually took — a
   * failed replace must not move the reference point.
   */
  async takeUpdate(): Promise<{ file: File; meta: FileMeta } | null> {
    if (this.dead) return null;
    try {
      const file = await this.handle.getFile();
      const meta = { lastModified: file.lastModified, size: file.size };
      const doc = await getDocument({ data: await file.arrayBuffer() }).promise;
      doc.destroy();
      return { file, meta };
    } catch {
      return null;
    }
  }

  /** Adopt the metadata of a file that was actually applied as the new
   * reference point, so the just-swapped version isn't offered again. */
  adopt(meta: FileMeta): void {
    this.baseline = meta;
    this.candidate = null;
    this.parseAttempts = 0;
  }

  private startPolling(): void {
    if (this.dead || this.polling) return;
    this.polling = true;
    this.callbacks.onStatus("watching");
    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_MS);
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async queryPermission(): Promise<PermissionState> {
    return (await this.handle.queryPermission?.({ mode: "read" })) ?? "denied";
  }

  private async poll(): Promise<void> {
    if (!this.polling || this.dead || this.busy) return;
    this.busy = true;
    try {
      if ((await this.queryPermission()) !== "granted") {
        // The grant lapsed mid-session: stop and ask for an explicit resume
        // rather than polling without access.
        this.stopPolling();
        this.callbacks.onStatus("needs-permission");
        return;
      }

      let file: File;
      try {
        file = await this.handle.getFile();
      } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") {
          // The file was moved or deleted; watching cannot continue.
          this.stop();
          this.callbacks.onStatus("stopped");
        }
        // Anything else (transient FS trouble): skip this round and retry.
        return;
      }

      const meta = { lastModified: file.lastModified, size: file.size };
      if (!this.baseline) {
        // First observation after starting (or after a reset): adopt it as
        // the reference point, never report it as a change.
        this.baseline = meta;
        this.candidate = null;
        return;
      }
      if (meta.lastModified === this.baseline.lastModified && meta.size === this.baseline.size) {
        this.candidate = null;
        this.parseAttempts = 0;
        return;
      }

      // The file changed. Require the new size+mtime to hold steady across
      // two consecutive polls before trusting it (in-place rewrites).
      if (
        !this.candidate ||
        this.candidate.lastModified !== meta.lastModified ||
        this.candidate.size !== meta.size
      ) {
        this.candidate = meta;
        this.parseAttempts = 0;
        return;
      }

      // Steady for two polls — parse before believing it. A failure means the
      // document is truncated or not yet complete: keep waiting, no error.
      // After MAX_PARSE_ATTEMPTS, write this version off and treat it as the
      // reference point; it isn't a deck, and a later edit gets a fresh chance.
      try {
        const doc = await getDocument({ data: await file.arrayBuffer() }).promise;
        doc.destroy();
      } catch {
        if (++this.parseAttempts >= MAX_PARSE_ATTEMPTS) {
          this.baseline = meta;
          this.candidate = null;
          this.parseAttempts = 0;
        }
        return;
      }

      this.baseline = meta;
      this.candidate = null;
      this.parseAttempts = 0;
      // The File read here is deliberately not handed over: it will very
      // likely be stale by the time the presenter clicks. See takeUpdate().
      this.callbacks.onUpdate();
    } finally {
      this.busy = false;
    }
  }
}

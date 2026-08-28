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
      types?: { description?: string; accept: Record<string, string[]> }[];
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
  multiple: false,
};

export function isDeckWatchSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

export type DeckWatchStatus = "watching" | "updated" | "needs-permission" | "stopped";

interface FileMeta {
  lastModified: number;
  size: number;
}

const POLL_MS = 2000;

export class DeckWatcher {
  private handle: FileSystemFileHandle;
  private callbacks: {
    onStatus: (status: DeckWatchStatus) => void;
    onUpdate: (file: File) => void;
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

  constructor(
    handle: FileSystemFileHandle,
    callbacks: {
      onStatus: (status: DeckWatchStatus) => void;
      onUpdate: (file: File) => void;
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

  /** Forget the known file metadata, e.g. right after the deck was replaced.
   * The swap itself rewrites the file; without this the watcher would
   * immediately re-detect the just-applied version as another update. */
  resetBaseline(): void {
    this.baseline = null;
    this.candidate = null;
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
        return;
      }

      // Steady for two polls — parse before believing it. A failure means the
      // document is truncated or not yet complete: keep waiting, no error.
      try {
        const doc = await getDocument({ data: await file.arrayBuffer() }).promise;
        doc.destroy();
      } catch {
        return;
      }

      this.baseline = meta;
      this.candidate = null;
      this.callbacks.onUpdate(file);
    } finally {
      this.busy = false;
    }
  }
}

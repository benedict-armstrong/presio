// Remote republish watching for URL-backed decks. A deck loaded from an
// external link re-fetches its PDF on every load, so a republish at the same
// URL is only invisible to a session that is already running. The controller
// polls the server's cheap metadata endpoint (one poller per session — viewers
// never poll) and, when the remote file provably changed, offers the new deck
// through the header pill. Same house rule as the file watcher (DeckWatcher):
// nothing swaps until the presenter clicks, and nothing surfaces when the host
// is unreachable or doesn't support the check.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { destroyPdf, loadLatestPdf } from "./pdf";

const BASE_MS = 30_000;
const MAX_MS = 4 * 60_000;

interface Sig {
  etag: string;
  lastModified: string;
  contentLength: string;
}
const same = (a: Sig, b: Sig) =>
  a.etag === b.etag && a.lastModified === b.lastModified && a.contentLength === b.contentLength;
const hasValidators = (s: Sig) => !!(s.etag || s.lastModified || s.contentLength);

export interface RemoteDeckPollerOptions {
  /** The session whose remote-version endpoint to poll. */
  id: string;
  /** The deck's external URL, re-downloaded to confirm a change. */
  url: string;
  /** Controller auth headers; a throw means there's nothing to poll with. */
  auth: () => Promise<Record<string, string>>;
  /** A confirmed republish, already downloaded and parsed. Owned by the callee. */
  onChange: (doc: PDFDocumentProxy) => void;
}

export class RemoteDeckPoller {
  private stopped = false;
  private busy = false; // a poll's probes + parse can outlast one interval; never overlap
  private backedOff = false; // parked at the slow cadence by an unreachable host
  private delay = BASE_MS;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private baseline: Sig | null = null;
  private candidate: Sig | null = null;
  private readonly opts: RemoteDeckPollerOptions;

  constructor(opts: RemoteDeckPollerOptions) {
    this.opts = opts;
  }

  start() {
    this.schedule();
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.poll(); }, this.delay);
  }

  private async poll() {
    if (this.stopped || this.busy) return;
    // Frozen background tabs can't present anyway; skip the round without
    // spending a request on the remote host.
    if (document.hidden) {
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      await this.probe();
    } finally {
      this.busy = false;
    }
  }

  private async probe() {
    let headers: Record<string, string>;
    try {
      headers = await this.opts.auth();
    } catch {
      this.stop(); // no credential to poll with — degrade silently
      return;
    }
    let sig: Sig;
    try {
      const res = await fetch(`/api/sessions/${this.opts.id}/remote-version`, { headers });
      if (res.status === 403 || res.status === 404) {
        this.stop(); // session gone, or not URL-backed: nothing to watch
        return;
      }
      if (!res.ok) {
        // Remote host unreachable (the server answers 502): back off to the
        // slowest cadence and keep trying, still silently.
        this.delay = MAX_MS;
        this.backedOff = true;
        this.schedule();
        return;
      }
      sig = await res.json();
      if (this.backedOff) {
        // The host answered again. Without this the session stays parked at
        // the four-minute cadence for good, since only a confirmed change
        // resets it — and it can't see one while the host is down.
        this.backedOff = false;
        this.delay = BASE_MS;
      }
    } catch {
      this.stop(); // network failure — today's behaviour, without errors
      return;
    }
    if (!hasValidators(sig)) {
      this.stop(); // host sends no validators — there is nothing to compare
      return;
    }
    if (!this.baseline) {
      this.baseline = sig; // first observation is the reference, never a change
      this.schedule();
      return;
    }
    if (same(sig, this.baseline)) {
      this.candidate = null;
      this.delay = Math.min(this.delay * 2, MAX_MS); // polite backoff while unchanged
      this.schedule();
      return;
    }
    // Different from the baseline. Hosts behind some CDNs mint a fresh ETag
    // per request, so require the new signature to hold steady across two
    // consecutive polls before trusting it.
    if (!this.candidate || !same(sig, this.candidate)) {
      this.candidate = sig;
      this.schedule();
      return;
    }
    // Confirmed change: read the new document's page count before offering
    // it, so applying clamps correctly. A parse failure means the publish is
    // probably mid-flight — keep watching silently and re-detect on the next
    // poll.
    this.candidate = null;
    try {
      // Always external here: the server only answers remote-version for a
      // deck backed by someone else's URL.
      const doc = await loadLatestPdf(this.opts.url, { external: true, version: Date.now() });
      if (this.stopped) {
        destroyPdf(doc);
        return;
      }
      this.baseline = sig;
      this.delay = BASE_MS; // stay fast for a while after a real change
      this.opts.onChange(doc);
    } catch {
      // candidate stays null: the next poll re-confirms and retries.
    }
    this.schedule();
  }
}

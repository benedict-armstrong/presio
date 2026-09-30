// Retained plugin messages (presio.send with { retain }): the latest message
// of each type, kept for devices that join later. On the presenter's device
// they're also saved per session, so they outlive a reload of the page.

import { lsGet, lsRemove, lsSet, pluginRetainedKey } from "@/lib/storage";
import { fitsRetainedBudget, jsonBytes, retainKey } from "@shared/pluginProtocol";
import type { WireEvent } from "./protocol";

/** How long retained changes wait before the presenter's copy is saved. */
const PERSIST_DELAY_MS = 300;

export class RetainedStore {
  private events = new Map<string, WireEvent>();
  // Each retained payload's size (JSON), for the per-plugin budget.
  private sizes = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whose copy this is: only the presenter's is saved, under its session. */
  private readonly owner: () => { presenter: boolean; sessionId: string };

  constructor(owner: () => { presenter: boolean; sessionId: string }) {
    this.owner = owner;
    // The presenter's retained messages are the plugins' shared state (what's
    // playing, what's showing), and after a server restart they're what the
    // session is re-seeded from.
    const { presenter, sessionId } = owner();
    if (!presenter) return;
    const saved = lsGet<unknown>(pluginRetainedKey(sessionId), []);
    for (const event of Array.isArray(saved) ? saved : []) {
      const e = event as Partial<WireEvent>;
      if (typeof e?.plugin === "string" && typeof e.type === "string" && e.payload !== undefined) {
        this.keep({ plugin: e.plugin, type: e.type, payload: e.payload, retain: e.retain === "deck" ? "deck" : true, from: "presenter" });
      }
    }
    // Restoring isn't a change to save.
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  /**
   * Keep (or, for a null payload, forget) a retained message, within the
   * plugin's budget. Returns whether it's kept. Over budget, the message still
   * goes out live; it just isn't there for devices that join later.
   */
  keep(event: WireEvent): boolean {
    const key = retainKey(event);
    if (event.payload === null) {
      this.events.delete(key);
      this.sizes.delete(key);
      this.schedulePersist();
      return false;
    }
    const size = jsonBytes(event.payload);
    const sizes = [...this.events].map(([k, e]): [string, { plugin: string; size: number }] => [
      k,
      { plugin: e.plugin, size: this.sizes.get(k) ?? 0 },
    ]);
    if (!fitsRetainedBudget(sizes, { key, plugin: event.plugin, size })) {
      console.warn(`Plugin "${event.plugin}" is over its retained budget; "${event.type}" won't reach late joiners`);
      return false;
    }
    this.events.set(key, { plugin: event.plugin, type: event.type, payload: event.payload, retain: event.retain || true, from: "presenter" });
    this.sizes.set(key, size);
    this.schedulePersist();
    return true;
  }

  /** The deck was replaced: forget what was retained for it (retain: "deck"). */
  forgetDeck() {
    for (const [key, event] of this.events) {
      if (event.retain !== "deck") continue;
      this.events.delete(key);
      this.sizes.delete(key);
    }
    this.schedulePersist();
  }

  all(): WireEvent[] {
    return [...this.events.values()];
  }

  /** Save now if a change is waiting (the page is going). Only this store's
   *  own changes — one that never changed anything (React may build a host
   *  it then discards) mustn't overwrite what another saved. */
  flush() {
    if (this.persistTimer) this.persist();
  }

  private schedulePersist() {
    if (!this.owner().presenter || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DELAY_MS);
  }

  private persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const { presenter, sessionId } = this.owner();
    if (!presenter) return;
    const key = pluginRetainedKey(sessionId);
    const events = [...this.events.values()].map(({ plugin, type, payload, retain }) => ({ plugin, type, payload, retain }));
    if (events.length) lsSet(key, events);
    else lsRemove(key);
  }
}

/** A deck replaced while its presenter's page wasn't open (from Home): forget
 *  the retained messages saved for it that belonged to the old deck. */
export function forgetDeckRetained(sessionId: string) {
  const key = pluginRetainedKey(sessionId);
  const saved = lsGet<unknown>(key, []);
  if (!Array.isArray(saved)) return;
  const kept = saved.filter((e) => (e as Partial<WireEvent>)?.retain !== "deck");
  if (kept.length) lsSet(key, kept);
  else lsRemove(key);
}


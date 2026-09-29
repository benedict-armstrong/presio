// A local deck's plugins between this browser's windows: the presenter's and
// its viewer window talk over a BroadcastChannel instead of the server.

import type { PluginHost } from "./host";
import type { HistoryEntry, SyncReply } from "./history";
import type { WireEvent } from "./protocol";

/** Everything the windows say to each other on the channel. */
type ChannelMessage =
  /** A plugin message, either way. */
  | { kind: "event"; event: WireEvent }
  /** Viewer → presenter: send me the retained messages. */
  | { kind: "hello" }
  | { kind: "retained"; events: WireEvent[] }
  /** Presenter → viewer: an edit it ordered. */
  | { kind: "history_entry"; plugin: string; entry: HistoryEntry }
  /** Presenter → viewer: the plugin's history starts afresh. */
  | { kind: "history_reset"; plugin: string }
  /** Presenter → viewer: its copy of the history has loaded; catch up. */
  | { kind: "history_loaded"; plugin: string }
  /** Viewer → presenter: what's missing after this head? */
  | { kind: "history_sync"; reqId: number; plugin: string; head: { seq: number; hash: string } }
  | { kind: "history_sync_reply"; reqId: number; reply: SyncReply };

/** How long the viewer window waits on the presenter's for a history. */
const SYNC_TIMEOUT_MS = 5000;

/** Connect a local deck's host to its other windows; returns the disconnect. */
export function connectLocalChannel(host: PluginHost, id: string, isPresenter: boolean): () => void {
  const channel = new BroadcastChannel(`presio-plugins-${id}`);
  const post = (m: ChannelMessage) => channel.postMessage(m);
  host.setOutbound((event) => post({ kind: "event", event }));
  // Histories: the presenter's window orders edits and passes each on; the
  // viewer window asks it for what it's missing (blobs it reads itself, from
  // this browser's IndexedDB).
  const syncs = new Map<number, (reply: SyncReply) => void>();
  let nextSync = 1;
  host.history.setLink(
    isPresenter
      ? {
          ordersHere: true,
          publish: (plugin, entry) => post({ kind: "history_entry", plugin, entry }),
          reset: (plugin) => post({ kind: "history_reset", plugin }),
          loaded: (plugin) => post({ kind: "history_loaded", plugin }),
        }
      : {
          sync: (plugin, head) =>
            new Promise<SyncReply>((resolve, reject) => {
              const reqId = nextSync++;
              const timer = setTimeout(() => {
                syncs.delete(reqId);
                reject(new Error("the presenter's window didn't answer"));
              }, SYNC_TIMEOUT_MS);
              syncs.set(reqId, (reply) => {
                clearTimeout(timer);
                syncs.delete(reqId);
                resolve(reply);
              });
              post({ kind: "history_sync", reqId, plugin, head });
            }),
        },
    true
  );
  channel.onmessage = (e: MessageEvent<ChannelMessage | null>) => {
    const m = e.data;
    if (!m) return;
    switch (m.kind) {
      case "event":
        host.receive(m.event);
        break;
      case "retained":
        host.seedRetained(m.events);
        break;
      case "hello":
        if (isPresenter) post({ kind: "retained", events: host.retainedEvents() });
        break;
      case "history_entry":
        if (!isPresenter) host.history.receive(m.plugin, m.entry);
        break;
      case "history_reset":
        if (!isPresenter) host.history.receiveReset(m.plugin);
        break;
      case "history_loaded":
        if (!isPresenter) host.history.receiveLoaded(m.plugin);
        break;
      case "history_sync":
        if (isPresenter) post({ kind: "history_sync_reply", reqId: m.reqId, reply: host.history.answerSync(m.plugin, m.head) });
        break;
      case "history_sync_reply":
        if (!isPresenter) syncs.get(m.reqId)?.(m.reply);
        break;
    }
  };
  if (!isPresenter) post({ kind: "hello" });
  return () => {
    channel.close();
    host.setOutbound(() => {});
    host.history.setLink({}, false);
  };
}

// Plugin frames' requests (presio.deck, presio.settings, presio.blobs): what
// each asks of the app, checked against the plugin's permissions and role.

import type { PdfAttachment } from "@/lib/pdf";
import { sanitizeSettingValue, setPluginSetting } from "@/lib/settings";
import { MAX_BLOB_BYTES } from "@shared/limits";
import { SHA256_RE } from "@shared/pluginProtocol";
import type { HistoryHub } from "./history";
import type { PluginManifest, PluginPermission } from "./manifest";
import type { PageSize, PluginRole } from "./protocol";
import { asRecord } from "./sanitize";

/** What answering needs of the host. */
export interface RequestEnv {
  role: PluginRole;
  attachments: () => Promise<PdfAttachment[]>;
  deckBytes: () => Promise<Uint8Array | null>;
  pageSizes: () => Promise<PageSize[]>;
  /** How an edited deck is saved; null where this device can't. */
  saveDeck: ((bytes: Uint8Array) => Promise<void>) | null;
  history: HistoryHub;
}

export interface Reply {
  result: unknown;
  error?: string;
}

const reply = (result: unknown, error?: string): Reply => ({ result, error });

interface RequestSpec {
  /** The manifest permission it needs, and what to say without it. */
  permission?: { name: PluginPermission; missing: string };
  /** Only the presenter's frames may ask; what to say to anyone else. */
  presenterOnly?: string;
  run: (env: RequestEnv, a: Record<string, unknown>, manifest: PluginManifest) => Promise<Reply> | Reply;
}

const READS_DECK = { name: "deck", missing: 'Reading the deck needs the "deck" permission in presio-plugin.json' } as const;
const USES_BLOBS = { name: "history", missing: 'Blobs need the "history" permission in presio-plugin.json' } as const;

/** Every request a frame can make, by kind. */
const REQUESTS: Record<string, RequestSpec> = {
  attachments: {
    permission: READS_DECK,
    run: async (env) => {
      try {
        // Copies, so a plugin can't mutate the bytes the app itself renders from.
        const list = await env.attachments();
        return reply(list.map(({ filename, content }) => ({ filename, bytes: content.slice() })));
      } catch {
        return reply(null, "Couldn't read the deck's attachments");
      }
    },
  },
  deckBytes: {
    permission: READS_DECK,
    run: async (env) => {
      try {
        const bytes = await env.deckBytes();
        if (!bytes) return reply(null, "The deck hasn't loaded yet");
        return reply(bytes.slice());
      } catch {
        return reply(null, "Couldn't read the deck");
      }
    },
  },
  pages: {
    permission: READS_DECK,
    run: async (env) => {
      try {
        return reply(await env.pageSizes());
      } catch {
        return reply(null, "Couldn't read the deck's pages");
      }
    },
  },
  saveDeck: {
    permission: { name: "editDeck", missing: 'Saving the deck needs the "editDeck" permission in presio-plugin.json' },
    presenterOnly: "The deck can't be edited from here",
    run: async (env, a) => {
      if (!env.saveDeck) return reply(null, "The deck can't be edited from here");
      if (!(a.bytes instanceof Uint8Array)) return reply(null, "save() takes the PDF as a Uint8Array");
      try {
        await env.saveDeck(a.bytes);
        return reply(null);
      } catch (e) {
        return reply(null, e instanceof Error ? e.message : "Couldn't save the deck");
      }
    },
  },
  setSetting: {
    presenterOnly: "Only the presenter can change settings",
    run: (_env, a, manifest) => {
      const spec = typeof a.name === "string" ? manifest.contributes.settings[a.name] : undefined;
      if (!spec) return reply(null, `No setting "${String(a.name)}" in presio-plugin.json`);
      if (sanitizeSettingValue(spec, a.value) === undefined) return reply(null, `Invalid value for "${a.name as string}"`);
      setPluginSetting(manifest.id, a.name as string, spec, a.value);
      return reply(null);
    },
  },
  blobPut: {
    permission: USES_BLOBS,
    run: async (env, a) => {
      const data = a.data;
      const blob =
        data instanceof Blob ? data
        : data instanceof Uint8Array || data instanceof ArrayBuffer ? new Blob([data as BlobPart])
        : null;
      if (!blob) return reply(null, "blobs.put() takes a Blob, a Uint8Array or an ArrayBuffer");
      if (blob.size > MAX_BLOB_BYTES) return reply(null, `A blob is at most ${MAX_BLOB_BYTES / 1024 / 1024} MB`);
      try {
        return reply(await env.history.putBlob(blob));
      } catch (e) {
        return reply(null, e instanceof Error ? e.message : "Couldn't keep the blob");
      }
    },
  },
  blobGet: {
    permission: USES_BLOBS,
    run: async (env, a) => {
      if (typeof a.sha !== "string" || !SHA256_RE.test(a.sha)) return reply(null, "blobs.get() takes a blob's hash");
      return reply(await env.history.getBlob(a.sha));
    },
  },
};

/** Answer one request from a plugin's frame. */
export async function answerRequest(env: RequestEnv, manifest: PluginManifest, kind: unknown, args: unknown): Promise<Reply> {
  const spec = typeof kind === "string" && Object.hasOwn(REQUESTS, kind) ? REQUESTS[kind] : undefined;
  if (!spec) return reply(null, `Unknown request "${String(kind)}"`);
  if (spec.permission && !manifest.permissions.includes(spec.permission.name)) return reply(null, spec.permission.missing);
  if (spec.presenterOnly && env.role !== "presenter") return reply(null, spec.presenterOnly);
  return spec.run(env, asRecord(args), manifest);
}

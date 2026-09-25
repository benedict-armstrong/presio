// The presenter's installed plugins: which exist and which are switched on
// (the "plugins" setting).
//
// A plugin is addressed by the base URL its presio-plugin.json sits under.
// Built-ins ship with the app under /plugins/, and a presenter can add any
// other URL — typically their own dev server while building one. Nothing runs
// until a plugin is both enabled here and activated by the deck on screen.

import { useMemo } from "react";
import { getSetting, setSetting, useSetting, type CoreSettings } from "@/lib/settings";
import { sha256Hex } from "@/lib/analytics";
import { parseManifest, type LoadedPlugin } from "./manifest";

export interface PluginEntry {
  /** Base URL, ending in "/". */
  url: string;
  enabled: boolean;
  builtin: boolean;
}

/** Shipped with the app, by URL, with whether each is on until the presenter
 *  says otherwise. All of them were core before plugins existed. Order is the order plugins' layers stack on a slide (later ones
 *  on top) and downloads pass through them. */
const BUILTINS: Record<string, { enabled: boolean }> = {
  "/plugins/timer/": { enabled: true },
  "/plugins/notes/": { enabled: true },
  "/plugins/media/": { enabled: true },
  "/plugins/drawing/": { enabled: true },
  "/plugins/join-code/": { enabled: true },
};
const BUILTIN_URLS = Object.keys(BUILTINS);

// The "plugins" setting maps URL -> { enabled }. Built-ins appear in it only
// once toggled; everything else is in it because it was added.
function entriesFrom(list: CoreSettings["plugins"]): PluginEntry[] {
  const builtins = BUILTIN_URLS.map((url) => ({
    url,
    enabled: list[url]?.enabled ?? BUILTINS[url].enabled,
    builtin: true,
  }));
  const added = Object.entries(list)
    .filter(([url]) => !BUILTIN_URLS.includes(url))
    .map(([url, { enabled }]) => ({ url, enabled, builtin: false }));
  return [...builtins, ...added];
}

export function usePluginEntries(): PluginEntry[] {
  const [list] = useSetting("plugins");
  return useMemo(() => entriesFrom(list), [list]);
}

export function setPluginEnabled(url: string, enabled: boolean) {
  setSetting("plugins", { ...getSetting("plugins"), [url]: { enabled } });
}

export function removePlugin(url: string) {
  const list = { ...getSetting("plugins") };
  delete list[url];
  setSetting("plugins", list);
}

/**
 * Normalize a presenter-entered plugin location to a base URL, or throw.
 * https anywhere; plain http on this machine for a dev server, or anywhere
 * when Presio itself is on http (a local deployment, where a LAN address lets
 * phones reach the dev server too — an https page couldn't load it at all).
 */
export function normalizePluginUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a full URL, e.g. http://localhost:5174/");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const httpOk = loopback || window.location.protocol === "http:";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && httpOk)) {
    throw new Error("Plugin URLs must be https (or http on localhost)");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/presio-plugin\.json$/, "");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/** Add (and enable) a plugin after checking its manifest loads. Returns the
 *  plugin and the base URL it's now listed under. */
export async function addPlugin(input: string): Promise<{ url: string; plugin: LoadedPlugin }> {
  const github = parseGitHubSource(input);
  const url = github ? await gitHubPluginUrl(github) : normalizePluginUrl(input);
  let plugin: LoadedPlugin;
  try {
    plugin = await loadPlugin(url);
  } catch (e) {
    if (!github || !(e instanceof Error)) throw e;
    const where = github.path ? `${github.path}/` : "the repo's root";
    throw new Error(`${e.message}. Is presio-plugin.json at ${where}, in a public repo?`, { cause: e });
  }
  setPluginEnabled(url, true);
  return { url, plugin };
}

// --- Plugins on GitHub ---
//
// A plugin is just a repo: "github:owner/repo" (or its github.com link) is
// served by jsDelivr, which — unlike raw.githubusercontent.com — serves
// scripts with their real MIME type and CORS headers, so plugins split into
// several files work too. GitHub's own release downloads can't be fetched by
// a page at all (no CORS).
//
// The URL is always pinned: to the tag given, else the latest release (or
// tag), else — a branch, or a repo with no tags — the commit it points at
// now. Viewers load the plugin themselves and check it's byte for byte the
// presenter's; a branch URL, cached for hours by the CDN, could hand them a
// different version and they'd go without it.

const JSDELIVR_GH = "https://cdn.jsdelivr.net/gh/";

export interface GitHubSource {
  owner: string;
  repo: string;
  /** Tag, branch or commit; undefined for "the latest". */
  ref?: string;
  /** The plugin's folder in the repo, without slashes at either end ("" for the root). */
  path: string;
}

const NAME = "[A-Za-z0-9_.-]+";

/**
 * A GitHub location for a plugin, or null when the input isn't one:
 * "github:owner/repo[@ref][/path]", a github.com repo or tree/blob link,
 * a raw.githubusercontent.com link or an unpinned jsDelivr one.
 */
export function parseGitHubSource(input: string): GitHubSource | null {
  const text = input.trim();
  const clean = (path: string | undefined) =>
    (path ?? "").replace(/(^|\/)presio-plugin\.json$/, "").replace(/^\/+|\/+$/g, "");
  const shorthand = new RegExp(`^github:(${NAME})/(${NAME})(?:@([^/]+))?(?:/(.*))?$`, "i").exec(text);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, ""), ref: shorthand[3], path: clean(shorthand[4]) };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" && parts.length >= 2) {
    const [owner, repo, kind, ref, ...rest] = parts;
    const tree = kind === "tree" || kind === "blob";
    return { owner, repo: repo.replace(/\.git$/, ""), ref: tree ? ref : undefined, path: tree ? clean(rest.join("/")) : "" };
  }
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 3) {
    // .../owner/repo/<ref>/path, where the ref may be spelled refs/heads/<ref>.
    const [owner, repo, ...rest] = parts;
    if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags")) rest.splice(0, 2);
    const [ref, ...path] = rest;
    return { owner, repo, ref, path: clean(path.join("/")) };
  }
  if (url.hostname === "cdn.jsdelivr.net" && parts[0] === "gh" && parts.length >= 3) {
    const [, owner, repoRef, ...path] = parts;
    const [repo, ref] = repoRef.split("@");
    // Already pinned: use it as given.
    if (ref) return null;
    return { owner, repo, path: clean(path.join("/")) };
  }
  return null;
}

async function gitHubApi<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.github.com/repos/${path}`, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      res.status === 403 || res.status === 429
        ? "GitHub's rate limit was hit looking up the plugin's version; add @<tag> to the URL, or try again later"
        : `Couldn't look up the plugin on GitHub (HTTP ${res.status})`
    );
  }
  return (await res.json()) as T;
}

/** The pinned jsDelivr URL for a plugin on GitHub (see above). */
export async function gitHubPluginUrl(source: GitHubSource): Promise<string> {
  const { owner, repo, path } = source;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let ref = source.ref;
  if (!ref) {
    const release = await gitHubApi<{ tag_name?: string }>(`${slug}/releases/latest`);
    ref = release?.tag_name;
    if (!ref) {
      const tags = await gitHubApi<{ name: string }[]>(`${slug}/tags?per_page=1`);
      ref = tags?.[0]?.name;
    }
    if (!ref) {
      const repoInfo = await gitHubApi<{ default_branch: string }>(slug);
      if (!repoInfo) throw new Error(`No public GitHub repo ${owner}/${repo}`);
      ref = repoInfo.default_branch;
    }
  }
  // A branch moves: pin the commit it's on now. Tags and commits stay put.
  // (Best effort when a ref was given: failing to ask isn't failing to add.)
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    const branch = await gitHubApi<{ commit: { sha: string } }>(`${slug}/branches/${encodeURIComponent(ref)}`).catch((e) => {
      if (source.ref) return null;
      throw e;
    });
    if (branch) ref = branch.commit.sha;
  }
  return `${JSDELIVR_GH}${owner}/${repo}@${ref}/${path ? `${path}/` : ""}`;
}

/** A plugin URL as people read it: "owner/repo@v1.2.0" for one from GitHub. */
export function describePluginUrl(url: string): string {
  const gh = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.*?)\/?$/.exec(url);
  if (gh) {
    const ref = /^[0-9a-f]{40}$/i.test(gh[3]) ? gh[3].slice(0, 7) : gh[3];
    return `${gh[1]}/${gh[2]}@${ref}${gh[4] ? `/${gh[4]}` : ""}`;
  }
  try {
    const u = new URL(url, window.location.href);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Fetch a plugin's manifest and HTML. Always revalidated rather than cached
 * at install: a dev server's plugin should pick up edits on the next load.
 *
 * `expectedHash` is for viewers loading what the presenter published: the
 * plugin only runs if its HTML is the presenter's, byte for byte.
 */
export async function loadPlugin(url: string, expectedHash?: string): Promise<LoadedPlugin> {
  const base = new URL(url, window.location.href);
  const res = await fetch(new URL("presio-plugin.json", base), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't load presio-plugin.json (HTTP ${res.status})`);
  const manifest = parseManifest(await res.json().catch(() => {
    throw new Error("presio-plugin.json isn't valid JSON");
  }));
  const htmlRes = await fetch(new URL(manifest.main, base), { cache: "no-cache" });
  if (!htmlRes.ok) throw new Error(`Couldn't load ${manifest.main} (HTTP ${htmlRes.status})`);
  const html = await htmlRes.text();
  const hash = await sha256Hex(new TextEncoder().encode(html).buffer as ArrayBuffer);
  if (expectedHash && hash !== expectedHash) throw new Error("This plugin changed since the presenter loaded it");
  return { manifest, url, baseUrl: base.href, html, hash };
}

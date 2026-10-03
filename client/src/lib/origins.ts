// The app origin (presio.ch: home, controller, settings, accounts) and the
// viewer origin (viewer.presio.ch: where audiences watch). The server names
// both in <meta> tags on every page (server/app.ts); with no viewer origin
// configured — self-hosting, local mode, plain `npm run dev` — everything runs
// on one origin as before.
//
// Why two: a presenter's plugins run on every audience device. On their own
// origin, they can't reach what Presio keeps in an audience member's browser
// for the app origin — their login, controller tokens for their own decks.
// So the viewer origin must never hold those: taking control from a viewer
// hands over to the app origin (see ViewerView).

import { getSessionAuth } from "@/lib/utils";
import { isLocalDeckId } from "@/lib/localId";

function meta(name: string): string | null {
  const value = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const app = meta("presio-app-origin");
const viewer = meta("presio-viewer-origin");
const here = window.location.origin;

/** Whether this deployment splits the two, and this page is on one of them.
 *  (A dev server reached some third way, e.g. by LAN IP, stays unsplit.) */
const split = !!app && !!viewer && app !== viewer && (here === app || here === viewer);

/** Where audiences join, or null when they use the app origin. */
export const viewerOrigin: string | null = split ? viewer : null;

/** Where everything but watching lives. */
export const appOrigin: string = split ? app! : here;

/** This page is on the viewer origin. */
export const onViewerOrigin = split && here === viewer;

/** `?takeover=1`: a viewer handed over to take control here (ViewerView). */
export const TAKEOVER_PARAM = "takeover";

/**
 * Where this URL belongs, when that isn't here: null to stay. The viewer
 * origin serves only the viewer; the app origin sends audiences to it, but
 * keeps a viewer this browser controls (the presenter's own viewer window, a
 * local deck, a demoted controller) and one handed over to take control.
 */
export function misplacedUrl(path: string, search: string): string | null {
  if (!split) return null;
  const params = new URLSearchParams(search);
  const match = /^\/s\/([^/]+)\/?$/.exec(path);
  const isViewer = !!match && (params.get("role") ?? "viewer") === "viewer";
  if (onViewerOrigin) return isViewer ? null : `${appOrigin}${path}${search}`;
  if (!isViewer || params.has(TAKEOVER_PARAM)) return null;
  const id = decodeURIComponent(match![1]);
  if (isLocalDeckId(id) || getSessionAuth(id).controllerToken) return null;
  return `${viewerOrigin}${path}${search}`;
}

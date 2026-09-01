// Minimal service worker: enough for installability ("save to home screen")
// plus a cached app shell so the client boots offline (local presentations
// already live in IndexedDB). Deliberately conservative — API calls and
// websockets are never intercepted, and the shell is refreshed network-first
// so deploys are picked up on the next load.
//
// The build rewrites the two placeholders below with the real asset list and a
// content-derived id (see `presio-sw-precache` in vite.config.ts). Precaching
// on install rather than on demand is what makes a first-run install usable
// offline: the pdf.js worker is a lazily fetched chunk, so an install-then-go-
// offline would otherwise open the app fine and fail on the first PDF.
const BUILD_ID = "__BUILD_ID__";
const PRECACHE = "__PRECACHE_MANIFEST__";

// Unreplaced (an unbuilt copy) degrades to the old fetch-time caching.
const PRECACHE_URLS = Array.isArray(PRECACHE) ? PRECACHE : [];
const CACHE = `presio-shell-${BUILD_ID}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // One entry at a time: `cache.addAll` is all-or-nothing, and a single
      // 404 would fail the install and leave the app with no offline support
      // at all rather than a partial cache.
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      await self.skipWaiting();
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never touch the API or the socket transport.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;

  // Hashed build assets are immutable: cache-first.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
    );
    return;
  }

  // Navigations (and other shell files like icons): network-first with cache
  // fallback so the app still opens without a connection.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const res = await fetch(request);
          if (res.ok) cache.put("/", res.clone());
          return res;
        } catch {
          return (await cache.match("/")) || Response.error();
        }
      })
    );
    return;
  }

  // Everything else that was precached (icons, the web manifest): serve it
  // from the cache when the network is gone.
  event.respondWith(
    fetch(request).catch(async () => (await caches.match(request)) || Response.error())
  );
});

// Service worker: makes the app installable and keeps the UI shell available
// offline. API calls (/api) and mock platforms are never cached – data always
// comes live from the server.
//
// This file is not content-hashed, so its caches are not tied to a build:
// hashed assets live in their own cache, which is trimmed to the most recently
// stored entries so files of old builds do not pile up after every update.
const SHELL_CACHE = 'sm-shell-v2';
const ASSET_CACHE = 'sm-assets-v1';
const KEEP = [SHELL_CACHE, ASSET_CACHE];
/** About two builds' worth of hashed files; anything evicted is simply fetched again. */
const MAX_ASSETS = 160;
// The app's path: "/" at the root, "/steward/" under a path prefix (SM_BASE_PATH) – the worker's scope.
const BASE = new URL(self.registration.scope).pathname;
const SHELL = [BASE, BASE + 'icon.svg', BASE + 'icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Drops the oldest entries (cache keys are in insertion order). */
async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((k) => cache.delete(k)));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(BASE)) return;
  const path = url.pathname.slice(BASE.length - 1);
  if (path.startsWith('/api/') || path.startsWith('/mock/')) return;

  // Hashed build assets never change: cache first.
  if (path.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSET_CACHE).then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) event.waitUntil(cache.put(req, res.clone()).then(() => trim(cache)));
              return res;
            }),
        ),
      ),
    );
    return;
  }

  // Pages: network first (always the current build's index.html), cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(BASE, copy)));
          }
          return res;
        })
        .catch(() => caches.match(BASE)),
    );
  }
});

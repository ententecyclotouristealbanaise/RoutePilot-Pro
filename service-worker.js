const VERSION = "v2.0.0";
const APP_CACHE = `routepilot-app-${VERSION}`;
const RUNTIME_CACHE = `routepilot-runtime-${VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./routepilot.webmanifest",
  "./routepilot-icon-192.svg",
  "./routepilot-icon-512.svg"
];

const CDN_ASSETS = [
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css",
  "https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js",
  "https://fonts.googleapis.com/css2?family=Outfit:wght@500;700;800&family=DM+Sans:wght@400;500;700&display=swap"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(APP_SHELL);
    await Promise.allSettled(CDN_ASSETS.map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      if (key === APP_CACHE || key === RUNTIME_CACHE) return Promise.resolve(false);
      return caches.delete(key);
    }));
    await self.clients.claim();
  })());
});

function shouldHandle(request) {
  return request.method === "GET" && request.url.startsWith("http");
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch (_e) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return caches.match("./index.html");
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);
  const fetched = fetch(request)
    .then((response) => {
      cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || fetched || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!shouldHandle(request)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

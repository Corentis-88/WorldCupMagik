const CACHE_NAME = "worldcupmagik-v13";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./mobile.html",
  "./how-to-use.html",
  "./styles.css",
  "./mobile.css",
  "./app.js",
  "./mobile-app.js",
  "./manifest.webmanifest",
  "./assets/icon.png",
  "./assets/world-cup-magik-splash.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.endsWith("/data/latest.json")) {
    event.respondWith(networkFirst(event.request, "./data/latest.json"));
    return;
  }

  if (url.pathname.endsWith("/data/mobile-latest.json")) {
    event.respondWith(networkFirst(event.request, "./data/mobile-latest.json"));
    return;
  }

  if (url.pathname.endsWith("/data/lineups-latest.json")) {
    event.respondWith(networkFirst(event.request, "./data/lineups-latest.json"));
    return;
  }

  if (url.pathname.endsWith("/") || /\.(html|js|css|webmanifest)$/i.test(url.pathname)) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  const cache = await caches.open(CACHE_NAME);
  cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheKey = request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request);
    cache.put(cacheKey, response.clone());
    return response;
  } catch {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
    throw new Error("No cached scan is available yet.");
  }
}

const CACHE_NAME = 'simji-pwa-v7';
const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/detail-edit.css',
  '/app.js',
  '/config.js',
  '/manifest.webmanifest',
  '/icons/simji-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('simji-pwa-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  );
  self.clients.claim();
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request, event) {
  const cached = await caches.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok) (await caches.open(CACHE_NAME)).put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(update.catch(() => undefined));
    return cached;
  }
  return update;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate' || url.pathname === '/config.js') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request, event));
});

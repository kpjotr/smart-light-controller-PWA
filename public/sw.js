const CACHE_NAME = 'smart-light-pwa-v1';
const APP_SHELL_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
];

function isFirebaseOrExternalRequest(url) {
  if (url.origin !== self.location.origin) {
    return true;
  }
  const host = url.hostname.toLowerCase();
  return (
    host.endsWith('firebaseio.com') ||
    host.endsWith('firebasedatabase.app') ||
    host.endsWith('googleapis.com') ||
    host.endsWith('gstatic.com') ||
    host.endsWith('firebaseapp.com')
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (isFirebaseOrExternalRequest(url)) {
    return;
  }

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(request, responseClone))
            .catch(() => {});
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) {
          return cached;
        }
        if (request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) {
            return fallback;
          }
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});

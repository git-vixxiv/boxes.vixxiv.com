/**
 * Boxes - Service Worker
 *
 * Network first, cache as the offline fallback. The app is always served
 * fresh when online, so a new release can never be stuck behind an old cache.
 */

const CACHE_NAME = 'boxes-v2';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/styles.css',
    '/db.js',
    '/app.js',
    '/firebase-config.js',
    '/firebase-db.js',
    '/billing-config.js',
    '/entitlement-core.js',
    '/entitlement.js',
    '/analytics.js',
    '/manifest.json',
    '/icons/icon.svg',
    '/icons/icon-192.svg',
    '/icons/logo.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS_TO_CACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    // Only the app's own files; Firebase, Square and analytics go straight out.
    if (new URL(request.url).origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(request, { ignoreSearch: true });
                if (cached) return cached;
                if (request.mode === 'navigate') return caches.match('/index.html');
                return Response.error();
            })
    );
});

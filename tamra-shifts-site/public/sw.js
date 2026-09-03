// Deliberately does not cache anything. Its only job is to exist with a fetch handler, which is
// what lets Chrome/Android treat the site as an installable app (the "add to home screen" /
// install-app prompt). app.js and styles.css already ship with no-store/no-cache headers from the
// server (see serveStatic in lib/server.js) specifically so a redeploy is never masked by a stale
// cache — a caching service worker here would quietly defeat that. Every request just passes
// straight through to the network.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => { event.respondWith(fetch(event.request)); });

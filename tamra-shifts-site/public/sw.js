// Deliberately does not cache anything. Its main job is to exist with a fetch handler, which is
// what lets Chrome/Android treat the site as an installable app (the "add to home screen" /
// install-app prompt), plus (below) the two handlers that make Web Push actually show something
// on screen. app.js and styles.css already ship with no-store/no-cache headers from the
// server (see serveStatic in lib/server.js) specifically so a redeploy is never masked by a stale
// cache — a caching service worker here would quietly defeat that. Every request just passes
// straight through to the network.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => { event.respondWith(fetch(event.request)); });

// A push message's payload is whatever lib/push.js's broadcastToAll() sent as JSON:
// { title, body, tag?, url? }. This handler is what turns that into an actual system
// notification — without it, a push subscription exists but nothing ever appears on screen.
self.addEventListener('push', (event) => {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'תמרה משמרות';
  var options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    tag: data.tag || undefined, // same tag replaces an earlier not-yet-seen notification instead of stacking
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open tab if there is one, instead of always
// opening a fresh one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if ('focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

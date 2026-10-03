'use strict';
// Minimal service worker so phones offer "Install app". It never caches: every screen and every
// number comes fresh from the server, so staff can't see stale attendance or salary.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Offline</title><body style="font-family:system-ui,sans-serif;padding:32px;text-align:center">'
    + '<h2>No internet connection</h2><p>Attendance needs the internet. Connect and try again.</p>'
    + '<button onclick="location.reload()" style="padding:10px 18px;font-size:16px">Try again</button>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )));
});

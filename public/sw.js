// Copyright 2026 Limestone Labs LLC. SPDX-License-Identifier: Apache-2.0
// The service worker. Its only job is the Android share menu: a PDF shared to the
// installed app arrives here as a form POST, is kept in this device's cache (never sent
// to the server), and the page picks it up. Everything else goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== '/share-target') return;
  e.respondWith((async () => {
    const form = await e.request.formData();
    const files = form.getAll('file').filter(f => f && f.size);
    const cache = await caches.open('llpdf-shared');
    for (const [i, f] of files.entries()) {
      await cache.put(`/shared/${i}`, new Response(f, {headers: {'content-type': f.type || 'application/pdf', 'x-name': encodeURIComponent(f.name || 'shared.pdf')}}));
    }
    return Response.redirect(`/?shared=${files.length}`, 303);
  })());
});

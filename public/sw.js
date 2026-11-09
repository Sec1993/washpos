const CACHE = 'washpos-v7';
const ASSETS = ['/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(
      ks.map(k => {
        if (k !== CACHE) return caches.delete(k);
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  
  // Selalu request langsung ke server untuk navigasi halaman & data transaksi (hindari tampilan usang)
  if (e.request.mode === 'navigate' || e.request.url.includes('/sales') || e.request.url.includes('/master') || e.request.url.includes('/receipt')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }
  
  e.respondWith(
    fetch(e.request).then(res => {
      if (res && res.status === 200 && e.request.url.startsWith('http')) {
        const resClone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, resClone));
      }
      return res;
    }).catch(() => {
      return caches.match(e.request);
    })
  );
});

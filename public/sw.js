const CACHE='washpos-v2';
const ASSETS=['/manifest.json'];

self.addEventListener('install',e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate',e=>{ e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k))))); self.clients.claim(); });

self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET') return;
  
  // Network First strategy
  e.respondWith(
    fetch(e.request).then(res => {
      // Don't cache redirects or errors, and only cache if we want to
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

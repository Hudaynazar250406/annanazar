const CACHE='annanazar-offline-v2';const BASE=new URL('./',self.location).pathname;
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.add(BASE+'offline.html'))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('annanazar-')&&k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate'&&new URL(e.request.url).origin===self.location.origin)e.respondWith(fetch(e.request).catch(()=>caches.open(CACHE).then(c=>c.match(BASE+'offline.html'))));});

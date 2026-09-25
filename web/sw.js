// Service worker mínimo: solo para que el navegador considere la página instalable
// ("Añadir a pantalla de inicio") y quede un shell cacheado para abrir sin red.
// Siempre intenta red primero (los datos son en vivo); cae al cache si no hay conexión.
const CACHE = "series-tracker-shell-v1";
const SHELL = [
  "./", "./index.html", "./app.js", "./proxy.js", "./style.css", "./manifest.webmanifest",
  "../extension/engine.js", "../extension/list.js", "../extension/sync.js", "../extension/store.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(r => { caches.open(CACHE).then(c => c.put(e.request, r.clone())).catch(() => {}); return r; })
      .catch(() => caches.match(e.request))
  );
});

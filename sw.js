// Service worker: tiene in memoria i file dell'app così si apre anche senza rete.
// I dati (Supabase) passano sempre dalla rete: qui non vengono mai salvati.
// Ad ogni rilascio che cambia i file, aumentare VERSION.
const VERSION = "sb-31";
const SHELL = [
  "./", "index.html", "app.css", "app.js", "js/logica.js", "js/dashboard.js", "config.js", "manifest.webmanifest",
  "fonts/akira-super-bold.woff2", "img/pattern-allos.svg", "icons/icon.svg", "icons/icon-192.png", "icons/apple-touch-icon.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.hostname.endsWith("supabase.co")) return;
  if (url.origin === location.origin) {
    // File dell'app: prima la rete (così arrivano gli aggiornamenti), poi la copia salvata.
    e.respondWith(fetch(req, { cache: "no-cache" }).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then(x => x.put(req, c)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
  } else if (/^(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) {
    // Librerie e font con versione fissa: prima la copia salvata.
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const c = res.clone(); caches.open(VERSION).then(x => x.put(req, c)); return res; })));
  }
});

// Network-first na may 4-segundong timeout.
// Kapag mabagal o walang internet, cache ang gagamitin.
const CACHE = "1105th-qr-v4";
const SHELL = [
  "./", "./index.html", "./style.css", "./theme.css", "./app.js",
  "./html5-qrcode.min.js", "./manifest.json",
  "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png",
  "./bg-camo.jpg", "./logo-small.png", "./logo-watermark.png", "./soldiers.svg"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  e.respondWith(
    new Promise((resolve) => {
      let settled = false;

      const timer = setTimeout(() => {
        caches.match(req).then((cached) => {
          if (cached && !settled) {
            settled = true;
            resolve(cached);
          }
        });
      }, 4000);

      fetch(req, { cache: "no-store" })
        .then((res) => {
          clearTimeout(timer);
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          if (!settled) {
            settled = true;
            resolve(res);
          }
        })
        .catch(() => {
          clearTimeout(timer);
          if (settled) return;
          caches.match(req).then((cached) => {
            settled = true;
            resolve(cached || caches.match("./index.html"));
          });
        });
    })
  );
});

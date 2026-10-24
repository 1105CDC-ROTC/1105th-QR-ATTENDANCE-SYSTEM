// Network-first na may 4-segundong timeout.
// Kapag mabagal o walang internet, cache ang gagamitin.
// May Background Sync din para mag-sync ng scans kahit sarado ang app.
const CACHE = "1105th-qr-v5";
const SHELL = [
  "./", "./index.html", "./style.css", "./theme.css", "./app.js",
  "./html5-qrcode.min.js", "./manifest.json",
  "./icon-192.png", "./icon-512.png",
  "./icon-maskable-192.png", "./icon-maskable-512.png",
  "./bg-camo.jpg", "./logo-small.png", "./logo-watermark.png", "./soldiers.svg"
];

const BACKEND_URL =
  "https://script.google.com/macros/s/AKfycbxQVMCHV1NsFrQClNPJUKjk-uus2QaqcSab1M6D8A1QZ1H9crHGQqmZCZedTjFaTgqzBA/exec";
const DB_NAME = "qr-attendance";
const SYNC_CHUNK = 40;

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

/* ===== Background Sync ===== */

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-scans") {
    event.waitUntil(syncInBackground());
  }
});

function swOpenDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function swRun(db, storeName, access, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, access);
    const request = action(transaction.objectStore(storeName));

    transaction.oncomplete = () => resolve(request ? request.result : undefined);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function syncInBackground() {
  const db = await swOpenDb();

  if (
    !db.objectStoreNames.contains("scans") ||
    !db.objectStoreNames.contains("schools")
  ) {
    return;
  }

  const all = await swRun(db, "scans", "readonly", (s) => s.getAll());
  const pending = all.filter((scan) => scan.status === "pending");

  if (!pending.length) return;

  const groups = {};
  pending.forEach((scan) => {
    (groups[scan.school] = groups[scan.school] || []).push(scan);
  });

  for (const school of Object.keys(groups)) {
    const record = await swRun(db, "schools", "readonly", (s) => s.get(school));
    if (!record) continue;

    const list = groups[school].sort((a, b) => a.ts - b.ts);

    for (let i = 0; i < list.length; i += SYNC_CHUNK) {
      const chunk = list.slice(i, i + SYNC_CHUNK);

      // Kapag walang internet, mag-e-error ito at susubukan ulit ng browser.
      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "sync",
          school: school,
          syncKey: record.syncKey,
          scans: chunk.map((scan) => ({
            id: scan.id,
            cadetId: scan.cadetId,
            mode: scan.mode,
            ts: scan.ts,
            date: scan.date
          }))
        })
      });

      const data = await response.json();
      if (!data.ok) break;

      for (const result of data.results || []) {
        const scan = chunk.find((item) => item.id === result.id);
        if (!scan) continue;

        if (result.status === "recorded" || result.status === "duplicate") {
          await swRun(db, "scans", "readwrite", (s) => s.delete(scan.id));
        } else {
          scan.status = "problem";
          scan.message =
            result.status === "already"
              ? "already in the sheet (" + (result.existing || "no time") + ")"
              : result.message || "could not be recorded";
          await swRun(db, "scans", "readwrite", (s) => s.put(scan));
        }
      }
    }
  }
}

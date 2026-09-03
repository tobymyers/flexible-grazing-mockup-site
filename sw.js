/* Service worker for the riparian exclusion mockup.
 * - Precaches the app shell and all region GeoJSON on first load.
 * - Runtime-caches basemap tiles (and CDN files) as they are viewed, so the
 *   field protocol is: pan/zoom the demo area on WiFi first, then go offline.
 */
'use strict';

const VERSION = 'rip-mockup-v11';
const SHELL_CACHE = VERSION + '-shell';
const TILE_CACHE = VERSION + '-tiles';

const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'manifest.webmanifest'
];

const REGIONS = ['red-canyon', 'bear-lake'];
const LAYERS = ['exclusion', 'water_gaps', 'paddock', 'allotments', 'ownership', 'springs'];
const DATA_URLS = [];
for (const root of ['data', 'stub-data']) {
  for (const r of REGIONS) {
    for (const l of LAYERS) {
      DATA_URLS.push(`${root}/${r}/${l}.geojson`);
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL);
    // Data files may not all exist yet (real data drops in later) — cache each
    // one individually and ignore misses.
    await Promise.allSettled(DATA_URLS.map(u => cache.add(u).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => !n.startsWith(VERSION))
      .map(n => caches.delete(n)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    // App shell + data: serve from cache, refresh in the background
    // (stale-while-revalidate) so new data/ files replace stubs on next load.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
  } else {
    // Basemap style, tiles, glyphs, sprites, CDN: cache-first. Tiles pile up
    // here as the user pans — that is the point (offline field use).
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (e) {
        return Response.error();
      }
    })());
  }
});

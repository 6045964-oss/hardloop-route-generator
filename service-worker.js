/* Hardloop Route Generator — service worker
 * - Statische app-bestanden: vooraf gecachet (werkt offline, installeerbaar)
 * - Kaarttegels: cache-first (app.js vult deze cache langs de route)
 * - OpenRouteService: altijd via het netwerk
 *
 * Verhoog VERSION na elke wijziging aan de app-bestanden, dan haalt de iPhone de nieuwe versie op.
 */
const VERSION = 'v1.4.0';
const STATIC_CACHE = `hrg-static-${VERSION}`;
const RUNTIME_CACHE = 'hrg-runtime-v1';
const TILE_CACHE = 'hrg-tiles-v1';
const MAX_TILES = 3000;

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

const CDN_ASSETS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' })));
    // CDN-bestanden: los proberen, zodat één mislukte download de installatie niet blokkeert.
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
        if (res.ok) await cache.put(url, res);
      } catch { /* wordt later alsnog runtime gecachet */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('hrg-static-') && k !== STATIC_CACHE)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'api.heigit.org') return; // nooit cachen

  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') {
      event.respondWith(networkFirst(req, './index.html'));
    } else if (url.pathname.endsWith('/config.js')) {
      event.respondWith(networkFirst(req));
    } else {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }

  if (/(^|\.)cdnjs\.cloudflare\.com$|fonts\.googleapis\.com$|fonts\.gstatic\.com$/.test(url.hostname)) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
  }
});

async function networkFirst(req, fallbackUrl) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(fallbackUrl || req, res.clone());
    return res;
  } catch {
    return (await cache.match(fallbackUrl || req, { ignoreSearch: true }))
      || (await cache.match(req, { ignoreSearch: true }))
      || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  return cached || (await network) || new Response('', { status: 504 });
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req) || (await caches.match(req));
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

let tilePuts = 0;

async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await cache.put(req.url, res.clone());
      if (++tilePuts % 100 === 0) trimCache(cache, MAX_TILES);
    }
    return res;
  } catch {
    // Offline en niet gecachet: een echte fout (geen stille lege tegel), zodat de app
    // via Leaflets 'tileerror' kan melden dat de kaart niet laadt.
    return Response.error();
  }
}

async function trimCache(cache, max) {
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // Oudste eerst (cache.keys() geeft invoegvolgorde terug)
  await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
}

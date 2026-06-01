// ===== MANDELA GENERALS SERVICE WORKER v14 =====
// Strategy:
//   App files  → Network-first (always try fresh, fallback to cache offline)
//   Firebase SDK → Cache-first (static SDK, rarely changes)
//   Firestore API → Network-only (never cache live data)

const CACHE_NAME = 'mandela-v20260603-shoe-cards-form';   // bump this on every deploy
const FIREBASE_CACHE = 'firebase-sdk-v1';

const APP_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

const FIREBASE_URLS = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
];

// ── INSTALL ─────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(c => c.addAll(APP_FILES)),
      caches.open(FIREBASE_CACHE).then(c =>
        Promise.allSettled(FIREBASE_URLS.map(url =>
          fetch(url).then(res => c.put(url, res)).catch(() => {})
        ))
      )
    ])
  );
  // Activate immediately — don't wait for old SW to stop
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FIREBASE_CACHE)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    )
  );
  // Take control of all open pages immediately
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // 1. Firestore / Firebase auth API — always network, never cache
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('firebase.googleapis.com') ||
    url.includes('identitytoolkit') ||
    url.includes('googleapis.com')
  ) {
    return; // pass through
  }

  // 2. Firebase SDK scripts — cache-first (they never change)
  if (url.includes('gstatic.com/firebasejs')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          caches.open(FIREBASE_CACHE).then(c => c.put(e.request, res.clone()));
          return res;
        });
      })
    );
    return;
  }

  // 3. App files — NETWORK-FIRST
  //    Try the network first so updates are always seen immediately.
  //    Fall back to cache only when offline.
  if (e.request.method === 'GET') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Got a fresh response — update the cache and return it
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          // Network failed (offline) — serve from cache
          return caches.match(e.request).then(cached => {
            if (cached) return cached;
            // Last resort: return cached index.html for navigation
            if (e.request.mode === 'navigate') {
              return caches.match('./index.html');
            }
          });
        })
    );
  }
});

// ── BACKGROUND SYNC ───────────────────────────────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'firebase-sync') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'BACKGROUND_SYNC' }))
      )
    );
  }
});

// ── MESSAGES ──────────────────────────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

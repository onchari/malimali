// ===== MANDELA GENERALS SERVICE WORKER =====
// Handles offline caching + background sync

const CACHE_NAME = 'mandela-v5';
const FIREBASE_CACHE = 'firebase-sdk-v1';

// App shell files - always cache these
const APP_FILES = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Firebase SDK URLs to cache for offline use
const FIREBASE_URLS = [
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js'
];

// ── INSTALL: cache app shell + Firebase SDK ───────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    Promise.all([
      // Cache app files
      caches.open(CACHE_NAME).then(c => c.addAll(APP_FILES)),
      // Cache Firebase SDK separately (won't fail if offline at install time)
      caches.open(FIREBASE_CACHE).then(c =>
        Promise.allSettled(FIREBASE_URLS.map(url =>
          fetch(url).then(res => c.put(url, res)).catch(() => {})
        ))
      )
    ])
  );
  self.skipWaiting();
});

// ── ACTIVATE: clean old caches ─────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FIREBASE_CACHE)
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH: cache-first for app + Firebase, network-first for Firestore API ─
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firestore API calls — network only (never cache live data)
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase.googleapis.com') ||
      url.includes('identitytoolkit')) {
    return; // let browser handle normally
  }

  // Firebase SDK — cache first, fallback to network
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

  // App files — cache first, fallback to network, update cache in background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const networkFetch = fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => cached); // if network fails, use cache

      // Return cache immediately if available, otherwise wait for network
      return cached || networkFetch;
    })
  );
});

// ── BACKGROUND SYNC: notify app when back online ──────────────────────────
self.addEventListener('sync', e => {
  if (e.tag === 'firebase-sync') {
    e.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(client =>
          client.postMessage({ type: 'BACKGROUND_SYNC' })
        )
      )
    );
  }
});

// ── MESSAGE: handle messages from app ─────────────────────────────────────
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

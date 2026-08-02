# Mandela General Stores — CLAUDE.md

## Project

Offline-first inventory & point-of-sale PWA for Mandela General Stores (a small retail shop). Tracks stock, records sales, manages daily business-day reconciliation, and syncs to Firebase Firestore. Runs entirely in the browser — no server, no build step.

**Tech stack:** Vanilla JS (ES2020), HTML5, CSS3, IndexedDB v11, Firebase Firestore v9 (modular), Service Worker (Cache API), GitHub Pages hosting.

## Architecture

### File layout
| File | Purpose |
|------|---------|
| `index.html` | SPA shell — all markup/modals/panels |
| `app.js` | All application logic (~10 000+ lines) |
| `app.css` | All styles |
| `sw.js` | Service worker — offline caching, background sync |
| `manifest.json` | PWA manifest (name: "Mandela General Stores") |

### IndexedDB v11 — 8 stores (`DB_NAME = 'InventoryApp'`)

| Store | Purpose |
|-------|---------|
| `items` | Product catalogue — one record per SKU |
| `shoe_sizes` | Per-size stock for footwear (`itemCode + size` → unique `codeSize`) |
| `sales` | Transaction lines (one record per sale) |
| `finances` | Money flows — investments, expenses, withdrawals |
| `business_days` | Daily session records (one per `businessDate`) |
| `types` | Product categories / sub-categories |
| `wishlist` | Prospective items the shop wants to stock |
| `photos` | Compressed item/wishlist photos (key: `"item_12"` / `"wish_3"`) |

Development uses a separate DB: `InventoryApp_dev`. Switch via Settings → Firebase Environment.

### Firebase Firestore sync

- **Project:** `mandela-generals`
- **Production collections:** `items`, `sales`, `shoe_sizes`, `finances`, `business_days`, `wishlist`
- **Development collections:** `dev_items`, `dev_sales`, `dev_shoe_sizes`, …  (prefix `dev_`)
- `types` and `photos` are **not** synced to Firestore.
- Sync is write-on-change (via `setDoc`) + explicit `forcePushToFirebase()` / `pullFromFirebase()`.
- `_localWriting` flag prevents echo-back from `onSnapshot` listeners.

### PWA / Service Worker
- **`CACHE_NAME`** must be bumped on every deploy (currently `mandela-v20260802b-english-ui`).
- App files: network-first with cache fallback.
- Firebase CDN: separate `FIREBASE_CACHE` cache, network-first.
- Background sync tag: `firebase-sync`.

## Key Concepts

### Item modes
- **Track Stock** (default): `isRecord = false` — qty is tracked; stock is deducted on sale.
- **Record Only:** `isRecord = true` — qty always stays 0; sale is recorded but no stock deduction. Used for items priced/tracked externally.

### Item types
- **Standard item:** plain `items` record.
- **Footwear / shoe:** `isShoe = true` — sizes stored in `shoe_sizes`; stock lives there, not on the parent item.
- **Sub-category group:** items that belong to a `type` which itself has a `parentType`; rendered grouped under the parent in the stock list.
- **Has variants:** `hasVariants = true` — non-shoe items with size/variant field; grouped by code in the stock list.

### Users & roles (hardcoded `USERS` array, ~line 8392)

| Username | Role | Tabs |
|----------|------|------|
| onchari | super | dash, inventory, sell, operations, settings |
| vanice | user | dash, inventory, sell, operations |
| trevor | clerk | inventory, sell |

Auth is PIN-based. PINs are SHA-256 hashed for comparison. No external auth service.

### Business Day
States: `OPEN` → `CLOSED` → `LOCKED`

- `openDay()` — creates or reopens the day record; sets `status = 'OPEN'`.
- `closeDay()` — closes the day; triggers reconciliation (cash count, float).
- `lockDay()` — archives the day; no further edits allowed.
- Past days left `OPEN` or `CLOSED` overnight are auto-locked on next app load.

### Session
- Stored in `localStorage` under key `mg_session` as `{ username, ts }`.
- TTL: 30 days (`30 * 24 * 60 * 60 * 1000` ms). Refreshed on every successful auth.
- `checkSession()` restores the session on load; `logout()` clears it.

## Data Model — Key Fields

**items**
`id`, `code` (unique), `name`, `type`, `variant`, `buyPrice`, `sellPrice`, `profit`, `qty`, `isRecord`, `isShoe`, `hasVariants`, `category`, `fbId`, `createdAt`, `updatedAt`

**shoe_sizes**
`id`, `itemId`, `itemCode`, `codeSize` ("CODE_42"), `size`, `buyPrice`, `sellPrice`, `qty`, `fbId`

**sales**
`id`, `itemId`, `itemCode`, `itemName`, `qty`, `priceUsed`, `buyPrice`, `businessDate`, `date`, `soldBy`, `paymentMethod`, `fbId`

**finances**
`id`, `type` (investment/expense/withdrawal), `amount`, `description`, `date`, `createdBy`, `fbId`

**business_days**
`id`, `businessDate` (unique, YYYY-MM-DD), `status` (OPEN/CLOSED/LOCKED), `openedBy`, `opened_at`, `closedBy`, `closed_at`, `float`, `cashCounted`, `fbId`

**types**
`id`, `name`, `color`, `emoji`, `isFootwear`, `active`, `parentId` (set for sub-categories)

## Common Tasks

### Adding an item
`saveItem()` (line ~3173) — validates form, calls `dbPut`/`dbAdd` on `items`.
For footwear: delegates to `saveShoeItems(baseCode, baseName, type)` (line ~10048) which upserts one `shoe_sizes` record per size row.

### Selling an item
`openSellModal(itemId)` (line ~5408) → user confirms qty/price → `confirmSale()` (line ~5508).
- `isRecord` items: sale recorded, stock **not** deducted.
- Shoe items: deducts from the selected `shoe_sizes` record.
- On success: writes to `sales` + syncs to Firestore via `setDoc`.

### Stock list rendering
`renderList()` (line ~3679):
- Shoes: grouped by `code` using enriched `shoe_sizes` totals.
- `hasVariants`: grouped by `code`.
- Sub-category items: grouped under their `parentType`.
- Plain items: listed individually.

### Firebase sync
- `forcePushToFirebase()` (line ~6844) — pushes all local records in batches.
- `pullFromFirebase(silent)` (line ~6928) — fetches all Firestore docs, merges into IndexedDB.

## Development Notes

- **Deploy:** `git push origin main` → GitHub Pages auto-deploys to `onchari.github.io/malimali/`.
- **After every deploy:** bump `CACHE_NAME` in `sw.js` (e.g. `mandela-v<date>-<tag>`).
- **No build step** — edit files directly; changes are live immediately in the browser.
- **Schema changes:** increment `DB_VER` (currently `11`) and add a migration branch in `initDB()`'s `onupgradeneeded` handler.
- **Environments:** localhost auto-uses `development` env (separate DB + `dev_` Firestore prefix). Production is auto-detected from hostname.
- **`window.xxx` exports** are at the bottom of `app.js` (~line 9165+) — required for `onclick=` handlers in `index.html`.

## Known Patterns

```js
// IndexedDB helpers — always use these, not raw IDB
dbAll('items')           // → Promise<array>
dbGet('items', id)       // → Promise<record|undefined>
dbAdd('items', obj)      // → Promise<newId>
dbPut('items', obj)      // → Promise<id>  (obj must have keyPath 'id')
dbDelete('items', id)    // → Promise<void>

// DOM helpers
UI.el('some-id')         // getElementById with null-safety

// User feedback
toast('Saved!', 'ok')   // green
toast('Error', 'err')   // red
toast('Info')            // neutral

// Async overlay (blocks UI during long ops)
_overlay.show('Saving...')
_overlay.hide()

// Output formatting
fmt(1500)   // → "1,500" (currency integer)
fmtN(42)    // → "42"    (plain integer with locale separator)

// XSS safety — always escape before innerHTML
escapeHtml(userSuppliedString)
```

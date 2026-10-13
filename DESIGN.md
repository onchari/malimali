# Mandela General Stores — Product Design Document

## 1. Overview

Mandela General Stores is an offline-first inventory and point-of-sale (POS) web application designed for a small retail shop. The system tracks stock, records sales, manages business-day reconciliation, handles financial movements, and synchronizes local data to Firebase Firestore when connectivity is available.

The application runs entirely in the browser and is implemented as a Progressive Web App (PWA). It is designed for reliability in environments with intermittent internet access and supports store operations without requiring a server-side app runtime.

### Business purpose
- Track inventory items and stock levels
- Record sales with price history and payment method
- Handle footwear and size-based stock
- Manage daily shop operations and reconciliation
- Record financial activities such as investments, expenses, and withdrawals
- Support wishlist and stock planning
- Continue working offline and sync later

### Product type
- Offline-first retail system
- Inventory management system
- POS and reconciliation tool
- Local-first PWA with cloud sync

### Deployment model
- Hosted on GitHub Pages
- No local build step required
- Files are edited directly and served as static assets

---

## 2. Product Goals and Functional Scope

### Core goals
1. Keep operations running even without internet access.
2. Let staff manage stock and sales in real time from the browser.
3. Store transactional data safely in the local browser database.
4. Synchronize local changes to Firestore automatically when online.
5. Support retail workflows such as stock movement, savings, pricing, and daily close.
6. Maintain a business-day lifecycle from open to close to lock.

### Primary user roles
The app includes a hardcoded user list with PIN-based login:

| Username | Role | Tabs |
|---|---|---|
| onchari | super | dash, inventory, sell, operations, settings |
| vanice | user | dash, inventory, sell, operations |
| trevor | clerk | inventory, sell |

### Role model
- Access is controlled by a hardcoded USERS array.
- Authentication is PIN-based.
- PINs are hashed with SHA-256 prior to comparison.
- A local session is stored in localStorage under the key `mg_session`.
- Session TTL is 30 days.

---

## 3. User Experience and Interface

The app is a single-page application using HTML, CSS, and JavaScript.

### UI structure
The shared app shell, navigation, and common components are defined in [index.html](index.html). Inventory-specific page and sheet markup is in [Inventory/inventory.html](Inventory/inventory.html) and is mounted by the shell at startup.

Main user-facing sections include:
- Dashboard
- Inventory
- Sell / POS
- Operations
- Settings

### Interaction model
- The UI runs in the browser without a backend server.
- Feature modules are loaded and share global app state.
- Common helper patterns are used such as:
  - `UI.el()` for safe DOM lookups
  - `toast()` for inline user feedback
  - `_overlay.show()` and `_overlay.hide()` for async operations
  - `fmt()` and `fmtN()` for formatted currency and number output
  - `escapeHtml()` for XSS-safe rendering

---

## 4. System Architecture

### High-level architecture

Browser UI
  |
  +-- App shell and screens
  |
  +-- Shared app logic and services
  |
  +-- Feature modules
       - inventory pages
       - item forms
       - stock views
       - shoe management
       - wishlist handling
       - photo import

  |
  v
Local data layer
  - IndexedDB stores
  - Durable local mutation queue
  - Local sync metadata

  |
  v
Offline/PWA layer
  - Service worker
  - Cache API
  - Background sync tag

  |
  v
Cloud sync layer
  - Firebase Firestore
  - Pull and push sync logic
  - Conflict-safe merge handling

### Architectural principles
- Local-first data ownership
- Offline continuity
- Durable sync queue
- Conflict-safe writes
- No server-side business logic
- Progressive Web App behavior

---

## 5. File Layout

### Root application files
| File | Purpose |
|---|---|
| [index.html](index.html) | Shared SPA shell, navigation, and component mount points |
| [app.js](app.js) | Shared application logic and services |
| [app.css](app.css) | Shared application styles |
| [sw.js](sw.js) | Service worker for offline cache and background sync |
| [manifest.json](manifest.json) | PWA manifest |

### Inventory feature files
| File | Purpose |
|---|---|
| [Inventory/inventory.html](Inventory/inventory.html) | Inventory pages and inventory-specific sheets, loaded by the shell |
| [Inventory/navigation.js](Inventory/navigation.js) | Inventory page and tab navigation |
| [Inventory/inventory-items.js](Inventory/inventory-items.js) | Item forms, stock list, item details, and footwear sizes |
| [Inventory/inventory-planning.js](Inventory/inventory-planning.js) | Wishlist, purchase planning, and photo-based stock import |
| [Inventory/inventory.css](Inventory/inventory.css) | Inventory styles and layout |

---

## 6. Offline-First Design

The app uses IndexedDB as the primary transactional store because browser storage must be durable and structured enough to support retail records.

### Why IndexedDB
- Better suited than localStorage for moderate/large structured datasets
- Supports transactional writes
- Suitable for storing inventory and sales records
- Enables durable local caching and sync queue design

### Offline behavior
- The app continues to work even when the user loses internet access.
- Sales and stock changes are committed locally first.
- Local changes are queued and retried when connectivity returns.
- Firestore remains a cloud mirror, not the only source of truth.

---

## 7. PWA and Service Worker Design

### PWA characteristics
- Installable app shell
- Works in browser like a native app
- Cached assets for offline access
- Background sync support

### Service worker responsibilities
- Cache app files
- Use network-first strategy with cache fallback
- Cache Firebase CDN separately
- Provide background sync tag: `firebase-sync`

### Cache strategy
- App files: network-first, fallback to cache
- Firebase CDN: separate cache with network-first behavior
- `CACHE_NAME` must be bumped on every deploy
- Current documented version: `mandela-v20260903a-robust-sync`

---

## 8. Firebase Sync Architecture

### Firebase project
- Project: `mandela-generals`
- Production collections:
  - `items`
  - `sales`
  - `shoe_sizes`
  - `finances`
  - `business_days`
  - `wishlist`
- Development collections use a `dev_` prefix for each corresponding collection

### Collections excluded from Firestore sync
- `types`
- `photos`

### Sync principles
- Local CRUD writes update IndexedDB first and then queue a sync mutation.
- The sync queue is durable and idempotent.
- Records store metadata including:
  - `_syncVersion`
  - `_syncClient`
  - `_syncUpdatedAt`
  - `_syncMutationId`
- Sync-safe merge logic supports conflict handling.
- Local startup normalization prevents accidental queueing for identity normalization actions.
- `_localWriting` prevents echo-back from Firestore snapshot listeners.

### Pull logic
- Pulls use `_syncUpdatedAt` cursors when available.
- Older collections fall back to a full pull strategy.
- The app supports destructive local restore from cloud and explicit queue recovery for legacy data.

### Utility functions
- `forcePushToFirebase()` drains the durable outbox.
- `pullFromFirebase(silent)` refreshes local data from the cloud.
- `restoreLocalFromCloud()` is a destructive local replacement mechanism.
- `syncRebuildOutbox()` rebuilds the queue without losing local data.

---

## 9. IndexedDB Schema

Database name: `InventoryApp`
Development database name: `InventoryApp_dev`

### Main stores

#### 1. items
Stores the product catalog.

Key fields:
- `id`
- `code` (unique product code)
- `name`
- `type`
- `variant`
- `buyPrice`
- `sellPrice`
- `profit`
- `qty`
- `isRecord`
- `isShoe`
- `hasVariants`
- `category`
- `fbId`
- `createdAt`
- `updatedAt`

#### 2. shoe_sizes
Tracks size-based stock for footwear.

Key fields:
- `id`
- `itemId`
- `itemCode`
- `codeSize` (for example `CODE_42`)
- `size`
- `buyPrice`
- `sellPrice`
- `qty`
- `fbId`

#### 3. sales
Stores sale records (one line or transaction per sale item).

Key fields:
- `id`
- `itemId`
- `itemCode`
- `itemName`
- `qty`
- `priceUsed`
- `buyPrice`
- `businessDate`
- `date`
- `soldBy`
- `paymentMethod`
- `fbId`

#### 4. finances
Tracks cash-flow-related data.

Key fields:
- `id`
- `type` (investment / expense / withdrawal)
- `amount`
- `description`
- `date`
- `createdBy`
- `fbId`

#### 5. business_days
Tracks daily operations over time.

Key fields:
- `id`
- `businessDate` (unique day key in YYYY-MM-DD format)
- `status` (OPEN / CLOSED / LOCKED)
- `openedBy`
- `opened_at`
- `closedBy`
- `closed_at`
- `float`
- `cashCounted`
- `fbId`

#### 6. types
Stores categories and subcategories.

Key fields:
- `id`
- `name`
- `color`
- `emoji`
- `isFootwear`
- `active`
- `parentId`

#### 7. wishlist
Tracks purchase planning items.

#### 8. photos
Stores compressed images for item or wishlist content.

#### 9. sync_queue
Durable mutation queue for Firestore synchronization.

#### 10. sync_meta
Stores sync state such as:
- Lamport clock-like version state
- Cross-tab lease information
- Incremental pull cursors

---

## 10. Domain Model and Business Concepts

### Item modes
The app supports two item modes:

1. Track Stock item
   - `isRecord = false`
   - stock quantity is tracked
   - sale deducts quantity

2. Record Only item
   - `isRecord = true`
   - quantity stays 0
   - sale is recorded without modifying stock quantity

This is used for items priced or tracked externally.

### Item types
- Standard item: plain records in `items`
- Footwear item: `isShoe = true`, stock is stored in `shoe_sizes`
- Sub-category group: item belongs to a `type` that has a `parentType`
- Has variants: `hasVariants = true`, non-shoe items with size/variant-based stock grouping

### Financial state model
The system tracks money movement with a `finances` collection, categorized by type:
- investment
- expense
- withdrawal

### Business-day lifecycle
State progression:
- `OPEN`
- `CLOSED`
- `LOCKED`

Key functions:
- `openDay()` creates or reopens a day record and sets `status = 'OPEN'`
- `closeDay()` closes the current day and triggers reconciliation flow
- `lockDay()` archives the day and prevents further edits

Past days that remain OPEN or CLOSED overnight are auto-locked on next app load.

---

## 11. Business Workflows

### Adding an item
The item save flow is handled by `saveItem()`.

Process:
- Validate form inputs
- Save item to the local `items` store using `dbPut()` or `dbAdd()`
- If footwear, delegate to `saveShoeItems(baseCode, baseName, type)`
- Upsert one `shoe_sizes` row per size entry
- Queue mutation to sync queue

### Selling an item
The flow begins with `openSellModal(itemId)` and continues via `confirmSale()`.

Process:
- User selects quantity and selling price
- App validates business-day state and stock availability
- `isRecord` items are recorded without stock deduction
- Shoe items deduct from the selected shoe size record
- A sales record is added to the `sales` store
- Sale is synced to Firestore when online

### Stock list rendering
The app uses `renderList()` to build stock views.

Stock grouping logic:
- Shoes grouped by code using totals from `shoe_sizes`
- `hasVariants` grouped by code
- Sub-category items grouped under their parent type
- Standard items listed individually

### Reconciliation
The close-day workflow includes cash and float reconciliation. The app ensures that closing a business day triggers a review of recorded activity and counts.

---

## 12. Authentication and Session Model

### Authentication pattern
- PIN-based auth
- Hardcoded `USERS` array containing username/role mappings
- Passwords are not stored in clear text
- SHA-256 hashing is applied before comparison

### Session storage
- Session stored in localStorage key `mg_session`
- Session payload contains:
  - `username`
  - `ts`

### Session properties
- TTL: 30 days
- Refreshed on every successful auth
- `checkSession()` restores the session when the app loads
- `logout()` clears the session manually

---

## 13. Data and Sync Model

### Local-first write model
- App writes to IndexedDB first
- Then it pushes to the durable queue
- Then it uploads to Firestore when online

### Mutation metadata
Records carry special fields to allow safe merge and replay:
- `_syncVersion`
- `_syncClient`
- `_syncUpdatedAt`
- `_syncMutationId`

### Idempotency and conflict safety
- Mutation IDs prevent duplicates
- Sync client IDs help identify source of mutation
- Updated timestamps support incremental sync and ordering
- Local writes ignore cloud echo-back via `_localWriting`

### Sync queue behavior
- Outbox is durable
- Failed pushes are retried automatically
- `forcePushToFirebase()` drains the queue manually
- Queue rebuild is available through `syncRebuildOutbox()` for legacy records

---

## 14. Database Migration and Schema Evolution

### Schema versioning
The app uses a database version number (`DB_VER`), currently documented as `11`.

### Migration strategy
When the schema changes:
- `DB_VER` is incremented
- The database upgrade branch in `initDB()` is updated
- New migration logic is added in `onupgradeneeded`

This ensures existing local data is upgraded safely without data loss.

---

## 15. Development and Environment Model

### Environments
The app supports multiple database and Firestore contexts:
- Localhost auto-uses development environment
- Production is detected via hostname

### Development behavior
- Uses database `InventoryApp_dev`
- Firestore collections are prefixed with `dev_`

### Deployment
The app is deployed to GitHub Pages via the main branch.

Deploy process:
- `git push origin main`
- GitHub Pages publishes the site automatically
- Application URL: `https://onchari.github.io/malimali/`

### Cache versioning requirement
After every deploy, `CACHE_NAME` in the service worker must be bumped.

---

## 16. Security Considerations

### Authentication security
- PINs are stored and compared as SHA-256 hashes
- No external auth service is used
- Authentication is local to the browser and application

### Data safety
- Local data is kept in IndexedDB, which is more durable and structured than localStorage
- Sync queue helps ensure writes are retried and not lost
- Cloud merges are controlled using metadata and mutation locks

### XSS safety
The app explicitly uses `escapeHtml()` before injecting untrusted content into HTML to reduce XSS risk.

---

## 17. Known Coding Patterns

The app uses a set of recognizable helper patterns:

```js
// IndexedDB helpers
dbAll('items')
dbGet('items', id)
dbAdd('items', obj)
dbPut('items', obj)
dbDelete('items', id)

// DOM utils
UI.el('some-id')

// Local feedback
toast('Saved!', 'ok')
toast('Error', 'err')
toast('Info')

// Overlay UI
_overlay.show('Saving...')
_overlay.hide()

// Formatting
fmt(1500)    // "1,500"
fmtN(42)     // "42"

// XSS-safe DOM injection
escapeHtml(userSuppliedString)
```

---

## 18. Operational Notes and Constraints

### No build step
The app is static and does not require a bundler or server-side compilation step.

### Browser-only runtime
All application logic executes in the browser. There is no dedicated backend service.

### Local writes and sync
The app treats the browser as a full operational environment, with cloud synchronization as a reliability and backup layer rather than the sole service layer.

### Cross-tab coordination
The app uses real browser coordination behaviors such as:
- `navigator.locks`
- IndexedDB lease system
- BroadcastChannel coordinated state changes

This reduces write collisions and stale state across tabs.

---

## 19. Non-Functional Requirements

### Reliability
- Keep the store operational in poor connectivity conditions
- Retry sync reliably when network is restored

### Data integrity
- Prevent duplicate writes
- Avoid syncing stale copies over newer local state
- Merge and queue safely under repeated updates

### Usability
- Minimal friction for daily stock and sale operations
- Instant feedback via toast and overlay states
- Simple navigation across tabs

### Portability
- Runs in modern browsers as a PWA
- Works without a distinct server runtime

---

## 20. Summary

Mandela General Stores is a browser-based, offline-first retail management system built around IndexedDB, Firestore sync, and service worker-based PWA support. It is designed for practical daily shop operations where connectivity may be intermittent but business continuity is essential.

The architecture is intentionally local-first:
- local database handles real operations
- sync queue ensures eventual synchronization
- Firestore acts as the cloud mirror
- the PWA layer guarantees a resilient offline experience

It is a full retail management app for inventory, sales, finance, and business-day operations without requiring a custom backend service.

---

## 21. Minimal Technical Summary

- Frontend: HTML, CSS, vanilla JS (ES2020)
- Storage: IndexedDB v14
- Cloud sync: Firebase Firestore v10 modular SDK
- PWA: Service Worker + Cache API
- Hosting: GitHub Pages
- Auth: local SHA-256 PIN validation
- Data model: local-first transactional structure with durable outbox sync

This document reflects the app as implemented in the current codebase and its design patterns.

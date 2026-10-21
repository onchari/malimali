# Application architecture and workflows

This document describes the browser application as implemented in this repository. The app is an offline-first inventory, point-of-sale, and daily-operations tool for Mandela General Stores. It is a static Progressive Web App (PWA): the browser runs the application and stores operational data locally; production data is synchronized with Firebase Cloud Firestore.

## At a glance

```text
index.html
  ├─ mounts inventory and sales HTML fragments
  ├─ mounts the shared stock-list component
  └─ loads classic scripts in order
       Inventory/navigation.js
       Inventory/inventory-items.js
       Inventory/inventory-planning.js
       Sales/sales.js
       app.js
            ├─ IndexedDB (local source of truth while offline)
            ├─ login, navigation, dashboard, operations, and shared UI
            ├─ durable sync outbox and sync metadata
            └─ Firebase Firestore (production synchronization)
```

The scripts are classic scripts rather than ES modules. They share browser globals, and HTML event handlers call functions exported on `window`. **Script load order is significant.** Some feature implementations also remain in `app.js` alongside the extracted feature scripts; verify behavior in the browser when changing those boundaries.

## Startup and navigation

1. `index.html` loads the app shell and asynchronously fetches the inventory, sales, and stock-list fragments.
2. The shell inserts the fragments into their mount points. It creates separate instances of the shared stock list for inventory browsing and sale search.
3. It loads the feature scripts and then `app.js`; a load failure displays a boot error in the shell.
4. `app.js` opens the environment-specific IndexedDB database, applies schema upgrades, migrates older records, initializes photos and sync metadata, and bootstraps the active business day and page data.
5. The login screen authenticates against the locally configured user list. A successful login restores the last accessible page. Sessions are kept in `localStorage` and refreshed on use.
6. In production, Firebase initialization attaches Firestore listeners and runs the sync flow. In development, cloud initialization exits early: the app uses a separate local database and does not sync to Firestore.

Top-level navigation is Dashboard, Inventory, Sell, Customers, Operations, and Settings. Inventory and Operations have their own tab/navigation state. Access is restricted in the UI by the user's configured tabs and role.

## Modules

| File | Responsibility |
| --- | --- |
| [index.html](./index.html) | SPA shell, navigation, page mount points, and fragment/script boot sequence. |
| [app.js](./app.js) | Shared state and helpers; IndexedDB schema and CRUD; authentication; page routing; dashboard; business-day and finance operations; customer workflows; Firebase connection, sync, and settings. |
| [app.css](./app.css) | Shared layout, navigation, component, and responsive styles. |
| [Inventory/inventory.html](./Inventory/inventory.html) | Inventory markup/templates, loaded into the shell. |
| [Inventory/navigation.js](./Inventory/navigation.js) | Inventory page mounting and inventory sub-tab navigation. |
| [Inventory/inventory-items.js](./Inventory/inventory-items.js) | Item entry/editing, footwear size entry/restocking, stock list rendering, and item details. |
| [Inventory/inventory-planning.js](./Inventory/inventory-planning.js) | Wishlist and saved purchase lists, stock monitoring/restock actions, and photo-based item import. |
| [Inventory/inventory.css](./Inventory/inventory.css) | Inventory-specific layout and styles. |
| [Inventory/stocklist.html](./Inventory/stocklist.html) | Reusable stock-list/search markup used by inventory and sale entry. |
| [Sales/sales.html](./Sales/sales.html) | Sales page and sheet templates, mounted by the shell. |
| [Sales/sales.js](./Sales/sales.js) | Sale search and entry, quick sale, sales history, reporting/export, and sale detail/edit flows. |
| [Sales/sales.css](./Sales/sales.css) | Sales-specific layout and styles. |
| [sw.js](./sw.js) | Offline cache, Firebase SDK caching, and background-sync notification. |
| [manifest.json](./manifest.json) | Installable PWA metadata and icons. |
| [version.json](./version.json) | Published application version checked by the in-app update UI. |

## Main user workflows

### Inventory and stock

- An item is created or edited through the inventory form. The save path validates fields and uses the shared IndexedDB helpers.
- Regular items keep stock quantity on the `items` record. Footwear keeps quantity and prices per size in `shoe_sizes`; the parent item is used for product-level identity and summary.
- Restocks update the relevant item or size and append a stock movement. Stock movement records are the audit trail used by the ledger/integrity features.
- The stock list groups footwear and variants and supports product search, detail views, and stock-control/low-stock workflows.
- `isRecord` items are catalogued for recording sales but do not deduct stock.

### Sales and history

1. The Sell page searches the shared stock list and opens a sale form, quick-sale form, or footwear-size sale form.
2. Sale confirmation requires an open business day, validates quantity/prices/stock, calculates revenue and profit, and records the transaction timestamp (`date`) and business date.
3. For tracked items, sale persistence atomically updates the sale, stock/item or shoe-size quantity, stock movement, sync metadata, and outbox. Record-only items skip stock deduction.
4. Sales history reads local records and supports date-period/custom-range filters, payment filters, sorting, daily views, sale details, editing, voiding/deletion, and report export.

The sale `date` is the transaction timestamp; `businessDate` is the trading-day grouping date. Different transaction timestamps represent distinct sales, even if their product, quantity, and price match.

### Wishlist and purchasing

- The wishlist stores prospective stock and supports saved lists, grouping, bulk editing, supplier/unit details, photos, and purchase planning.
- Stock monitoring identifies items needing attention and can start a restock workflow.
- Photo import extracts candidate item rows for review before the user commits them to inventory; imported candidates are not automatically accepted as stock records.
- Wishlist list membership is also kept in local storage, while the wishlist records themselves use the database/sync helpers.

### Customers

Customer records and customer transactions support customer lookup and related account/transaction workflows. These records are local-first and included in the production syncable store set.

### Business day, dashboard, and finances

- Business-day records use the states `OPEN`, `CLOSED`, and `LOCKED`. Opening creates or reopens the current day; closing summarizes sales and reconciliation values; locking archives the day against further edits.
- The dashboard and day views derive sales, profit, stock, and business-day summaries from local records.
- Finance records represent money flows such as investments, expenses, withdrawals, and reconciliation-related entries. Finance tools provide entry, review, cleanup, and reporting.

## Data storage

### IndexedDB

The database is opened at schema version `17` in `app.js`. Production uses `InventoryApp`; development uses `InventoryApp_dev`. They are separate browser databases.

| Store | Purpose |
| --- | --- |
| `items` | Product catalogue and product-level stock/price fields. |
| `shoe_sizes` | Per-size footwear stock and pricing. |
| `stock_moves` | Append-only stock deltas and references to stock-affecting events. |
| `sales` | Sale transaction lines, including timestamp and business date. |
| `finances` | Financial entries and reconciliation data. |
| `business_days` | Daily business state, opening/closing information, and summaries. |
| `types` | Product categories and subcategories. |
| `wishlist` | Prospective purchases, monitoring, and related metadata. |
| `purchase_budgets` | Purchase-planning budgets. |
| `photos` | Local item and wishlist photos; not in the Firestore sync set. |
| `customers` | Customer records. |
| `customer_txns` | Customer-related transaction records. |
| `sync_queue` | Durable, retryable outbox for cloud writes and tombstones. |
| `sync_meta` | Sync clock, lease, and pull-cursor metadata. |
| `sync_dead_letters` | Failed sync entries retained for diagnosis/recovery. |
| `sync_audit` | Local sync audit records. |

Use the `dbAll`, `dbGet`, `dbAdd`, `dbPut`, and `dbDelete` helpers for ordinary local CRUD. Syncable writes generally update the record, Lamport/HLC metadata, and outbox together. The specialized sale persistence path additionally makes its stock/sale writes atomic.

### Firestore

The configured project is `mandela-generals`. Production uses the unprefixed collections for syncable stores. Development is deliberately local-only in the current startup path; although a development collection prefix exists in configuration, `initFirebase()` returns before connecting in development.

Syncable data includes items, sales, footwear sizes, stock moves, finances, business days, wishlist entries, purchase budgets, customers, and customer transactions. Types and photos are local-only. Firestore document IDs are based on each record's `fbId`.

Records carry sync version/client/time/mutation metadata. Local changes enter the durable outbox; queue processing writes deterministic documents and represents deletes as tombstones. Pull applies remote records to IndexedDB, uses per-collection update cursors where available, and falls back to full collection reads when incremental pulls are unavailable. A sync lock/lease coordinates work across tabs, and realtime listeners refresh local views.

Settings also exposes explicit recovery operations. **Restoring local data from cloud replaces local syncable data and discards unsynced local changes; it is not a merge or a Firestore backup restore.**

## Offline and update behavior

- The service worker caches application files using a network-first strategy with cached fallback for offline use.
- Firebase SDK scripts use a separate cache-first cache. Firestore and other live Google APIs pass through without being cached.
- Background sync asks open clients to process the Firebase queue; it does not independently write Firestore from the service worker.
- `APP_VERSION`, the published `version.json`, script query versions, and service-worker cache names are separate update signals. Keep them consistent when publishing changes; bump the service-worker cache name so clients install the new asset set.

## Maintenance notes

- There is no bundler or build step; the browser runs the checked-in HTML, CSS, and JavaScript directly.
- A schema change requires incrementing `DB_VER` and adding an IndexedDB upgrade/migration path in `initDB()`.
- Changes to a public handler must preserve its `window` export if HTML invokes it with an inline handler.
- Feature scripts and `app.js` share globals. Check both the module file and `app.js` before moving or redefining a feature function.
- Validate sale, stock, outbox, and timestamp behavior together when changing a sale flow; these records are coupled by business rules and sync identity.

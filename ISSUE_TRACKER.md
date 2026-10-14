# Issue Tracker

Static code-review findings for the current Dashboard, Inventory, Sales,
Operations, Settings, and shared application services, reviewed on 2026-10-14.
This tracker lists unresolved findings and improvements only; completed entries
have been removed. Some findings still require runtime or configuration verification.

## Sales bugs and risks

Order is a suggested sequence within each table (lower numbers first), not a
release commitment; dependencies take precedence across the two tables.
Dependencies are prerequisite tracker items; `—` means none identified.

| ID | Priority | Order | Depends on | Status | Finding | Areas |
|---|---|---:|---|---|---|---|
| SALES-004 | Medium | 1 | — | Open | Regular and off-stock sales hardcode payment method to cash; the payment selector is not wired into these flows. Confirm whether sales should remain cash-only; if so, remove or clearly label unused payment controls. | `Sales/sales.js` `selectPayment`, `confirmSaleUnlocked`, `confirmOffStockSale`; `Sales/sales.html` |
| SALES-020 | Medium | 2 | — | Open | Footwear search cards may show the parent item's minimum sale price even when the selected size has a different size-specific minimum. Confirm displayed pricing against configured parent and size floors. | `Sales/sales.js` search result rendering and sale confirmation |
| SALES-022 | Medium | 3 | — | Open | Multi-day history aggregation adds only known buy costs and profits but displays the partial sums as complete numeric totals. When any included sale has unknown cost/profit, day and period totals can misleadingly show zero or an incomplete amount instead of unavailable. | `Sales/sales.js` `_renderHistoryPage`, daily grouping, period totals |
| SALES-023 | Medium | 4 | — | Open | If the app remains open across Nairobi midnight, `activeDay` may still refer to yesterday. Sales confirmation checks only that the stale day is open, while new sales are assigned today's `businessDate`; closing the stale day then filters out those sales. Refresh/validate the active day before accepting sales and before closing. | `Sales/sales.js` `confirmSaleUnlocked`; `app.js` `requireOpenDay`, `loadActiveDay`, `closeDay` |

## Other module issues and risks

Order is a suggested implementation sequence; dependencies take precedence.
Risks that depend on intended behavior or external configuration are labeled.

| ID | Module | Priority | Order | Depends on | Status | Finding | Areas |
|---|---|---|---:|---|---|---|---|
| OPS-001 | Operations | High | 1 | OPS-I001 | Open | Business-day reconciliation details are stored locally and copied to the business-day record asynchronously. Other devices or cleared browser storage may not recover entered details; migration and save completion need verification. | `app.js` `_saveDayRecon`, close-day flow, business-day sync |
| AUTH-001 | Settings / Auth | High (verify) | 2 | CORE-I001 | Open | PINs and role checks are client-side; session restoration trusts a locally stored username and UI navigation restrictions do not enforce authorization. Verify Firestore rules and hosting/data access before relying on roles to protect business data; cloud exposure is unverified. | `app.js` `USERS`, `checkSession`, auth/role checks; Firestore rules |
| AUTH-002 | Settings / Auth | Medium (verify) | 3 | CORE-I001 | Open | The production page displayed dashboard sales totals, stock alerts, and wishlist counts while the sign-in screen was visible. This may be stale/local browser data rather than public cloud access, but business summaries remain visible after logout or before authentication on that browser. Confirm intended behavior and clear or gate sensitive cached UI when signed out. | `app.js` dashboard rendering, sign-in/session initialization, logout |
| CORE-002 | Settings / PWA Sync | Medium (verify) | 4 | PWA-I001 | Open | The service-worker Background Sync handler only messages open clients; it does not drain the durable sync queue when no app page is open. Verify expected behavior on target browsers and document or implement foreground-only queue processing. | `sw.js` `sync` handler; `app.js` queue processing |
| PWA-002 | PWA / Offline | Medium | 5 | — | Open | The service worker precaches several app assets without query strings, while the shell fetches Sales markup and app scripts with `?v=20261014.08`. Offline fallback uses an exact request cache match, so if the versioned request was not cached during a successful online load, the precached unversioned asset is missed and shell initialization can fail. | `sw.js` `APP_FILES`, fetch fallback; `index.html` asset loader |
| OPS-002 | Operations / Diagnostics | Medium (verify) | 6 | OPS-I002 | Open | The standalone ledger reconciliation may double-count footwear opening stock: migration can create a parent-item opening movement as well as per-size movements, while the diagnostic sums all movements by item and compares them with size totals. This can report false positive variance. Also confirm behavior for ordinary stock histories before treating the output as drift. | `app.js` `runStockLedgerMigrationCutover`; `reconcile.js` `computeDrift` |
| INV-003 | Inventory | Medium (verify) | 7 | — | Open | Inventory views mix raw `qty` fields with ledger-derived quantity helpers. This can display inconsistent stock after migrations, edits, or partial restocks; static review did not reproduce a specific mismatch. | `Inventory/inventory-items.js` `renderList`, `openSheet`, stock monitor; `app.js` quantity helpers |

## Improvements

| ID | Priority | Order | Depends on | Status | Improvement |
|---|---|---:|---|---|---|
| SALES-I003 | Medium | 1 | — | Open | Wire payment-method selection into both normal and off-stock sale entry, or remove the unused selector and clearly make the workflows cash-only. |
| SALES-I007 | Medium | 2 | — | Open | Run the added manual regression cases for repeated sale edits, void failures/retries, offline edits of unlinked sales, legacy price fields, zero/missing quantities, and date/timezone boundaries; add automated coverage where practical. Manual cases have been added but not executed. |
| SALES-I008 | Low | 3 | — | Open | Remove or reconcile obsolete helpers and entry points once all callers have been confirmed. |
| SALES-I011 | Low | 4 | — | Open | Benchmark history and report export with realistic sales volumes; add date-indexed queries or pagination if loading all records causes slow filters or exports. |
| SALES-I012 | Low | 5 | — | Open | Measure Sell search with a large catalogue and stock-movement ledger; avoid repeatedly loading/scanning the full ledger for each item or size if profiling confirms this bottleneck. |

### Cross-module improvements

| ID | Priority | Order | Depends on | Status | Improvement |
|---|---|---:|---|---|---|
| CORE-I001 | High | 1 | — | Open | Define the intended authentication and authorization boundary; enforce roles through trusted Firebase security rules or another server-side mechanism rather than client-side UI checks alone. |
| OPS-I001 | High | 2 | — | Open | Store business-day reconciliation inputs/results in the canonical synced business-day record and migrate device-local reconciliation data safely. |
| PWA-I001 | Medium | 3 | CORE-I001 | Open | Specify and test offline queue behavior when no page is open; if background upload is required, implement it with an appropriate supported/authenticated design, otherwise communicate that uploads resume when the app is opened. |
| INV-I003 | Medium | 4 | — | Open | Standardize Inventory quantity reads on one ledger-aware available-stock helper for items and footwear sizes; add migration/restock regression checks. |
| OPS-I002 | Medium | 5 | — | Open | Redesign the stock-drift diagnostic around a valid expected-stock equation that includes opening counts and all stock-changing events, and reconcile shoe-size movements without counting parent and size opening balances twice. Rename or remove the diagnostic if required inputs are unavailable. |

# Issue Tracker

Static code-review findings for the current Dashboard, Inventory, Sales,
Operations, Settings, and shared application services, reviewed on 2026-10-13.
Items have not all been reproduced with production data; verify behavior and
impact before closing or changing priority.

## Sales bugs and risks

Order is a suggested sequence within each table (lower numbers first), not a
release commitment; dependencies take precedence across the two tables.
Dependencies are prerequisite tracker items; `—` means none identified.

| ID | Priority | Order | Depends on | Status | Finding | Areas |
|---|---|---:|---|---|---|---|
| SALES-001 | High | 1 | SALES-I002 | Open | Repeated sale edits can overwrite the same stock-movement ID (`sale:<id>:edit`), potentially making ledger-derived stock quantity incorrect. | `app.js` `persistSaleEditAtomically`; `Sales/sales.js` `saveSaleEdit` |
| SALES-002 | High | 2 | SALES-I002 | Open | Editing an unlinked/off-stock sale uses `dbPut("sales", sale)` without explicitly queuing a sync update; local and Firestore records may diverge. | `Sales/sales.js` `saveSaleEdit` |
| SALES-003 | High | 3 | SALES-I002 | Open | Voiding a sale updates cloud deletion, stock, ledger, finance, monitor rows, and local sale record in separate steps. A failure partway through can leave inconsistent state or make retries unsafe. | `app.js` `voidSale` |
| SALES-015 | High | 4 | SALES-I002 | Open | Sale edits do not use the sale lock; concurrent edits or an edit racing a sale can calculate stock deltas from stale state. Revalidate the latest sale and stock while holding the appropriate lock. | `Sales/sales.js` `saveSaleEdit`; sale confirmation lock |
| SALES-016 | High | 5 | SALES-I002 | Open | Editing an off-stock sale updates the sale record but may not update its linked `sale-monitor` wishlist row, leaving monitored quantity or estimated cost stale. | `Sales/sales.js` `confirmOffStockSale`, `saveSaleEdit`; `app.js` monitor helpers |
| SALES-004 | Medium | 6 | — | Open | Regular and off-stock sales hardcode payment method to cash; the payment selector is not wired into these flows. | `Sales/sales.js` `selectPayment`, `confirmSaleUnlocked`, `confirmOffStockSale` |
| SALES-005 | Medium | 7 | SALES-I001 | Open | Sale/buy price alias precedence differs between modal preview, final confirmation, and saved values. Legacy records with conflicting `sellPrice`/`sell` or `buyPrice`/`buy` may produce a preview that differs from the recorded sale. | `Sales/sales.js` `openSellModal`, `updateSellModal`, `confirmSaleUnlocked` |
| SALES-006 | Medium | 8 | SALES-I001 | Open | History grouping accepts legacy `priceUsed`, but period totals, detailed tables, and sale details omit that fallback; older records can show inconsistent revenue. | `Sales/sales.js` `_renderHistoryPage`, `_histSalesTotals`, `_histTable`, `openSaleDetail` |
| SALES-007 | Medium | 9 | SALES-I004 | Open | Sell search truncates results to 120 without pagination or an indication that more matches exist. | `Sales/sales.js` `searchSell` |
| SALES-008 | Medium | 10 | SALES-I004 | Open | Concurrent Sell searches are not cancelled or guarded by a request generation. A slower older request may overwrite results for a newer query. | `Sales/sales.js` `onSellSearch`, `searchSell` |
| SALES-009 | Medium | 11 | SALES-I006 | Open | The buy-price input is described as optional, but standard sale confirmation rejects missing or zero buy price. This blocks sales with an unknown or genuinely zero cost; legacy/off-stock edits can also reject records with genuinely unknown cost. | `Sales/sales.html` sell sheet; `Sales/sales.js` `confirmSaleUnlocked`, `saveSaleEdit` |
| SALES-017 | Medium | 12 | SALES-I001 | Open | History treats a missing legacy quantity as one, but sale edits use zero when calculating the old quantity; editing such a record can apply an incorrect stock delta. | `Sales/sales.js` history quantity helpers, `saveSaleEdit` |
| SALES-018 | Medium | 13 | SALES-I001 | Open | Sale edits set `sellPrice` and `actualPrice` to the edited price without preserving the original list price or recalculating `overridden`, so price audit metadata can become inconsistent. | `Sales/sales.js` `saveSaleEdit` |
| SALES-019 | Medium | 14 | — | Open | Sell search can skip footwear when the query matches only a shoe-size record, because it filters on parent-item match before examining size records. Confirm against `_gscScore` and size matching before closing. | `Sales/sales.js` `searchSell`; `app.js` `_gscScore` |
| SALES-020 | Medium | 15 | — | Open | Footwear search cards may show the parent item's minimum sale price even when the selected size has a different size-specific minimum. Confirm displayed pricing against configured parent and size floors. | `Sales/sales.js` search result rendering and sale confirmation |
| SALES-010 | Medium | 16 | SALES-I005 | Open | Sales without a valid business date or timestamp are silently assigned to today in history, which can misstate daily totals. | `Sales/sales.js` `_historySaleDate` |
| SALES-011 | Low | 17 | SALES-I001 | Open | Several views use `qty \|\| 1`; an explicit zero quantity is therefore rendered and totaled as one. | `Sales/sales.js` `_histSalesTotals`, `_histTable`, `openSaleDetail`, `exportSalesReport` |
| SALES-012 | Low | 18 | — | Open | CSV cells are quoted and escaped for CSV syntax but not neutralized against spreadsheet formula interpretation for values beginning with `=`, `+`, `-`, or `@`. | `Sales/sales.js` `exportSalesReport` |
| SALES-013 | Low | 19 | SALES-I008 | Open | The legacy `filterSalesByPeriod()` uses a rolling seven-day period rather than the configured Sunday–Saturday business week. It appears unused by the current UI but could mislead future callers. | `Sales/sales.js` `filterSalesByPeriod` |
| SALES-014 | Low | 20 | SALES-I008 | Open | The exported `deleteSale()` path deletes a sale without restoring stock, while the newer detail-sheet flow uses `voidSale()`. The legacy entry point could cause inconsistent behavior if reused. | `Sales/sales.js` `deleteSale`, `app.js` `voidSale` |
| SALES-021 |  |  |  |  |  |  |

## Other module issues and risks

Order is a suggested implementation sequence; dependencies take precedence.
Risks that depend on intended behavior or external configuration are labeled.

| ID | Module | Priority | Order | Depends on | Status | Finding | Areas |
|---|---|---|---:|---|---|---|---|
| CORE-001 | Settings / Sync | High | 1 | CORE-I002 | Open | Manual sync can show success after failed uploads: the push path suppresses the failure toast and clears error state, while force sync can continue to pull/report completion despite push failures. Verify the queue result before clearing errors, pulling, or reporting success. | `app.js` `syncPushOnly`, `runForceSync`, `forcePushToFirebase` |
| OPS-001 | Operations | High | 2 | OPS-I001 | Open | Business-day reconciliation details are stored only in `localStorage`, while the business-day record is synced separately. Other devices or cleared browser storage cannot recover those entered details from the cloud. | `app.js` `_saveDayRecon`, close-day flow, business-day sync |
| AUTH-001 | Settings / Auth | High (verify) | 3 | CORE-I001 | Open | PINs and role checks are client-side; session restoration trusts a locally stored username and UI navigation restrictions do not enforce authorization. Verify Firestore rules and hosting/data access before relying on roles to protect business data; cloud exposure is unverified. | `app.js` `USERS`, `checkSession`, auth/role checks; Firestore rules |
| INV-001 | Inventory | High | 4 | INV-I001 | Open | Deleting an item or shoe-size records does not reverse or invalidate related stock-movement ledger entries, although ledger-derived quantities still use those movements. Deleted inventory can therefore leave stale movements affecting derived stock. | `Inventory/inventory-items.js` `deleteItem`; `app.js` `cascadeDeleteRecord`, `deriveQty` |
| CORE-002 | Settings / PWA Sync | Medium (verify) | 5 | PWA-I001 | Open | The service-worker Background Sync handler only messages open clients; it does not drain the durable sync queue when no app page is open. Verify expected behavior on target browsers and document or implement foreground-only queue processing. | `sw.js` `sync` handler; `app.js` queue processing |
| INV-002 | Inventory | Medium | 6 | INV-I002 | Open | Wishlist helpers are defined in both the inventory planning script and `app.js`. Since the shell loads inventory scripts before `app.js`, later global declarations can replace earlier implementations and make behavior dependent on script order. | `Inventory/inventory-planning.js`; `app.js` wishlist helpers |
| DASH-001 | Dashboard | Medium | 7 | SALES-I005 | Open | The seven-day sparkline builds dates with UTC `toISOString()` while the dashboard's current business date uses local time. Around midnight in UTC+3, the range and current-day highlight can shift by one day. | `app.js` dashboard sparkline and `todayDateStr` |
| OPS-002 | Operations / Diagnostics | Medium (verify) | 8 | OPS-I002 | Open | The standalone stock-drift script compares lifetime sold quantity directly with current stock and omits opening stock, receipts, returns, and voids. Its delta is not a reliable stock-drift measure for ordinary inventory histories; no in-app callers were found. | `reconcile.js` `computeDrift` |
| INV-003 | Inventory | Medium (verify) | 9 | INV-I003 | Open | Inventory views mix raw `qty` fields with ledger-derived quantity helpers. This can display inconsistent stock after migrations, edits, or partial restocks; static review did not reproduce a specific mismatch. | `Inventory/inventory-items.js` `renderList`, `openSheet`, stock monitor; `app.js` quantity helpers |
| CORE-003 | Settings / Sync | Medium | 10 | CORE-I003 | Open | Exceptions while checking local records or the sync queue can be rendered as “Synced,” hiding a failed or unknown status and removing a clear retry signal. | `app.js` sync-status read/update helpers |

## Improvements

| ID | Priority | Order | Depends on | Status | Improvement |
|---|---|---:|---|---|---|
| SALES-I001 | High | 1 | — | Open | Centralize sale normalization and calculation (date, quantity, unit prices, revenue, cost, and profit) so history, details, summaries, and exports agree. |
| SALES-I002 | High | 2 | — | Open | Make sale, edit, and void operations consistently transactional across the sale, stock records, stock-movement ledger, monitor/finance records, and sync outbox; assign unique stable movement IDs. |
| SALES-I003 | Medium | 3 | — | Open | Wire payment-method selection into both normal and off-stock sale entry, or remove the unused selector and clearly make the workflows cash-only. |
| SALES-I004 | Medium | 4 | — | Open | Add pagination or an explicit “show more” affordance for Sell search, and prevent stale async results from replacing results for the current query. |
| SALES-I005 | Medium | 5 | — | Open | Define and use the business timezone consistently for business dates, Dashboard date ranges, filters, and timestamp-only legacy records. |
| SALES-I006 | Medium | 6 | — | Open | Distinguish unknown buy cost from a true zero cost, especially for off-stock and legacy sales, and show when profit cannot be calculated. |
| SALES-I007 | Medium | 7 | SALES-I001, SALES-I002, SALES-I005, SALES-I006 | Open | Add regression coverage for repeated sale edits, void failures/retries, offline edits of unlinked sales, legacy price fields, zero/missing quantities, and date/timezone boundaries. |
| SALES-I008 | Low | 8 | — | Open | Remove or reconcile obsolete helpers and entry points once all callers have been confirmed. |
| SALES-I009 | Low | 9 | — | Open | Make Sell result cards keyboard-accessible with native interactive elements or equivalent focus and keyboard behavior. |
| SALES-I010 | Low | 10 | — | Open | Add user-visible error handling and a retry path to the detail-sheet action that navigates to and pre-fills the add-to-inventory form. |
| SALES-I011 | Low | 11 | — | Open | Benchmark history and report export with realistic sales volumes; add date-indexed queries or pagination if loading all records causes slow filters or exports. |
| SALES-I012 | Low | 12 | SALES-I004 | Open | Measure Sell search with a large catalogue and stock-movement ledger; avoid repeatedly loading/scanning the full ledger for each item or size if profiling confirms this bottleneck. |

### Cross-module improvements

| ID | Priority | Order | Depends on | Status | Improvement |
|---|---|---:|---|---|---|
| CORE-I001 | High | 1 | — | Open | Define the intended authentication and authorization boundary; enforce roles through trusted Firebase security rules or another server-side mechanism rather than client-side UI checks alone. |
| CORE-I002 | High | 2 | CORE-I003 | Open | Make the sync queue's push outcome explicit and consistent across manual sync actions; preserve failure state and provide a retry path instead of reporting false success. |
| OPS-I001 | High | 3 | CORE-I002 | Open | Store business-day reconciliation inputs/results in the canonical synced business-day record and migrate device-local reconciliation data safely. |
| INV-I001 | High | 4 | — | Open | Define safe item deletion with stock-ledger history: retain a tombstone/history, block deletion, or write compensating movements so deleted items cannot leave unexplained derived stock. |
| CORE-I003 | Medium | 5 | — | Open | Use distinct loading, synced, pending, and error/unknown states for sync status; retain a visible retry action when reads or uploads fail. |
| INV-I002 | Medium | 6 | — | Open | Keep one authoritative wishlist implementation and remove duplicate global helper definitions; make script ownership explicit. |
| PWA-I001 | Medium | 7 | CORE-I001 | Open | Specify and test offline queue behavior when no page is open; if background upload is required, implement it with an appropriate supported/authenticated design, otherwise communicate that uploads resume when the app is opened. |
| INV-I003 | Medium | 8 | INV-I001 | Open | Standardize Inventory quantity reads on one ledger-aware available-stock helper for items and footwear sizes; add migration/restock regression checks. |
| OPS-I002 | Medium | 9 | — | Open | Redesign the stock-drift diagnostic around a valid expected-stock equation that includes opening counts and all stock-changing events, or rename/remove it if those inputs are unavailable. |

# Issue Tracker

Sales-module findings from a static code review on 2026-10-13. These items have
not yet been reproduced with production data; verify behavior and impact before
closing or changing priority.

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

## Improvements

| ID | Priority | Order | Depends on | Status | Improvement |
|---|---|---:|---|---|---|
| SALES-I001 | High | 1 | — | Open | Centralize sale normalization and calculation (date, quantity, unit prices, revenue, cost, and profit) so history, details, summaries, and exports agree. |
| SALES-I002 | High | 2 | — | Open | Make sale, edit, and void operations consistently transactional across the sale, stock records, stock-movement ledger, monitor/finance records, and sync outbox; assign unique stable movement IDs. |
| SALES-I003 | Medium | 3 | — | Open | Wire payment-method selection into both normal and off-stock sale entry, or remove the unused selector and clearly make the workflows cash-only. |
| SALES-I004 | Medium | 4 | — | Open | Add pagination or an explicit “show more” affordance for Sell search, and prevent stale async results from replacing results for the current query. |
| SALES-I005 | Medium | 5 | — | Open | Define and use the business timezone consistently for business dates, filters, and timestamp-only legacy records. |
| SALES-I006 | Medium | 6 | — | Open | Distinguish unknown buy cost from a true zero cost, especially for off-stock and legacy sales, and show when profit cannot be calculated. |
| SALES-I007 | Medium | 7 | SALES-I001, SALES-I002, SALES-I005, SALES-I006 | Open | Add regression coverage for repeated sale edits, void failures/retries, offline edits of unlinked sales, legacy price fields, zero/missing quantities, and date/timezone boundaries. |
| SALES-I008 | Low | 8 | — | Open | Remove or reconcile obsolete helpers and entry points once all callers have been confirmed. |
| SALES-I009 | Low | 9 | — | Open | Make Sell result cards keyboard-accessible with native interactive elements or equivalent focus and keyboard behavior. |
| SALES-I010 | Low | 10 | — | Open | Add user-visible error handling and a retry path to the detail-sheet action that navigates to and pre-fills the add-to-inventory form. |
| SALES-I011 | Low | 11 | — | Open | Benchmark history and report export with realistic sales volumes; add date-indexed queries or pagination if loading all records causes slow filters or exports. |
| SALES-I012 | Low | 12 | SALES-I004 | Open | Measure Sell search with a large catalogue and stock-movement ledger; avoid repeatedly loading/scanning the full ledger for each item or size if profiling confirms this bottleneck. |

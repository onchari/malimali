# Requirement: Sell Not In Stock

Oct 13, 2026

## Purpose and scope

Sales and Inventory use one shared stock-list search on the Sales page. The cashier can filter the visible list and search for an item to sell from the same input. Selecting an existing item opens its in-app details page, then the normal sale form as another in-app page. A missing item opens a separate sale form, styled consistently with the Inventory form, which saves the sale and a Record Only inventory item together.

**In scope:** removing the separate Sales-only search and "Sell Not In Stock" button, combining inventory filtering and sell matching in the shared search, the in-app item details and standard sale pages, and the independent missing-item sale form.

**Out of scope:** sale history and reports, and the void flow.

## Functional requirements

| ID    | Requirement                                                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-1  | The separate "Sell Not In Stock" button is removed. One Sell button remains.                                                                                                               |
| FR-2  | Sales retains the shared Stock List search as its only search input. It filters the visible inventory list and also searches inventory for sale matches; it is focused when the Sell tab opens. |
| FR-3  | After 2 or more characters, the system searches inventory by name and code, about 150 ms after the last keystroke. Results of an older search are discarded if a newer one has started.    |
| FR-4  | The dropdown shows at most 8 matches, each with name, code, category, stock and price, and states how many more matches exist.                                                             |
| FR-5  | **Item exists:** the cashier selects a match. The search closes and the item details open as an in-app page, the same details shown when selecting an inventory-list item.                  |
| FR-6  | From item details, Sell opens the standard sale form as an in-app page. Existing sale, pricing, shoe-size, stock, and validation logic is preserved.                                       |
| FR-7  | **Item does not exist:** one full-card button contains "**<typed name> is NOT in the inventory.**" and "Click to sell it and automatically add it PARTIALLY to the inventory." |
| FR-8  | Tapping anywhere on that card opens an independent, in-page sale form using Inventory form styling, with the typed name filled in. It does not use a popup or reuse the Add Item form. |
| FR-9  | The form requires item name, quantity to sell, and sell price. Quantity to sell, buy price, and tracked stock quantity default to 0. An explicit "Buy price is unknown" option stores an unknown cost as null. Category is optional for recording the sale and can be selected to complete that inventory detail. Record Only is selected by default; Track Stock reveals stock quantity. |
| FR-10 | Submitting saves the sale and new Record Only inventory item atomically. If the save fails, nothing is written and the form retains its values with a retryable error.                      |
| FR-11 | After a successful save, the sale form and any item-details page close before the existing sale success screen is shown.                                                                   |
| FR-12 | Incomplete items show an "Incomplete" badge in the inventory list and can be filtered. Opening one lets the user fill in the missing details. Saving them clears the flag.                 |
| FR-13 | An Incomplete item also appears in the Sell search with an "Incomplete" badge. Selecting it opens the quick form linked to that item, so a repeat sale does not create a duplicate.        |

## Data captured

Selling an existing item through the standard sale form changes nothing here. For an item not found, the independent sale form atomically creates a Record Only item and sale.

| Record               | Fields                                                                                                                          | Notes                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory item (new) | id, name, code, category, quantity, buy price, sell price, isRecord, incomplete flag, missing fields, source, created at          | Quantity is 0 and `isRecord` is true. Missing inventory details are tracked as Incomplete. Source is "off-stock-sale". Buy price defaults to known zero; the explicit unknown option stores null. |
| Sale                 | id, item id, item name, quantity, sell price, actual price, buy price, payment method, off-stock flag, business date, timestamp    | Links to the new or existing Incomplete item.                                                                                                                                                     |
| Restock monitor row  | Numeric local `id`, sale and item IDs, quantity, estimated cost, status                                                             | Created with the sale for stock-monitor tracking.                                                                                                                                                  |

## Business rules and validation

- Item name and sell price are required. Sell price must be greater than zero.
- Buy price, quantity to sell, and Track Stock quantity default to 0. The explicit "Buy price is unknown" option distinguishes a null/unknown cost from a known zero cost. Category is optional; selecting an active category fills the item category and can clear that missing detail. Quantity to sell must be at least 1; Track Stock quantity must be at least the quantity being sold. Code is optional.
- An Incomplete item is complete when name, category, code, buy price, and sell price are all present. A buy price of 0 is present; only the explicit unknown option means the buy price is unknown.
- The payment method is Cash; the missing-item form does not show a payment selector.
- The business date is calculated in the Africa/Nairobi time zone, the same way as everywhere else in the app.
- The item is created as Record Only with quantity 0, so the sale does not deduct tracked stock.
- Before creating a new item, the system checks for an existing item (including Incomplete ones) with the same name, ignoring case and extra spaces. If one exists, the sale links to it instead of creating a duplicate.
- The Sell button is disabled while a save is running, so a double tap cannot create two sales.

## UI requirements

The unified Sales search must fix the problems in the former popup: the dropdown covers fields below it, the messages contradict each other, and the subtitle is outdated.

| State                     | Input                 | Dropdown and messages                                                                                                          |
| ------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Idle (under 2 characters) | Neutral border        | Grey hint: "Search by name, code, type, size…". No dropdown.                                                                   |
| Searching                 | Neutral border        | Grey "Searching inventory…".                                                                                                   |
| Found                     | Green border and tint | Dropdown opens with a green header, "N matches in inventory. Select one.", and one row per match with an "In inventory" badge. |
| Found, Incomplete item    | Green border and tint | Same row with an amber "Incomplete" badge.                                                                                     |
| No match                  | Red border and tint   | One clickable card includes "**<typed name> is NOT in the inventory.** Click to sell it and automatically add it PARTIALLY to the inventory." |
| New item                  | Name prefilled        | Opens an in-page Sales form styled like Add Item, with a Record Only/Track Stock toggle; Record Only hides stock quantity and Track Stock shows it. |

- No duplicate Sales-specific search remains; the shared stock-list search handles both list filtering and sell-item matching.
- The dropdown is attached directly under the input, sits above content below it, and closes on selection, Escape, or a tap outside.
- Selecting an existing item opens the in-app item details page; selling from it opens the in-app sale form. Back returns to the originating Inventory or Sales page.
- Colour is never the only signal. Every state also has text, and each match carries a badge.
- Keyboard support: arrow keys move through matches, Enter selects, Escape closes. The input is a proper combobox for screen readers, and status changes are announced.
- Inputs use at least 16 px text so phones do not zoom in on focus.
- The in-page form replaces the Sales search/history content until the user returns or submits.

## Non-functional requirements and tracker items

- The sale and new Record Only item are committed in one all-or-nothing transaction.
- **Unique IDs:** every record gets a unique, stable ID, so repeated saves never overwrite each other.
- **Offline:** the flow works offline. The search reads local inventory and the save goes to the sync queue.
- **Speed:** search results appear within 300 ms for a catalogue of several thousand items.
- **Mobile first:** the form is rendered in the app page on all screen sizes.

This requirement addresses these items in ISSUE_TRACKER.md:

| Tracker item          | How it is addressed                                                         |
| --------------------- | --------------------------------------------------------------------------- |
| SALES-004             | Payment method is selectable and saved with the sale.                       |
| SALES-008, SALES-I004 | Stale search results are discarded, and the result cap is stated on screen. |
| SALES-009, SALES-I006 | Buy price is optional, with unknown kept distinct from zero.                |
| SALES-I002            | Item, sale, and restock-monitor records save atomically with unique IDs.     |
| SALES-I005            | Business date uses the Africa/Nairobi time zone.                            |

## Acceptance criteria and open questions

**Resolved decisions**

- Required details to clear Incomplete: name, category, code, buy price, and sell price.
- Selecting an Incomplete item always opens the quick form, regardless of its quantity.
- Selling a missing item uses the independent form and saves the sale and item atomically.
- Existing role access is preserved; this flow does not add a new role restriction.
- Duplicate prevention uses exact names after trimming, collapsing whitespace, and ignoring case. Near-duplicate matching is not included.

**Quick-form browser verification**

- [x] Search states were exercised with a matching item and a no-match query; result badges and the quick-form handoff were checked.
- [x] A quick sale wrote one incomplete Record Only item, one sale, and one monitor row atomically; unknown buy price remained `null`.
- [x] A repeat sale linked to the same Incomplete item without creating another item.
- [x] A zero buy price remained distinct from unknown; two concurrent submit calls produced one sale.
- [x] A forced duplicate-code failure left all three stores unchanged and retained the form values.
- [x] The quick form fit a 360 px viewport without horizontal overflow.

The normal existing-item sale, completing an Incomplete item through the inventory form, and larger-catalogue stale-search timing still need full manual acceptance testing.

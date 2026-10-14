// Sales module logic. Shared database, sync, stock, and business-day services are provided by app.js.

function showSalesTab(tab) {
  _activeSalesTab = tab === "history" ? "history" : "sell";
  ["sell", "history"].forEach((name) => {
    const btn = document.getElementById("sales-tab-" + name);
    const slot = document.getElementById("sales-slot-" + name);
    if (btn) btn.classList.toggle("active", name === _activeSalesTab);
    if (slot) slot.classList.toggle("active", name === _activeSalesTab);
  });
  const sub = document.getElementById("sales-sub");
  if (sub) {
    sub.textContent =
      _activeSalesTab === "history"
        ? "Today and past sales records"
        : "Search inventory to sell an item";
  }
  if (_activeSalesTab === "sell") {
    renderSellPage();
    renderList().catch((error) => {
      console.error("[showSalesTab] stock list failed to render", error);
      toast("Inventory list could not be loaded: " + (error.message || "Unknown error"), "err");
    });
    setTimeout(() => {
      const el = document.getElementById("sell-search");
      if (el) el.focus();
    }, 150);
  } else {
    renderHistoryPage();
  }
  saveLastView();
}

function getSaleMotivation() {
  const messages = getMotivationMessages();
  if (!messages.length) return "";
  const today = todayDateStr();
  const year = today.slice(0, 4);
  let state = {};
  try {
    state = JSON.parse(localStorage.getItem(MOTIVATION_STATE_KEY) || "{}");
  } catch (_) {}
  if (state.year !== year)
    state = { year, used: [], categoryCounts: {}, lastUsed: {} };
  if (!Array.isArray(state.used)) state.used = [];
  if (!state.categoryCounts || typeof state.categoryCounts !== "object")
    state.categoryCounts = {};
  if (!state.lastUsed || typeof state.lastUsed !== "object")
    state.lastUsed = {};
  const available = messages.filter((m) => !state.used.includes(m.id));
  const pool = available.length ? available : messages;
  if (!available.length) {
    state.used = [];
    state.categoryCounts = {};
  }
  const notToday = pool.filter((m) => state.lastUsed[m.id] !== today);
  const candidates = notToday.length ? notToday : pool;
  const minCount = Math.min(
    ...candidates.map((m) => state.categoryCounts[m.category] || 0),
  );
  const balanced = candidates.filter(
    (m) => (state.categoryCounts[m.category] || 0) === minCount,
  );
  const chosen =
    balanced[Math.floor(Math.random() * balanced.length)] || candidates[0];
  state.used.push(chosen.id);
  state.categoryCounts[chosen.category] =
    (state.categoryCounts[chosen.category] || 0) + 1;
  state.lastUsed[chosen.id] = today;
  localStorage.setItem(MOTIVATION_STATE_KEY, JSON.stringify(state));
  return chosen.category + ": " + chosen.text;
}

function showSaleSuccess(profit) {
  const hasProfit = profit != null && Number.isFinite(Number(profit));
  showSplash("", hasProfit ? Number(profit) : 0, hasProfit ? Number(profit) : null, true);
  const msg = document.getElementById("splash-msg");
  const sub = document.getElementById("splash-sub");
  const label = document.querySelector(
    "#splash-profit-wrap .splash-profit-lbl",
  );
  const motivation = document.getElementById("splash-motivation");
  if (msg) msg.textContent = "Congratulations!";
  if (label) label.textContent = hasProfit ? "Profit earned" : "Profit";
  if (sub) {
    sub.textContent = hasProfit
      ? "You earned " + fmt(Number(profit)) + " from this sale."
      : "Sale recorded. Profit is unavailable because the item cost is unknown.";
  }
  const profitWrap = document.getElementById("splash-profit-wrap");
  if (profitWrap) profitWrap.style.display = hasProfit ? "block" : "none";
  if (motivation) {
    motivation.textContent = getSaleMotivation();
    motivation.style.display = "block";
  }
}

// ===== MAKE A SALE =====
let currentSellItemId = null;
let _selectedPayment = "cash"; // cash | mpesa
let _isShoeSale = false;
let _sellShoeItem = null;
let _sellShoeSize = null; // full sizeRec object

async function _legacySearchSell() {
  try {
    const q = (document.getElementById("sell-search").value || "")
      .trim()
      .toLowerCase();
    const results = document.getElementById("sell-results");
    if (!q) {
      results.innerHTML = "";
      return;
    }
    const items = await dbAll("items");
    const matched = items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        i.code.toLowerCase().includes(q) ||
        (i.size || "").toLowerCase().includes(q),
    );
    if (!matched.length) {
      results.innerHTML =
        '<div class="empty" style="padding:24px 0;"><div class="e-icon" style="font-size:36px;"><i class="fa-solid fa-magnifying-glass"></i></div><p>No items found</p></div>';
      return;
    }
    results.innerHTML = matched
      .map((item) => {
        const t = getTypeObj(item.type);
        const outOfStock = item.qty === 0;
        const stockColor = outOfStock
          ? "var(--red)"
          : item.qty <= 3
            ? "var(--amber)"
            : "var(--green)";
        return `<div class="item-card" onclick="${outOfStock ? "" : "openSellModal(" + item.id + ")"}"
      style="margin-bottom:10px;${outOfStock ? "opacity:0.5;pointer-events:none;" : "cursor:pointer;"}">
      <div class="item-top">
        <div class="item-icon" style="background:${t.color || "var(--surface2)"};">${t.emoji}</div>
        <div class="item-body">
          <div class="item-code">${item.code}${item.size ? " - " + item.size : ""}</div>
          <div class="item-name">${item.name || ""}</div>
          <div class="item-tags">
            <span class="tag tag-cyan">${item.type}</span>
            <span class="tag" style="background:${outOfStock ? "var(--red-light)" : item.qty <= 3 ? "var(--amber-light)" : "var(--green-light)"};color:${stockColor};">
              ${outOfStock ? "Out of stock" : item.qty + " pcs"}
            </span>
          </div>
        </div>
        <div class="item-right">
          <div style="font-size:18px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(item.sell)}</div>
          <div style="font-size:11px;color:var(--green);font-family:var(--mono);margin-top:3px;">+${fmt(item.profit)} profit</div>
          ${!outOfStock ? '<div style="margin-top:8px;background:var(--accent);color:white;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;text-align:center;">Sell</div>' : ""}
        </div>
      </div>
    </div>`;
      })
      .join("");
  } catch (e) {
    console.error("[searchSell]", e);
    toast("Error: " + e.message, "err");
  }
}

let _sellSearchTimer = null;

async function searchSell() {
  return _renderSellMatches(_sellSearchVersion);
}

let _sellSearchVersion = 0;
let _sellSearchActiveIndex = -1;
let _quickSellSaving = false;
let _quickSellOutsideHandlerBound = false;
let _quickSellIsRecord = true;

function _setSellSearchState(state, message) {
  const input = document.getElementById("sell-search");
  const status = document.getElementById("sell-search-status");
  const results = document.getElementById("sell-results");
  if (!input || !status || !results) return;
  input.classList.remove("is-found", "is-missing");
  if (state === "found") input.classList.add("is-found");
  if (state === "missing") input.classList.add("is-missing");
  status.textContent = message;
  status.className =
    "sell-search-status is-screen-reader-only" + (state ? " is-" + state : "");
}

function _hideSellResults() {
  const results = document.getElementById("sell-results");
  const input = document.getElementById("sell-search");
  if (results) {
    results.hidden = true;
    results.innerHTML = "";
  }
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  _sellSearchActiveIndex = -1;
}

function _bindSellSearchDismissal() {
  if (_quickSellOutsideHandlerBound) return;
  _quickSellOutsideHandlerBound = true;
  document.addEventListener("click", (event) => {
    const container = document.querySelector("[data-stocklist-sales]");
    if (container && !container.contains(event.target)) _hideSellResults();
  });
}

function onSellSearch(val, input = document.getElementById("sell-search")) {
  if (!input || !input.closest("[data-stocklist-sales]")) return;
  const version = ++_sellSearchVersion;
  clearTimeout(_sellSearchTimer);
  _bindSellSearchDismissal();
  const raw = String(val || "").trim();
  if (raw.length < 2) {
    _hideSellResults();
    _setSellSearchState("", "Search item to sell");
    return;
  }
  _setSellSearchState("", "Searching inventory…");
  const results = document.getElementById("sell-results");
  if (results) {
    results.hidden = false;
    results.innerHTML = '<div class="sell-search-loading">Searching inventory…</div>';
  }
  _sellSearchTimer = setTimeout(() => _renderSellMatches(version), 150);
}
window.onSellSearch = onSellSearch;

function clearSellSearch() {
  const inp = document.getElementById("sell-search");
  if (inp) inp.value = "";
  if (inp) onInventorySearch("", inp);
  if (inp) inp.focus();
}
window.clearSellSearch = clearSellSearch;

function onSellSearchKeydown(event, input) {
  if (!input?.closest("[data-stocklist-sales]")) return;
  const results = document.getElementById("sell-results");
  if (!results || results.hidden) {
    if (event.key === "Escape") _hideSellResults();
    return;
  }
  const options = Array.from(results.querySelectorAll('[role="option"]'));
  if (!options.length) return;
  if (event.key === "Escape") {
    event.preventDefault();
    _hideSellResults();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    _sellSearchActiveIndex =
      (_sellSearchActiveIndex + direction + options.length) % options.length;
    options.forEach((option, index) => {
      const selected = index === _sellSearchActiveIndex;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("is-active", selected);
    });
    const active = options[_sellSearchActiveIndex];
    const input = document.getElementById("sell-search");
    if (input && active) input.setAttribute("aria-activedescendant", active.id);
    if (active) active.scrollIntoView({ block: "nearest" });
    return;
  }
  if (event.key === "Enter" && _sellSearchActiveIndex >= 0) {
    event.preventDefault();
    const active = options[_sellSearchActiveIndex];
    if (active) active.click();
  }
}
window.onSellSearchKeydown = onSellSearchKeydown;

function _normaliseSellName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function _renderSellMatches(version) {
  try {
    const input = document.getElementById("sell-search");
    const results = document.getElementById("sell-results");
    if (!input || !results || version !== _sellSearchVersion) return;
    const raw = input.value.trim();
    const query = _normaliseSellName(raw);
    if (query.length < 2) return;
    const items =
      Array.isArray(allItems) && allItems.length ? allItems : await dbAll("items");
    if (version !== _sellSearchVersion || input.value.trim() !== raw) return;
    const matchedItems = items
      .map((item) => ({ item, score: _gscScore(item, raw) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || String(a.item.name || "").localeCompare(String(b.item.name || "")));
    const totalMatches = matchedItems.length;
    const maxMatches = matchedItems.slice(0, 8);
    if (!totalMatches) {
      _setSellSearchState("missing", "Item does not exist.");
      results.hidden = false;
      results.innerHTML = `
        <button type="button" class="sell-search-new" role="option" id="sell-option-new">
          <strong>“${escapeHtml(raw)}” is NOT in the inventory.</strong>
          <span>Click to sell it and automatically add it PARTIALLY to the inventory.</span>
        </button>`;
      results.querySelector("#sell-option-new").addEventListener("click", () => {
        const itemName = input.value.trim();
        _hideSellResults();
        openQuickSell(null, itemName);
      });
      input.setAttribute("aria-expanded", "true");
      _sellSearchActiveIndex = 0;
      return;
    }

    _setSellSearchState("found", `${totalMatches} match${totalMatches === 1 ? "" : "es"} in inventory. Select one.`);
    const rows = [];
    for (const { item } of maxMatches) {
      const category = item.type || "No category";
      const price = item.sellPrice ?? item.sell ?? null;
      const quantity = item.isRecord ? null : await displayStockQty(item);
      rows.push({
        item,
        name: item.name || item.code || "Unnamed item",
        code: item.code || "No code",
        category,
        quantity,
        price,
        recordOnly: !!item.isRecord,
      });
    }
    if (version !== _sellSearchVersion || input.value.trim() !== raw) return;
    results.innerHTML = `
      <div class="sell-search-message is-found">Showing ${Math.min(rows.length, 8)} of ${totalMatches} match${totalMatches === 1 ? "" : "es"} in inventory. Select one.</div>
      ${rows.slice(0, 8).map((row, index) => `
        <button type="button" class="sell-search-option" role="option" aria-selected="false" id="sell-option-${index}" data-item-id="${Number(row.item.id)}">
          <span class="sell-search-option-main">
            <span class="sell-search-name">${escapeHtml(row.name)}</span>
            <span class="sell-search-meta">${escapeHtml(row.code)} · ${escapeHtml(row.category)}</span>
          </span>
          <span class="sell-search-option-data">
            <span class="sell-search-stock">${row.recordOnly ? "Record Only" : `${Number(row.quantity || 0)} in stock`}</span>
            <span class="sell-search-price">${row.price == null ? "Price not set" : fmt(row.price)}</span>
            ${row.item.incomplete ? '<span class="sell-search-badge is-incomplete">Incomplete</span>' : '<span class="sell-search-badge">In inventory</span>'}
          </span>
        </button>`).join("")}
      ${totalMatches > rows.length ? `<div class="sell-search-more">${totalMatches - rows.length} more inventory match${totalMatches - rows.length === 1 ? "" : "es"} not shown</div>` : ""}
    `;
    results.querySelectorAll(".sell-search-option").forEach((button) => {
      button.addEventListener("click", () => {
        const item = items.find((entry) => String(entry.id) === button.dataset.itemId);
        if (!item) {
          toast("This inventory item is no longer available. Search again.", "err");
          return;
        }
        _hideSellResults();
        if (item.incomplete) {
          openQuickSell(item);
        } else {
          openSheet(item.id);
        }
      });
    });
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
    _sellSearchActiveIndex = -1;
    _bindSellSearchDismissal();
  } catch (error) {
    console.error("[searchSell]", error);
    const results = document.getElementById("sell-results");
    if (results) {
      results.hidden = false;
      results.innerHTML = '<div class="sell-search-error">Could not search inventory. Please try again.</div>';
    }
    _setSellSearchState("", "Inventory search failed. Please try again.");
    toast("Could not search inventory: " + (error.message || "Unknown error"), "err");
  }
}

function openQuickSell(item, typedName) {
  const page = document.getElementById("quick-sell-page");
  const salesView = document.getElementById("sales-main-view");
  if (!page || !salesView) return;
  const title = document.getElementById("quick-sell-title");
  const note = document.getElementById("quick-sell-note");
  if (title) title.textContent = item ? "Sell incomplete item" : "Sell item not in inventory";
  if (note) {
    note.textContent = item
      ? "Record this sale and update the item's available details."
      : "This item will be added to inventory as Record Only. Stock quantity will not be tracked. Enter item name and sell price; other details are optional.";
  }
  const setValue = (id, value) => {
    const field = document.getElementById(id);
    if (field) field.value = value == null ? "" : String(value);
  };
  setValue("quick-sell-item-id", item ? item.id : "");
  setValue("quick-sell-name", item ? item.name : typedName || "");
  setValue("quick-sell-qty", "0");
  setValue("quick-sell-stock-qty", item && !item.isRecord ? item.qty || 0 : 0);
  setValue("quick-sell-price", item ? item.sellPrice ?? item.sell ?? "" : "");
  const existingBuyPrice = item ? item.buyPrice ?? item.buy : 0;
  setValue("quick-sell-buy", existingBuyPrice ?? 0);
  setValue("quick-sell-code", item ? item.code || "" : "");
  const category = document.getElementById("quick-sell-category");
  if (category) {
    const options = ['<option value="">Choose category...</option>'];
    walkCategoryTree((type, depth) => {
      if (!isCategoryActive(type) || _categoryHasActiveChildren(type.id)) return;
      const prefix = depth ? "\u2003".repeat(depth) + "\u21b3 " : "";
      options.push(
        `<option value="${escapeHtml(type.name)}">${escapeHtml(prefix + (type.emoji || "📦") + " " + type.name)}</option>`,
      );
    });
    category.innerHTML = options.join("");
    category.value = item?.type || "";
  }
  const buyUnknown = document.getElementById("quick-sell-buy-unknown");
  if (buyUnknown) {
    buyUnknown.checked = !!item && existingBuyPrice == null;
    toggleQuickSellBuyUnknown(buyUnknown.checked);
  }
  setQuickSellMode(item ? item.isRecord !== false : true);
  _quickSellSaving = false;
  const submit = document.getElementById("quick-sell-submit");
  if (submit) {
    submit.disabled = false;
    submit.innerHTML = '<i class="fa-solid fa-check"></i> Sell item';
  }
  const error = document.getElementById("quick-sell-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  salesView.hidden = true;
  page.hidden = false;
  window.scrollTo(0, 0);
  setTimeout(() => document.getElementById("quick-sell-name")?.focus(), 80);
}
window.openQuickSell = openQuickSell;

function toggleQuickSellBuyUnknown(isUnknown) {
  const input = document.getElementById("quick-sell-buy");
  if (input) input.disabled = !!isUnknown;
}
window.toggleQuickSellBuyUnknown = toggleQuickSellBuyUnknown;

function closeQuickSell() {
  const page = document.getElementById("quick-sell-page");
  const salesView = document.getElementById("sales-main-view");
  if (page) page.hidden = true;
  if (salesView) salesView.hidden = false;
  document.getElementById("sell-search")?.focus();
}
window.closeQuickSell = closeQuickSell;

function setQuickSellMode(isRecord) {
  _quickSellIsRecord = !!isRecord;
  const toggle = document.getElementById("quick-sell-mode-toggle");
  if (toggle) toggle.checked = !_quickSellIsRecord;
  const modeBar = document.getElementById("quick-sell-item-mode");
  if (modeBar) modeBar.classList.toggle("record-mode", _quickSellIsRecord);
  document
    .getElementById("quick-sell-mode-record")
    ?.classList.toggle("mode-opt-active", _quickSellIsRecord);
  document
    .getElementById("quick-sell-mode-track")
    ?.classList.toggle("mode-opt-active", !_quickSellIsRecord);
  const stockField = document.getElementById("quick-sell-stock-field");
  if (stockField) {
    stockField.hidden = _quickSellIsRecord;
    stockField.style.display = _quickSellIsRecord ? "none" : "";
  }
  const note = document.getElementById("quick-sell-mode-note");
  const message = document.getElementById("quick-sell-mode-message");
  const subtitle = document.getElementById("quick-sell-note");
  const isExistingItem = !!document.getElementById("quick-sell-item-id")?.value;
  if (note) note.classList.toggle("track-mode-note", !_quickSellIsRecord);
  if (message) {
    message.textContent = _quickSellIsRecord
      ? "Qty not tracked - item always shows as available for sale."
      : "Qty is tracked - enter the stock available before this sale.";
  }
  if (subtitle) {
    subtitle.textContent = isExistingItem
      ? _quickSellIsRecord
        ? "Record this sale and update the item's available details."
        : "Record this sale and reduce the item's tracked stock by the quantity sold."
      : _quickSellIsRecord
        ? "This item will be added to inventory as Record Only. Stock quantity will not be tracked. Enter item name and sell price; code is optional."
        : "This item will be added to inventory with tracked stock, reduced by the quantity sold. Enter item name, stock quantity, and sell price.";
  }
}
window.setQuickSellMode = setQuickSellMode;
async function submitQuickSell() {
  if (_quickSellSaving) return;
  if (!requireOpenDay()) return;
  const name = document.getElementById("quick-sell-name")?.value.trim().replace(/\s+/g, " ") || "";
  const qtyRaw = document.getElementById("quick-sell-qty")?.value ?? "";
  const qty = Number(qtyRaw);
  const stockQtyRaw = document.getElementById("quick-sell-stock-qty")?.value ?? "0";
  const stockQty = Number(stockQtyRaw);
  const priceRaw = document.getElementById("quick-sell-price")?.value ?? "";
  const sellPrice = priceRaw.trim() === "" ? NaN : Number(priceRaw);
  const buyRaw = document.getElementById("quick-sell-buy")?.value ?? "";
  const buyIsUnknown = !!document.getElementById("quick-sell-buy-unknown")?.checked;
  const buyPrice = buyIsUnknown
    ? null
    : buyRaw.trim() === ""
      ? NaN
      : Number(buyRaw);
  const category = document.getElementById("quick-sell-category")?.value.trim() || "";
  const code = sanitiseCode(document.getElementById("quick-sell-code")?.value || "");
  const itemIdRaw = document.getElementById("quick-sell-item-id")?.value || "";
  const errorBox = document.getElementById("quick-sell-error");
  const showError = (message) => {
    if (errorBox) {
      errorBox.textContent = message;
      errorBox.hidden = false;
    }
  };
  if (!name) return showError("Enter an item name.");
  if (name.length > 120)
    return showError("Item name must be 120 characters or fewer.");
  const saleQty = qty;
  if (!Number.isInteger(saleQty) || saleQty < 1 || saleQty > 999999)
    return showError("Quantity must be a whole number from 1 to 999,999.");
  if (!Number.isFinite(sellPrice) || sellPrice <= 0)
    return showError("Enter a sell price greater than zero.");
  if (buyPrice !== null && (!Number.isFinite(buyPrice) || buyPrice < 0))
    return showError("Buy price must be 0 or more.");
  if (!_quickSellIsRecord) {
    if (!Number.isInteger(stockQty) || stockQty < 0 || stockQty > 999999)
      return showError("Stock quantity must be a whole number from 0 to 999,999.");
    if (stockQty < saleQty)
      return showError("Stock quantity must be at least the quantity being sold.");
  }
  if (code && code.length > 40) return showError("Code must be 40 characters or fewer.");
  if (itemIdRaw && (!Number.isInteger(Number(itemIdRaw)) || Number(itemIdRaw) <= 0))
    return showError("This inventory item is invalid. Search again.");

  const item = {
    id: itemIdRaw ? Number(itemIdRaw) : null,
    name,
    code,
    type: category,
    buyPrice,
    sellPrice,
    isRecord: _quickSellIsRecord,
    stockQty: _quickSellIsRecord ? 0 : stockQty,
  };
  const sale = {
    itemName: name,
    qty: saleQty,
    sellPrice,
    actualPrice: sellPrice,
    revenue: saleQty * sellPrice,
    profit: buyPrice == null ? null : saleQty * (sellPrice - buyPrice),
    paymentMethod: "cash",
  };
  if (
    !Number.isFinite(sale.revenue) ||
    (sale.profit != null && !Number.isFinite(sale.profit))
  ) {
    return showError("Sale totals are too large to record.");
  }
  _quickSellSaving = true;
  if (errorBox) {
    errorBox.hidden = true;
    errorBox.textContent = "";
  }
  const submit = document.getElementById("quick-sell-submit");
  if (submit) {
    submit.disabled = true;
    submit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';
  }
  try {
    const result = await persistQuickSellAtomically({ item, sale });
    closeQuickSell();
    try {
      allItems = await dbAll("items");
      await renderList();
      await renderDashboard();
      await renderStockMonitor();
      await refreshSalesViews();
      if (activeDay) updateDayLiveStats();
      scheduleSync();
    } catch (refreshError) {
      console.error("[submitQuickSell] sale saved but view refresh failed", refreshError);
      toast("Sale saved, but some views could not refresh. Reload to see the latest inventory.", "err");
    }
    const search = document.getElementById("sell-search");
    if (search) {
      search.value = "";
      onSellSearch("");
    }
    showPage("history");
    showSaleSuccess(result.sale.profit);
  } catch (saveError) {
    console.error("[submitQuickSell]", saveError);
    showError("Sale was not saved. " + (saveError.message || "Please try again."));
    toast("Could not save sale: " + (saveError.message || "Please try again"), "err");
  } finally {
    _quickSellSaving = false;
    if (submit) {
      submit.disabled = false;
      submit.innerHTML = '<i class="fa-solid fa-rotate-right"></i> Retry Sell item';
    }
  }
}
window.submitQuickSell = submitQuickSell;

function selectPayment(method) {
  _selectedPayment = method;
  // Reset all payment buttons
  document
    .querySelectorAll(".pay-btn")
    .forEach((btn) => btn.classList.remove("active"));
  // Activate selected
  const idMap = {
    cash: "pay-cash",
    mpesa: "pay-mpesa",
    Cash: "pay-cash",
    "M-Pesa": "pay-mpesa",
  };
  const btnId = idMap[method] || "pay-cash";
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add("active");
}

// Shows the "enter buy price" field only when the item/size has no cost on record yet.
function _toggleSmBuyField(currentBuy) {
  const field = document.getElementById("sm-buy-field");
  const input = document.getElementById("sm-buy");
  if (input) input.value = "";
  if (field) field.style.display = currentBuy > 0 ? "none" : "";
}

function _showSellFormPage() {
  const sellPage = document.getElementById("sell-modal");
  if (!sellPage?.classList.contains("active")) {
    const activePage = document.querySelector(".page.active");
    const pageId = activePage?.id || "page-sell";
    window._sellFormReturnPage =
      pageId === "detail-sheet"
        ? "item-detail"
        : pageId === "sell-modal"
          ? "sell"
          : pageId.replace(/^page-/, "") || "sell";
  }
  showPage("sell-form");
}

async function openSellModal(itemId) {
  try {
    const item = await dbGet("items", itemId);
    if (!item) {
      toast("Warning: Item not found", "err");
      return;
    }
    const availableQty = item.isRecord ? 0 : await readableStockQty(item);
    if (availableQty <= 0 && !item.isRecord) {
      toast(
        "Warning: " +
          (item.name || item.code) +
          " is out of stock - restock first",
        "err",
      );
      return;
    }
    currentSellItemId = itemId;
    const t = getTypeObj(item.type);
    document.getElementById("sm-icon").textContent = t.emoji;
    document.getElementById("sm-icon").style.background =
      t.color || "var(--surface2)";
    document.getElementById("sm-name").textContent = item.name;
    document.getElementById("sm-meta").textContent =
      item.code +
      (item.size ? " - " + item.size : "") +
      (item.isRecord ? " · Record" : "");
    document.getElementById("sm-stock").textContent = item.isRecord
      ? "∞"
      : availableQty;
    const _itemSell = item.sellPrice || item.sell || 0;
    const _itemBuy = item.buyPrice || item.buy || 0;
    const _itemSellMin = item.sellPriceMin || 0;
    document.getElementById("sm-sell").textContent = fmt(_itemSell);
    const _smPriceRange = document.getElementById("sm-price-range");
    const _smMinVal = document.getElementById("sm-price-min-val");
    if (_smPriceRange) {
      if (_itemSellMin > 0 && _itemSellMin < _itemSell) {
        if (_smMinVal) _smMinVal.textContent = fmt(_itemSellMin);
        _smPriceRange.style.display = "block";
      } else {
        _smPriceRange.style.display = "none";
      }
    }
    const _maxProfit = _itemSell - _itemBuy;
    const _minProfit = _itemSellMin > 0 ? _itemSellMin - _itemBuy : _maxProfit;
    const _smProfit = document.getElementById("sm-profit");
    if (_smProfit) {
      _smProfit.textContent =
        _itemSellMin > 0 && _itemSellMin < _itemSell
          ? "+" + fmt(_minProfit) + " – +" + fmt(_maxProfit)
          : (_maxProfit >= 0 ? "+" : "") + fmt(_maxProfit);
    }
    const _smProfitRange = document.getElementById("sm-profit-range");
    if (_smProfitRange) _smProfitRange.style.display = "none";
    const _tpel = document.getElementById("sm-total-profit");
    if (_tpel)
      _tpel.textContent = (_maxProfit >= 0 ? "+" : "") + fmt(_maxProfit);
    document.getElementById("sm-cur").textContent = currency;
    document.getElementById("sm-qty").value = 0;
    document.getElementById("sm-qty").min = 0;
    document.getElementById("sm-qty").max = item.isRecord
      ? 999999
      : availableQty;
    document.getElementById("sm-actual").value = "";
    _toggleSmBuyField(_itemBuy);
    updateSellModal();
    _showSellFormPage();
  } catch (e) {
    console.error("[openSellModal]", e);
    toast("Error: " + e.message, "err");
  }
}

function closeSellModal() {
  const modal = document.getElementById("sell-modal");
  const wasActive = modal?.classList.contains("active");
  currentSellItemId = null;
  _isShoeSale = false;
  _sellShoeItem = null;
  _sellShoeSize = null;
  if (wasActive) showPage(window._sellFormReturnPage || "sell");
}

async function updateSellModal() {
  try {
    if (!currentSellItemId) return;
    const item = await dbGet("items", currentSellItemId);
    // For shoe sales use the specific size record prices & stock
    const basePrice =
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.sellPrice || item.sellPrice || item.sell || 0
        : item.sell || item.sellPrice || 0;
    const buyOnRecord =
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.buyPrice || item.buyPrice || item.buy || 0
        : item.buy || item.buyPrice || 0;
    const buyRaw = parseFloat(document.getElementById("sm-buy")?.value);
    const baseBuy = !isNaN(buyRaw) && buyRaw >= 0 ? buyRaw : buyOnRecord;
    const maxStock = item.isRecord
      ? 999999
      : await readableStockQty(
          _isShoeSale && _sellShoeSize ? _sellShoeSize : item,
          _isShoeSale && _sellShoeSize ? _sellShoeSize.id : null,
        );
    const qtyEl = document.getElementById("sm-qty");
    const rawQty = qtyEl?.value ?? "";
    let qty = Number(rawQty);
    if (rawQty === "" || !Number.isFinite(qty) || qty < 0) qty = 0;
    if (qty > maxStock) {
      qty = maxStock;
      if (qtyEl) qtyEl.value = String(qty);
      toast("Only " + maxStock + " in stock", "err");
    }
    if (qtyEl) {
      qtyEl.min = 0;
      qtyEl.max = maxStock;
    }
    const actualRaw = parseFloat(document.getElementById("sm-actual").value);
    const priceUsed =
      !isNaN(actualRaw) && actualRaw > 0 ? actualRaw : basePrice;
    const totalRev = qty * priceUsed;
    const totalProfit = qty * (priceUsed - baseBuy);
    const overridden =
      !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== basePrice;
    document.getElementById("sm-price-used").textContent =
      fmt(priceUsed) + (overridden ? " (custom)" : " (default)");
    document.getElementById("sm-total-rev").textContent = fmt(totalRev);
    document.getElementById("sm-total-profit").textContent =
      (totalProfit >= 0 ? "+" : "") + fmt(totalProfit);
    document.getElementById("sm-total-profit").style.color =
      totalProfit >= 0 ? "var(--green)" : "var(--red)";
    document.getElementById("sm-qty").max = maxStock;
    // Update per-item profit display + warn if below cost
    const profitPerItem = priceUsed - baseBuy;
    const smProfit = document.getElementById("sm-profit");
    if (smProfit) {
      smProfit.textContent =
        (profitPerItem >= 0 ? "+" : "") + fmt(profitPerItem);
      smProfit.style.color = profitPerItem >= 0 ? "var(--green)" : "var(--red)";
    }
    // ── Min-price floor warning ────────────────────────────────────
    const sellMin =
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.sellPriceMin || 0
        : item.sellPriceMin || 0;
    const minWarn = document.getElementById("sm-min-warn");
    const belowMin = sellMin > 0 && priceUsed > 0 && priceUsed < sellMin;
    if (minWarn) minWarn.style.display = belowMin ? "block" : "none";

    const confirmBtn = document.getElementById("confirm-sale-btn");
    if (confirmBtn) {
      confirmBtn.textContent = belowMin
        ? "⚠ CONFIRM BELOW MIN"
        : "CONFIRM SALE";
      confirmBtn.style.background = belowMin ? "#d97706" : "#1e7a3e";
      confirmBtn.title =
        priceUsed < baseBuy && priceUsed > 0
          ? "Warning: selling below cost price"
          : "";
    }
  } catch (e) {
    console.error("[updateSellModal]", e);
    toast("Error: " + e.message, "err");
  }
}

function adjSellQty(d) {
  const inp = document.getElementById("sm-qty");
  if (!inp) return;
  let v = (parseInt(inp.value) || 0) + d;
  const parsedMax = parseInt(inp.max, 10);
  const max = Number.isFinite(parsedMax) ? Math.max(0, parsedMax) : 999999;
  if (v > max) {
    toast("Warning: Only " + max + " in stock", "err");
    v = max;
  }
  inp.value = Math.max(0, v);
  updateSellModal();
}

async function confirmSale() {
  if (!currentSellItemId) return;
  if (!requireOpenDay()) return;
  await withSaleLock(currentSellItemId, () => confirmSaleUnlocked());
}

async function confirmSaleUnlocked() {
  if (!currentSellItemId) return;
  if (!requireOpenDay()) return;

  // Gray out confirm button + show progress overlay
  const _confirmBtn = document.getElementById("confirm-sale-btn");
  _overlay.show("Processing Sale...", _confirmBtn);

  try {
    const item = await dbGet("items", currentSellItemId);
    if (!item) {
      toast("Item not found", "err");
      closeSellModal();
      _overlay.hide();
      return;
    }
    if (_isShoeSale && _sellShoeSize) {
      const currentSizes = await getShoeSizes(item.code);
      const currentSize = currentSizes.find(
        (size) => String(size.id) === String(_sellShoeSize.id),
      );
      if (!currentSize) {
        toast("Shoe size is no longer available", "err");
        closeSellModal();
        return;
      }
      _sellShoeSize = currentSize;
    }

    // ── Read form values ───────────────────────────────────────────
    const qtyEl = document.getElementById("sm-qty");
    const actualEl = document.getElementById("sm-actual");
    const buyEl = document.getElementById("sm-buy");
    const qty = Number(qtyEl?.value || "0");
    const actualInput = actualEl?.value.trim() || "";
    const buyInput = buyEl?.value.trim() || "";
    const actualRaw = actualInput === "" ? NaN : Number(actualInput);
    const buyEntered = buyInput === "" ? null : Number(buyInput);

    // ── Prices - use normalized sellPrice/buyPrice ─────────────────
    const sellPrice =
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.sellPrice || item.sellPrice || item.sell || 0
        : item.sellPrice || item.sell || 0;
    const buyOnRecord = Number(
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.buyPrice ?? item.buyPrice ?? item.buy ?? 0
        : item.buyPrice ?? item.buy ?? 0,
    );
    if (buyEntered !== null && (!Number.isFinite(buyEntered) || buyEntered < 0)) {
      Validate.fail("Buy price must be 0 or more", "sm-buy");
      _overlay.hide();
      return;
    }
    if (!Number.isNaN(actualRaw) && (!Number.isFinite(actualRaw) || actualRaw <= 0)) {
      Validate.fail("Actual sale price must be greater than zero", "sm-actual");
      _overlay.hide();
      return;
    }
    // If there was no buy price on record, use whatever the user entered at sell time and save it.
    const buyPriceEntered =
      buyOnRecord <= 0 && buyEntered !== null;
    const buyPrice = buyPriceEntered ? buyEntered : buyOnRecord;

    const priceUsed =
      Number.isFinite(actualRaw) && actualRaw > 0 ? actualRaw : sellPrice;

    // ── Validate stock ─────────────────────────────────────────────
    const maxQty =
      _isShoeSale && _sellShoeSize
        ? await readableStockQty(_sellShoeSize, _sellShoeSize.id)
        : await readableStockQty(item);
    const itemLabel = item.name || item.code;
    if (!Number.isInteger(qty) || qty < 1 || qty > 999999) {
      Validate.fail("Enter a whole quantity from 1 to 999,999", "sm-qty");
      _overlay.hide();
      return;
    }
    if (!item.isRecord) {
      if (qty > maxQty) {
        Validate.fail(
          "Only " + maxQty + " in stock - cannot sell " + qty,
          "sm-qty",
        );
        _overlay.hide();
        return;
      }
      if (!Validate.stock(qty, maxQty, itemLabel)) {
        _overlay.hide();
        return;
      }
    }

    // ── Validate sale price and cost ────────────────────────────────
    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
      Validate.fail("Sale price must be greater than zero", "sm-actual");
      _overlay.hide();
      return;
    }
    if (!Number.isFinite(buyPrice) || buyPrice < 0) {
      Validate.fail("Buy price must be 0 or more", "sm-buy");
      _overlay.hide();
      return;
    }
    if (!Number.isFinite(priceUsed) || priceUsed <= 0) {
      Validate.fail("Sale price must be greater than zero", "sm-actual");
      _overlay.hide();
      return;
    }
    if (buyPrice >= priceUsed) {
      Validate.fail("Buy price must be less than sale price", "sm-buy");
      _overlay.hide();
      return;
    }
    const _sellMin =
      _isShoeSale && _sellShoeSize
        ? _sellShoeSize.sellPriceMin || 0
        : item.sellPriceMin || 0;
    if (_sellMin > 0 && priceUsed < _sellMin) {
      const go = confirm(
        "Price " +
          fmt(priceUsed) +
          " is below minimum " +
          fmt(_sellMin) +
          ".\nSell anyway?",
      );
      if (!go) {
        _overlay.hide();
        return;
      }
    }

    const revenue = qty * priceUsed;
    const profit = qty * (priceUsed - buyPrice);
    if (!Number.isFinite(revenue) || !Number.isFinite(profit)) {
      Validate.fail("Sale totals are too large to record", "sm-actual");
      _overlay.hide();
      return;
    }

    const paymentMethod = "cash";

    const sale = {
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name || item.code,
      itemType: item.type || "",
      itemSize:
        _isShoeSale && _sellShoeSize
          ? String(_sellShoeSize.size)
          : item.variant || item.size || "",
      qty,
      buyPrice,
      sellPrice,
      actualPrice: priceUsed,
      revenue,
      profit,
      overridden: !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== sellPrice,
      paymentMethod,
      soldBy: currentUser ? currentUser.username : "system",
      businessDate: todayDateStr(), // auto-assigned by date
      date: new Date().toISOString(),
    };

    // ── Persist a newly-entered buy price so future sales use it ────
    if (buyPriceEntered) {
      if (_isShoeSale && _sellShoeSize) {
        _sellShoeSize.buyPrice = buyPrice;
        _sellShoeSize.profit = sellPrice - buyPrice;
      } else {
        item.buyPrice = buyPrice;
        item.profit = sellPrice - buyPrice;
      }
    }

    // ── Deduct stock (skip for record-only items) ─────────────────
    if (!item.isRecord) {
      if (_isShoeSale && _sellShoeSize) {
        _sellShoeSize.qty = Math.max(0, (_sellShoeSize.qty || 0) - qty);
        _sellShoeSize.updatedAt = new Date().toISOString();
        const allSz = await getShoeSizes(item.code);
        item.qty = allSz.reduce((t, s) => t + s.qty, 0);
        _sellShoeSize.qtyCache = Number(_sellShoeSize.qty || 0);
        item.qtyCache = Number(item.qty || 0);
      } else {
        item.qty = Math.max(0, item.qty - qty);
        item.qtyCache = Number(item.qty || 0);
      }
    }

    // ── Record sale ────────────────────────────────────────────────
    // Pre-assign fbId so IndexedDB stores it immediately
    sale.fbId = stableSaleFbId(sale);
    await persistSaleAtomically({
      item,
      shoeSize: !item.isRecord && _isShoeSale ? _sellShoeSize : null,
      sale,
      delta: item.isRecord ? 0 : -qty,
      actor: currentUser ? currentUser.username : "system",
    });

    // Sales are the source of truth for revenue - no duplicate finance row.

    // ── Close all overlays ─────────────────────────────────────────
    closeSellModal(); // sell modal
    closeSheet(); // detail sheet (if open)
    closeShoeSizeActions(); // size action sheet (if open)

    // ── Reset sell search if on sell page ─────────────────────────
    const sellSearch = document.getElementById("sell-search");
    const sellResults = document.getElementById("sell-results");
    if (sellSearch) sellSearch.value = "";
    if (sellResults) sellResults.innerHTML = "";

    // ── Refresh UI ─────────────────────────────────────────────────
    allItems = await dbAll("items");
    await enrichShoeItems(allItems);
    renderList();
    renderDashboard();
    updateHeader();
    updateLowStockBadge();
    scheduleSync();
    try {
      await refreshSalesViews();
    } catch (_) {
      /* intentionally ignored */
    }
    try {
      if (activeDay) updateDayLiveStats();
    } catch (_) {
      /* intentionally ignored */
    }
    showPage("history");
    // Refresh finance page if it's currently visible
    try {
      const financeVisible =
        document.getElementById("page-finance")?.classList.contains("active") ||
        (document
          .getElementById("page-operations")
          ?.classList.contains("active") &&
          _activeOperationsTab === "finance");
      if (financeVisible) {
        renderFinancePage();
      }
    } catch (_) {
      /* intentionally ignored */
    }

    const syncStatus = await saleSaveStatus();
    toast(
      syncStatus.pending
        ? fmt(revenue) + " - Sale saved locally, sync pending"
        : fmt(revenue) + " - Profit: " + fmt(profit),
      syncStatus.pending ? "" : "ok",
    );
    showSaleSuccess(profit);
  } catch (err) {
    console.error("[confirmSale]", err);
    toast("Warning: Sale failed: " + (err.message || "Unknown error"), "err");
  } finally {
    _overlay.hide();
  }
}

async function renderSellPage() {
  try {
    await searchSell();
  } catch (e) {
    console.error("[renderSellPage]", e);
    toast("Error: " + e.message, "err");
  }
}

async function refreshSalesViews() {
  try {
    await renderSellPage();
  } catch (_) {
    /* intentionally ignored */
  }
  try {
    await renderHistoryPage();
  } catch (_) {
    /* intentionally ignored */
  }
}

async function deleteSale(saleId) {
  try {
    if (!confirm("Delete this sale record? Stock will NOT be restored."))
      return;
    const sale = await dbGet("sales", saleId);
    if (sale) {
      _rememberDeletedSale(sale);
      await fbDeleteSale(sale);
      await fbDeleteFinanceEntry({
        type: "revenue",
        saleId: sale.id,
        amount: sale.revenue,
        date: sale.businessDate || (sale.date || "").split("T")[0],
        description: "Sale: " + (sale.itemName || sale.itemCode || "item"),
      });
      await _deleteLocalRevenueForSale(saleId);
    }
    await dbDelete("sales", saleId);
    await refreshUI();
    refreshSalesViews();
    renderFinancePage();
    toast("Sale record deleted", "");
  } catch (e) {
    console.error("[deleteSale]", e);
    toast("Error: " + e.message, "err");
  }
}

// ═══════════════════════════════════════════════════════════
// SALES EXPORT BY DATE FILTER
// ═══════════════════════════════════════════════════════════

function filterSalesByPeriod(sales, period) {
  const now = new Date();
  return sales.filter((s) => {
    const d = new Date(s.date);
    if (period === "today") {
      return d.toDateString() === now.toDateString();
    } else if (period === "week") {
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      return d >= weekAgo;
    } else if (period === "month") {
      return (
        d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
      );
    }
    return true; // all
  });
}

// ═══════════════════════════════════════════════════════════

let _histFocusedDate = null;
let _histNavigationStack = [];
let _histLastRenderedState = null;
let _histRenderGeneration = 0;
let _histScrollToRestore = null;

function _captureHistoryState() {
  return {
    filter: document.getElementById("hist-period-filter")?.value || "today",
    customFrom: document.getElementById("hist-custom-from")?.value || "",
    customTo: document.getElementById("hist-custom-to")?.value || "",
    focusedDate: _histFocusedDate,
    sort: { ..._histSort },
    scrollY: window.scrollY,
  };
}

function _rememberRenderedHistoryState() {
  _histLastRenderedState = _captureHistoryState();
}

function _restoreHistoryScroll() {
  if (_histScrollToRestore == null) return;
  const scrollY = _histScrollToRestore;
  _histScrollToRestore = null;
  requestAnimationFrame(() => {
    window.scrollTo(0, scrollY);
    if (_histLastRenderedState) _histLastRenderedState.scrollY = scrollY;
  });
}

function _updateHistoryNavigation(filterVal, isDayFocused) {
  const controls = document.getElementById("hist-navigation-controls");
  const back = document.getElementById("hist-back-button");
  const home = document.getElementById("hist-home-button");
  const hasPrevious = _histNavigationStack.length > 0;
  const showHome = isDayFocused || filterVal !== "today" || hasPrevious;
  if (controls) controls.hidden = hasPrevious || showHome ? false : true;
  if (back) back.hidden = !hasPrevious;
  if (home) home.hidden = !showHome;
}

function _historyDateOffset(today, offsetDays) {
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(year, month - 1, day + offsetDays);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function _weekStartDate(dateStr) {
  const daysSinceSunday = new Date(dateStr + "T12:00:00").getDay();
  return _historyDateOffset(dateStr, -daysSinceSunday);
}

function _historyFilterRange(filterVal, today, customFrom, customTo) {
  if (filterVal === "today")
    return {
      from: today,
      to: today,
      label: new Date(today + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    };
  if (filterVal === "yesterday") {
    const yesterday = _historyDateOffset(today, -1);
    return {
      from: yesterday,
      to: yesterday,
      label: new Date(yesterday + "T12:00:00").toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
    };
  }
  if (filterVal === "prev_week" || filterVal === "last_week") {
    const to = _historyDateOffset(_weekStartDate(today), -1);
    const from = _historyDateOffset(to, -6);
    return { from, to, label: from + " – " + to };
  }
  if (filterVal === "week") {
    const from = _weekStartDate(today);
    return { from, to: today, label: from + " – " + today };
  }
  if (filterVal === "month") {
    const from = today.slice(0, 8) + "01";
    return { from, to: today, label: from + " – " + today };
  }
  if (filterVal === "prev_month") {
    const currentMonthStart = today.slice(0, 8) + "01";
    const to = _historyDateOffset(currentMonthStart, -1);
    const from = to.slice(0, 8) + "01";
    return { from, to, label: from + " – " + to };
  }
  if (filterVal === "custom") {
    if (!customFrom || !customTo)
      return {
        from: "9999-12-31",
        to: today,
        label: "Choose a date range",
      };
    if (customFrom > customTo)
      return {
        from: "9999-12-31",
        to: today,
        label: "Invalid date range",
      };
    return {
      from: customFrom,
      to: customTo,
      label: customFrom + " – " + customTo,
    };
  }
  return { from: null, to: today, label: "All records" };
}

function _historySaleDate(sale, today) {
  const businessDate = sale.businessDate || sale.business_date;
  if (businessDate) return businessDate;
  if (!sale.date) return today;
  const date = new Date(sale.date);
  if (Number.isNaN(date.getTime())) return today;
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function _histCountLabel(count, singular) {
  return `${fmtN(count)} ${singular}${count === 1 ? "" : "s"}`;
}

async function _renderHistoryPage(generation) {
  const today = todayDateStr();
  // Ensure allItems is fresh for inventory status badges
  if (!allItems.length) allItems = await dbAll("items");

  const allSales = await dbAll("sales");
  if (generation !== _histRenderGeneration) return;

  const filterEl = UI.el("hist-period-filter");
  const filterVal = filterEl ? filterEl.value : "today";

  const customRangeEl = document.getElementById("hist-custom-range");
  const customFromEl = document.getElementById("hist-custom-from");
  const customToEl = document.getElementById("hist-custom-to");
  const historyRange = _historyFilterRange(
    filterVal,
    today,
    customFromEl?.value || "",
    customToEl?.value || "",
  );

  const byDate = {};
  allSales.forEach((s) => {
    const d = _historySaleDate(s, today);
    if (d > today) return; // never show future records
    if (historyRange.from && d < historyRange.from) return;
    if (historyRange.to && d > historyRange.to) return;
    if (!byDate[d])
      byDate[d] = {
        sales: [],
        revenue: 0,
        profit: 0,
        cost: 0,
        qty: 0,
      };
    byDate[d].sales.push(s);
    const qty = s.qty || 1;
    byDate[d].revenue +=
      Number(s.actualPrice || s.sellPrice || s.priceUsed || 0) * qty;
    byDate[d].profit += Number(s.profit) || 0;
    byDate[d].cost += (Number(s.buyPrice) || 0) * qty;
    byDate[d].qty += qty;
  });

  if (_histFocusedDate && !byDate[_histFocusedDate]) _histFocusedDate = null;
  const isDayFocused = Boolean(_histFocusedDate);
  document
    .getElementById("sales-slot-history")
    ?.classList.toggle("hist-day-focused", isDayFocused);
  if (customRangeEl)
    customRangeEl.style.display =
      filterVal === "custom" ? "flex" : "none";

  const rangeEl = document.getElementById("hist-range-label");
  if (rangeEl) {
    rangeEl.textContent = isDayFocused
      ? new Date(_histFocusedDate + "T12:00:00").toLocaleDateString("en-GB", {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : historyRange.label;
  }

  const datesSorted = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
  const isSingleDateFilter =
    filterVal === "today" ||
    filterVal === "yesterday" ||
    (filterVal === "custom" && historyRange.from === historyRange.to);
  const recList = UI.el("hist-records-list");
  if (!recList) return;
  _updateHistoryNavigation(filterVal, isDayFocused);

  if (isDayFocused) {
    recList.innerHTML = `
      <div class="hist-focused-context">${escapeHtml(filterEl?.selectedOptions[0]?.textContent.trim() || "Selected period")}</div>
      ${_histTable(byDate[_histFocusedDate].sales)}`;
    window._histByDate = byDate;
    _rememberRenderedHistoryState();
    _restoreHistoryScroll();
    return;
  }

  if (!datesSorted.length) {
    recList.innerHTML = `
      <div class="hist-empty-state">No sales recorded for this period.</div>
      ${_histTable([])}`;
    _rememberRenderedHistoryState();
    _restoreHistoryScroll();
    return;
  }
  if (isSingleDateFilter) {
    recList.innerHTML = _histTable(byDate[datesSorted[0]].sales);
    _rememberRenderedHistoryState();
    _restoreHistoryScroll();
    return;
  }
  const periodTotals =
    _histSalesTotals(datesSorted.flatMap((date) => byDate[date].sales));

  // Insights are calculated from the records currently included by the filter.
  const bestRevDay = datesSorted.reduce(
    (best, d) => (byDate[d].revenue > (byDate[best]?.revenue || 0) ? d : best),
    datesSorted[0],
  );
  const itemTotals = {};
  Object.values(byDate).forEach((day) =>
    day.sales.forEach((s) => {
      const key = s.itemCode || s.itemName || "Item";
      if (!itemTotals[key])
        itemTotals[key] = {
          name: s.itemName || s.itemCode || "Item",
          qty: 0,
          profit: 0,
        };
      itemTotals[key].qty += s.qty || 1;
      itemTotals[key].profit += s.profit || 0;
    }),
  );
  const itemStats = Object.values(itemTotals);
  const bestEarning = itemStats.reduce(
    (best, item) => (item.profit > (best?.profit || -Infinity) ? item : best),
    null,
  );
  const bestSold = itemStats.reduce(
    (best, item) => (item.qty > (best?.qty || 0) ? item : best),
    null,
  );
  const insightText =
    bestEarning && bestSold
      ? `<div class="pr-insight-line pr-insight-earning"><span class="pr-insight-label">Top earning</span><strong>${escapeHtml(bestEarning.name)}</strong><span>${_fmtNum(bestEarning.profit)}</span></div>
       <div class="pr-insight-line pr-insight-sold"><span class="pr-insight-label">Best seller</span><strong>${escapeHtml(bestSold.name)}</strong><span>${fmtN(bestSold.qty)} sold</span></div>`
      : '<div class="pr-insight-line">No item sales in this period.</div>';

  // Store byDate for click access
  window._histByDate = byDate;

  // Day table rows, newest first
  const dayRows = datesSorted
    .map((date) => {
      const day = byDate[date];
      const safeId = date.replace(/-/g, "");
      const dt = new Date(date + "T12:00:00");
      const label = dt.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "2-digit",
        month: "short",
        year: "numeric",
      });
      const earningColor = day.profit >= 0 ? "#16a34a" : "#dc2626";
      const isBest = date === bestRevDay && datesSorted.length > 1;
      const isToday = date === today;
      const rowCls = isToday
        ? " hist-row-today"
        : isBest
          ? " hist-row-best"
          : "";
      return `<tr class="hist-day-tr${rowCls}" onclick="expandHistDay('${safeId}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();expandHistDay('${safeId}');}" style="cursor:pointer;">
      <td class="hdt-date">${label}${isBest ? " ★" : ""}</td>
      <td class="hdt-num">${day.sales.length}</td>
      <td class="hdt-num">${fmtN(day.qty)}</td>
      <td class="hdt-num">${_fmtNum(day.cost)}</td>
      <td class="hdt-num">${_fmtNum(day.revenue)}</td>
      <td class="hdt-num" style="color:${earningColor};font-weight:800;">${_fmtNum(day.profit)}</td>
      <td class="hdt-chev"><i class="fa-solid fa-chevron-right"></i></td>
    </tr>`;
    })
    .join("");
  const periodTotalsRow = `<tr class="hist-totals-top hist-days-total-row">
      <td><strong class="hist-total-label">Totals</strong></td>
      <td>${fmtN(periodTotals.transactions)}</td>
      <td><span class="hist-total-meta">${fmtN(periodTotals.qty)} items sold</span></td>
      <td>${_fmtNum(periodTotals.buy)}</td>
      <td>${_fmtNum(periodTotals.sale)}</td>
      <td class="${periodTotals.profit >= 0 ? "hp-pos" : "hp-neg"}">${_fmtNum(periodTotals.profit)}</td>
      <td></td>
    </tr>`;
  const dayCards = `<table class="hist-days-table">
    <thead><tr>
      <th class="hdt-date">Date</th>
      <th class="hdt-num">Transactions</th>
      <th class="hdt-num">Items</th>
      <th class="hdt-num">Buy</th>
      <th class="hdt-num">Sale</th>
      <th class="hdt-num">Profit</th>
      <th class="hdt-chev"></th>
    </tr></thead>
    <tbody>${periodTotalsRow}${dayRows}</tbody>
  </table>`;
  recList.innerHTML = `
  <!-- Day list rows -->
  <div class="pr-days-list">${dayCards}</div>

  <!-- Expanded detail area -->
    <div id="hist-expanded-area" class="hist-expanded-area" style="display:none;"></div>

    <!-- Insights + export -->
    <div class="pr-insights">
      <div class="pr-insights-icon"><i class="fa-solid fa-lightbulb"></i></div>
      <div class="pr-insights-body">
        <div class="pr-insights-title">Insights</div>
        <div class="pr-insights-text">${insightText}</div>
      </div>
      <button class="pr-export-btn" onclick="exportSalesReport()">
        <i class="fa-solid fa-download"></i> Export Report
      </button>
    </div>

    </div>`;

  _rememberRenderedHistoryState();
  _restoreHistoryScroll();
}

async function renderHistoryPage() {
  const generation = ++_histRenderGeneration;
  const recList = UI.el("hist-records-list");
  const filterVal =
    document.getElementById("hist-period-filter")?.value || "today";
  _updateHistoryNavigation(filterVal, Boolean(_histFocusedDate));
  window._histByDate = {};
  if (recList)
    recList.innerHTML =
      '<div class="hist-loading-state" role="status">Loading sales…</div>';
  try {
    await _renderHistoryPage(generation);
  } catch (error) {
    if (generation !== _histRenderGeneration) return;
    console.error("[renderHistoryPage]", error);
    if (recList)
      recList.innerHTML = `
        <div class="hist-error-state" role="alert">
          <span>Sales could not be loaded. Check your connection and try again.</span>
          <button type="button" onclick="renderHistoryPage()">Retry</button>
        </div>`;
  }
}

// Money formatted for a table cell (no currency prefix - shown once in the header instead)
function _fmtNum(n) {
  return (parseFloat(n) || 0).toLocaleString("en-KE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

let _histSort = { key: "date", dir: -1 };

function _histSortArrow(key) {
  if (_histSort.key !== key) return '<span class="hist-sort-arrow">↕</span>';
  return `<span class="hist-sort-arrow hist-sort-arrow-active">${_histSort.dir === 1 ? "↑" : "↓"}</span>`;
}

function _histSortButton(label, key, title = label) {
  return `<button type="button" class="hist-sort-btn" title="${title}" aria-label="${title}" onclick="sortHistTable('${key}')">${label}${_histSortArrow(key)}</button>`;
}

function sortHistTable(key) {
  if (_histSort.key === key) _histSort.dir *= -1;
  else {
    _histSort.key = key;
    _histSort.dir = key === "item" ? 1 : -1;
  }
  renderHistoryPage();
}
window.sortHistTable = sortHistTable;

function _histSalesTotals(sales) {
  return sales.reduce(
    (sum, sale) => {
      const qty = sale.qty || 1;
      sum.transactions += 1;
      sum.qty += qty;
      sum.buy += (Number(sale.buyPrice) || 0) * qty;
      sum.sale += (Number(sale.actualPrice || sale.sellPrice) || 0) * qty;
      if (sale.profit == null || !Number.isFinite(Number(sale.profit)))
        sum.unknownProfit += 1;
      else sum.profit += Number(sale.profit);
      return sum;
    },
    { transactions: 0, qty: 0, buy: 0, sale: 0, profit: 0, unknownProfit: 0 },
  );
}

function _histTotalsRow(totals) {
  const profitTotal =
    totals.unknownProfit > 0
      ? `Unavailable for ${fmtN(totals.unknownProfit)} sale${totals.unknownProfit === 1 ? "" : "s"}`
      : _fmtNum(totals.profit);
  return `<tr class="hist-totals-top"><td></td><td><strong class="hist-total-label">Totals</strong><span class="hist-total-meta">${_histCountLabel(totals.transactions, "transaction")} · ${_histCountLabel(totals.qty, "item")}</span></td><td></td><td>${_fmtNum(totals.buy)}</td><td>${_fmtNum(totals.sale)}</td><td class="${totals.unknownProfit ? "" : totals.profit >= 0 ? "hp-pos" : "hp-neg"}">${profitTotal}</td><td></td></tr>`;
}

// ── Tabular sale record renderer ────────────────────────────────────
function _histTable(sales) {
  const totals = _histSalesTotals(sales);
  const sorted = [...sales].sort((a, b) => {
    const qtyA = a.qty || 1,
      qtyB = b.qty || 1;
    const values =
      {
        date: [
          new Date(a.date || 0).getTime(),
          new Date(b.date || 0).getTime(),
        ],
        item: [
          (a.itemName || a.itemCode || "Item").toLowerCase(),
          (b.itemName || b.itemCode || "Item").toLowerCase(),
        ],
        unitCost: [Number(a.buyPrice) || 0, Number(b.buyPrice) || 0],
        cost: [(a.buyPrice || 0) * qtyA, (b.buyPrice || 0) * qtyB],
        revenue: [
          (a.actualPrice || a.sellPrice || 0) * qtyA,
          (b.actualPrice || b.sellPrice || 0) * qtyB,
        ],
        earning: [a.profit || 0, b.profit || 0],
      }[_histSort.key] || [];
    const result = values[0] < values[1] ? -1 : values[0] > values[1] ? 1 : 0;
    return result * _histSort.dir;
  });

  const detailRows = sorted
    .map((s, i) => {
      const qty = s.qty || 1;
      const hasCost = s.buyPrice != null && Number.isFinite(Number(s.buyPrice));
      const unitCost = hasCost ? Number(s.buyPrice) : 0;
      const buy = unitCost * qty;
      const sell = (s.actualPrice || s.sellPrice || 0) * qty;
      const hasProfit = s.profit != null && Number.isFinite(Number(s.profit));
      const profit = hasProfit ? Number(s.profit) : 0;
      const rawName =
        (s.itemName || s.itemCode || "Item") +
        (s.itemSize ? " · Sz " + s.itemSize : "") +
        (qty > 1 ? " ×" + qty : "");
      const click = s.id ? `onclick="openSaleDetail(${s.id})"` : "";
      const profCls = !hasProfit ? "" : profit >= 0 ? "hp-pos" : "hp-neg";
      const inInv = allItems.some(
        (item) =>
          (s.itemId && item.id === s.itemId) ||
          (s.itemCode && item.code === s.itemCode),
      );
      const invBadge = inInv
        ? '<span class="inv-circle inv-circle-found" title="In inventory">✓</span>'
        : '<span class="inv-circle inv-circle-missing" title="Not in inventory">✕</span>';
      // Row number: 1 = most recent (top), n = oldest (bottom)
      return (
        `<tr class="hist-clickable-row" ${click}>` +
        `<td class="hist-num">${i + 1}</td>` +
        `<td>${escapeHtml(rawName)}</td>` +
        `<td>${hasCost ? _fmtNum(unitCost) : "N/A"}</td>` +
        `<td>${hasCost ? _fmtNum(buy) : "N/A"}</td>` +
        `<td>${_fmtNum(sell)}</td>` +
        `<td class="${profCls}">${hasProfit ? _fmtNum(profit) : "N/A"}</td>` +
        `<td class="hist-td-chevron">${invBadge}</td>` +
        `</tr>`
      );
    })
    .join("");

  return (
    `<div class="hist-table-wrap"><table class="hist-table hist-table-lined">` +
    `<thead>` +
    _histTotalsRow(totals) +
    `<tr>` +
    `<th class="hist-num">#</th>` +
    `<th>${_histSortButton("Item", "item")}</th>` +
    `<th>${_histSortButton("@", "unitCost", "Unit cost per item")}</th>` +
    `<th>${_histSortButton("Buy", "cost")}</th>` +
    `<th>${_histSortButton("Sale", "revenue")}</th>` +
    `<th>${_histSortButton("Profit", "earning")}</th>` +
    `<th></th>` +
    `</tr>` +
    `</thead>` +
    `<tbody>${detailRows}</tbody>` +
    `</table></div>`
  );
}
window.renderHistoryPage = renderHistoryPage;

function expandHistDay(safeId) {
  const date = safeId.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  focusHistoryDay(date);
}
window.expandHistDay = expandHistDay;

function focusHistoryDay(date) {
  if (!(window._histByDate || {})[date]) return;
  const previous = _histLastRenderedState || _captureHistoryState();
  if (previous.focusedDate !== date)
    _histNavigationStack.push({ ...previous, sort: { ...previous.sort } });
  _histFocusedDate = date;
  _histScrollToRestore = null;
  renderHistoryPage();
}
window.focusHistoryDay = focusHistoryDay;

function historyBack() {
  const previous = _histNavigationStack.pop();
  if (!previous) {
    _histFocusedDate = null;
    renderHistoryPage();
    return;
  }
  const filter = document.getElementById("hist-period-filter");
  const customFrom = document.getElementById("hist-custom-from");
  const customTo = document.getElementById("hist-custom-to");
  if (filter) filter.value = previous.filter;
  if (customFrom) customFrom.value = previous.customFrom;
  if (customTo) customTo.value = previous.customTo;
  _histFocusedDate = previous.focusedDate;
  _histSort = { ...previous.sort };
  _histScrollToRestore = previous.scrollY;
  renderHistoryPage();
}
window.historyBack = historyBack;
window.returnToHistoryFilter = historyBack;

function showTodaySalesHistory() {
  _histNavigationStack = [];
  _histFocusedDate = null;
  const filter = document.getElementById("hist-period-filter");
  const customFrom = document.getElementById("hist-custom-from");
  const customTo = document.getElementById("hist-custom-to");
  if (filter) filter.value = "today";
  if (customFrom) customFrom.value = "";
  if (customTo) customTo.value = "";
  _histSort = { key: "date", dir: -1 };
  _histScrollToRestore = 0;
  renderHistoryPage();
}
window.showTodaySalesHistory = showTodaySalesHistory;

function changeSalesHistoryFilter(filterValue) {
  const previous = _histLastRenderedState || _captureHistoryState();
  if (previous.filter !== filterValue)
    _histNavigationStack.push({ ...previous, sort: { ...previous.sort } });
  _histFocusedDate = null;
  const filter = document.getElementById("hist-period-filter");
  if (filter) filter.value = filterValue;
  _histScrollToRestore = 0;
  renderHistoryPage();
}
window.changeSalesHistoryFilter = changeSalesHistoryFilter;

function changeSalesCustomRange() {
  const previous = _histLastRenderedState || _captureHistoryState();
  const customFrom = document.getElementById("hist-custom-from")?.value || "";
  const customTo = document.getElementById("hist-custom-to")?.value || "";
  if (
    previous.customFrom !== customFrom ||
    previous.customTo !== customTo
  )
    _histNavigationStack.push({ ...previous, sort: { ...previous.sort } });
  _histFocusedDate = null;
  _histScrollToRestore = 0;
  renderHistoryPage();
}
window.changeSalesCustomRange = changeSalesCustomRange;

async function exportSalesReport() {
  // Export only the currently visible period + filters
  const allSales = await dbAll("sales");
  const filterVal =
    document.getElementById("hist-period-filter")?.value || "all";
  const today = todayDateStr();
  const historyRange = _historyFilterRange(
    filterVal,
    today,
    document.getElementById("hist-custom-from")?.value || "",
    document.getElementById("hist-custom-to")?.value || "",
  );
  const _histPay = window._histPayFilter || "all";
  const _histSearch = (document.getElementById("hist-item-search")?.value || "")
    .toLowerCase()
    .trim();

  const filtered = [...allSales]
    .filter((s) => {
      const d = _historySaleDate(s, today);
      if (
        d > today ||
        (historyRange.from && d < historyRange.from) ||
        (historyRange.to && d > historyRange.to)
      )
        return false;
      if (
        _histPay !== "all" &&
        (s.paymentMethod || "cash").toLowerCase() !== _histPay
      )
        return false;
      if (
        _histSearch &&
        !(s.itemName || "").toLowerCase().includes(_histSearch) &&
        !(s.itemCode || "").toLowerCase().includes(_histSearch)
      )
        return false;
      return true;
    })
    .sort((a, b) =>
      _historySaleDate(b, today).localeCompare(_historySaleDate(a, today)),
    );

  const periodLabel = filterVal.replace("_", " ");
  const rows = [
    [
      "Date",
      "Item",
      "Code",
      "Qty",
      "Buy Price",
      "Revenue",
      "Profit",
      "Payment",
    ],
  ];
  filtered.forEach((s) =>
    rows.push([
      _historySaleDate(s, today),
      s.itemName || "",
      s.itemCode || "",
      s.qty || 1,
      s.buyPrice ?? "",
      s.revenue || 0,
      s.profit ?? "",
      s.paymentMethod || "cash",
    ]),
  );
  const csv = rows
    .map((r) =>
      r.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: "sales-" + periodLabel + ".csv",
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast(filtered.length + " records exported", "ok");
}
window.exportSalesReport = exportSalesReport;

/** Payment method chip selector */
function histSetPay(method) {
  window._histPayFilter = method;
  document.querySelectorAll(".hist-pay-chip").forEach((b) => {
    b.classList.toggle("active", b.dataset.pay === method);
  });
  renderHistoryPage();
}
window.histSetPay = histSetPay;

function collapseHistDay() {
  historyBack();
}
window.collapseHistDay = collapseHistDay;

function toggleHistDay(safeId) {
  expandHistDay(safeId);
}
window.toggleHistDay = toggleHistDay;

// ══════════════════════════════════════════════════════════════════
// SALE DETAIL SHEET
// ══════════════════════════════════════════════════════════════════

async function openSaleDetail(saleId) {
  const sale = await dbGet("sales", saleId);
  if (!sale) {
    toast("Sale not found", "err");
    return;
  }
  const linkedItem =
    sale.itemId == null ? null : await dbGet("items", sale.itemId);

  document.getElementById("sds-id").value = saleId;

  // Populate view
  const qty = sale.qty || 1;
  const price = sale.actualPrice || sale.sellPrice || 0;
  const hasProfit = sale.buyPrice != null && sale.profit != null;
  const buy = sale.buyPrice == null ? 0 : Number(sale.buyPrice);
  const profit = hasProfit ? Number(sale.profit) : null;
  const dateStr = sale.date
    ? new Date(sale.date).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : sale.businessDate || "—";

  document.getElementById("sds-name").textContent = sale.itemName || "—";
  document.getElementById("sds-code").textContent = sale.itemCode || "";
  document.getElementById("sds-qty").textContent = fmtN(qty);
  document.getElementById("sds-price").textContent = fmt(price);
  document.getElementById("sds-revenue").textContent = fmt(qty * price);
  const profEl = document.getElementById("sds-profit");
  profEl.textContent = hasProfit
    ? (profit >= 0 ? "+" : "") + fmt(profit)
    : "N/A - cost unknown";
  profEl.style.color = hasProfit
    ? profit >= 0
      ? "var(--green)"
      : "var(--red)"
    : "var(--muted)";
  document.getElementById("sds-date").textContent = dateStr;

  const pm = (sale.paymentMethod || "cash").toUpperCase();
  const pmBadge = document.getElementById("sds-payment-badge");
  pmBadge.textContent = pm;
  pmBadge.className =
    "sds-item-badge sds-pm-" + (sale.paymentMethod || "cash").toLowerCase();

  // Pre-fill edit form
  document.getElementById("sds-edit-qty").value = qty;
  document.getElementById("sds-edit-price").value = price;
  const pmSel = document.getElementById("sds-edit-payment");
  if (pmSel) pmSel.value = sale.paymentMethod || "cash";

  const canMutate = canMutateSale(sale);
  const editButton = document.getElementById("sds-edit-btn");
  const deleteButton = document.getElementById("sds-delete-btn");
  const addButton = document.getElementById("sds-add-btn");
  if (editButton) {
    editButton.style.display = "flex";
    editButton.disabled = false;
    editButton.style.opacity = "1";
    editButton.style.cursor = "pointer";
    editButton.title = canMutate
      ? "Edit this sale"
      : "Editing is restricted until the business day is open and an authorized account is signed in";
  }
  if (deleteButton) {
    deleteButton.style.display = "flex";
    deleteButton.disabled = false;
    deleteButton.style.opacity = "1";
    deleteButton.style.cursor = "pointer";
    deleteButton.title = canMutate
      ? "Delete or void this sale"
      : "Deletion is restricted until the business day is open and an authorized account is signed in";
  }
  if (addButton) {
    addButton.style.display = "flex";
    addButton.disabled = false;
    addButton.title = linkedItem
      ? "This sale is already linked to inventory"
      : "Add this sale to inventory";
  }

  // Reset to view mode
  document.getElementById("sds-edit-form").style.display = "none";
  document.getElementById("sds-view").style.display = "block";
  document.getElementById("sds-actions").style.display = "flex";

  document.getElementById("sale-detail-sheet").classList.add("open");
}
window.openSaleDetail = openSaleDetail;

function closeSaleDetailSheet() {
  document.getElementById("sale-detail-sheet").classList.remove("open");
}
window.closeSaleDetailSheet = closeSaleDetailSheet;

function toggleSaleEditForm() {
  const saleId = Number(document.getElementById("sds-id")?.value);
  if (!currentUser || !["super", "user"].includes(currentUser.role)) {
    toast("Only authorized users can edit sales", "err");
    return;
  }
  if (!activeDay || activeDay.status !== "OPEN") {
    toast("Open the business day before editing a sale", "err");
    return;
  }
  if (!Number.isInteger(saleId) || saleId <= 0) {
    toast("Sale record not found", "err");
    return;
  }
  const form = document.getElementById("sds-edit-form");
  const view = document.getElementById("sds-view");
  const acts = document.getElementById("sds-actions");
  const showing = form.style.display !== "none";
  form.style.display = showing ? "none" : "block";
  view.style.display = "block";
  // Hide action buttons while editing to reduce clutter
  if (!showing) acts.style.display = "none";
  else acts.style.display = "flex";
}
window.toggleSaleEditForm = toggleSaleEditForm;

function discardSaleEdit() {
  document.getElementById("sds-edit-form").style.display = "none";
  document.getElementById("sds-actions").style.display = "flex";
}
window.discardSaleEdit = discardSaleEdit;
function adjEditedSaleQty(delta) {
  const input = document.getElementById("sds-edit-qty");
  if (!input) return;
  const current = parseInt(input.value, 10) || 1;
  input.value = String(Math.max(1, Math.min(999999, current + delta)));
}
window.adjEditedSaleQty = adjEditedSaleQty;

async function saveSaleEdit() {
  try {
    if (!currentUser || !["super", "user"].includes(currentUser.role)) {
      toast("You do not have permission to edit sales", "err");
      return;
    }
    if (!activeDay || activeDay.status !== "OPEN") {
      toast("Sales can only be edited while the business day is open", "err");
      return;
    }

    const id = Number(document.getElementById("sds-id").value);
    const qtyInput = document.getElementById("sds-edit-qty").value;
    const priceInput = document.getElementById("sds-edit-price").value;
    const qty = Number(qtyInput);
    const price = Number(priceInput);
    const pm = document.getElementById("sds-edit-payment").value || "cash";
    if (!Number.isInteger(id) || id <= 0) {
      toast("Sale record not found", "err");
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > 999999) {
      toast("Quantity must be a whole number from 1 to 999,999", "err");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      toast("Price must be greater than zero", "err");
      return;
    }
    if (!["cash", "mpesa", "till", "credit"].includes(pm)) {
      toast("Invalid payment method", "err");
      return;
    }

    const sale = await dbGet("sales", id);
    if (!sale) {
      toast("Sale not found", "err");
      return;
    }
    const saleDate = sale.businessDate || sale.business_date;
    const activeDate = activeDay.businessDate || activeDay.business_date;
    if (saleDate && saleDate !== activeDate) {
      toast("Only sales from the open business day can be edited", "err");
      return;
    }

    const item = sale.itemId == null ? null : await dbGet("items", sale.itemId);
    const saleSize = sale.itemSize || sale.size;
    const size =
      item?.isShoe && saleSize
        ? (await getShoeSizes(item.code)).find(
            (record) => String(record.size) === String(saleSize),
          )
        : null;
    const buy = [
      sale.buyPrice,
      size?.buyPrice,
      item?.buyPrice,
      item?.buy,
      sale.buy,
    ]
      .filter((value) => value !== null && value !== undefined && value !== "")
      .map(Number)
      .find((value) => Number.isFinite(value) && value >= 0);
    if (buy == null) {
      toast("The sale and linked item have no valid buy price", "err");
      return;
    }
    const minimumPrice = Number(size?.sellPriceMin || item?.sellPriceMin || 0);
    if (minimumPrice > 0 && price < minimumPrice) {
      toast("Price cannot be below the minimum sale price", "err");
      return;
    }
    if (price <= buy) {
      toast("Price must be greater than the buy price", "err");
      return;
    }
    const revenue = qty * price;
    const profit = qty * (price - buy);
    if (!Number.isFinite(revenue) || !Number.isFinite(profit)) {
      toast("Sale totals are too large to record", "err");
      return;
    }

    const oldQty = Number(sale.qty);
    if (!Number.isInteger(oldQty) || oldQty < 1 || oldQty > 999999) {
      toast("The original sale quantity is invalid; it cannot be edited", "err");
      return;
    }
    const stockDelta = oldQty - qty;
    if (stockDelta !== 0 && !item) {
      toast("The original inventory item could not be found", "err");
      return;
    }
    if (stockDelta !== 0 && item?.isShoe && !size) {
      toast("The original shoe size could not be found", "err");
      return;
    }
    if (stockDelta < 0 && !item.isRecord) {
      const available = size
        ? await readableStockQty(size, size.id)
        : await readableStockQty(item);
      if (-stockDelta > available) {
        toast("Not enough stock for the increased sale quantity", "err");
        return;
      }
    }
    if (stockDelta !== 0 && !item.isRecord) {
      if (size) {
        size.qty = Math.max(0, Number(size.qty || 0) + stockDelta);
        size.qtyCache = Number(size.qty);
        size.updatedAt = new Date().toISOString();
        const allSizes = await getShoeSizes(item.code);
        item.qty = allSizes.reduce(
          (total, record) => total + Number(record.qty || 0),
          0,
        );
      } else {
        item.qty = Math.max(0, Number(item.qty || 0) + stockDelta);
      }
      item.qtyCache = Number(item.qty || 0);
      item.updatedAt = new Date().toISOString();
    }

    sale.qty = qty;
    sale.buyPrice = buy;
    sale.actualPrice = price;
    sale.sellPrice = price;
    sale.paymentMethod = pm;
    sale.revenue = revenue;
    sale.profit = profit;
    sale.updatedAt = new Date().toISOString();
    if (item) {
      await persistSaleEditAtomically({
        item,
        shoeSize: size && !item.isRecord ? size : null,
        sale,
        delta: item.isRecord ? 0 : stockDelta,
        actor: currentUser.username,
      });
    } else {
      await dbPut("sales", sale);
    }
    closeSaleDetailSheet();
    await refreshUI();
    await renderHistoryPage();
    try {
      await renderSellPage();
    } catch (_) {}
    toast("Sale updated", "ok");
  } catch (error) {
    console.error("[saveSaleEdit]", error);
    toast("Sale update failed: " + (error.message || "Unknown error"), "err");
  }
}
window.saveSaleEdit = saveSaleEdit;

async function deleteSaleFromDetail() {
  const id = Number(document.getElementById("sds-id")?.value);
  if (!Number.isInteger(id) || id <= 0) {
    toast("Sale record not found", "err");
    return;
  }
  await voidSale(id);
}
window.deleteSaleFromDetail = deleteSaleFromDetail;

async function saleAddToInventoryFromDetail() {
  const id = Number(document.getElementById("sds-id")?.value);
  if (!Number.isInteger(id) || id <= 0) {
    toast("Sale record not found", "err");
    return;
  }
  const sale = await dbGet("sales", id);
  if (!sale) {
    toast("Sale not found", "err");
    return;
  }
  if (sale.itemId != null && (await dbGet("items", sale.itemId))) {
    toast("This sale is already linked to inventory", "");
    return;
  }
  closeSaleDetailSheet();
  showPage("add");
  await new Promise((r) => setTimeout(r, 100));
  // Match type or default to General
  const matchType = types.find(
    (t) => t.name === sale.itemType && isCategoryActive(t),
  );
  const useType = matchType
    ? sale.itemType
    : types.find((t) => t.name === "General" && isCategoryActive(t))
      ? "General"
      : "";
  setAddFormType(useType, { skipTypeChange: false });
  await new Promise((r) => setTimeout(r, 80));
  const el = (id) => document.getElementById(id);
  if (el("f-code")) el("f-code").value = sale.itemCode || "";
  if (el("f-name")) el("f-name").value = sale.itemName || "";
  if (el("f-qty")) el("f-qty").value = sale.qty || 1;
  if (el("f-buy")) el("f-buy").value = sale.buyPrice > 0 ? sale.buyPrice : "";
  if (el("f-sell"))
    el("f-sell").value = sale.sellPrice > 0 ? sale.sellPrice : "";
  updateProfitPreview();
  setItemMode(false);
  toast("Pre-filled from sale — save to link across system", "");
}
window.saleAddToInventoryFromDetail = saleAddToInventoryFromDetail;

async function openSellShoeModal(itemId, size) {
  const item = await dbGet("items", itemId);
  if (!item) {
    toast("Item not found", "err");
    return;
  }
  const sizes = await getShoeSizes(item.code);
  const sizeRec = sizes.find((s) => s.size === size);
  const availableQty = sizeRec
    ? await readableStockQty(sizeRec, sizeRec.id)
    : 0;
  if (!sizeRec || availableQty <= 0) {
    toast("Size " + size + " is out of stock", "err");
    return;
  }
  _isShoeSale = true;
  _sellShoeItem = item;
  _sellShoeSize = sizeRec;
  currentSellItemId = itemId;
  const t = getTypeObj(item.type);
  const el = (id) => document.getElementById(id);
  if (el("sm-icon")) {
    el("sm-icon").textContent = t.emoji;
    el("sm-icon").style.background = t.color || "var(--surface2)";
  }
  if (el("sm-name"))
    el("sm-name").textContent = item.name + " (Size " + size + ")";
  if (el("sm-meta")) el("sm-meta").textContent = item.code + " - Size " + size;
  if (el("sm-stock")) el("sm-stock").textContent = availableQty;
  if (el("sm-sell"))
    el("sm-sell").textContent = fmt(sizeRec.sellPrice || item.sellPrice || 0);
  if (el("sm-cur")) el("sm-cur").textContent = currency;
  if (el("sm-qty")) {
    el("sm-qty").value = 0;
    el("sm-qty").min = 0;
    el("sm-qty").max = availableQty;
  }
  if (el("sm-actual")) el("sm-actual").value = "";
  _toggleSmBuyField(sizeRec.buyPrice || item.buyPrice || 0);
  _showSellFormPage();
  updateSellModal();
}
window.openSellShoeModal = openSellShoeModal;

window.showSalesTab = showSalesTab;
window.openSellShoeModal = openSellShoeModal;
window.deleteSale = deleteSale;

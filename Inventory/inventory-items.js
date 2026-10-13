/* ===== item-form.js ===== */
function parsePriceInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return NaN;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : NaN;
}

// ===== SAVE ITEM =====
function resetInventoryListForNewItem() {
  activeTypeFilter = "all";
  const search = UI.el("search");
  if (search) search.value = "";
  const clearSearch = UI.el("search-clear");
  if (clearSearch) clearSearch.style.display = "none";
}

async function saveItem() {
  _overlay.show("Saving...");
  try {
    // Use hidden input; fall back to JS variable if input got cleared unexpectedly
    const editIdRaw =
      UI.el("edit-id")?.value || (_editingItemId ? String(_editingItemId) : "");

    // SHOE SIZE EDIT
    // SHOE SIZE RESTOCK - adds qty to existing, never replaces
    if (editIdRaw && editIdRaw.startsWith("shoe_restock_")) {
      const parts = editIdRaw.replace("shoe_restock_", "").split("_");
      const itemId = parseInt(parts[0]);
      const size = parseInt(parts[1]);
      const item = await dbGet("items", itemId);
      const allSz = await getShoeSizes(item ? item.code : "");
      const sizeRec = allSz.find((s) => s.size === size);
      if (!sizeRec) {
        toast("Size record not found", "err");
        return;
      }
      const addQty = parseInt(UI.el("f-qty")?.value);
      if (isNaN(addQty) || addQty <= 0) {
        toast("Warning: Enter quantity to add", "err");
        return;
      }
      const buy = parsePriceInput(UI.el("f-buy")?.value);
      const sell = parsePriceInput(UI.el("f-sell")?.value);
      const nextBuy = !isNaN(buy)
        ? buy
        : sizeRec.buyPrice || item?.buyPrice || item?.buy || 0;
      const nextSell = !isNaN(sell)
        ? sell
        : sizeRec.sellPrice || item?.sellPrice || item?.sell || 0;
      if (!Validate.price(nextBuy, nextSell, "f-buy", "f-sell")) return;
      const newQty = (sizeRec.qty || 0) + addQty;
      if (newQty > 999999) {
        toast("Warning: Exceeds max 999,999", "err");
        return;
      }
      sizeRec.qty = newQty;
      sizeRec.buyPrice = nextBuy;
      sizeRec.sellPrice = nextSell;
      sizeRec.profit = nextSell - nextBuy;
      sizeRec.updatedAt = new Date().toISOString();
      await dbPut("shoe_sizes", sizeRec);
      await appendStockMove({
        itemId: item?.id || sizeRec.itemId,
        sizeId: sizeRec.id,
        delta: addQty,
        reason: "receive",
        refId: `restock:${item?.id || sizeRec.itemId}:${sizeRec.id}`,
        actor: currentUser ? currentUser.username : "system",
      });
      fbSyncShoeSize(sizeRec);
      if (item) {
        const updSz = await getShoeSizes(item.code);
        item.qty = updSz.reduce((t, s) => t + s.qty, 0);
        item.buyPrice = nextBuy;
        item.sellPrice = nextSell;
        item.profit = nextSell - nextBuy;
        item.updatedAt = new Date().toISOString();
        item.updatedBy = currentUser ? currentUser.username : "system";
        await dbPut("items", item);
        fbSyncItem(item);
      }
      await recordStockInvestment(
        item || sizeRec,
        addQty * nextBuy,
        addQty,
        "Shoe restock",
      );
      fbSyncShoeSize(sizeRec);
      clearForm();
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      toast("\U0001f4e6 Size " + size + ": +" + addQty + " to " + newQty, "ok");
      showPage("list");
      return;
    }

    if (editIdRaw && editIdRaw.startsWith("shoe_edit_")) {
      const parts = editIdRaw.replace("shoe_edit_", "").split("_");
      const itemId = parseInt(parts[0]);
      const size = parseInt(parts[1]);
      const item = await dbGet("items", itemId);
      const allSz = await getShoeSizes(item ? item.code : "");
      const sizeRec = allSz.find((s) => s.size === size);
      if (!sizeRec) {
        toast("Size record not found", "err");
        return;
      }
      const qty = parseInt(UI.el("f-qty")?.value);
      const previousQty = Number(sizeRec.qty || 0);
      const buy =
        parsePriceInput(UI.el("f-buy")?.value) || sizeRec.buyPrice || 0;
      const sell =
        parsePriceInput(UI.el("f-sell")?.value) || sizeRec.sellPrice || 0;
      if (isNaN(qty) || qty < 0)
        return Validate.fail("Enter a valid quantity (0 or more)", "f-qty");
      if (!Validate.price(buy, sell, "f-buy", "f-sell")) return;
      sizeRec.qty = qty;
      sizeRec.buyPrice = buy;
      sizeRec.sellPrice = sell;
      sizeRec.profit = sell - buy;
      sizeRec.updatedAt = new Date().toISOString();
      await dbPut("shoe_sizes", sizeRec);
      if (qty !== previousQty) {
        await appendStockMove({
          itemId: item?.id || sizeRec.itemId,
          sizeId: sizeRec.id,
          delta: qty - previousQty,
          reason: "adjust",
          refId: `edit:${item?.id || sizeRec.itemId}:${sizeRec.id}:${sizeRec.updatedAt}`,
          actor: currentUser ? currentUser.username : "system",
        });
      }
      if (item) {
        const updSz = await getShoeSizes(item.code);
        item.qty = updSz.reduce((t, s) => t + s.qty, 0);
        item.buyPrice = buy;
        item.sellPrice = sell;
        item.updatedAt = new Date().toISOString();
        item.updatedBy = currentUser ? currentUser.username : "system";
        await dbPut("items", item);
        fbSyncItem(item);
      }
      ["f-code", "f-name", "f-size"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = false;
          el.style.opacity = "";
          el.style.cursor = "";
        }
      });
      setAddTypeLocked(false);
      setRestockBanner(false);
      clearForm();
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      toast("Size " + size + " updated - " + qty + " pcs - " + fmt(sell), "ok");
      showPage("list");
      return;
    }

    // RESTOCK MODE
    if (editIdRaw && editIdRaw.startsWith("restock_")) {
      const existing = await dbGet(
        "items",
        parseInt(editIdRaw.replace("restock_", "")),
      );
      if (!existing) {
        toast("Warning: Item not found", "err");
        exitRestockMode();
        return;
      }
      const qtyEl = UI.el("f-qty");
      const addQty = parseInt(qtyEl ? qtyEl.value.trim() : "0");
      if (!addQty || addQty <= 0) {
        toast("Warning: Enter quantity to add", "err");
        if (qtyEl) qtyEl.focus();
        return;
      }
      if (
        addQty > CODE_MAX_QTY &&
        !confirm("Adding " + addQty + " units - confirm?")
      )
        return;
      const newQty = existing.qty + addQty;
      if (newQty > 999999) {
        toast("Warning: Exceeds max 999,999", "err");
        return;
      }
      existing.qty = newQty;
      existing.updatedAt = new Date().toISOString();
      await dbPut("items", existing);
      await appendStockMove({
        itemId: existing.id,
        delta: addQty,
        reason: "receive",
        refId: `restock:${existing.id}:${existing.updatedAt}`,
        actor: currentUser ? currentUser.username : "system",
      });
      fbSyncItem(existing);
      const actualBuy =
        _purchaseProcessing?.wishId === _wishStockingFromId
          ? _purchaseProcessing.unitBuy
          : existing.buyPrice || existing.buy || 0;
      await recordStockInvestment(
        existing,
        addQty * actualBuy,
        addQty,
        "Restock",
      );
      if (_wishStockingFromId) {
        await markWishlistStockedById(
          _wishStockingFromId,
          existing.id,
          addQty,
          actualBuy,
        );
        _wishStockingFromId = null;
        _purchaseProcessing = null;
      }
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      exitRestockMode();
      toast(
        "\U0001f4e6 " + existing.code + ": +" + addQty + " to " + newQty,
        "ok",
      );
      return;
    }

    // COMMON FIELDS
    const type = UI.el("f-type")?.value || "";
    const code = sanitiseCode(UI.el("f-code")?.value || "");
    const name = (UI.el("f-name")?.value || "").trim().replace(/[ \t]+/g, " ");
    if (!name) {
      return Validate.fail("Enter item name", "f-name");
    }
    if (!code) {
      toast("Warning: Enter item code", "err");
      return;
    }
    if (!editIdRaw) {
      const codeMatches = await findCodeMatchesForSave(code);
      const existingCode = codeMatches.find((i) => i.code === code);
      // Footwear: same code is OK when adding/updating sizes on an existing shoe SKU
      const addingShoeSizes =
        existingCode && isFootwearType(type) && existingCode.isShoe;
      if (existingCode && !addingShoeSizes) {
        showCodeDropdown(codeMatches, code);
        toast(
          "Warning: Item code already exists - select it from the dropdown",
          "err",
        );
        UI.el("f-code")?.focus();
        return;
      }
    }

    // Determine Record Only mode early — affects both shoe and standard paths
    const isRecord = !!_addFormIsRecord;

    // Footwear stock is stored on the selected shoe sizes.
    if (isFootwearType(type) && !editIdRaw && !isRecord) {
      const savedCount = await saveShoeItems(code, name, type);
      if (!savedCount) return;
      if (_wishStockingFromId) {
        const stocked = (await dbAll("items")).find((i) => i.code === code);
        if (stocked)
          await markWishlistStockedById(_wishStockingFromId, stocked.id);
        _wishStockingFromId = null;
      }
      clearForm();
      clearAddFormPhoto();
      resetInventoryListForNewItem();
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      await renderWishlistPage();
      await renderStockMonitorSummary();
      showPage("list");
      toast("" + savedCount + " shoe size(s) saved!", "ok");
      return;
    }

    // STANDARD ADD / EDIT
    const size = UI.el("f-size")?.value.trim() || "";
    const qtyRaw = isRecord ? "0" : UI.el("f-qty")?.value || "";
    const qty = qtyRaw === "" ? 0 : Number(qtyRaw);
    const unit = isRecord ? "" : UI.el("f-unit")?.value || "";
    const buyRaw = UI.el("f-buy")?.value || "";
    const sellRaw = UI.el("f-sell")?.value || "";
    const sellMinRaw = UI.el("f-sell-min")?.value || "";
    const buy = buyRaw === "" ? 0 : parsePriceInput(buyRaw);
    const sell = sellRaw === "" ? 0 : parsePriceInput(sellRaw);
    const sellPriceMin = sellMinRaw === "" ? 0 : parsePriceInput(sellMinRaw);
    if (!isRecord && qtyRaw === "")
      return Validate.fail("Enter quantity", "f-qty");
    if (
      !isRecord &&
      !getActiveUnits().some((activeUnit) => activeUnit.abbr === unit)
    )
      return Validate.fail("Activate a unit in Settings", "f-unit");
    if (
      !isRecord &&
      qtyRaw !== "" &&
      (!Number.isFinite(qty) || !Number.isInteger(qty))
    )
      return Validate.fail("Enter a whole-number quantity", "f-qty");
    if (!isRecord && qty < 0)
      return Validate.fail("Quantity cannot be negative", "f-qty");
    if (!isRecord && qty > 999999)
      return Validate.fail("Quantity exceeds maximum (999,999)", "f-qty");
    if (
      !isRecord &&
      qty > CODE_MAX_QTY &&
      !confirm("Adding " + qty + " units - confirm?")
    )
      return;
    // Record Only: buy price is the one mandatory pricing field
    if (isRecord && (!buy || buy <= 0))
      return Validate.fail("Buy price is required for Record items", "f-buy");
    if (
      !Validate.moneyOptional(buyRaw === "" ? null : buy, "f-buy", "Buy price")
    )
      return;
    if (
      !Validate.moneyOptional(
        sellRaw === "" ? null : sell,
        "f-sell",
        "Sell price",
      )
    )
      return;
    if (
      !Validate.moneyOptional(
        sellMinRaw === "" ? null : sellPriceMin,
        "f-sell-min",
        "Minimum sell price",
      )
    )
      return;
    if (buy > 0 && sell > 0 && sell < buy) {
      return Validate.fail(
        "Selling price (" +
          fmt(sell) +
          ") cannot be less than buying price (" +
          fmt(buy) +
          ")",
        "f-sell",
      );
    }
    if (sellPriceMin > 0 && sell > 0 && sellPriceMin >= sell) {
      return Validate.fail(
        "Min sell price must be lower than sell price (" + fmt(sell) + ")",
        "f-sell-min",
      );
    }
    if (sellPriceMin > 0 && buy > 0 && sellPriceMin < buy) {
      if (
        !confirm(
          "Min sell price (" +
            fmt(sellPriceMin) +
            ") is below buy price (" +
            fmt(buy) +
            "). Confirm?",
        )
      )
        return;
    }
    const profit = sell - buy;
    const item = {
      type,
      code,
      name,
      variant: size,
      buyPrice: buy,
      sellPrice: sell,
      sellPriceMin: sellPriceMin || undefined,
      profit,
      qty,
      unit: unit || undefined,
      isRecord,
      createdAt: new Date().toISOString(),
    };

    if (editIdRaw) {
      const resolvedId = parseInt(editIdRaw);
      if (!resolvedId || isNaN(resolvedId)) {
        toast("Warning: Cannot save: item ID missing", "err");
        return;
      }
      const original = await dbGet("items", resolvedId);
      if (
        original &&
        !original.isShoe &&
        !original.isRecord &&
        isFootwearType(type)
      ) {
        return Validate.fail(
          "To categorize an item as footwear, add it using the footwear size workflow",
          "f-type",
        );
      }
      const previousQty = Number(original?.qty || 0);
      // Merge: start from original to preserve all fields (isShoe, photo refs, etc)
      // then overwrite only what the form controls
      const saved = Object.assign({}, original || {}, {
        id: resolvedId,
        type,
        category: type,
        code,
        name,
        variant: size,
        buyPrice: buy,
        sellPrice: sell,
        sellPriceMin: sellPriceMin || undefined,
        profit,
        qty,
        unit: unit || undefined,
        isRecord,
        createdAt: original
          ? original.createdAt || item.createdAt
          : item.createdAt,
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser ? currentUser.username : "system",
        fbId: original ? original.fbId : undefined,
      });
      await dbPut("items", saved);
      if (!isRecord && qty !== previousQty) {
        await appendStockMove({
          itemId: saved.id,
          delta: qty - previousQty,
          reason: "adjust",
          refId: `edit:${saved.id}:${saved.updatedAt}`,
          actor: currentUser ? currentUser.username : "system",
        });
      }
      if (_addFormPhotoData) await setItemPhoto(saved.id, _addFormPhotoData);
      fbSyncItem(saved);
      await _backfillSalesForItem(saved); // keep itemId in sync with any code changes
      clearForm();
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      try {
        await renderHistoryPage();
      } catch (_) {}
      toast("Item updated!", "ok");
      showPage("list");
    } else {
      // Pre-assign fbId so it's stored in IndexedDB immediately — prevents stale allItems
      item.fbId = stableItemFbId(item);
      const newId = await dbAdd("items", item);
      item.id = newId;
      await appendStockMove({
        itemId: newId,
        delta: qty,
        reason: "receive",
        refId: `initial:${newId}`,
        actor: currentUser ? currentUser.username : "system",
      });
      if (_addFormPhotoData) await setItemPhoto(newId, _addFormPhotoData);
      const actualBuy =
        _purchaseProcessing?.wishId === _wishStockingFromId
          ? _purchaseProcessing.unitBuy
          : buy;
      if (_wishStockingFromId) {
        await markWishlistStockedById(
          _wishStockingFromId,
          newId,
          qty,
          actualBuy,
        );
        _wishStockingFromId = null;
        _purchaseProcessing = null;
      } else {
        await markWishlistStockedForItem(item);
      }
      await recordStockInvestment(item, qty * actualBuy, qty, "New stock");
      fbSyncItem(item);
      // Link any existing sales with this code to the new item ID
      const _backfilled = await _backfillSalesForItem(item);
      clearForm();
      clearAddFormPhoto();
      resetInventoryListForNewItem();
      allItems = await dbAll("items");
      await enrichShoeItems(allItems);
      renderList();
      renderDashboard();
      updateHeader();
      scheduleSync();
      if (_backfilled > 0) {
        try {
          await renderHistoryPage();
        } catch (_) {}
      }
      showPage("list");
      showSplash(name, sell, profit);
    }
  } catch (err) {
    if (err.name === "ConstraintError") {
      toast(
        "Warning: Code already exists - select from dropdown to restock",
        "err",
      );
    } else {
      toast("Warning: Save failed: " + (err.message || "Unknown error"), "err");
      console.error("[SAVE]", err);
    }
  } finally {
    _overlay.hide();
  }
}

function clearForm() {
  UI.el("edit-id").value = "";
  _editingItemId = null; // clear JS-side edit tracker
  _lastAddFormType = "";
  // Default to General category; fall back to empty if it doesn't exist
  const _defaultType = types.find(
    (t) => t.name === "General" && isCategoryActive(t),
  )
    ? "General"
    : "";
  setAddFormType(_defaultType, { skipTypeChange: true });
  UI.el("f-code").value = "";
  UI.el("f-name").value = "";
  UI.el("f-size").value = "";
  UI.el("f-qty").value = "";
  UI.el("f-buy").value = "";
  UI.el("f-sell").value = "";
  const _fSellMin = UI.el("f-sell-min");
  if (_fSellMin) _fSellMin.value = "";
  const pp = UI.el("profit-preview");
  if (pp) pp.style.display = "none";
  setSaveBtnLabel("Save");
  const ml = UI.el("form-mode-label");
  if (ml) {
    ml.textContent = "";
    ml.hidden = true;
  }
  setAddFormSubtitle();
  const ce = UI.el("cancel-edit-btn");
  if (ce) ce.style.display = "none";

  // Re-enable any locked fields
  ["f-code", "f-name", "f-size", "f-qty", "f-buy", "f-sell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = false;
      el.style.opacity = "";
      el.style.cursor = "";
    }
  });
  setAddTypeLocked(false);

  _shoeState.reset();
  resetShoeUiPanels();
  _addFormWasFootwear = false;
  _addFormIsRecord = true;
  _preloadShoeCode = "";
  const pageAdd = document.getElementById("page-add");
  if (pageAdd) pageAdd.classList.remove("footwear-add-mode");
  const cascadeWrap = document.getElementById("f-type-cascade");
  if (cascadeWrap) delete cascadeWrap.dataset.footwearMode;
  ["shoe-shared-qty", "shoe-shared-buy", "shoe-shared-sell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });

  setRestockBanner(false);
  hideRestockView();
  _wishStockingFromId = null;
  onTypeChange();

  // Apply Record Only after onTypeChange so the default stays in sync.
  setItemMode(true);

  clearCodeMatchSelect();
  hideCodeDropdown();
}

// Code autocomplete helpers use the shared state declared by app.js.

async function findCodeMatchesForSave(code) {
  const clean = sanitiseCode(code);
  if (!clean) return [];
  const source = allItems && allItems.length ? allItems : await dbAll("items");
  const seen = new Set();
  const unique = [];
  for (const item of source) {
    if (!item.code || seen.has(item.code)) continue;
    seen.add(item.code);
    unique.push(item);
  }
  const exact = unique.filter((i) => i.code === clean);
  const startsWith = unique.filter(
    (i) => i.code !== clean && i.code.startsWith(clean),
  );
  const contains = unique.filter(
    (i) =>
      i.code !== clean && !i.code.startsWith(clean) && i.code.includes(clean),
  );
  const nameMatch = unique.filter(
    (i) =>
      i.name &&
      i.name.toUpperCase().includes(clean) &&
      !exact.includes(i) &&
      !startsWith.includes(i) &&
      !contains.includes(i),
  );
  return [...exact, ...startsWith, ...contains, ...nameMatch].slice(0, 10);
}

async function onCodeInput() {
  const raw = UI.el("f-code").value;
  const clean = sanitiseCode(raw);
  UI.el("f-code").value = clean;
  if (!clean) {
    clearCodeMatchSelect();
    hideCodeDropdown();
    return;
  }
  const source = allItems && allItems.length ? allItems : await dbAll("items");

  // De-duplicate by code then search: exact to startsWith to contains
  const seen = new Set();
  const unique = [];
  for (const item of source) {
    if (!item.code || seen.has(item.code)) continue;
    seen.add(item.code);
    unique.push(item);
  }
  const exact = unique.filter((i) => i.code === clean);
  const startsWith = unique.filter(
    (i) => i.code !== clean && i.code.startsWith(clean),
  );
  const contains = unique.filter(
    (i) =>
      i.code !== clean && !i.code.startsWith(clean) && i.code.includes(clean),
  );
  const nameMatch = unique.filter(
    (i) =>
      !seen.has("NAME_" + i.code) &&
      i.name &&
      i.name.toUpperCase().includes(clean) &&
      !exact.includes(i) &&
      !startsWith.includes(i) &&
      !contains.includes(i),
  );
  const matches = [...exact, ...startsWith, ...contains, ...nameMatch].slice(
    0,
    10,
  );

  if (!matches.length) {
    clearCodeMatchSelect("No match");
    hideCodeDropdown();
    return;
  }
  showCodeDropdown(matches, clean);

  const exactMatches = matches.filter((i) => i.code === clean);
  if (
    exactMatches.length === 1 &&
    exactMatches[0].isShoe &&
    isAddFormFootwearContext() &&
    !UI.el("edit-id")?.value
  ) {
    await preloadShoeSizesForAdd(exactMatches[0].code);
  }
}

async function preloadShoeSizesForAdd(code) {
  if (!code || !isAddFormFootwearContext()) return;
  const items = allItems && allItems.length ? allItems : await dbAll("items");
  const product = items.find((i) => i.code === code && i.isShoe);
  if (!product) return;
  if (_preloadShoeCode === code) return;
  _preloadShoeCode = code;
  _shoeState.sizes.clear();
  _shoeState.shownGroups.clear();
  const grid = UI.el("sz-grid");
  if (grid) grid.innerHTML = "";
  const records = await getShoeSizes(code);
  if (!records.length) return;

  const groupsNeeded = new Set();
  records.forEach((sz) =>
    groupsNeeded.add(sz.sizeGroup || _shoeState.groupFor(sz.size)),
  );
  records.forEach((sz) => _shoeState.sizes.add(sz.size));
  renderAllShoeGroupCards();

  const szWrap = UI.el("shoe-rows-wrap");
  if (szWrap)
    szWrap.style.display = _shoeState.sizes.size > 0 ? "block" : "none";
  renderShoeGroupButtons();
  renderShoeSummary();
  if (_shoeState.perSizeMode) renderShoeRows();
  updateShoeCollectiveSummary();
}

// ── Restock an existing footwear collection - only missing/out-of-stock
// sizes are selectable. Sizes already carrying stock (qty > 0) are locked.
async function preloadShoeSizesForRestock(code) {
  _shoeState.reset();
  const records = await getShoeSizes(code);
  records
    .filter((r) => (r.qty || 0) > 0)
    .forEach((r) => _shoeState.lockedSizes.add(Number(r.size)));
  const grid = UI.el("sz-grid");
  if (grid) grid.innerHTML = "";
  renderAllShoeGroupCards();
  showShoePricingPanel();
  renderShoeSummary();
  updateShoeCollectiveSummary();
}
window.preloadShoeSizesForRestock = preloadShoeSizesForRestock;

// Entry point: "Restock" button on a footwear collection's stock-list header.
async function openShoeCollectionRestock(code) {
  const items = allItems && allItems.length ? allItems : await dbAll("items");
  const item = items.find((i) => i.code === code && i.isShoe);
  if (!item) {
    toast("Item not found", "err");
    return;
  }

  showPage("add");
  setTimeout(async () => {
    setAddFormType(item.type || "", { skipTypeChange: true });
    UI.el("f-code").value = item.code || "";
    UI.el("f-name").value = item.name || "";
    UI.el("edit-id").value = "";
    onTypeChange();

    ["f-code", "f-name"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = true;
        el.style.opacity = "0.45";
        el.style.cursor = "not-allowed";
      }
    });
    setAddTypeLocked(true);
    setSaveBtnLabel("Save new sizes");
    const ml = UI.el("form-mode-label");
    if (ml) {
      ml.hidden = false;
      ml.textContent =
        "Restock " + item.code + " - missing & out-of-stock sizes only";
    }
    UI.el("cancel-edit-btn").style.display = "block";

    await preloadShoeSizesForRestock(item.code);
  }, 100);
}
window.openShoeCollectionRestock = openShoeCollectionRestock;

function showCodeDropdown(items, typedCode) {
  const select = document.getElementById("code-match-select");
  if (select) {
    select.onchange = () => selectExistingItemFromDropdown(select.value);
    select.disabled = !items.length;
    select.style.opacity = items.length ? "1" : "0.55";
    select.style.cursor = items.length ? "pointer" : "not-allowed";
    select.innerHTML =
      '<option value="">Match existing code...</option>' +
      items
        .map(
          (item) =>
            '<option value="' +
            item.id +
            '">' +
            escapeHtml(item.code) +
            "</option>",
        )
        .join("");
    hideCodeDropdown();
    return;
  }

  let dd = document.getElementById("code-dropdown");
  if (!dd) {
    dd = document.createElement("div");
    dd.id = "code-dropdown";
    dd.className = "code-dd";
    const cf = UI.el("f-code");
    if (cf) cf.parentNode.appendChild(dd);
  }
  dd.innerHTML = items
    .map((item) => {
      const isExact = item.code === typedCode;
      return `<div class="code-dd-item${isExact ? " code-dd-exact" : ""}" onclick="selectExistingItem(${item.id})">
      <div class="code-dd-code">${escapeHtml(item.code)}</div>
    </div>`;
    })
    .join("");
  dd.style.display = "block";
}

function hideCodeDropdown() {
  const dd = document.getElementById("code-dropdown");
  if (dd) dd.style.display = "none";
}

function clearCodeMatchSelect(label = "Match existing code...") {
  const select = document.getElementById("code-match-select");
  if (!select) return;
  select.innerHTML = '<option value="">' + escapeHtml(label) + "</option>";
  select.value = "";
  select.disabled = true;
  select.style.opacity = "0.55";
  select.style.cursor = "not-allowed";
}

function selectExistingItemFromDropdown(value) {
  const id = parseInt(value);
  if (!id) return;
  selectExistingItem(id);
}

async function selectExistingItem(itemId) {
  try {
    const item = await dbGet("items", itemId);
    if (!item) {
      toast("Warning: Item not found", "err");
      hideCodeDropdown();
      return;
    }
    hideCodeDropdown();

    // If on the Add page: open the item's detail sheet directly
    // This lets the user see, restock, edit or sell without creating a duplicate
    showPage("list");
    setTimeout(async () => {
      await openSheet(itemId);
    }, 80);
  } catch (e) {
    console.error("[selectExistingItem]", e);
    toast("Error: " + e.message, "err");
  }
}

function exitRestockMode() {
  _codeDropdownActive = false;
  clearForm();
}

async function recordStockInvestment(item, amount, qty, sourceLabel) {
  const value = parseFloat(amount) || 0;
  if (value <= 0) return null;
  const entry = {
    type: "stock_purchase",
    amount: value,
    description:
      (sourceLabel || "Stock added") +
      ": " +
      (item.name || item.code || "Item") +
      (qty ? " x " + qty : ""),
    category: "stock",
    itemCode: item.code || "",
    qty: qty || 0,
    date: todayDateStr(),
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : "system",
    auto: true,
  };
  entry.id = await dbAdd("finances", entry);
  return entry;
}

function cancelEdit() {
  clearForm();
  clearAddFormPhoto();
  showPage("list");
}

/* ===== stock.js ===== */
// ===== RENDER LIST =====
async function renderList() {
  allItems = await dbAll("items");
  const search = (UI.el("search")?.value || "").toLowerCase();
  renderTypeChips();
  _renderSizeGroupFilter();

  // Filter — if there's a query, rank by match score; otherwise sort by recency
  const filtered = allItems
    .filter((item) => {
      const matchSearch = !search || _gscScore(item, search) > 0;
      const matchType = itemMatchesTypeFilter(item, activeTypeFilter);
      return matchSearch && matchType;
    })
    .sort((a, b) => {
      if (search) return _gscScore(b, search) - _gscScore(a, search);
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

  updateHeader();
  const stockListCount = UI.el("stock-list-count");
  if (stockListCount)
    stockListCount.textContent =
      filtered.length + " of " + allItems.length + " items";

  const list = UI.el("item-list");
  if (!list) return;

  if (!filtered.length) {
    list.style.border = "none";
    const hasNoItems = allItems.length === 0 && !search && activeTypeFilter === "all";
    list.innerHTML = hasNoItems
      ? `<div class="inventory-empty-state inventory-empty-first">
          <div class="inventory-empty-art" aria-hidden="true">
            <i class="fa-solid fa-box-open"></i>
            <span><i class="fa-solid fa-plus"></i></span>
          </div>
          <h2>Your stock list is ready!</h2>
          <p>Search for a product or choose a category,<br class="desktop-break"> or add a new item to get started.</p>
          <div class="inventory-empty-actions">
            <button type="button" class="import-photo-btn inventory-photo-import-btn" onclick="openPhotoImport()">
              <i class="fa-solid fa-camera"></i> Add Stock from Photo
            </button>
            <button type="button" class="inventory-add-item-btn" onclick="showInventoryTab('add')">
              <i class="fa-solid fa-plus"></i> Add Item
            </button>
          </div>
        </div>`
      : `<div class="inventory-empty-state inventory-empty-no-match">
          <div class="inventory-empty-art" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></div>
          <h2>No matching products</h2>
          <p>Try another search or choose a different category.</p>
        </div>`;
    renderStockMonitorSummary();
    return;
  }

  // Sales index for profit display
  const allSales = await dbAll("sales");
  const salesByItem = {};
  const salesBySize = {}; // for shoe sizes: key = "CODE_size"
  allSales.forEach((s) => {
    if (!salesByItem[s.itemId]) salesByItem[s.itemId] = { qty: 0 };
    salesByItem[s.itemId].qty += s.qty || 1;
    if (s.itemCode && (s.itemSize || s.size)) {
      const k = s.itemCode + "_" + (s.itemSize || s.size);
      if (!salesBySize[k]) salesBySize[k] = 0;
      salesBySize[k] += s.qty || 1;
    }
  });

  // Load all shoe sizes once
  const allSizes = await dbAll("shoe_sizes");
  const ledgerSizeQty = new Map(
    await Promise.all(
      allSizes.map(async (size) => [
        size.id,
        await readableStockQty(size, size.id),
      ]),
    ),
  );
  const ledgerItemQty = new Map(
    await Promise.all(
      filtered.map(async (item) => [item.id, await displayStockQty(item)]),
    ),
  );

  const cards = [];

  // Pre-build sub-category type groups (non-shoe items whose type has a parentId)
  const _typeGroupMap = {};
  const _seenTypeGroups = new Set();
  const _groupedItemIds = new Set();
  for (const _gi of filtered) {
    if (_gi.isShoe) continue;
    const _gtObj = getTypeObj(_gi.type);
    if (_gtObj && _gtObj.parentId) {
      const _gpt = types.find((t) => t.id === _gtObj.parentId);
      if (_gpt) {
        if (!_typeGroupMap[_gpt.id])
          _typeGroupMap[_gpt.id] = { parentType: _gpt, items: [] };
        _typeGroupMap[_gpt.id].items.push(_gi);
        _groupedItemIds.add(_gi.id);
      }
    }
  }

  for (const item of filtered) {
    const t = getTypeObj(item.type);

    if (item.isShoe) {
      // ── SHOE ITEM - one card per SIZE ─────────────────────────────
      const sizes = allSizes
        .filter((s) => s.itemCode === item.code)
        .sort((a, b) => a.size - b.size);

      if (!sizes.length) {
        // Shoe parent with no sizes yet - show placeholder
        cards.push(`
          <div class="item-card item-card-shoe-header" onclick="openSheet(${item.id})">
            <div class="item-top">
              <div class="item-icon" style="background:${t.color || "var(--surface2)"};">${t.emoji}</div>
              <div class="item-body">
                <div class="item-code">${escapeHtml(item.code)}</div>
                <div class="item-name">${escapeHtml(item.name || "")}</div>
                <div class="item-tags">
                  <span class="tag tag-cyan">${escapeHtml(item.type)}</span>
                  <span class="tag tag-gray">No sizes added</span>
                </div>
              </div>
            </div>
          </div>`);
        continue;
      }

      // ── Aggregates for the group header ──────────────────────
      const groupTotalPcs = sizes.reduce(
        (s, sz) => s + (ledgerSizeQty.get(sz.id) || 0),
        0,
      );
      const groupSoldPcs = sizes.reduce(
        (s, sz) => s + (salesBySize[item.code + "_" + sz.size] || 0),
        0,
      );
      const groupBuyCost = sizes.reduce(
        (s, sz) =>
          s + (sz.buyPrice || item.buyPrice || item.buy || 0) * (sz.qty || 0),
        0,
      );
      let _grpRevenue = 0;
      allSales
        .filter((s) => s.itemCode === item.code)
        .forEach((s) => {
          _grpRevenue += s.revenue || 0;
        });
      const allOut = sizes.every((sz) => (ledgerSizeQty.get(sz.id) || 0) <= 0);
      const hasOut = sizes.some((sz) => (ledgerSizeQty.get(sz.id) || 0) <= 0);
      const isExpanded =
        (UI.el("search")?.value || "").length > 0 ||
        (_expandedShoeGroups && _expandedShoeGroups.has(item.code));

      cards.push(`
        <div class="shoe-group-header" onclick="toggleShoeGroup('${escapeHtml(item.code)}')" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${t.color || "#1e3a5f"};">${t.emoji}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(item.code)}</span>
              ${allOut ? '<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>' : hasOut ? '<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>' : ""}
            </div>
            <span class="shoe-group-name">${escapeHtml(item.name || "")}</span>
            <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>${groupTotalPcs} pcs</span><span>Sold ${groupSoldPcs}</span>
              <span>${fmt(groupBuyCost)}</span><span style="color:var(--accent2);">${fmt(_grpRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <button type="button" class="shoe-group-restock-btn" title="Restock - add missing or out-of-stock sizes"
                    onclick="event.stopPropagation();openShoeCollectionRestock('${escapeHtml(item.code)}')">
              <i class="fa-solid fa-plus"></i>
            </button>
            <span class="tag tag-cyan" style="font-size:10px;">${escapeHtml(item.type)}</span>
            <span style="font-size:16px;color:var(--muted);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded ? 180 : 0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) {
        cards.push('<div style="height:4px;"></div>');
      } else {
        const activeSgf = window._activeSizeGroupFilter || "all";
        const filteredSizes =
          activeSgf === "all"
            ? sizes
            : sizes.filter((sz) => sz.sizeGroup === activeSgf);
        filteredSizes.forEach((sz) => {
          const price = sz.sellPrice || item.sellPrice || 0;
          const buy = sz.buyPrice || item.buyPrice || 0;
          const availableQty = ledgerSizeQty.get(sz.id) || 0;
          const isOut = availableQty <= 0;
          const isLow = !isOut && availableQty <= LOW_STOCK_LEVEL;
          const stockColor = isOut
            ? "tag-red"
            : isLow
              ? "tag-amber"
              : "tag-green";
          const stockLabel = isOut ? "Out" : availableQty + " pcs";
          const soldQty = salesBySize[item.code + "_" + sz.size] || 0;
          cards.push(`
            <div class="item-card shoe-size-row${isOut ? " shoe-out-card" : ""}" onclick="openShoeSizeCard('${escapeHtml(item.code)}',${sz.size})">
              ${isOut ? '<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>' : ""}
              <div class="item-top">
                <div class="shoe-size-badge ${isOut ? "out" : isLow ? "low" : ""}">${sz.size}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(item.name || item.code)}</div>
                  <div class="item-tags">
                    ${sz.sizeGroup ? `<span class="tag tag-gray">${escapeHtml(getShoeGroups()[sz.sizeGroup]?.label || sz.sizeGroup)}</span>` : ""}
                    <span class="tag ${stockColor}">${stockLabel}</span>
                    <span class="tag tag-gray">${soldQty} sold</span>
                  </div>
                </div>
                <div class="item-right">
                  <div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent2);">${fmt(price)}</div>
                  <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:2px;">Buy: ${fmt(buy)}</div>
                </div>
              </div>
            </div>`);
        });
        cards.push('<div style="height:6px;"></div>');
      }
    } else if (item.hasVariants) {
      // ── GENERAL VARIANT ITEM - expandable like footwear ───────────
      const variants = allSizes
        .filter((s) => s.itemCode === item.code)
        .sort((a, b) =>
          String(a.sizeGroup || "").localeCompare(String(b.sizeGroup || "")),
        );

      if (!variants.length) {
        cards.push(`
          <div class="item-card" onclick="openSheet(${item.id})">
            <div class="item-top">
              <div class="item-icon" style="background:${t.color || "var(--surface2)"};">${t.emoji}</div>
              <div class="item-body">
                <div class="item-code">${escapeHtml(item.code)}</div>
                <div class="item-name">${escapeHtml(item.name || "")}</div>
                <div class="item-tags">
                  <span class="tag tag-cyan">${escapeHtml(item.type)}</span>
                  <span class="tag tag-gray">No variants</span>
                </div>
              </div>
            </div>
          </div>`);
        continue;
      }

      const groupTotalPcs = variants.reduce(
        (s, v) => s + (ledgerSizeQty.get(v.id) || 0),
        0,
      );
      const groupSoldPcs = variants.reduce(
        (s, v) => s + (salesBySize[item.code + "_" + v.sizeGroup] || 0),
        0,
      );
      const groupRevenue = allSales
        .filter((s) => s.itemCode === item.code)
        .reduce((s, x) => s + (x.revenue || 0), 0);
      const allOut = variants.every((v) => (ledgerSizeQty.get(v.id) || 0) <= 0);
      const hasOut = variants.some((v) => (ledgerSizeQty.get(v.id) || 0) <= 0);
      const isExpanded =
        (UI.el("search")?.value || "").length > 0 ||
        (_expandedShoeGroups && _expandedShoeGroups.has(item.code));

      cards.push(`
        <div class="shoe-group-header" onclick="toggleShoeGroup('${escapeHtml(item.code)}')" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${t.color || "#334155"};">${t.emoji}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(item.code)}</span>
              ${allOut ? '<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>' : hasOut ? '<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>' : ""}
            </div>
            <span class="shoe-group-name">${escapeHtml(item.name || "")}</span>
            <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>${variants.length} ${escapeHtml(item.variantType || "variant")}${variants.length !== 1 ? "s" : ""}</span>
              <span>${groupTotalPcs} pcs</span>
              <span>Sold ${groupSoldPcs}</span>
              <span style="color:var(--accent2);">${fmt(groupRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <span class="tag tag-cyan" style="font-size:10px;">${escapeHtml(item.variantType || "Variants")}</span>
            <span style="font-size:16px;color:var(--muted);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded ? 180 : 0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) {
        cards.push('<div style="height:4px;"></div>');
      } else {
        variants.forEach((v) => {
          const availableQty = ledgerSizeQty.get(v.id) || 0;
          const isOut = availableQty <= 0;
          const isLow = !isOut && availableQty <= LOW_STOCK_LEVEL;
          const sc = isOut ? "tag-red" : isLow ? "tag-amber" : "tag-green";
          const sl = isOut ? "Out" : availableQty + " pcs";
          const sq = salesBySize[item.code + "_" + v.sizeGroup] || 0;
          const sp = v.sellPrice || item.sellPrice || 0;
          const bp = v.buyPrice || item.buyPrice || 0;
          cards.push(`
            <div class="item-card shoe-size-row${isOut ? " shoe-out-card" : ""}" onclick="openSheet(${item.id})">
              ${isOut ? '<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>' : ""}
              <div class="item-top">
                <div class="variant-badge ${isOut ? "out" : isLow ? "low" : ""}">${escapeHtml(v.sizeGroup || "?")}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(item.name || item.code)}</div>
                  <div class="item-tags">
                    <span class="tag tag-gray">${sq} sold</span>
                    <span class="tag ${sc}">${sl}</span>
                  </div>
                </div>
                <div class="item-right">
                  <div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent2);">${fmt(sp)}</div>
                  <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:2px;">Buy: ${fmt(bp)}</div>
                </div>
              </div>
            </div>`);
        });
        cards.push('<div style="height:6px;"></div>');
      }
    } else if (_groupedItemIds.has(item.id)) {
      // ── SUB-CATEGORY GROUP - expandable like footwear ─────────────
      const ptId = getTypeObj(item.type).parentId;
      if (_seenTypeGroups.has(ptId)) continue;
      _seenTypeGroups.add(ptId);

      const { parentType, items: groupItems } = _typeGroupMap[ptId];
      const isExpanded =
        (UI.el("search")?.value || "").length > 0 ||
        _expandedTypeGroups.has(ptId);
      const groupTotalQty = groupItems.reduce(
        (s, i) => s + (ledgerItemQty.get(i.id) || 0),
        0,
      );
      const groupRevenue = allSales
        .filter((s) => groupItems.some((i) => i.id === s.itemId))
        .reduce((s, x) => s + (x.revenue || 0), 0);
      const allOut = groupItems.every(
        (i) => (ledgerItemQty.get(i.id) || 0) <= 0,
      );
      const hasOut = groupItems.some(
        (i) => (ledgerItemQty.get(i.id) || 0) <= 0,
      );

      cards.push(`
        <div class="type-group-header" onclick="toggleTypeGroup(${ptId})" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${parentType.color || "#334155"};">${parentType.emoji || "📦"}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(parentType.name)}</span>
              ${allOut ? '<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>' : hasOut ? '<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>' : ""}
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,.6);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>${groupItems.length} item${groupItems.length !== 1 ? "s" : ""}</span>
              <span>${groupTotalQty} pcs</span>
              <span style="color:var(--accent2);">${fmt(groupRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <span style="font-size:16px;color:rgba(255,255,255,.6);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded ? 180 : 0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) {
        cards.push('<div style="height:4px;"></div>');
      } else {
        for (const ci of groupItems) {
          const ct = getTypeObj(ci.type);
          const ciQty = ledgerItemQty.get(ci.id) || 0;
          const sc =
            ciQty === 0
              ? "tag-red"
              : ciQty <= LOW_STOCK_LEVEL
                ? "tag-amber"
                : "tag-green";
          const sl = ciQty === 0 ? "Out" : ciQty + " pcs";
          const sq = (salesByItem[ci.id] || {}).qty || 0;
          const sp = ci.sellPrice || ci.sell || 0;
          const bp = ci.buyPrice || ci.buy || 0;
          cards.push(`
            <div class="item-card type-group-child-row${ciQty <= 0 ? " shoe-out-card" : ""}" onclick="openSheet(${ci.id})">
              ${ciQty <= 0 ? '<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>' : ""}
              <div class="item-top">
                <div class="item-icon" style="background:${ct.color || "var(--surface2)"};">${ct.emoji || "📦"}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(ci.code)}${ci.variant || ci.size ? " - " + escapeHtml(ci.variant || ci.size) : ""}</div>
                  <div class="item-name">${escapeHtml(ci.name || "")}</div>
                  <div class="item-tags">
                    <span class="tag tag-cyan">${escapeHtml(ci.type)}</span>
                    <span class="tag tag-gray">${sq} sold</span>
                    <span class="tag ${sc}">${sl}</span>
                  </div>
                </div>
                <div class="item-right">
                  <div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(sp)}</div>
                  <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">Buy: ${fmt(bp)}</div>
                </div>
              </div>
            </div>`);
        }
        cards.push('<div style="height:6px;"></div>');
      }
    } else {
      // ── STANDARD ITEM - single card ───────────────────────────────
      const isRec = !!item.isRecord;
      const availableQty = ledgerItemQty.get(item.id) || 0;
      const stockColor = isRec
        ? "tag-amber"
        : availableQty === 0
          ? "tag-red"
          : availableQty <= LOW_STOCK_LEVEL
            ? "tag-amber"
            : "tag-green";
      const stockLabel = isRec
        ? "Record"
        : availableQty === 0
          ? "Out"
          : availableQty + " pcs";
      const soldQty = (salesByItem[item.id] || {}).qty || 0;
      const sellPrice = item.sellPrice || item.sell || 0;
      const buyPrice = item.buyPrice || item.buy || 0;

      const stockDot = isRec
        ? "#f59e0b"
        : availableQty === 0
          ? "var(--red)"
          : availableQty <= LOW_STOCK_LEVEL
            ? "#f59e0b"
            : "var(--green)";
      cards.push(`
        <div class="item-card item-card-compact${isRec ? " item-card-record" : availableQty <= 0 ? " shoe-out-card" : ""}" onclick="openSheet(${item.id})">
          <div class="item-top">
            <div class="item-icon" style="background:${t.color || "var(--surface2)"};">${t.emoji}</div>
            <div class="item-body">
              <div class="ic-row1">
                <span class="ic-code">${escapeHtml(item.code)}${item.variant || item.size ? " · " + escapeHtml(item.variant || item.size) : ""}</span>
                <span class="ic-name">${escapeHtml(item.name || "")}</span>
              </div>
              <div class="ic-row2">
                <span class="ic-type">${escapeHtml(item.type)}</span>
                ${isRec ? '<span class="ic-badge ic-badge-rec">RECORD</span>' : ""}
                <span class="ic-dot" style="background:${stockDot};"></span>
                <span class="ic-stock">${stockLabel}</span>
                ${soldQty > 0 ? '<span class="ic-sold">· ' + soldQty + " sold</span>" : ""}
              </div>
            </div>
            <div class="item-right">
              <div class="ic-price">${fmt(sellPrice)}</div>
              ${buyPrice > 0 ? '<div class="ic-buy">Buy ' + fmt(buyPrice) + "</div>" : ""}
            </div>
          </div>
        </div>`);
    }
  }

  list.style.border = "";
  list.innerHTML = cards.join("");
  renderStockMonitorSummary();
}

async function renderInventoryStockTable() {
  allItems = await dbAll("items");
  const search = (UI.el("search")?.value || "").toLowerCase();
  const allSizes = await dbAll("shoe_sizes");
  const searchSizesByItemCode = new Map();
  allSizes.forEach((size) => {
    if (!searchSizesByItemCode.has(size.itemCode))
      searchSizesByItemCode.set(size.itemCode, []);
    searchSizesByItemCode
      .get(size.itemCode)
      .push([size.size, size.sizeGroup].filter(Boolean).join(" "));
  });
  const scoreItem = (item) =>
    _gscScore(
      {
        ...item,
        variant: [
          item.variant,
          item.size,
          ...(searchSizesByItemCode.get(item.code) || []),
        ]
          .filter(Boolean)
          .join(" "),
      },
      search,
    );
  renderTypeChips();
  _renderSizeGroupFilter();

  const filtered = allItems
    .filter(
      (item) =>
        (!search || scoreItem(item) > 0) &&
        itemMatchesTypeFilter(item, activeTypeFilter),
    )
    .sort((a, b) => {
      if (search) return scoreItem(b) - scoreItem(a);
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });

  updateHeader();
  const stockListCount = UI.el("stock-list-count");
  if (stockListCount)
    stockListCount.textContent =
      filtered.length + " of " + allItems.length + " items";

  const list = UI.el("item-list");
  if (!list) return;

  if (!filtered.length) {
    list.style.border = "none";
    const hasNoItems =
      allItems.length === 0 && !search && activeTypeFilter === "all";
    list.innerHTML = hasNoItems
      ? `<div class="inventory-empty-state inventory-empty-first">
          <div class="inventory-empty-art" aria-hidden="true">
            <i class="fa-solid fa-box-open"></i>
            <span><i class="fa-solid fa-plus"></i></span>
          </div>
          <h2>Your stock list is ready!</h2>
          <p>Search for a product or choose a category,<br class="desktop-break"> or add a new item to get started.</p>
          <div class="inventory-empty-actions">
            <button type="button" class="import-photo-btn inventory-photo-import-btn" onclick="openPhotoImport()">
              <i class="fa-solid fa-camera"></i> Add Stock from Photo
            </button>
            <button type="button" class="inventory-add-item-btn" onclick="showInventoryTab('add')">
              <i class="fa-solid fa-plus"></i> Add Item
            </button>
          </div>
        </div>`
      : `<div class="inventory-empty-state inventory-empty-no-match">
          <div class="inventory-empty-art" aria-hidden="true"><i class="fa-solid fa-magnifying-glass"></i></div>
          <h2>No matching products</h2>
          <p>Try another search or choose a different category.</p>
        </div>`;
    renderStockMonitorSummary();
    return;
  }

  const sizeQuantities = new Map(
    await Promise.all(
      allSizes.map(async (size) => [
        size.id,
        await readableStockQty(size, size.id),
      ]),
    ),
  );
  const itemQuantities = new Map(
    await Promise.all(
      filtered.map(async (item) => [item.id, await displayStockQty(item)]),
    ),
  );

  const formatTablePrice = (price) =>
    (parseFloat(price) || 0).toLocaleString("en-KE", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  const rows = [];
  const getStockState = (quantity, isRecord) => {
    if (isRecord) return { label: "Record", className: "record" };
    if (quantity <= 0) return { label: "Out of stock", className: "out" };
    if (quantity <= LOW_STOCK_LEVEL)
      return { label: "Low stock", className: "low" };
    return { label: "In stock", className: "in" };
  };
  const addRow = ({
    item,
    variant = "",
    quantity = 0,
    buyPrice = item.buyPrice || item.buy || 0,
    sellPrice = item.sellPrice || item.sell || 0,
    isRecord = !!item.isRecord,
    size = "",
    targetRows = rows,
  }) => {
    const stockState = getStockState(quantity, isRecord);
    const safeItemCode = escapeHtml(item.code || "");
    const safeName = escapeHtml(item.name || item.code || "");
    const safeVariant = escapeHtml(variant || "—");
    const displayName =
      variant && variant !== "—"
        ? safeName + " · " + safeVariant
        : safeName;
    targetRows.push(`
      <tr class="stock-table-row-${stockState.className}" data-item-id="${Number(item.id)}" ${
        size !== "" ? `data-item-code="${safeItemCode}" data-item-size="${escapeHtml(String(size))}"` : ""
      } tabindex="0" role="button" aria-label="Open ${safeName}${variant ? " " + safeVariant : ""}; status: ${stockState.label}">
      <td class="stock-table-code" title="Status: ${stockState.label}">${safeItemCode}<span class="stock-table-stock-indicator" aria-hidden="true"></span></td>
      <td class="stock-table-name">${displayName}</td>
      <td class="stock-table-number">${isRecord ? "—" : fmtN(quantity)}</td>
      <td class="stock-table-number">${formatTablePrice(buyPrice)}</td>
        <td class="stock-table-number stock-table-selling">${formatTablePrice(sellPrice)}</td>
      </tr>`);
  };
  const addShoeGroupRow = (item, sizes) => {
    const totalQuantity = sizes.reduce(
      (total, size) => total + (sizeQuantities.get(size.id) || 0),
      0,
    );
    const stockState = getStockState(totalQuantity, !!item.isRecord);
    const safeItemCode = escapeHtml(item.code || "");
    const safeName = escapeHtml(item.name || item.code || "");
    const groupId = `stock-shoe-group-${Number(item.id)}`;
    const childRows = [];
    const groupPrice = (field, fallback) => {
      const prices = [
        ...new Set(
          sizes.map(
            (size) =>
              parseFloat(size[field]) ||
              parseFloat(item[fallback]) ||
              parseFloat(item[field === "buyPrice" ? "buy" : "sell"]) ||
              0,
          ),
        ),
      ];
      return prices.length === 1
        ? formatTablePrice(prices[0])
        : "Varies";
    };
    sizes.forEach((size) =>
      addRow({
        item,
        size: size.size,
        variant:
          "Size " +
          size.size +
          (size.sizeGroup
            ? " · " + (getShoeGroups()[size.sizeGroup]?.label || size.sizeGroup)
            : ""),
        quantity: sizeQuantities.get(size.id) || 0,
        buyPrice: size.buyPrice || item.buyPrice || item.buy || 0,
        sellPrice: size.sellPrice || item.sellPrice || item.sell || 0,
        targetRows: childRows,
      }),
    );
    rows.push(`
      <tr class="stock-table-row-${stockState.className} stock-table-shoe-group">
        <td class="stock-table-code" title="Status: ${stockState.label}">
          <button type="button" class="stock-table-expand" data-item-name="${safeName}" aria-expanded="false" aria-controls="${groupId}" aria-label="Expand ${safeName} sizes">
            <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
          </button>
          ${safeItemCode}<span class="stock-table-stock-indicator" aria-hidden="true"></span>
        </td>
        <td class="stock-table-name">${safeName}<span class="stock-table-size-count">${sizes.length} sizes</span></td>
        <td class="stock-table-number">${item.isRecord ? "—" : fmtN(totalQuantity)}</td>
        <td class="stock-table-number">${groupPrice("buyPrice", "buy")}</td>
        <td class="stock-table-number stock-table-selling">${groupPrice("sellPrice", "sell")}</td>
      </tr>
      <tr class="stock-table-shoe-children" id="${groupId}" hidden>
        <td colspan="5">
          <table class="inventory-stock-table stock-table-shoe-child-table" aria-label="${safeName} sizes">
            <tbody>${childRows.join("")}</tbody>
          </table>
        </td>
      </tr>`);
  };

  for (const item of filtered) {
    if (item.isShoe) {
      const allItemSizes = allSizes
        .filter((size) => size.itemCode === item.code)
        .sort((a, b) => a.size - b.size);
      const activeSizeGroup = window._activeSizeGroupFilter || "all";
      const sizes =
        activeSizeGroup === "all"
          ? allItemSizes
          : allItemSizes.filter(
              (size) => size.sizeGroup === activeSizeGroup,
            );
      if (!sizes.length) {
        if (allItemSizes.length && activeSizeGroup !== "all") continue;
        addRow({
          item,
          variant: "No sizes",
          quantity: 0,
        });
        continue;
      }
      if (sizes.length > 1) {
        addShoeGroupRow(item, sizes);
        continue;
      }
      sizes.forEach((size) => {
        addRow({
          item,
          size: size.size,
          variant:
            "Size " +
            size.size +
            (size.sizeGroup
              ? " · " +
                (getShoeGroups()[size.sizeGroup]?.label || size.sizeGroup)
              : ""),
          quantity: sizeQuantities.get(size.id) || 0,
          buyPrice: size.buyPrice || item.buyPrice || item.buy || 0,
          sellPrice: size.sellPrice || item.sellPrice || item.sell || 0,
        });
      });
      continue;
    }

    if (item.hasVariants) {
      const variants = allSizes
        .filter((size) => size.itemCode === item.code)
        .sort((a, b) =>
          String(a.sizeGroup || "").localeCompare(String(b.sizeGroup || "")),
        );
      if (variants.length) {
        variants.forEach((variant) => {
          addRow({
            item,
            variant:
              variant.sizeGroup || variant.size || item.variantType || "Variant",
            quantity: sizeQuantities.get(variant.id) || 0,
            buyPrice: variant.buyPrice || item.buyPrice || item.buy || 0,
            sellPrice: variant.sellPrice || item.sellPrice || item.sell || 0,
          });
        });
        continue;
      }
    }

    addRow({
      item,
      variant: item.variant || item.size || "",
      quantity: itemQuantities.get(item.id) || 0,
    });
  }

  list.style.border = "";
  list.innerHTML = `
    <div class="inventory-stock-table-wrap">
      <table class="inventory-stock-table">
        <thead>
          <tr>
            <th scope="col">Code</th>
            <th scope="col">Item</th>
            <th scope="col">Qty</th>
            <th scope="col" title="Buy price">Buy</th>
            <th scope="col" title="Selling price">Sell</th>
          </tr>
        </thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;

  list.querySelectorAll(".stock-table-expand").forEach((button) => {
    button.addEventListener("click", () => {
      const children = document.getElementById(
        button.getAttribute("aria-controls"),
      );
      if (!children) return;
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.setAttribute("aria-expanded", String(!expanded));
      children.hidden = expanded;
      button.setAttribute(
        "aria-label",
        `${expanded ? "Expand" : "Collapse"} ${button.dataset.itemName} sizes`,
      );
    });
  });

  list.querySelectorAll(".inventory-stock-table tbody tr").forEach((row) => {
    if (!row.hasAttribute("data-item-id")) return;
    const openItem = () => {
      const itemId = Number(row.dataset.itemId);
      if (row.dataset.itemSize) {
        openShoeSizeCard(row.dataset.itemCode, Number(row.dataset.itemSize));
      } else {
        openSheet(itemId);
      }
    };
    row.addEventListener("click", openItem);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openItem();
      }
    });
  });
  renderStockMonitorSummary();
}

async function getStockMonitorRows() {
  const items = await dbAll("items");
  await enrichShoeItems(items);
  const sizes = await dbAll("shoe_sizes");
  const wishlist = db.objectStoreNames.contains("wishlist")
    ? await dbAll("wishlist")
    : [];
  const rows = [];

  for (const item of items) {
    if (item.isShoe) {
      for (const sz of sizes.filter(
        (record) => record.itemCode === item.code,
      )) {
        const availableQty = await readableStockQty(sz, sz.id);
        if (availableQty > 0) continue;
        rows.push({
          kind: "out",
          itemId: item.id,
          size: sz.size,
          name: item.name || item.code,
          code: item.code,
          type: item.type || "",
          qty: 0,
          buyPrice: sz.buyPrice || item.buyPrice || item.buy || 0,
          label: "Out of stock - size " + sz.size,
        });
      }
    } else if (!item.isRecord && (await readableStockQty(item)) <= 0) {
      rows.push({
        kind: "out",
        itemId: item.id,
        name: item.name || item.code,
        code: item.code,
        type: item.type || "",
        qty: 0,
        buyPrice: item.buyPrice || item.buy || 0,
        label: "Out of stock",
      });
    }
  }

  wishlist
    .filter((w) => (w.status || "prospective") !== "stocked")
    .forEach((w) =>
      rows.push({
        kind:
          (w.status || "") === "unaccounted" ? "unaccounted" : "prospective",
        wishId: w.id,
        name: w.name || w.code || "Prospective item",
        code: w.code || "",
        type: w.type || "",
        qty: w.qty || 0,
        buyPrice: w.estimatedCost || 0,
        note: w.note || "",
        label:
          (w.status || "") === "unaccounted" ? "Not accounted" : "Prospective",
      }),
    );

  return rows.sort((a, b) => {
    const order = { out: 0, unaccounted: 1, prospective: 2 };
    if (a.kind !== b.kind) return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
    return (a.name || "").localeCompare(b.name || "");
  });
}

function filterStockRows(rows, kind) {
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

async function renderStockMonitorSummary() {
  const rows = await getStockMonitorRows();
  const wishCount = rows.filter((r) => r.kind === "prospective").length;
  const wishSub = document.getElementById("wishlist-sub");
  if (wishSub) wishSub.textContent = wishCount + " prospective items";
}

function renderOffstockTypeOptions() {
  mountOffTypeCascade();
}

async function openStockMonitor() {
  await renderStockMonitor();
  const sheet = document.getElementById("stock-monitor-sheet");
  if (sheet) sheet.classList.add("open");
}

function closeStockMonitor() {
  const sheet = document.getElementById("stock-monitor-sheet");
  if (sheet) sheet.classList.remove("open");
}

async function renderStockMonitor() {
  const targets = [
    {
      list: document.getElementById("stock-monitor-list"),
      counts: document.getElementById("stock-monitor-counts"),
      sheetOnly: true,
    },
    {
      list: document.getElementById("inventory-monitor-list"),
      counts: document.getElementById("inventory-monitor-counts"),
      sheetOnly: false,
    },
  ].filter((t) => t.list);
  if (!targets.length) return;
  const allRows = await getStockMonitorRows();
  const rows = allRows.filter(
    (row) => row.kind === "out" || row.kind === "unaccounted",
  );
  const outCount = rows.filter((row) => row.kind === "out").length;
  const unaccountedCount = rows.filter(
    (row) => row.kind === "unaccounted",
  ).length;
  const html = rows.length
    ? rows
        .map((row) => {
          const cls = row.kind === "out" ? "out" : "unaccounted";
          const status =
            row.kind === "out"
              ? '<span class="tag tag-red">Out of stock</span>'
              : '<span class="tag tag-blue">Not accounted</span>';
          const restockAction =
            row.kind === "out"
              ? "restockFromMonitor(" +
                row.itemId +
                (row.size ? "," + row.size : "") +
                ")"
              : "openWishlistDetail(" + row.wishId + ")";
          const deleteBtn =
            row.kind !== "out"
              ? '<button class="stock-monitor-action delete" onclick="event.stopPropagation();deleteWishlistItem(' +
                row.wishId +
                ')" title="Remove"><i class="fa-solid fa-trash"></i></button>'
              : "";
          return (
            '<div class="stock-monitor-row ' +
            cls +
            '" onclick="' +
            restockAction +
            '" role="button" tabindex="0">' +
            '<div class="stock-monitor-body">' +
            '<div class="stock-monitor-name">' +
            escapeHtml(row.name) +
            "</div>" +
            '<div class="stock-monitor-meta">' +
            escapeHtml(row.code || "No code") +
            (row.type ? " - " + escapeHtml(row.type) : "") +
            (row.qty ? " - target " + row.qty : "") +
            (row.buyPrice ? " - " + fmt(row.buyPrice) : "") +
            "</div>" +
            '<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;">' +
            status +
            (row.size
              ? '<span class="tag tag-gray">Size ' +
                escapeHtml(row.size) +
                "</span>"
              : "") +
            (row.note
              ? '<span class="tag tag-gray">' + escapeHtml(row.note) + "</span>"
              : "") +
            "</div>" +
            "</div>" +
            '<div class="stock-monitor-actions">' +
            '<button class="stock-monitor-action restock" onclick="event.stopPropagation();' +
            restockAction +
            '" title="Restock"><i class="fa-solid fa-boxes-stacked"></i></button>' +
            deleteBtn +
            "</div>" +
            "</div>"
          );
        })
        .join("")
    : '<div class="empty" style="padding:28px 12px;"><div class="e-icon">OK</div><p>No monitored items.</p></div>';

  targets.forEach((target) => {
    if (target.counts) {
      target.counts.innerHTML =
        '<div class="stock-monitor-pill red">' +
        outCount +
        " Out of stock</div>" +
        '<div class="stock-monitor-pill blue">' +
        unaccountedCount +
        " Not accounted</div>";
    }
    target.list.innerHTML = html;
  });
}


function toggleShoeGroup(code) {
  if (_expandedShoeGroups.has(code)) {
    _expandedShoeGroups.delete(code);
  } else {
    _expandedShoeGroups.add(code);
  }
  renderList();
}
window.toggleShoeGroup = toggleShoeGroup;

// ══════════════════════════════════════════════════════════════════
// AI ASSISTANT  —  Google Gemini 2.5 Flash
// ══════════════════════════════════════════════════════════════════
// Shared settings keys are declared by app.js.

/* ===== item-details.js ===== */
async function openShoeSizeCard(itemCode, size) {
  const items = await dbAll("items");
  const item = items.find((i) => i.code === itemCode);
  if (!item) {
    toast("Item not found", "err");
    return;
  }

  const allSz = await getShoeSizes(itemCode);
  const sizeRec = allSz.find((s) => s.size === size);
  if (!sizeRec) {
    toast("Size record not found", "err");
    return;
  }

  const price = sizeRec.sellPrice || item.sellPrice || 0;
  const buy = sizeRec.buyPrice || item.buyPrice || 0;
  const profit = price - buy;
  const availableQty = await readableStockQty(sizeRec, sizeRec.id);
  const isOut = availableQty <= 0;
  const isLow = !isOut && availableQty <= LOW_STOCK_LEVEL;
  const stockCol = isOut ? "var(--red)" : isLow ? "#d97706" : "var(--green)";
  const stockLbl = isOut ? "Out of stock" : availableQty + " pcs in stock";
  const groupLbl =
    getShoeGroups()[sizeRec.sizeGroup]?.label ||
    sizeRec.sizeGroup ||
    "Size group";

  let sheet = document.getElementById("shoe-size-action-sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "shoe-size-action-sheet";
    sheet.className = "sheet-overlay";
    sheet.innerHTML =
      '<div class="sheet detail-sheet-unified" id="shoe-size-action-inner"></div>';
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) closeShoeSizeActions();
    });
    document.body.appendChild(sheet);
  }

  const inner = document.getElementById("shoe-size-action-inner");
  inner.innerHTML = `
    <div class="sheet-handle"></div>
    <button type="button" class="detail-sheet-close" onclick="closeShoeSizeActions()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    <div class="detail-sheet-hero">
      <div class="shoe-size-badge ${isOut ? "out" : isLow ? "low" : ""}" style="width:56px;height:56px;font-size:24px;">${size}</div>
      <div class="detail-sheet-hero-text">
        <div class="detail-sheet-title">${escapeHtml(item.name || item.code)}</div>
        <div class="detail-sheet-sub">${escapeHtml(item.code)} - Size ${size} - ${groupLbl}</div>
        <div class="detail-sheet-stock" style="color:${stockCol};">${stockLbl}</div>
      </div>
    </div>
    <div id="sh-price-cols" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin:0 12px 10px;">
      <div class="sh-stat-box"><div class="sh-stat-lbl">Buying</div><div class="sh-stat-val muted">${fmt(buy)}</div></div>
      <div class="sh-stat-box"><div class="sh-stat-lbl">Selling</div><div class="sh-stat-val accent2">${fmt(price)}</div></div>
      <div class="sh-stat-box accent-bg"><div class="sh-stat-lbl">Profit</div><div class="sh-stat-val ${profit > 0 ? "green" : "muted"}">${fmt(profit)}</div></div>
      <div class="sh-stat-box"><div class="sh-stat-lbl">Stock</div><div class="sh-stat-val accent">${availableQty} pcs</div></div>
    </div>
    <div class="detail-action-row">
      <button type="button" class="btn-del detail-action-btn" onclick="closeShoeSizeActions();openSheet(${item.id})">
        <i class="fa-solid fa-box"></i> Product
      </button>
      <button type="button" class="detail-action-btn detail-action-restock" onclick="closeShoeSizeActions();openShoeSizeRestock(${item.id},${size})">
        <i class="fa-solid fa-boxes-stacked"></i> Restock
      </button>
    </div>
    <div class="detail-sell-wrap">
      ${
        !isOut
          ? `<button type="button" class="detail-sell-btn" onclick="closeShoeSizeActions();closeSheet();openSellShoeModal(${item.id},${size})">SELL - Size ${size}</button>`
          : `<div class="detail-sell-muted">Out of stock - restock first</div>`
      }
    </div>
    <div style="padding:0 12px 16px;text-align:center;">
      <button type="button" class="detail-link-btn" onclick="closeShoeSizeActions();openShoeSizeEdit(${item.id},${size})">Edit prices</button>
    </div>`;

  sheet.classList.add("open");
}
window.openShoeSizeCard = openShoeSizeCard;

// ===== DETAIL SHEET =====

async function renderShoeDetailGrid(item) {
  const wrap = document.getElementById("sh-shoe-sizes");
  if (!wrap || !item) return;

  const sizes = (await getShoeSizes(item.code))
    .filter((s) => Number.isFinite(Number(s.size)))
    .sort((a, b) => Number(a.size) - Number(b.size));

  if (!sizes.length) {
    wrap.style.display = "none";
    return;
  }

  const quantities = await Promise.all(
    sizes.map((size) => readableStockQty(size, size.id)),
  );

  wrap.style.display = "block";
  wrap.innerHTML =
    '<div class="sh-detail-size-grid">' +
    sizes
      .map((s, index) => {
        const n = Number(s.size);
        const selected = _selectedShoeSizes.has(n);
        const quantity = quantities[index];
        const state =
          quantity <= 0 ? " out" : quantity <= LOW_STOCK_LEVEL ? " low" : "";
        return (
          '<button type="button" class="sh-detail-size-btn' +
          state +
          (selected ? " selected" : "") +
          '"' +
          ' data-sh-size="' +
          n +
          '" onclick="toggleDetailShoeSize(' +
          item.id +
          "," +
          n +
          ')">' +
          n +
          "</button>"
        );
      })
      .join("") +
    "</div>";

  _updateDetailShoeSelectionBar(item.id);
}

function toggleDetailShoeSize(itemId, size) {
  size = Number(size);
  if (_selectedShoeSizes.has(size)) _selectedShoeSizes.delete(size);
  else _selectedShoeSizes.add(size);

  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  _selectedShoeSize = selected.length ? selected[selected.length - 1] : null;

  document.querySelectorAll("#sh-shoe-sizes [data-sh-size]").forEach((btn) => {
    btn.classList.toggle(
      "selected",
      _selectedShoeSizes.has(Number(btn.dataset.shSize)),
    );
  });
  _updateDetailShoeSelectionBar(itemId);
}
window.toggleDetailShoeSize = toggleDetailShoeSize;

function _updateDetailShoeSelectionBar(itemId) {
  const bar = document.getElementById("sh-selected-size-bar");
  if (!bar) return;
  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  if (!selected.length) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "block";
  bar.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
    '<span style="font-family:var(--mono);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
    selected.join(", ") +
    "</span>" +
    '<button onclick="restockSelectedShoeSizes(' +
    itemId +
    ')" style="padding:7px 12px;background:var(--green);color:white;border:none;border-radius:var(--r);font-size:12px;font-weight:800;cursor:pointer;font-family:var(--sans);flex-shrink:0;">Restock</button>' +
    "</div>";
}

async function restockSelectedShoeSizes(itemId) {
  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  if (!selected.length) {
    toast("Select size first", "err");
    return;
  }
  if (selected.length === 1) {
    closeSheet();
    openShoeSizeRestock(itemId, selected[0]);
    return;
  }
  openBulkShoeRestockSheet(itemId, selected);
}
window.restockSelectedShoeSizes = restockSelectedShoeSizes;

function openBulkShoeRestockSheet(itemId, sizes) {
  _bulkShoeRestock = { itemId, sizes: [...sizes] };
  let sheet = document.getElementById("bulk-shoe-restock-sheet");
  if (!sheet) {
    sheet = document.createElement("div");
    sheet.id = "bulk-shoe-restock-sheet";
    sheet.className = "sheet-overlay";
    sheet.innerHTML = '<div class="sheet" id="bulk-shoe-restock-inner"></div>';
    sheet.addEventListener("click", (e) => {
      if (e.target === sheet) closeBulkShoeRestock();
    });
    document.body.appendChild(sheet);
  }

  const inner = document.getElementById("bulk-shoe-restock-inner");
  inner.innerHTML =
    '<div class="sheet-handle"></div>' +
    '<div class="sheet-title">Restock sizes</div>' +
    '<div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent);margin-bottom:12px;">' +
    sizes.join(", ") +
    "</div>" +
    '<input id="bulk-shoe-restock-qty" type="number" min="1" inputmode="numeric" placeholder="Qty to add to each size" ' +
    'style="width:100%;padding:13px 14px;border:1.5px solid var(--border);border-radius:var(--r);font-size:16px;font-weight:800;font-family:var(--mono);background:var(--bg);outline:none;margin-bottom:12px;">' +
    '<div class="detail-restock-actions">' +
    '<button onclick="confirmBulkShoeRestock()" class="detail-restock-confirm">RESTOCK</button>' +
    '<button onclick="closeBulkShoeRestock()" class="detail-restock-cancel">Cancel</button>' +
    "</div>";

  sheet.classList.add("open");
  setTimeout(
    () => document.getElementById("bulk-shoe-restock-qty")?.focus(),
    80,
  );
}

function closeBulkShoeRestock() {
  const sheet = document.getElementById("bulk-shoe-restock-sheet");
  if (sheet) sheet.classList.remove("open");
}
window.closeBulkShoeRestock = closeBulkShoeRestock;

async function confirmBulkShoeRestock() {
  if (!_bulkShoeRestock) return;
  const qty = parseInt(
    document.getElementById("bulk-shoe-restock-qty")?.value || "0",
  );
  if (!Validate.restockQty(qty, "bulk-shoe-restock-qty")) return;

  const { itemId, sizes } = _bulkShoeRestock;
  const item = await dbGet("items", itemId);
  if (!item) {
    toast("Item not found", "err");
    return;
  }

  const records = await getShoeSizes(item.code);
  const changed = [];
  for (const size of sizes) {
    const rec = records.find((s) => Number(s.size) === Number(size));
    if (!rec) continue;
    rec.qty = (rec.qty || 0) + qty;
    rec.updatedAt = new Date().toISOString();
    await dbPut("shoe_sizes", rec);
    fbSyncShoeSize(rec);
    changed.push(rec);
  }

  const fresh = await getShoeSizes(item.code);
  item.qty = fresh.reduce((t, s) => t + (s.qty || 0), 0);
  item.updatedAt = new Date().toISOString();
  await dbPut("items", item);
  await recordStockInvestment(
    item,
    changed.reduce(
      (sum, rec) =>
        sum + qty * (rec.buyPrice || rec.buy || item.buyPrice || item.buy || 0),
      0,
    ),
    qty * changed.length,
    "Shoe restock",
  );
  fbSyncItem(item);

  for (const rec of changed) await fbSyncShoeSize(rec);

  scheduleSync();
  closeBulkShoeRestock();
  allItems = await dbAll("items");
  await enrichShoeItems(allItems);
  renderList();
  renderDashboard();
  updateHeader();
  toast("Added " + qty + " to " + changed.length + " sizes", "ok");
  await openSheet(itemId);
}
window.confirmBulkShoeRestock = confirmBulkShoeRestock;

function openSellFromSheet() {
  const id = currentDetailId;
  closeSheet();
  setTimeout(async () => {
    const item = await dbGet("items", id);
    if (!item) {
      toast("Item not found", "err");
      return;
    }
    if (item.isShoe) {
      if (!_selectedShoeSize) {
        toast("Warning: Select a size first from the detail sheet", "err");
        setTimeout(() => openSheet(id), 150);
        return;
      }
      openSellShoeModal(id, _selectedShoeSize);
    } else {
      if (item.qty <= 0 && !item.isRecord) {
        toast("Warning: Out of stock", "err");
        return;
      }
      openSellModal(id);
    }
  }, 120);
}

function triggerSheetPhotoUpload(event) {
  event.stopPropagation();
  const itemId = currentDetailId;
  showImagePickerSheet({
    title: "Item photo",
    photoPreset: "item",
    onPick: async (dataUrl) => {
      await setItemPhoto(itemId, dataUrl);
      const photoImg = document.getElementById("sh-photo-img");
      const fallback = document.getElementById("sh-photo-fallback");
      const panWrap = document.getElementById("sh-photo-pan");
      const saved = getItemPhoto(itemId);
      if (photoImg && saved) {
        photoImg.src = saved;
      }
      if (panWrap) panWrap.style.display = "block";
      if (fallback) fallback.style.display = "none";
      if (typeof window._resetPhotoPan === "function") {
        requestAnimationFrame(() => window._resetPhotoPan());
      }
      const btn = document.getElementById("sh-photo-btn");
      if (btn) btn.textContent = "Photo";
      renderList();
      toast("Photo saved", "ok");
    },
  });
}

async function openSheet(id) {
  currentDetailId = id;
  const item = await dbGet("items", id);
  if (!item) return;
  const t = getTypeObj(item.type);
  const sales = await dbAll("sales");
  const itemSales = sales.filter((s) => s.itemId === id);
  const soldQty = itemSales.reduce((a, s) => a + s.qty, 0);
  const revenue = itemSales.reduce((a, s) => a + s.revenue, 0);
  const profitMade = itemSales.reduce((a, s) => a + s.profit, 0);

  // Photo or emoji fallback
  const photo = getItemPhoto(id);
  const photoImg = document.getElementById("sh-photo-img");
  const photoFallback = document.getElementById("sh-photo-fallback");
  const photoPan =
    document.getElementById("sh-photo-pan") ||
    document.getElementById("sh-photo-area-inner");
  const panHint = document.getElementById("sh-photo-pan-hint");
  if (photo) {
    photoImg.src = photo;
    if (photoPan) {
      const panEl = document.getElementById("sh-photo-pan");
      if (panEl) panEl.style.display = "block";
    }
    if (panHint) panHint.style.display = "block";
    photoFallback.style.display = "none";
  } else {
    if (photoPan) photoPan.style.display = "none";
    if (panHint) panHint.style.display = "none";
    photoFallback.style.display = "flex";
    photoFallback.style.background = t.color || "var(--surface2)";
  }
  if (typeof window._resetPhotoPan === "function") {
    requestAnimationFrame(() => window._resetPhotoPan());
  }

  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  set("sh-photo-btn", photo ? "Change photo" : "Add photo");
  set("sh-icon", t.emoji);
  set("sh-name", item.name);
  set("sh-code", item.code + (item.size ? " - " + item.size : ""));
  set("sh-type", item.type);
  const tbadge = document.getElementById("sh-type-badge");
  if (tbadge) tbadge.textContent = t.emoji + " " + item.type;
  set("sh-size", item.size || "-");
  set("sh-buy", fmt(item.buyPrice || item.buy || 0));
  set("sh-sell", fmt(item.sellPrice || item.sell || 0));
  set("sh-profit", fmt(item.profit));
  set("sh-qty", item.qty + " pcs");
  set("sh-code-large", item.code + (item.size ? " - " + item.size : ""));

  // ── SHOE ITEMS - load fresh sizes, show size grid ─────────────
  const priceCols = document.getElementById("sh-price-cols");
  if (priceCols) priceCols.style.display = "grid";
  const sizeSec = document.getElementById("sh-shoe-sizes");
  const sizebar = document.getElementById("sh-selected-size-bar");
  _selectedShoeSize = null; // reset selection
  _selectedShoeSizes = new Set();

  if (item.isShoe) {
    const freshSizes = await getShoeSizes(item.code);
    const sizeQtys = await Promise.all(
      freshSizes.map((size) => readableStockQty(size, size.id)),
    );
    const totalQty = sizeQtys.reduce((total, qty) => total + qty, 0);
    item.qty = totalQty;
    // Show shoe buy/sell from defaults
    set("sh-buy", fmt(item.buyPrice || item.defaultBuy || 0));
    set("sh-sell", fmt(item.sellPrice || item.defaultSell || 0));
    set("sh-qty", totalQty + " pcs");
    if (sizeSec) sizeSec.style.display = "block";
    if (sizebar) {
      sizebar.style.display = "none";
      sizebar.textContent = "";
    }
    await renderShoeDetailGrid(item);
  } else {
    item.qty = await readableStockQty(item);
    set("sh-buy", fmt(item.buyPrice || item.buy || 0));
    set("sh-sell", fmt(item.sellPrice || item.sell || 0));
    set("sh-qty", item.qty + " pcs");
    if (sizeSec) sizeSec.style.display = "none";
    if (sizebar) sizebar.style.display = "none";
  }

  // Out of stock
  const outBadge = document.getElementById("sh-out-badge");
  const sellBtn = document.getElementById("sh-sell-btn");
  if (item.qty <= 0 && !item.isShoe && !item.isRecord) {
    if (outBadge) outBadge.style.display = "block";
    if (sellBtn) {
      sellBtn.disabled = true;
      sellBtn.style.opacity = "0.4";
      sellBtn.style.cursor = "not-allowed";
      sellBtn.textContent = "OUT OF STOCK";
    }
  } else {
    if (outBadge) outBadge.style.display = "none";
    if (sellBtn) {
      sellBtn.disabled = false;
      sellBtn.style.opacity = "1";
      sellBtn.style.cursor = "pointer";
      sellBtn.textContent = item.isShoe ? "SELECT SIZE & SELL" : "SELL";
    }
  }
  set("sh-total", fmt((item.buyPrice || item.buy || 0) * (item.qty || 0)));
  set("sh-sold", soldQty);
  set("sh-revenue", fmt(revenue));
  set("sh-profit-made", fmt(profitMade));

  document.getElementById("detail-sheet").classList.add("open");

  const restockPanel = document.getElementById("restock-panel");
  if (restockPanel) restockPanel.style.display = "none";
  updateDetailRestockBtnLabel();

  const shSellBtn = document.getElementById("sh-sell-btn");
  const delBtn = document.querySelector("#detail-sheet .btn-del");
  const editBtn = document.querySelector("#detail-sheet .btn-edit");
  const restockBtn = document.querySelector(
    "#detail-sheet .detail-action-restock",
  );
  const actionRow = document.getElementById("sh-action-row");
  [shSellBtn, delBtn, editBtn].forEach((b) => {
    if (b) {
      b.style.display = "";
      b.style.opacity = "1";
      b.style.pointerEvents = "auto";
    }
  });
  if (restockBtn) {
    const showRestock = !item.isShoe;
    restockBtn.style.display = showRestock ? "" : "none";
    restockBtn.style.opacity = showRestock ? "1" : "0";
    restockBtn.style.pointerEvents = showRestock ? "auto" : "none";
  }
  if (actionRow) {
    actionRow.style.display = "";
    actionRow.style.justifyContent = item.isShoe
      ? "flex-start"
      : "space-between";
  }
  if (item.isShoe && restockPanel) restockPanel.style.display = "none";
  const notice = document.getElementById("sh-day-notice");
  if (notice) notice.style.display = "none";
}

function closeSheet() {
  const sheet = document.getElementById("detail-sheet");
  if (sheet) sheet.classList.remove("open");
  const ov = document.getElementById("saving-overlay");
  if (ov) ov.style.display = "none";
}

async function deleteItem() {
  try {
    const toDelete = await dbGet("items", currentDetailId);
    if (!toDelete) {
      toast("Item not found", "err");
      return;
    }
    // Warn if item has sales history
    const allSales = await dbAll("sales");
    const itemSales = allSales.filter(
      (s) => s.itemId === currentDetailId || s.itemCode === toDelete.code,
    );
    let msg = 'Delete "' + (toDelete.name || toDelete.code) + '"?';
    if (itemSales.length > 0)
      msg +=
        "\n\nWarning: This item has " +
        itemSales.length +
        " sale record(s). The sales history will remain but the item cannot be restocked.";
    if (!confirm(msg)) return;
    if (toDelete.isShoe) {
      const sizes = await getShoeSizes(toDelete.code);
      for (const sz of sizes) {
        await cascadeDeleteRecord("shoe_sizes", sz.id, sz);
      }
    }
    await cascadeDeleteRecord("items", currentDetailId, toDelete);
    await removeItemPhoto(currentDetailId);
    closeSheet();
    allItems = await dbAll("items");
    renderList();
    renderDashboard();
    renderSummary();
    updateHeader();
    toast("Item deleted");
  } catch (e) {
    console.error("[deleteItem]", e);
    toast("Error: " + e.message, "err");
  }
}

async function editItem() {
  try {
    const item = await dbGet("items", currentDetailId);
    if (!item) {
      toast("Item not found.", "err");
      return;
    }
    closeSheet();

    if (item.isShoe) {
      const size = _selectedShoeSize;
      if (!size) {
        toast("Warning: Select a size first before editing", "err");
        setTimeout(() => openSheet(item.id), 100);
        return;
      }
      const sizes = await getShoeSizes(item.code);
      const sizeRec = sizes.find((s) => s.size === size);
      if (!sizeRec) {
        toast("Size record not found", "err");
        return;
      }
      _editingItemId = null; // shoe edits use shoe_edit_ prefix, not _editingItemId
      UI.el("edit-id").value = "shoe_edit_" + item.id + "_" + size;
      setAddFormType(item.type || "", { skipTypeChange: true });
      renderItemUnitOptions(item.unit || "");
      setItemMode(!!item.isRecord);
      UI.el("f-code").value = item.code || "";
      UI.el("f-name").value = item.name || "";
      UI.el("f-size").value = size;
      UI.el("f-qty").value = sizeRec.qty ?? "";
      UI.el("f-buy").value = sizeRec.buyPrice || item.defaultBuy || "";
      UI.el("f-sell").value = sizeRec.sellPrice || item.defaultSell || "";
      showPage("add");
      ["f-code", "f-name", "f-size"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.disabled = true;
          el.style.opacity = "0.45";
          el.style.cursor = "not-allowed";
        }
      });
      setAddTypeLocked(true);
      const shoePanel = UI.el("shoe-size-panel");
      const stdPricing = UI.el("std-pricing-section");
      const sizeField = document.getElementById("f-size-field");
      if (shoePanel) shoePanel.style.display = "none";
      if (stdPricing) stdPricing.style.display = "block";
      if (sizeField) sizeField.style.display = "block";
      setSaveBtnLabel("Save size " + size);
      const _ml1 = UI.el("form-mode-label");
      if (_ml1) {
        _ml1.hidden = false;
        _ml1.textContent = "Edit - " + item.code + " Size " + size;
      }
      UI.el("cancel-edit-btn").style.display = "block";
      _editOriginItemId = item.id;
      updateProfitPreview();
      return;
    }

    // ── STANDARD ITEM EDIT ────────────────────────────────────────
    _editingItemId = item.id; // store reliably in JS variable
    showPage("add");
    UI.el("edit-id").value = item.id;
    setAddFormType(item.type || "", { skipTypeChange: true });
    renderItemUnitOptions(item.unit || "");
    setItemMode(!!item.isRecord);
    UI.el("f-code").value = item.code || "";
    UI.el("f-name").value = item.name || "";
    UI.el("f-size").value = item.variant || item.size || ""; // normalized field name
    UI.el("f-qty").value = item.qty ?? "";
    UI.el("f-buy").value = item.buyPrice || item.buy || "";
    UI.el("f-sell").value = item.sellPrice || item.sell || "";
    const _editSellMin = UI.el("f-sell-min");
    if (_editSellMin) _editSellMin.value = item.sellPriceMin || "";
    // Keep the SKU fixed while allowing the item to be recategorized.
    ["f-code"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = true;
        el.style.opacity = "0.45";
        el.style.cursor = "not-allowed";
      }
    });
    setAddTypeLocked(false);
    setSaveBtnLabel("Save changes");
    const _ml2 = UI.el("form-mode-label");
    if (_ml2) {
      _ml2.hidden = false;
      _ml2.textContent = "Edit - " + (item.name || item.code);
    }
    UI.el("cancel-edit-btn").style.display = "block";
    _editOriginItemId = item.id;
    onTypeChange();
    updateProfitPreview();
    const existingPhoto = getItemPhoto(item.id);
    if (existingPhoto) applyAddFormPhotoPreview(existingPhoto);
  } catch (e) {
    console.error("[editItem]", e);
    toast("Error: " + e.message, "err");
  }
}

// ===== DASHBOARD =====
// ── Dashboard period state ──────────────────────────────────


async function toggleRestock() {
  const panel = document.getElementById("restock-panel");
  if (!panel) return;
  const item = currentDetailId ? await dbGet("items", currentDetailId) : null;
  if (item?.isShoe) {
    toast("Pick a size from the grid, then restock that size", "err");
    return;
  }
  panel.style.display = panel.style.display === "none" ? "block" : "none";
  if (panel.style.display !== "block") return;
  const buyEl = document.getElementById("restock-buy");
  const sellEl = document.getElementById("restock-sell");
  const qtyEl = document.getElementById("restock-qty");
  if (item && buyEl)
    buyEl.value = item.buyPrice ?? item.buy ?? item.defaultBuy ?? "";
  if (item && sellEl)
    sellEl.value = item.sellPrice ?? item.sell ?? item.defaultSell ?? "";
  if (qtyEl) qtyEl.value = "";
  updateDetailRestockBtnLabel();
  (qtyEl || buyEl)?.focus();
}

function updateDetailRestockBtnLabel() {
  const btn = document.getElementById("detail-restock-btn");
  if (!btn) return;
  const sizeEl = document.getElementById("sh-size");
  const sizeText = sizeEl ? (sizeEl.textContent || "").trim() : "";
  const hasSize = sizeText && sizeText !== "-";
  btn.textContent = hasSize ? "RESTOCK (" + sizeText + ")" : "RESTOCK";
}

async function confirmRestock() {
  const restockBtn = document.getElementById("detail-restock-btn");
  if (restockBtn) {
    restockBtn.disabled = true;
    restockBtn.style.opacity = "0.5";
  }
  try {
    const qty = parseInt(document.getElementById("restock-qty").value);
    if (!Validate.restockQty(qty, "restock-qty")) return;
    const buyRaw = Input.money("restock-buy");
    const sellRaw = Input.money("restock-sell");
    if (buyRaw !== null && buyRaw < 0)
      return Validate.fail("Invalid buy price", "restock-buy");
    if (sellRaw !== null && sellRaw < 0)
      return Validate.fail("Invalid sell price", "restock-sell");
    const item = await dbGet("items", currentDetailId);
    if (!item) {
      toast("Warning: Item not found", "err");
      return;
    }
    if (item.isShoe) {
      toast("Restock a shoe size from the size list", "err");
      return;
    }
    const unitBuy = buyRaw !== null ? buyRaw : item.buyPrice || item.buy || 0;
    if (sellRaw !== null) {
      item.sellPrice = sellRaw;
    }
    if (buyRaw !== null) {
      item.buyPrice = buyRaw;
    }
    item.qty += qty;
    item.updatedAt = new Date().toISOString();
    await persistStockMutationAtomically({
      item,
      delta: qty,
      reason: "receive",
      refId: `restock:${item.id}:${item.updatedAt}`,
      actor: currentUser ? currentUser.username : "system",
    });
    await recordStockInvestment(item, qty * unitBuy, qty, "Restock");
    fbSyncItem(item);
    scheduleSync();
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set("sh-buy", fmt(item.buyPrice || item.buy || 0));
    set("sh-sell", fmt(item.sellPrice || item.sell || 0));
    set("sh-qty", item.qty + " pcs");
    const panel = document.getElementById("restock-panel");
    if (panel) panel.style.display = "none";
    allItems = await dbAll("items");
    await enrichShoeItems(allItems);
    renderList();
    renderDashboard();
    updateHeader();
    updateLowStockBadge();
    toast("Added " + qty + " pcs to " + (item.name || item.code), "ok");
  } catch (e) {
    console.error("[confirmRestock]", e);
    toast("Warning: Restock failed: " + e.message, "err");
  } finally {
    if (restockBtn) {
      restockBtn.disabled = false;
      restockBtn.style.opacity = "";
    }
  }
}

// ═══════════════════════════════════════════════════════════
// LOW STOCK BADGE IN HEADER
// ═══════════════════════════════════════════════════════════

/* ===== shoe-management.js ===== */
function renderAllShoeGroupCards() {
  const wrap = document.getElementById("shoe-size-groups");
  if (!wrap) return;
  const groups = getShoeGroups();
  const entries = Object.entries(groups).sort((a, b) => a[1].min - b[1].min);
  const signature = JSON.stringify(entries);
  if (wrap.dataset.groupsSignature !== signature) {
    wrap.innerHTML = entries
      .map(
        ([group, config]) =>
          '<div class="sg-card" id="sg-card-' +
          escapeHtml(group) +
          '" data-group="' +
          escapeHtml(group) +
          '"><div class="sg-card-head"><span class="sg-ltr">' +
          escapeHtml(group) +
          '</span><span class="sg-range" id="sg-range-' +
          escapeHtml(group) +
          '">' +
          config.min +
          "–" +
          config.max +
          '</span><span class="sg-name" aria-hidden="true">' +
          escapeHtml(config.label) +
          '</span></div><div class="sg-card-sizes" id="sg-card-sizes-' +
          escapeHtml(group) +
          '"></div></div>',
      )
      .join("");
    wrap.dataset.groupsSignature = signature;
  }

  entries.forEach(([g, config]) => {
    const container = document.getElementById("sg-card-sizes-" + g);
    const card = document.getElementById("sg-card-" + g);
    if (!container) return;
    const { min, max } = config;
    container.innerHTML = "";
    for (let s = min; s <= max; s++) {
      const btn = document.createElement("button");
      btn.type = "button";
      const isLocked = _shoeState.lockedSizes.has(s);
      btn.className =
        "sz-btn" +
        (_shoeState.sizes.has(s) ? " sz-active" : "") +
        (isLocked ? " sz-locked" : "");
      btn.id = "sz-" + s;
      btn.textContent = String(s);
      if (isLocked) {
        btn.disabled = true;
        btn.title = "Already in stock";
      } else {
        btn.onclick = () => toggleShoeSize(s);
      }
      container.appendChild(btn);
    }
    const anySelected = _getGroupSizes(g).some((sz) =>
      _shoeState.sizes.has(sz),
    );
    if (card) card.classList.toggle("sg-card-active", anySelected);
    if (anySelected) _shoeState.shownGroups.add(g);
    else _shoeState.shownGroups.delete(g);
  });
}

function selectSizeGroup(g) {
  const sizes = _getGroupSizes(g);
  if (!sizes.length) return;
  const allOn = sizes.every((s) => _shoeState.sizes.has(s));
  sizes.forEach((s) => {
    if (allOn) _shoeState.sizes.delete(s);
    else _shoeState.sizes.add(s);
  });
  renderAllShoeGroupCards();
  showShoePricingPanel();
  if (_shoeState.perSizeMode) renderShoeRows();
  updateShoeCollectiveSummary();
}
window.selectSizeGroup = selectSizeGroup;

function setShoeMode(mode) {
  _shoeState.perSizeMode = mode === "persize";

  // Update tab buttons
  document
    .getElementById("mode-tab-shared")
    .classList.toggle("active", !_shoeState.perSizeMode);
  document
    .getElementById("mode-tab-persize")
    .classList.toggle("active", _shoeState.perSizeMode);

  // Show/hide panels
  const sharedWrap = document.getElementById("shoe-shared-wrap");
  const perSizeWrap = document.getElementById("shoe-per-size-wrap");
  if (sharedWrap)
    sharedWrap.style.display = _shoeState.perSizeMode ? "none" : "block";
  if (perSizeWrap)
    perSizeWrap.style.display = _shoeState.perSizeMode ? "block" : "none";

  // Rebuild per-size rows when switching to per-size
  if (_shoeState.perSizeMode) renderShoeRows();
  updateShoeCollectiveSummary();
}
window.setShoeMode = setShoeMode;

function initShoeCollectiveSummaryListeners() {
  if (_shoeCollectiveListenersOn) return;
  _shoeCollectiveListenersOn = true;
  ["shoe-shared-qty", "shoe-shared-buy", "shoe-shared-sell"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", updateShoeCollectiveSummary);
  });
  const rows = document.getElementById("shoe-rows");
  if (rows) {
    rows.addEventListener("input", (e) => {
      if (
        e.target &&
        e.target.classList &&
        e.target.classList.contains("shoe-cell")
      ) {
        updateShoeCollectiveSummary();
      }
    });
  }
}

function updateShoeCollectiveSummary() {
  renderShoeSummary();
  const qtyEl = document.getElementById("shoe-metric-qty");
  const bpEl = document.getElementById("shoe-metric-bp");
  const spEl = document.getElementById("shoe-metric-sp");
  if (!qtyEl || !bpEl || !spEl) return;

  const sorted = _shoeState.sortedSizes;
  const n = sorted.length;
  if (!n) {
    qtyEl.textContent = "0";
    bpEl.textContent = "-";
    spEl.textContent = "-";
    bpEl.classList.remove("accent");
    spEl.classList.remove("accent");
    return;
  }

  if (!_shoeState.perSizeMode) {
    const qPer = parseInt(UI.el("shoe-shared-qty")?.value || "0", 10) || 0;
    const bp = parseFloat(UI.el("shoe-shared-buy")?.value || "0") || 0;
    const sp = parseFloat(UI.el("shoe-shared-sell")?.value || "0") || 0;
    const totalQty = qPer * n;
    qtyEl.textContent = String(totalQty);
    bpEl.textContent = bp > 0 ? fmt(bp) : "-";
    spEl.textContent = sp > 0 ? fmt(sp) : "-";
    bpEl.classList.toggle("accent", bp > 0);
    spEl.classList.toggle("accent", sp > 0);
    return;
  }

  let totalQty = 0;
  let buySum = 0;
  let sellSum = 0;
  let priced = 0;
  sorted.forEach((s) => {
    const q = parseInt(UI.el("shr-qty-" + s)?.value || "0", 10) || 0;
    const b = parseFloat(UI.el("shr-buy-" + s)?.value || "0") || 0;
    const p = parseFloat(UI.el("shr-sell-" + s)?.value || "0") || 0;
    totalQty += q;
    if (b > 0 || p > 0) {
      buySum += b;
      sellSum += p;
      priced += 1;
    }
  });
  qtyEl.textContent = String(totalQty);
  if (priced) {
    bpEl.textContent = fmt(Math.round(buySum / priced));
    spEl.textContent = fmt(Math.round(sellSum / priced));
    bpEl.classList.add("accent");
    spEl.classList.add("accent");
  } else {
    bpEl.textContent = "-";
    spEl.textContent = "-";
    bpEl.classList.remove("accent");
    spEl.classList.remove("accent");
  }
}
window.updateShoeCollectiveSummary = updateShoeCollectiveSummary;

async function upsertShoeSize(record, opts) {
  const addQty = !!(opts && opts.addQty);
  const all = await dbAll("shoe_sizes");
  const existing = all.find(
    (s) => s.itemCode === record.itemCode && s.size === record.size,
  );
  if (existing) {
    const incomingQty = record.qty || 0;
    const updated = {
      ...existing,
      ...record,
      qty: addQty ? (existing.qty || 0) + incomingQty : incomingQty,
      id: existing.id,
    };
    await dbPut("shoe_sizes", updated);
    fbSyncShoeSize(updated);
    return updated;
  } else {
    record.codeSize = record.itemCode + "_" + record.size;
    try {
      const id = await dbAdd("shoe_sizes", record);
      record.id = id;
      fbSyncShoeSize(record);
      return record;
    } catch (e) {
      if (e.name === "ConstraintError") {
        // Unique codeSize violation - find and update existing
        const byCS = all.find((s) => s.codeSize === record.codeSize);
        if (byCS) {
          const updated = { ...byCS, ...record, id: byCS.id };
          await dbPut("shoe_sizes", updated);
          fbSyncShoeSize(updated);
          return updated;
        }
      }
      throw e;
    }
  }
}

async function saveShoeItems(baseCode, baseName, type) {
  if (_shoeState.sizes.size === 0) {
    toast("Warning: Select at least one size", "err");
    return false;
  }

  const ungroupedSize = _shoeState.sortedSizes.find(
    (size) => !_shoeState.groupFor(size),
  );
  if (ungroupedSize != null) {
    toast("Size " + ungroupedSize + " is outside the configured groups", "err");
    return false;
  }

  if (!_shoeState.group) {
    const firstSize = [..._shoeState.sizes][0];
    _shoeState.group = _shoeState.groupFor(firstSize);
    if (!_shoeState.group) {
      toast("Selected size is outside the configured groups", "err");
      return false;
    }
  }

  let sharedQty = 0,
    sharedBuy = 0,
    sharedSell = 0;
  if (!_shoeState.perSizeMode) {
    sharedQty = parseInt(UI.el("shoe-shared-qty")?.value || "0") || 0;
    sharedBuy = parseFloat(UI.el("shoe-shared-buy")?.value || "0") || 0;
    sharedSell = parseFloat(UI.el("shoe-shared-sell")?.value || "0") || 0;
    if (sharedQty < 0) {
      toast("Warning: Quantity cannot be negative", "err");
      return false;
    }
    if (sharedBuy < 0) {
      toast("Warning: Buy price cannot be negative", "err");
      return false;
    }
    if (sharedSell < 0) {
      toast("Warning: Sell price cannot be negative", "err");
      return false;
    }
    if (sharedBuy > 0 && sharedSell > 0 && sharedSell < sharedBuy) {
      toast("Warning: Sell price cannot be less than buy price", "err");
      return false;
    }
  }

  const sorted = _shoeState.sortedSizes;
  const allItms = await dbAll("items");
  let product = allItms.find((i) => i.code === baseCode);

  if (!product) {
    const pid = await dbAdd("items", {
      code: baseCode,
      name: baseName || type + " " + baseCode,
      type,
      category: type,
      isShoe: true,
      buyPrice: _shoeState.perSizeMode ? 0 : sharedBuy,
      sellPrice: _shoeState.perSizeMode ? 0 : sharedSell,
      profit: _shoeState.perSizeMode ? 0 : sharedSell - sharedBuy,
      qty: 0,
      createdAt: new Date().toISOString(),
    });
    product = await dbGet("items", pid);
  } else if (!_shoeState.perSizeMode) {
    product.buyPrice = sharedBuy;
    product.sellPrice = sharedSell;
    product.profit = sharedSell - sharedBuy;
    await dbPut("items", product);
  }

  let saved = 0;
  let stockCost = 0;
  let stockQty = 0;
  const perSizeErrors = [];
  for (const size of sorted) {
    let qty, buy, sell;
    if (_shoeState.perSizeMode) {
      qty = parseInt(UI.el("shr-qty-" + size)?.value || "0") || 0;
      buy = parseFloat(UI.el("shr-buy-" + size)?.value || "0") || 0;
      sell = parseFloat(UI.el("shr-sell-" + size)?.value || "0") || 0;
      if (qty < 0) {
        perSizeErrors.push("Size " + size + ": quantity cannot be negative");
        continue;
      }
      if (buy < 0) {
        perSizeErrors.push("Size " + size + ": buy price cannot be negative");
        continue;
      }
      if (sell < 0) {
        perSizeErrors.push("Size " + size + ": sell price cannot be negative");
        continue;
      }
      if (buy > 0 && sell > 0 && sell < buy) {
        perSizeErrors.push(
          "Size " + size + ": sell price cannot be less than buy price",
        );
        continue;
      }
    } else {
      qty = sharedQty;
      buy = sharedBuy;
      sell = sharedSell;
    }

    await upsertShoeSize(
      {
        itemCode: baseCode,
        itemId: product.id,
        size,
        sizeGroup: _shoeState.groupFor(size),
        qty,
        buyPrice: buy,
        sellPrice: sell,
        profit: sell - buy,
        codeSize: baseCode + "_" + size,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { addQty: true },
    );
    saved++;
    stockCost += qty * buy;
    stockQty += qty;
  }

  if (perSizeErrors.length)
    toast("Warning: Skipped: " + perSizeErrors.join(" - "), "err");
  if (saved === 0) {
    toast("Warning: No sizes saved - check quantity and price values", "err");
    return false;
  }

  const allSz = await getShoeSizes(baseCode);
  product.qty = allSz.reduce((t, s) => t + s.qty, 0);
  await dbPut("items", product);
  await recordStockInvestment(product, stockCost, stockQty, "Shoe stock");
  await markWishlistStockedForItem(product);
  fbSyncItem(product);

  if (_addFormPhotoData && product?.id) {
    await setItemPhoto(product.id, _addFormPhotoData);
  }

  for (const sz of allSz) await fbSyncShoeSize(sz);
  return saved;
}
window.saveShoeItems = saveShoeItems;

function deselectSizeGroup(g) {
  _getGroupSizes(g).forEach((s) => _shoeState.sizes.delete(s));
  if (_shoeState.group === g) _shoeState.group = null;
  _shoeState.shownGroups.delete(g);
  renderAllShoeGroupCards();
  showShoePricingPanel();
  renderShoeSummary();
  renderShoeRows();
  updateShoeCollectiveSummary();
}
window.deselectSizeGroup = deselectSizeGroup;

function toggleShoeSize(s) {
  if (_shoeState.lockedSizes.has(s)) return; // already in stock - restock-mode disables these
  if (_shoeState.sizes.has(s)) _shoeState.sizes.delete(s);
  else _shoeState.sizes.add(s);

  renderAllShoeGroupCards();
  showShoePricingPanel();

  // If switching to persize and rows already rendered, rebuild them
  if (_shoeState.perSizeMode) renderShoeRows();
  renderShoeSummary();
  updateShoeCollectiveSummary();
}
window.toggleShoeSize = toggleShoeSize;

// ── Shoe size action handlers ─────────────────────────────────────
async function openShoeSizeRestock(itemId, size) {
  const item = await dbGet("items", itemId);
  if (!item) {
    toast("Item not found", "err");
    return;
  }
  const sizes = await getShoeSizes(item.code);
  const sizeRec = sizes.find((s) => s.size === size);
  if (!sizeRec) {
    toast("Size record not found", "err");
    return;
  }
  closeShoeSizeActions();
  closeSheet();
  showPage("add");
  setTimeout(() => {
    setAddFormType(item.type || "", { skipTypeChange: true });
    UI.el("f-code").value = item.code || "";
    UI.el("f-name").value = item.name || "";
    UI.el("edit-id").value = "shoe_restock_" + itemId + "_" + size;
    UI.el("f-size").value = size;
    UI.el("f-qty").value = "";
    UI.el("f-buy").value = sizeRec.buyPrice || "";
    UI.el("f-sell").value = sizeRec.sellPrice || "";
    setAddTypeLocked(true);
    showRestockView({
      code: item.code,
      name: item.name,
      type: item.type,
      size,
      stock: sizeRec.qty || 0,
      stockUnit: " pcs",
      buy: sizeRec.buyPrice || item.buyPrice || 0,
      sell: sizeRec.sellPrice || item.sellPrice || 0,
    });
    updateProfitPreview();
  }, 100);
}
window.openShoeSizeRestock = openShoeSizeRestock;

async function openShoeSizeEdit(itemId, size) {
  const item = await dbGet("items", itemId);
  if (!item) {
    toast("Item not found", "err");
    return;
  }
  const sizes = await getShoeSizes(item.code);
  const sizeRec = sizes.find((s) => s.size === size);
  if (!sizeRec) {
    toast("Size record not found", "err");
    return;
  }
  showPage("add");
  setTimeout(() => {
    setAddFormType(item.type || "", { skipTypeChange: true });
    UI.el("f-code").value = item.code || "";
    UI.el("f-name").value = item.name || "";
    UI.el("f-size").value = size;
    UI.el("f-qty").value = sizeRec.qty ?? "";
    UI.el("f-buy").value = sizeRec.buyPrice || "";
    UI.el("f-sell").value = sizeRec.sellPrice || "";
    UI.el("edit-id").value = "shoe_edit_" + itemId + "_" + size;
    onTypeChange();
    ["f-code", "f-name", "f-size"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = true;
        el.style.opacity = "0.45";
        el.style.cursor = "not-allowed";
      }
    });
    setAddTypeLocked(true);
    setSaveBtnLabel("Save size " + size);
    const _ml3 = UI.el("form-mode-label");
    if (_ml3) {
      _ml3.hidden = false;
      _ml3.textContent = "Edit size " + size + " - " + item.code;
    }
    UI.el("cancel-edit-btn").style.display = "block";
    updateProfitPreview();
  }, 100);
}
window.openShoeSizeEdit = openShoeSizeEdit;

async function closeShoeSizeActions() {
  const sheet = document.getElementById("shoe-size-action-sheet");
  if (sheet) sheet.classList.remove("open");
}
window.closeShoeSizeActions = closeShoeSizeActions;

// ── Restored missing shoe functions ─────────────────────────────

function getShoeGroups() {
  const defaults = JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  try {
    const saved = localStorage.getItem(KEY_SHOE_GROUPS);
    if (!saved) return defaults;
    const parsed = JSON.parse(saved);
    const isVersioned =
      parsed?.version === 2 &&
      parsed.groups &&
      typeof parsed.groups === "object" &&
      !Array.isArray(parsed.groups);
    const source = isVersioned ? parsed.groups : parsed;
    const out = isVersioned ? {} : Object.assign({}, defaults);
    for (const [g, cfg] of Object.entries(source || {})) {
      if (!/^[A-Za-z0-9_-]{1,12}$/.test(g)) continue;
      const min = parseInt(cfg?.min, 10);
      const max = parseInt(cfg?.max, 10);
      if (
        Number.isFinite(min) &&
        Number.isFinite(max) &&
        min >= 1 &&
        max <= 60 &&
        min <= max
      ) {
        out[g] = {
          min,
          max,
          label: String(cfg.label || defaults[g]?.label || g),
        };
      }
    }
    return out;
  } catch (e) {
    return defaults;
  }
}
function _getGroupSizes(g) {
  const groups = getShoeGroups();
  if (!groups[g]) return [];
  const { min, max } = groups[g];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}
function renderShoeGroupButtons() {
  renderAllShoeGroupCards();
}
function renderShoeRows() {
  const rows = document.getElementById("shoe-rows");
  if (!rows) return;
  if (!_shoeState.perSizeMode) {
    rows.innerHTML = "";
    return;
  }
  const sorted = _shoeState.sortedSizes;
  rows.innerHTML = sorted
    .map(
      (s) =>
        '<div class="shoe-row">' +
        '<span class="shoe-sz-lbl">' +
        s +
        "</span>" +
        '<input type="number" class="shoe-cell" id="shr-qty-' +
        s +
        '" min="0" inputmode="numeric" placeholder="Qty">' +
        '<input type="number" class="shoe-cell" id="shr-buy-' +
        s +
        '" min="0" inputmode="decimal" placeholder="BP">' +
        '<input type="number" class="shoe-cell" id="shr-sell-' +
        s +
        '" min="0" inputmode="decimal" placeholder="SP">' +
        "</div>",
    )
    .join("");
  updateShoeCollectiveSummary();
}


function renderShoeSummary() {
  const el = UI.el("shoe-selected-summary");
  if (!el) return;
  const sorted = _shoeState.sortedSizes;
  if (!sorted.length) {
    el.innerHTML = '<span class="shoe-selected-chips-empty">-</span>';
  } else {
    el.innerHTML = sorted
      .map((s) => {
        const g = (_shoeState.groupFor(s) || "other").toLowerCase();
        return (
          '<span class="shoe-selected-chip shoe-chip-' +
          g +
          '">' +
          s +
          "</span>"
        );
      })
      .join("");
  }
  const saveBtn = UI.el("save-btn");
  const panel = UI.el("shoe-size-panel");
  if (saveBtn && panel && panel.style.display !== "none" && sorted.length) {
    setSaveBtnLabel(
      "Save " + sorted.length + " size" + (sorted.length > 1 ? "s" : ""),
    );
  }
}

// ═══════════════════════════════════════════════════════════
// PHOTO IMPORT MODULE — Import inventory from a handwritten stock photo
// ═══════════════════════════════════════════════════════════

var _piExtractedRows = [];
var _piImageDataUrl = "";

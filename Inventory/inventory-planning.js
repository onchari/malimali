/* ===== wishlist.js ===== */
function getSavedWishlistLists() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(KEY_WISHLIST_SAVED_LISTS) || "[]",
    );
    return Array.isArray(saved)
      ? saved
          .filter(
            (list) =>
              list &&
              typeof list === "object" &&
              typeof list.name === "string" &&
              list.name.trim() &&
              Array.isArray(list.itemIds),
          )
          .map((list) => ({
            ...list,
            category: String(list.category || "").trim(),
            supply: String(list.supply || "").trim(),
            budget: Number(list.budget || 0) || 0,
            status: ["planned", "ordering", "partial", "complete"].includes(
              list.status,
            )
              ? list.status
              : "planned",
            dueDate: String(list.dueDate || "").trim(),
            itemIds: [
              ...new Set(
                list.itemIds
                  .map((id) => Number(id))
                  .filter((id) => Number.isInteger(id)),
              ),
            ],
          }))
      : [];
  } catch (_) {
    return [];
  }
}

function persistSavedWishlistLists(lists) {
  localStorage.setItem(KEY_WISHLIST_SAVED_LISTS, JSON.stringify(lists));
}

function getWishlistListMembership(itemId, lists) {
  return (
    lists.find((list) =>
      (list.itemIds || []).some((id) => String(id) === String(itemId)),
    ) || null
  );
}

function removeWishlistItemsFromLists(lists, itemIds) {
  const ids = new Set(itemIds.map((id) => String(id)));
  lists.forEach((list) => {
    list.itemIds = (list.itemIds || []).filter((id) => !ids.has(String(id)));
  });
}

async function runAtomicWishlistOperation(itemIds, updateRecord, updateLists) {
  const ids = [
    ...new Set(
      itemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    ),
  ];
  const previousRecords = (
    await Promise.all(ids.map((id) => dbGet("wishlist", id)))
  ).filter(Boolean);
  const previousLists = localStorage.getItem(KEY_WISHLIST_SAVED_LISTS);
  try {
    for (const record of previousRecords) {
      updateRecord(record);
      await dbPut("wishlist", record);
    }
    updateLists();
  } catch (error) {
    for (const record of previousRecords) {
      try {
        await dbPut("wishlist", record);
      } catch (_) {}
    }
    if (previousLists === null)
      localStorage.removeItem(KEY_WISHLIST_SAVED_LISTS);
    else localStorage.setItem(KEY_WISHLIST_SAVED_LISTS, previousLists);
    throw error;
  }
}

function moveWishlistItemsToSavedList(itemIds, targetListId) {
  const lists = getSavedWishlistLists();
  const target = lists.find((list) => list.id === targetListId);
  if (!target) return { ok: false, reason: "Saved list not found" };
  const targetIds = new Set((target.itemIds || []).map((id) => String(id)));
  const ids = [
    ...new Set(
      itemIds.map((id) => Number(id)).filter((id) => Number.isInteger(id)),
    ),
  ];
  const duplicates = ids.filter((id) => targetIds.has(String(id)));
  if (duplicates.length)
    return {
      ok: false,
      reason: "One or more items already exist in the destination list",
    };
  removeWishlistItemsFromLists(lists, ids);
  target.itemIds = [...new Set([...(target.itemIds || []), ...ids])];
  persistSavedWishlistLists(lists);
  return { ok: true, target };
}

function moveWishlistItemsToGeneralList(itemIds) {
  const lists = getSavedWishlistLists();
  removeWishlistItemsFromLists(lists, itemIds);
  persistSavedWishlistLists(lists);
}

function assignWishlistItemToSavedList(itemId, listId) {
  return moveWishlistItemsToSavedList([itemId], listId).ok;
}

function getSavedWishlistListForAdd() {
  if (_activeWishlistView !== "saved") return null;
  const lists = getSavedWishlistLists();
  return lists.find((list) => list.name === _activeWishlistSavedList) || null;
}

function createSavedWishlistList() {
  const rawName = window.prompt("Name this saved list", "");
  if (rawName === null) return;
  const name = String(rawName).trim();
  if (!name) return toast("Enter a name for the list", "err");
  const lists = getSavedWishlistLists();
  if (lists.some((list) => list.name.toLowerCase() === name.toLowerCase())) {
    return toast('"' + name + '" already exists', "info");
  }
  lists.push({
    id:
      "wish-list-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    name,
    category: "",
    supply: "",
    budget: 0,
    status: "planned",
    dueDate: "",
    itemIds: [],
  });
  persistSavedWishlistLists(lists);
  renderWishlistPage();
  toast('Stock list "' + name + '" created', "ok");
}
window.createSavedWishlistList = createSavedWishlistList;

function editSavedWishlistList(listId) {
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  const rawName = window.prompt("Rename saved list", list.name);
  if (rawName === null) return;
  const name = String(rawName).trim();
  if (!name) return toast("Enter a name for the list", "err");
  if (
    lists.some(
      (entry) =>
        entry.id !== listId && entry.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    return toast('"' + name + '" already exists', "info");
  }
  const previousName = list.name;
  list.name = name;
  if (_activeWishlistSavedList === previousName)
    _activeWishlistSavedList = name;
  persistSavedWishlistLists(lists);
  renderWishlistPage();
  toast("Saved list renamed", "ok");
}
window.editSavedWishlistList = editSavedWishlistList;
window.renameSavedWishlistList = editSavedWishlistList;

function duplicateSavedWishlistList(listId) {
  const lists = getSavedWishlistLists();
  const source = lists.find((list) => list.id === listId);
  if (!source) return toast("Saved list not found", "err");
  const copyName = source.name + " copy";
  if (
    lists.some((list) => list.name.toLowerCase() === copyName.toLowerCase())
  ) {
    return toast('"' + copyName + '" already exists', "info");
  }
  lists.push({
    ...source,
    id:
      "wish-list-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    name: copyName,
    status: "planned",
    itemIds: [...source.itemIds],
  });
  persistSavedWishlistLists(lists);
  renderWishlistPage();
  toast('Stock list "' + copyName + '" duplicated', "ok");
}
window.duplicateSavedWishlistList = duplicateSavedWishlistList;

async function deleteSavedWishlistList(listId) {
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  const wishes = db.objectStoreNames.contains("wishlist")
    ? await dbAll("wishlist")
    : [];
  const liveIds = (list.itemIds || []).filter((id) => {
    const wish = wishes.find((entry) => String(entry.id) === String(id));
    return (
      wish && wishStatus(wish) !== "stocked" && wishStatus(wish) !== "discarded"
    );
  });
  const stockedIds = (list.itemIds || []).filter((id) => {
    const wish = wishes.find((entry) => String(entry.id) === String(id));
    return wish && wishStatus(wish) === "stocked";
  });
  const transferMessage = [
    "Items in this list will be moved across:",
    liveIds.length +
      " live item" +
      (liveIds.length === 1 ? "" : "s") +
      " to Main list",
    stockedIds.length +
      " item" +
      (stockedIds.length === 1 ? "" : "s") +
      " marked as stocked to Stocked list",
  ].join("\n");
  if (!confirm(transferMessage + '\n\nDelete wishlist "' + list.name + '"?'))
    return;
  removeWishlistItemsFromLists(lists, [...liveIds, ...stockedIds]);
  persistSavedWishlistLists(lists.filter((entry) => entry.id !== listId));
  if (_activeWishlistSavedList === list.name) {
    _activeWishlistSavedList = "";
    _activeWishlistView = "saved";
  }
  _selectedWishlistIds.clear();
  renderWishlistPage();
  const movedSummary = [
    liveIds.length
      ? liveIds.length +
        " live item" +
        (liveIds.length === 1 ? "" : "s") +
        " moved to General List"
      : "",
    stockedIds.length
      ? stockedIds.length +
        " stocked item" +
        (stockedIds.length === 1 ? "" : "s") +
        " kept in Stocked"
      : "",
  ]
    .filter(Boolean)
    .join("; ");
  toast(
    movedSummary ? "Saved list deleted. " + movedSummary : "Saved list deleted",
    "ok",
  );
}
window.deleteSavedWishlistList = deleteSavedWishlistList;

function setWishlistView(view, savedListName) {
  const nextView = ["main", "stocked", "saved"].includes(view) ? view : "main";
  _activeWishlistView = nextView;
  if (nextView === "saved" && savedListName)
    _activeWishlistSavedList = String(savedListName);
  _selectedWishlistIds.clear();
  renderWishlistPage();
}
window.setWishlistView = setWishlistView;

function chooseWishlistSavedList() {
  setWishlistView("saved", _activeWishlistSavedList);
}
window.chooseWishlistSavedList = chooseWishlistSavedList;

function openSavedWishlistList(listId) {
  const list = getSavedWishlistLists().find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  if (_activeWishlistSavedList === list.name) {
    _activeWishlistSavedList = "";
    _selectedWishlistIds.clear();
    renderWishlistPage();
    return;
  }
  setWishlistView("saved", list.name);
}
window.openSavedWishlistList = openSavedWishlistList;

async function toggleSavedWishlistListSelection(listId, checked) {
  const list = getSavedWishlistLists().find((entry) => entry.id === listId);
  if (!list) return;
  _selectedSavedWishlistListId = checked ? listId : "";
  const wishes = db.objectStoreNames.contains("wishlist")
    ? await dbAll("wishlist")
    : [];
  const liveIds = wishes
    .filter(
      (wish) =>
        (list.itemIds || []).some((id) => String(id) === String(wish.id)) &&
        wishStatus(wish) !== "stocked" &&
        wishStatus(wish) !== "discarded",
    )
    .map((wish) => wish.id);
  liveIds.forEach((id) => {
    if (checked) _selectedWishlistIds.add(id);
    else _selectedWishlistIds.delete(id);
  });
  renderWishlistPage();
}
window.toggleSavedWishlistListSelection = toggleSavedWishlistListSelection;

function toggleSavedWishlistMoveButton(select) {
  const button = select
    ?.closest(".wish-saved-list-transfer")
    ?.querySelector("button");
  if (button) button.disabled = !select.value;
}
window.toggleSavedWishlistMoveButton = toggleSavedWishlistMoveButton;

function moveAllItemsFromSavedWishlistList(sourceListId, targetListId) {
  const lists = getSavedWishlistLists();
  const source = lists.find((list) => list.id === sourceListId);
  const target = lists.find(
    (list) => list.id === targetListId && list.id !== sourceListId,
  );
  if (!source) return toast("Source list not found", "err");
  if (!target) return toast("Choose another active list", "info");
  const sourceIds = [
    ...new Set(
      (source.itemIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id)),
    ),
  ];
  if (!sourceIds.length)
    return toast("There are no items in this list", "info");
  const existingTargetIds = [...(target.itemIds || [])];
  removeWishlistItemsFromLists(lists, sourceIds);
  target.itemIds = [...new Set([...existingTargetIds, ...sourceIds])];
  persistSavedWishlistLists(lists.filter((list) => list.id !== sourceListId));
  _selectedSavedWishlistListId = "";
  _selectedWishlistIds.clear();
  _activeWishlistSavedList = target.name;
  renderWishlistPage();
  toast(
    sourceIds.length +
      " item" +
      (sourceIds.length === 1 ? "" : "s") +
      ' moved to "' +
      target.name +
      '". Empty source list deleted.',
    "ok",
  );
}
window.moveAllItemsFromSavedWishlistList = moveAllItemsFromSavedWishlistList;

async function addActiveWishlistItemsToSavedList(listId) {
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  const wishes = await dbAll("wishlist");
  const activeIds = wishes
    .filter(
      (wish) =>
        !isWishlistSaleMonitorEntry(wish) &&
        wishStatus(wish) !== "stocked" &&
        wishStatus(wish) !== "cancelled" &&
        wishStatus(wish) !== "discarded",
    )
    .map((wish) => wish.id);
  const existing = new Set(list.itemIds || []);
  const added = activeIds.filter((id) => !existing.has(id));
  for (const other of lists) {
    other.itemIds = (other.itemIds || []).filter(
      (id) => !activeIds.includes(id),
    );
  }
  list.itemIds = [...new Set([...(list.itemIds || []), ...activeIds])];
  persistSavedWishlistLists(lists);
  renderWishlistPage();
  toast(
    added.length +
      " active item" +
      (added.length === 1 ? "" : "s") +
      ' added to "' +
      list.name +
      '"',
    "ok",
  );
}
window.addActiveWishlistItemsToSavedList = addActiveWishlistItemsToSavedList;
function getWishlistListMetrics(list, wishesById, includeStocked = false) {
  const items = (list.itemIds || [])
    .map((id) => wishesById.get(id))
    .filter(
      (wish) =>
        wish &&
        (includeStocked || wishStatus(wish) !== "stocked") &&
        wishStatus(wish) !== "discarded",
    );
  const quantity = items.reduce((sum, wish) => sum + Number(wish.qty || 0), 0);
  const estimated = items.reduce(
    (sum, wish) =>
      sum + Number(wish.qty || 0) * Number(wish.estimatedCost || 0),
    0,
  );
  return {
    items,
    quantity,
    estimated,
    remaining: Math.max(0, Number(list.budget || 0) - estimated),
    stocked: items.filter((wish) => wishStatus(wish) === "stocked").length,
  };
}

function removeWishlistItemFromSavedList(listId, itemId) {
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return;
  list.itemIds = (list.itemIds || []).filter(
    (id) => String(id) !== String(itemId),
  );
  persistSavedWishlistLists(lists);
  renderWishlistPage();
  toast("Item removed from list", "ok");
}
window.removeWishlistItemFromSavedList = removeWishlistItemFromSavedList;

function clearStockedItemsFromSavedList(listId) {
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  dbAll("wishlist").then((wishes) => {
    const stocked = wishes.filter(
      (wish) =>
        list.itemIds.some((id) => String(id) === String(wish.id)) &&
        wishStatus(wish) === "stocked",
    );
    if (!stocked.length) return toast("No stocked items to clear", "info");
    const ids = new Set(stocked.map((wish) => String(wish.id)));
    list.itemIds = list.itemIds.filter((id) => !ids.has(String(id)));
    persistSavedWishlistLists(lists);
    stocked.forEach((wish) => _selectedWishlistIds.delete(Number(wish.id)));
    renderWishlistPage();
    toast(
      stocked.length +
        " stocked item" +
        (stocked.length === 1 ? "" : "s") +
        " cleared from " +
        list.name,
      "ok",
    );
  });
}
window.clearStockedItemsFromSavedList = clearStockedItemsFromSavedList;

function moveWishlistItemToList(itemId, targetListId, sourceListId) {
  if (!targetListId) return;
  const result = moveWishlistItemsToSavedList([itemId], targetListId);
  if (!result.ok) return toast(result.reason, "info");
  renderWishlistPage();
  toast('Item moved to "' + result.target.name + '"', "ok");
}
window.moveWishlistItemToList = moveWishlistItemToList;

function beginWishlistItemDrag(event, itemId) {
  if (event.dataTransfer)
    event.dataTransfer.setData("text/plain", String(itemId));
}

function dropWishlistItem(event, listId, beforeItemId) {
  event.preventDefault();
  const itemId = event.dataTransfer?.getData("text/plain");
  if (!itemId || itemId === String(beforeItemId)) return;
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.id === listId);
  if (!list) return;
  const current = (list.itemIds || []).find((id) => String(id) === itemId);
  if (current === undefined) return;
  list.itemIds = list.itemIds.filter((id) => String(id) !== itemId);
  const index = list.itemIds.findIndex(
    (id) => String(id) === String(beforeItemId),
  );
  list.itemIds.splice(index < 0 ? list.itemIds.length : index, 0, current);
  persistSavedWishlistLists(lists);
  renderWishlistPage();
}
window.beginWishlistItemDrag = beginWishlistItemDrag;
window.dropWishlistItem = dropWishlistItem;

function chooseWishlistShareOptions() {
  const modal = document.getElementById("wish-share-modal");
  if (!modal) return Promise.resolve(null);
  const close = document.getElementById("wish-share-close");
  const cancel = document.getElementById("wish-share-cancel");
  const submit = document.getElementById("wish-share-submit");
  const prices = document.getElementById("wish-share-include-prices");
  const finish = (result) => {
    modal.hidden = true;
    modal.onkeydown = null;
    return result;
  };
  modal.hidden = false;
  document
    .querySelector('input[name="wish-share-scope"][value="all"]')
    ?.focus();
  return new Promise((resolve) => {
    close.onclick = () => resolve(finish(null));
    cancel.onclick = () => resolve(finish(null));
    modal.onclick = (event) => {
      if (event.target === modal) resolve(finish(null));
    };
    submit.onclick = () => {
      const scope =
        document.querySelector('input[name="wish-share-scope"]:checked')
          ?.value || "all";
      resolve(finish({ scope, includePrices: !!prices?.checked }));
    };
    modal.onkeydown = (event) => {
      if (event.key === "Escape") resolve(finish(null));
    };
  });
}
window.chooseWishlistShareOptions = chooseWishlistShareOptions;

async function shareSavedWishlistListViaWhatsApp(listId) {
  const list = getSavedWishlistLists().find((entry) => entry.id === listId);
  if (!list) return toast("Saved list not found", "err");
  const wishesById = new Map(
    (await dbAll("wishlist")).map((wish) => [wish.id, wish]),
  );
  const shareOptions = await chooseWishlistShareOptions();
  if (!shareOptions) return;
  const allItems = (list.itemIds || [])
    .map((id) => wishesById.get(id))
    .filter(Boolean);
  const items = allItems.filter(
    (wish) =>
      shareOptions.scope === "all" ||
      (shareOptions.scope === "stocked" && wishStatus(wish) === "stocked") ||
      (shareOptions.scope === "not-stocked" && wishStatus(wish) !== "stocked"),
  );
  if (!items.length) return toast("There are no items to share", "info");
  const includePrices = shareOptions.includePrices;
  const totalEstimated = items.reduce(
    (sum, wish) =>
      sum + Number(wish.qty || 0) * Number(wish.estimatedCost || 0),
    0,
  );
  const stockedItems = items.filter((wish) => wishStatus(wish) === "stocked");
  const notStockedItems = items.filter(
    (wish) => wishStatus(wish) !== "stocked",
  );
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  const sharedAt = dateParts.dayPeriod
    ? dateParts.weekday +
      " " +
      dateParts.day +
      ", " +
      dateParts.month +
      " " +
      dateParts.year +
      " – " +
      dateParts.hour +
      ":" +
      dateParts.minute +
      dateParts.dayPeriod.toLowerCase()
    : "";
  const itemLine = (wish, index) => {
    const qty = Number(wish.qty || 0);
    const unit = String(wish.unit || "").trim();
    const amount =
      qty > 0 && Number(wish.estimatedCost || 0) > 0
        ? fmt(qty * Number(wish.estimatedCost || 0))
        : "";
    const details = [String(wish.name || "Unnamed item")];
    if (qty > 0) details.push(qty + (unit ? " " + unit : ""));
    if (includePrices && amount) details.push(amount);
    return index + 1 + ". *" + details.join(" — ") + "*";
  };
  const lines = [
    "*🏠 " + String(list.name || "Wishlist").toLocaleUpperCase() + "*",
    "",
  ];
  if (sharedAt) lines.push("*" + sharedAt + "*", "");
  if (stockedItems.length) {
    lines.push("*Items Already Stocked:*", "");
    stockedItems.forEach((wish, index) => lines.push(itemLine(wish, index)));
    lines.push("");
  }
  if (notStockedItems.length) {
    lines.push("*Items Not Yet Stocked:*", "");
    notStockedItems.forEach((wish, index) => lines.push(itemLine(wish, index)));
    lines.push("");
  }
  lines.push("📦 *Total Items:* " + items.length);
  if (includePrices) lines.push("💰 *Estimated Total:* " + fmt(totalEstimated));
  lines.push(
    "✅ *Stocked:* " + stockedItems.length,
    "⏳ *Not Yet Stocked:* " + notStockedItems.length,
  );
  const shareUrl =
    "https://wa.me/?text=" + encodeURIComponent(lines.join("\n"));
  const shareWindow = window.open(shareUrl, "_blank", "noopener,noreferrer");
  if (!shareWindow) toast("Allow popups to share this list", "info");
}
window.shareSavedWishlistListViaWhatsApp = shareSavedWishlistListViaWhatsApp;

function exportSavedWishlistList(listId) {
  const list = getSavedWishlistLists().find((entry) => entry.id === listId);
  if (!list) return;
  dbAll("wishlist").then((wishes) => {
    const byId = new Map(wishes.map((wish) => [wish.id, wish]));
    const rows = [
      [
        "List",
        "Item",
        "Category",
        "Supply",
        "Quantity",
        "Estimated price",
        "Estimated amount",
      ],
    ];
    (list.itemIds || []).forEach((id) => {
      const wish = byId.get(id);
      if (!wish) return;
      const qty = Number(wish.qty || 0);
      const price = Number(wish.estimatedCost || 0);
      rows.push([
        list.name,
        wish.name || "",
        wish.type || "",
        wish.supplierId || wish.supplier || "",
        qty,
        price,
        qty * price,
      ]);
    });
    const csv = rows
      .map((row) =>
        row
          .map((value) => '"' + String(value).replace(/"/g, '""') + '"')
          .join(","),
      )
      .join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    link.download =
      list.name
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase() + ".csv";
    link.click();
    URL.revokeObjectURL(link.href);
  });
}
window.exportSavedWishlistList = exportSavedWishlistList;

function renderSavedWishlistListsPanel(savedLists, allWishes) {
  const wishesById = new Map(allWishes.map((wish) => [wish.id, wish]));
  const cards = savedLists
    .map((list) => {
      const isActive = _activeWishlistSavedList === list.name;
      const metrics = getWishlistListMetrics(list, wishesById, isActive);
      const items = [...metrics.items].sort((a, b) => {
        const aStocked = wishStatus(a) === "stocked" ? 1 : 0;
        const bStocked = wishStatus(b) === "stocked" ? 1 : 0;
        return aStocked - bStocked;
      });
      const stockedItems = items.filter(
        (wish) => wishStatus(wish) === "stocked",
      );
      const itemRows = items
        .map((wish) => {
          const qty = Number(wish.qty || 0);
          const estimatedPrice = Number(wish.estimatedCost || 0);
          const amount =
            qty > 0 && estimatedPrice > 0 ? fmtN(qty * estimatedPrice) : "";
          const unit = String(wish.unit || "").trim();
          const itemName = wish.name || "Unnamed item";
          const stockedClass =
            wishStatus(wish) === "stocked" ? " is-stocked" : "";
          return (
            '<tr class="wish-saved-list-row' +
            stockedClass +
            '" draggable="true" onclick="openWishlistDetail(' +
            wish.id +
            ')" ondragstart="beginWishlistItemDrag(event,' +
            wish.id +
            ')" ondragover="event.preventDefault()" ondrop="dropWishlistItem(event,\'' +
            escapeHtml(list.id) +
            "'," +
            wish.id +
            ')"><td class="wish-table-check-cell"><input type="checkbox" class="wish-select-item" value="' +
            wish.id +
            '" aria-label="Select ' +
            escapeHtml(itemName) +
            '"' +
            (_selectedWishlistIds.has(Number(wish.id)) ? " checked" : "") +
            ' onchange="event.stopPropagation();updateWishlistSelection()"></td><td class="wish-table-name"><button type="button" class="wish-saved-list-item-name" onclick="event.stopPropagation();openWishlistDetail(' +
            wish.id +
            ')">' +
            escapeHtml(itemName) +
            "</button></td><td>" +
            (qty > 0 ? qty + (unit ? " " + escapeHtml(unit) : "") : "") +
            '</td><td class="wish-table-amount">' +
            escapeHtml(amount) +
            "</td></tr>"
          );
        })
        .join("");
      const clearStockedButton =
        isActive && stockedItems.length
          ? '<button type="button" class="wish-saved-list-clear-stocked" onclick="clearStockedItemsFromSavedList(\'' +
            escapeHtml(list.id) +
            '\')"><i class="fa-solid fa-broom"></i> Clear stocked</button>'
          : "";
      const itemPreview = isActive
        ? '<div class="wish-saved-list-items">' +
          (itemRows
            ? '<div class="wish-table-wrap"><table class="wish-table wish-saved-list-table"><thead><tr><th scope="col">Select</th><th scope="col">Item</th><th scope="col">Qty</th><th scope="col">Est. amount</th></tr></thead><tbody>' +
              itemRows +
              '</tbody><tfoot><tr><th colspan="2">List totals</th><th>' +
              fmtN(metrics.quantity) +
              "</th><th>" +
              fmtN(metrics.estimated) +
              "</th></tr></tfoot></table></div>"
            : "<span>No items in this list yet.</span>") +
          clearStockedButton +
          "</div>"
        : "";
      const listActions =
        '<div class="wish-saved-list-actions"><button type="button" title="Edit list" aria-label="Edit list ' +
        escapeHtml(list.name) +
        '" onclick="editSavedWishlistList(\'' +
        escapeHtml(list.id) +
        '\')"><i class="fa-solid fa-pen"></i></button><button type="button" title="Delete list" aria-label="Delete list ' +
        escapeHtml(list.name) +
        '" onclick="deleteSavedWishlistList(\'' +
        escapeHtml(list.id) +
        '\')"><i class="fa-solid fa-trash"></i></button><button type="button" class="wish-saved-list-whatsapp" title="Share list via WhatsApp" aria-label="Share list ' +
        escapeHtml(list.name) +
        ' via WhatsApp" onclick="shareSavedWishlistListViaWhatsApp(\'' +
        escapeHtml(list.id) +
        '\')"><i class="fa-brands fa-whatsapp"></i></button></div>';
      const moveOptions = savedLists
        .filter((target) => target.id !== list.id)
        .map(
          (target) =>
            '<option value="' +
            escapeHtml(target.id) +
            '">' +
            escapeHtml(target.name) +
            "</option>",
        )
        .join("");
      const bulkActions = isActive
        ? '<div class="wish-saved-list-bulk-actions" hidden>' +
          '<button type="button" class="wish-saved-list-bulk-btn wish-saved-list-stock-btn" title="Mark selected stocked" aria-label="Mark selected stocked" onclick="markSelectedWishlistItemsStocked()"><i class="fa-solid fa-check"></i><span>Stocked</span></button>' +
          (moveOptions
            ? '<select class="wish-saved-list-bulk-select wish-saved-list-move-select" title="Move selected items" aria-label="Move selected items" onchange="if(this.value){moveSelectedSavedWishlistItemsToList(this.value);this.value=\'\';}"><option value="">Move to...</option>' +
              moveOptions +
              "</select>"
            : "") +
          '<button type="button" class="wish-saved-list-bulk-btn" title="Edit selected" aria-label="Edit selected" onclick="editSelectedWishlistItem()"><i class="fa-solid fa-pen"></i><span>Edit</span></button>' +
          '<button type="button" class="wish-saved-list-bulk-btn danger" title="Delete selected" aria-label="Delete selected" onclick="deleteSelectedWishlistItems()"><i class="fa-solid fa-trash"></i><span>Delete</span></button>' +
          "</div>"
        : "";
      const actionRow = isActive
        ? '<div class="wish-saved-list-actions-row"><div class="wish-saved-list-add-group"><button type="button" class="wish-saved-list-add-items" onclick="showWishlistSection(\'add\')"><i class="fa-solid fa-plus"></i> Add item</button></div>' +
          bulkActions +
          "</div>"
        : "";
      const moveTargets = savedLists
        .filter((target) => target.id !== list.id)
        .map(
          (target) =>
            '<option value="' +
            escapeHtml(target.id) +
            '">' +
            escapeHtml(target.name) +
            "</option>",
        )
        .join("");
      const listTransfer =
        _selectedSavedWishlistListId === list.id && moveTargets
          ? '<div class="wish-saved-list-transfer"><label for="wish-move-target-' +
            escapeHtml(list.id) +
            '">Move to</label><select id="wish-move-target-' +
            escapeHtml(list.id) +
            '" class="wish-saved-list-transfer-select" onchange="toggleSavedWishlistMoveButton(this)"><option value="">Choose list...</option>' +
            moveTargets +
            '</select><button type="button" class="wish-saved-list-transfer-btn" disabled onclick="moveAllItemsFromSavedWishlistList(\'' +
            escapeHtml(list.id) +
            "', this.closest('.wish-saved-list-transfer').querySelector('select').value)\">Move all</button></div>"
          : "";
      return (
        '<article class="wish-saved-list-card' +
        (isActive ? " active" : "") +
        '"><div class="wish-saved-list-card-head"><input type="checkbox" class="wish-saved-list-select"' +
        (_selectedSavedWishlistListId === list.id ? " checked" : "") +
        ' aria-label="Select list ' +
        escapeHtml(list.name) +
        '" onchange="event.stopPropagation();toggleSavedWishlistListSelection(\'' +
        escapeHtml(list.id) +
        "',this.checked)\">" +
        listActions +
        '<button type="button" class="wish-saved-list-open" onclick="openSavedWishlistList(\'' +
        escapeHtml(list.id) +
        '\')"><span class="wish-saved-list-icon"><i class="fa-solid fa-list-check"></i></span><span class="wish-saved-list-copy"><strong>' +
        escapeHtml(list.name) +
        "</strong></span></button>" +
        listTransfer +
        "</div>" +
        actionRow +
        itemPreview +
        "</article>"
      );
    })
    .join("");
  return (
    '<div class="wish-saved-lists-panel"><div class="wish-saved-lists-head"><strong><i class="fa-solid fa-list-ul"></i> Wish lists</strong><button type="button" class="wish-filter-btn" onclick="createSavedWishlistList()"><i class="fa-solid fa-plus"></i> Add list</button></div><div class="wish-saved-list-grid">' +
    (cards ||
      '<div class="wish-saved-empty"><i class="fa-solid fa-list"></i><span>No saved lists yet.</span></div>') +
    "</div></div>"
  );
}

function addVisibleWishlistItemsToSavedList(selectedListName) {
  const listName = String(selectedListName || "").trim();
  if (!listName) {
    toast("Choose a saved list first", "info");
    return;
  }
  const visibleIds = [
    ...document.querySelectorAll("#wishlist-list .wish-row[data-wish-id]"),
  ]
    .map((row) => Number(row.dataset.wishId))
    .filter((id) => Number.isFinite(id));
  if (!visibleIds.length) {
    toast("There are no visible wishlist items to add", "info");
    return;
  }
  const lists = getSavedWishlistLists();
  const list = lists.find((entry) => entry.name === listName);
  if (!list) {
    toast("Saved list not found", "err");
    return;
  }
  const result = moveWishlistItemsToSavedList(visibleIds, list.id);
  if (!result.ok) return toast(result.reason, "info");
  renderWishlistPage();
  toast(
    visibleIds.length +
      " visible item" +
      (visibleIds.length === 1 ? "" : "s") +
      ' moved to "' +
      listName +
      '"',
    "ok",
  );
}
window.addVisibleWishlistItemsToSavedList = addVisibleWishlistItemsToSavedList;

function toggleWishlistAddMenu(targetListId) {
  const menu = document.getElementById("wish-add-menu-" + targetListId);
  if (menu) menu.hidden = !menu.hidden;
}
window.toggleWishlistAddMenu = toggleWishlistAddMenu;

function beginWishlistAddFromSource(targetListId, sourceListId) {
  const lists = getSavedWishlistLists();
  const target = lists.find((list) => list.id === targetListId);
  if (!target) return toast("Saved list not found", "err");
  _wishlistAddToSavedListId = target.id;
  if (sourceListId === "general") {
    _activeWishlistView = "main";
    _activeWishlistSavedList = "";
    _activeWishlistSection = "list";
    _selectedWishlistIds.clear();
    renderWishlistPage();
    toast("Select General List items, then use Add to current list", "info");
    return;
  }
  const source = lists.find(
    (list) => list.id === sourceListId && list.id !== target.id,
  );
  if (!source) return toast("Source list not found", "err");
  _activeWishlistView = "saved";
  _activeWishlistSavedList = source.name;
  _activeWishlistSection = "list";
  _selectedWishlistIds.clear();
  renderWishlistPage();
  toast(
    "Select items from " + source.name + ", then use Add to current list",
    "info",
  );
}
window.beginWishlistAddFromSource = beginWishlistAddFromSource;

function addSelectedItemsToPendingWishlistList() {
  if (!_wishlistAddToSavedListId)
    return toast("Choose a destination list first", "info");
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select wishlist items first", "info");
  const result = moveWishlistItemsToSavedList(ids, _wishlistAddToSavedListId);
  if (!result.ok) return toast(result.reason, "info");
  _wishlistAddToSavedListId = "";
  _selectedWishlistIds.clear();
  _activeWishlistView = "saved";
  _activeWishlistSavedList = result.target.name;
  renderWishlistPage();
  toast(
    ids.length +
      " item" +
      (ids.length === 1 ? "" : "s") +
      " moved to " +
      result.target.name,
    "ok",
  );
}
window.addSelectedItemsToPendingWishlistList =
  addSelectedItemsToPendingWishlistList;

function getSelectedWishlistIds() {
  const checkedIds = [...document.querySelectorAll(".wish-select-item:checked")]
    .map((checkbox) => Number(checkbox.value))
    .filter((id) => Number.isFinite(id));
  return checkedIds.length
    ? checkedIds
    : [..._selectedWishlistIds].filter((id) => Number.isFinite(id));
}

function updateWishlistSelection() {
  const visible = [...document.querySelectorAll(".wish-select-item")];
  const visibleIds = new Set(
    visible
      .map((checkbox) => Number(checkbox.value))
      .filter((id) => Number.isFinite(id)),
  );
  visible.forEach((checkbox) => {
    const id = Number(checkbox.value);
    if (checkbox.checked) _selectedWishlistIds.add(id);
    else _selectedWishlistIds.delete(id);
  });
  const count = _selectedWishlistIds.size;
  const bar = document.getElementById("wishlist-bulk-actions");
  if (bar) bar.hidden = count === 0;
  const addSelectedButton = document.getElementById(
    "wishlist-add-selected-btn",
  );
  if (addSelectedButton)
    addSelectedButton.hidden = count === 0 || !_wishlistAddToSavedListId;
  const selectedRows = visible
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.closest("tr"));
  const hasUnstockedSelection = selectedRows.some(
    (row) => !row?.classList.contains("is-stocked"),
  );
  const hasStockedSelection = selectedRows.some((row) =>
    row?.classList.contains("is-stocked"),
  );
  const stockedAction = document.querySelector(".wish-bulk-stocked");
  const stockedDestination = document.getElementById(
    "wishlist-stocked-destination",
  );
  if (stockedAction) stockedAction.hidden = !hasUnstockedSelection;
  if (stockedDestination) stockedDestination.hidden = !hasStockedSelection;
  const savedListBulkActions = document.querySelector(
    ".wish-saved-list-bulk-actions",
  );
  if (savedListBulkActions) {
    const savedListSelection = [
      ...document.querySelectorAll(
        ".wish-saved-list-table .wish-select-item:checked",
      ),
    ];
    const savedListSelectionCount = savedListSelection.length;
    const hasUnstocked = savedListSelection.some(
      (checkbox) => !checkbox.closest("tr")?.classList.contains("is-stocked"),
    );
    savedListBulkActions.hidden = savedListSelectionCount === 0;
    const stockButton = savedListBulkActions.querySelector(
      ".wish-saved-list-stock-btn",
    );
    const moveSelect = savedListBulkActions.querySelector(
      ".wish-saved-list-move-select",
    );
    if (stockButton) stockButton.hidden = !hasUnstocked;
    if (moveSelect) moveSelect.hidden = savedListSelectionCount === 0;
  }
  const selectAll = document.getElementById("wish-select-all");
  if (selectAll) {
    selectAll.checked =
      visibleIds.size > 0 && visible.every((checkbox) => checkbox.checked);
    selectAll.indeterminate =
      visible.some((checkbox) => checkbox.checked) && !selectAll.checked;
  }
}

function toggleAllWishlistSelection(checked) {
  document.querySelectorAll(".wish-select-item").forEach((checkbox) => {
    checkbox.checked = checked;
  });
  updateWishlistSelection();
}

async function markSelectedWishlistItemsStocked() {
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select wishlist items first", "info");
  const now = new Date().toISOString();
  try {
    await runAtomicWishlistOperation(
      ids,
      (wish) => {
        wish.status = "stocked";
        wish.stockedAt = now;
      },
      () => {},
    );
  } catch (_) {
    return toast("Could not mark the selected items stocked", "err");
  }
  _selectedWishlistIds.clear();
  scheduleSync();
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast(
    ids.length + " item" + (ids.length === 1 ? "" : "s") + " marked stocked",
    "ok",
  );
}
window.markSelectedWishlistItemsStocked = markSelectedWishlistItemsStocked;

async function moveSelectedWishlistItemsToGeneral() {
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select wishlist items first", "info");
  const wishes = (
    await Promise.all(ids.map((id) => dbGet("wishlist", id)))
  ).filter(Boolean);
  const movable = wishes.filter((wish) => wishStatus(wish) !== "discarded");
  if (!movable.length)
    return toast("Discarded items cannot move to the General List", "info");
  const now = new Date().toISOString();
  try {
    await runAtomicWishlistOperation(
      movable.map((wish) => wish.id),
      (wish) => {
        if (wishStatus(wish) === "stocked") {
          wish.status = "planned";
          wish.stockedAt = null;
          wish.stockedItemId = null;
          wish.dayPurchaseDate = null;
          wish.updatedAt = now;
        }
      },
      () => moveWishlistItemsToGeneralList(movable.map((wish) => wish.id)),
    );
  } catch (_) {
    return toast("Could not move the selected items to General List", "err");
  }
  _selectedWishlistIds.clear();
  scheduleSync();
  await renderWishlistPage();
  toast(
    movable.length +
      " item" +
      (movable.length === 1 ? "" : "s") +
      " moved to General List",
    "ok",
  );
}
window.moveSelectedWishlistItemsToGeneral = moveSelectedWishlistItemsToGeneral;

function moveSelectedSavedWishlistItemsToList(targetListId) {
  const ids = [
    ...document.querySelectorAll(
      ".wish-saved-list-table .wish-select-item:checked",
    ),
  ]
    .map((checkbox) => Number(checkbox.value))
    .filter((id) => Number.isInteger(id));
  if (!ids.length) return toast("Select wishlist items first", "info");
  const target = getSavedWishlistLists().find(
    (list) => list.id === targetListId,
  );
  if (!target) return toast("Choose another saved list", "info");
  const result = moveWishlistItemsToSavedList(ids, target.id);
  if (!result.ok) return toast(result.reason, "info");
  _selectedWishlistIds.clear();
  _selectedSavedWishlistListId = "";
  _activeWishlistView = "saved";
  _activeWishlistSavedList = target.name;
  renderWishlistPage();
  toast(
    ids.length +
      " item" +
      (ids.length === 1 ? "" : "s") +
      ' moved to "' +
      target.name +
      '"',
    "ok",
  );
}
window.moveSelectedSavedWishlistItemsToList =
  moveSelectedSavedWishlistItemsToList;

async function moveSelectedStockedItemsToList(targetListId) {
  const ids = getSelectedWishlistIds();
  const wishes = (
    await Promise.all(ids.map((id) => dbGet("wishlist", id)))
  ).filter((wish) => wish && wishStatus(wish) === "stocked");
  if (!wishes.length) return toast("Select stocked items first", "info");
  const target =
    targetListId === "general"
      ? null
      : getSavedWishlistLists().find((list) => list.id === targetListId);
  if (targetListId !== "general" && !target)
    return toast("Choose an active destination list", "info");
  if (target) {
    const duplicate = wishes.some((wish) =>
      (target.itemIds || []).some((id) => String(id) === String(wish.id)),
    );
    if (duplicate)
      return toast(
        "One or more items already exist in the destination list",
        "info",
      );
  }
  const now = new Date().toISOString();
  try {
    await runAtomicWishlistOperation(
      wishes.map((wish) => wish.id),
      (wish) => {
        wish.status = "planned";
        wish.stockedAt = null;
        wish.stockedItemId = null;
        wish.dayPurchaseDate = null;
        wish.updatedAt = now;
      },
      () => {
        if (target)
          moveWishlistItemsToSavedList(
            wishes.map((wish) => wish.id),
            target.id,
          );
        else moveWishlistItemsToGeneralList(wishes.map((wish) => wish.id));
      },
    );
  } catch (_) {
    return toast("Could not move the stocked items", "err");
  }
  _selectedWishlistIds.clear();
  scheduleSync();
  await renderWishlistPage();
  toast(
    wishes.length +
      " item" +
      (wishes.length === 1 ? "" : "s") +
      " moved to " +
      (target ? target.name : "General List"),
    "ok",
  );
}
window.moveSelectedStockedItemsToList = moveSelectedStockedItemsToList;

async function discardSelectedWishlistItems() {
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select stocked items first", "info");
  const wishes = (
    await Promise.all(ids.map((id) => dbGet("wishlist", id)))
  ).filter(Boolean);
  const stocked = wishes.filter((wish) => wishStatus(wish) === "stocked");
  if (!stocked.length) return toast("Select stocked items to discard", "info");
  if (
    !confirm(
      "Discard " +
        stocked.length +
        " stocked item" +
        (stocked.length === 1 ? "" : "s") +
        "?",
    )
  )
    return;
  const now = new Date().toISOString();
  try {
    await runAtomicWishlistOperation(
      stocked.map((wish) => wish.id),
      (wish) => {
        wish.status = "discarded";
        wish.discardedAt = now;
        wish.updatedAt = now;
      },
      () => moveWishlistItemsToGeneralList(stocked.map((wish) => wish.id)),
    );
  } catch (_) {
    return toast("Could not discard the selected items", "err");
  }
  _selectedWishlistIds.clear();
  scheduleSync();
  await renderWishlistPage();
  toast(
    stocked.length + " item" + (stocked.length === 1 ? "" : "s") + " discarded",
    "ok",
  );
}
window.discardSelectedWishlistItems = discardSelectedWishlistItems;

async function deleteSelectedWishlistItems() {
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select wishlist items first", "info");
  if (
    !confirm(
      "Delete " +
        ids.length +
        " selected wishlist item" +
        (ids.length === 1 ? "" : "s") +
        "?",
    )
  )
    return;
  for (const id of ids) await deleteWishlistItem(id, true);
  _selectedWishlistIds.clear();
  await renderWishlistPage();
  await renderStockMonitor();
  await renderStockMonitorSummary();
  toast(
    ids.length + " item" + (ids.length === 1 ? "" : "s") + " deleted",
    "ok",
  );
}
window.deleteSelectedWishlistItems = deleteSelectedWishlistItems;

async function editSelectedWishlistItem() {
  const ids = getSelectedWishlistIds();
  if (!ids.length) return toast("Select wishlist items first", "info");
  if (ids.length === 1) return openEditWishlistItem(ids[0]);
  await openWishlistBulkEdit(ids);
}
window.editSelectedWishlistItem = editSelectedWishlistItem;

async function openWishlistBulkEdit(ids) {
  const records = (
    await Promise.all(ids.map((id) => dbGet("wishlist", id)))
  ).filter(Boolean);
  if (!records.length)
    return toast("Selected wishlist items were not found", "err");
  const fields = {
    name: records.map((wish) => String(wish.name || "")),
    unit: records.map((wish) => String(wish.unit || "Pcs")),
    qty: records.map((wish) => String(Number(wish.qty || 0))),
    estimatedCost: records.map((wish) =>
      String(Number(wish.estimatedCost || 0)),
    ),
    status: records.map((wish) => normalizeWishlistStatus(wish.status)),
    category: records.map((wish) => String(wish.type || wish.category || "")),
    supplierId: records.map((wish) =>
      String(wish.supplierId || wish.supplier || ""),
    ),
    note: records.map((wish) => String(wish.note || "")),
  };
  const values = {
    name: document.getElementById("wish-bulk-name"),
    unit: document.getElementById("wish-bulk-unit"),
    qty: document.getElementById("wish-bulk-qty"),
    estimatedCost: document.getElementById("wish-bulk-cost"),
    status: document.getElementById("wish-bulk-status"),
    category: document.getElementById("wish-bulk-category"),
    supplierId: document.getElementById("wish-bulk-supplier"),
    note: document.getElementById("wish-bulk-note"),
  };
  Object.entries(values).forEach(([field, input]) => {
    if (!input) return;
    const first = fields[field][0];
    const common = fields[field].every((value) => value === first);
    input.value = common ? first : "";
    input.placeholder = common ? "" : "Mixed values";
  });
  document.querySelectorAll("[data-bulk-edit-field]").forEach((checkbox) => {
    checkbox.checked = false;
    const input = values[checkbox.dataset.bulkEditField];
    if (input) input.disabled = false;
  });
  const sheet = document.getElementById("wishlist-bulk-edit-sheet");
  if (sheet) sheet.classList.add("open");
}
window.openWishlistBulkEdit = openWishlistBulkEdit;

function closeWishlistBulkEdit() {
  const sheet = document.getElementById("wishlist-bulk-edit-sheet");
  if (sheet) sheet.classList.remove("open");
}
window.closeWishlistBulkEdit = closeWishlistBulkEdit;

async function saveWishlistBulkEdit() {
  const ids = getSelectedWishlistIds();
  const selectedFields = [
    ...document.querySelectorAll("[data-bulk-edit-field]:checked"),
  ].map((checkbox) => checkbox.dataset.bulkEditField);
  if (!ids.length) return closeWishlistBulkEdit();
  if (!selectedFields.length)
    return toast("Choose at least one field to update", "info");
  const statusRaw = document.getElementById("wish-bulk-status")?.value || "";
  if (selectedFields.includes("status") && !statusRaw)
    return toast("Choose a status before applying it", "info");
  const values = {
    name: Input.text("wish-bulk-name"),
    unit: Input.text("wish-bulk-unit") || "Pcs",
    qty: Number(document.getElementById("wish-bulk-qty")?.value || 0),
    estimatedCost: Number(
      document.getElementById("wish-bulk-cost")?.value || 0,
    ),
    status: normalizeWishlistStatus(statusRaw),
    category: Input.text("wish-bulk-category"),
    supplierId: Input.text("wish-bulk-supplier"),
    note: Input.text("wish-bulk-note"),
  };
  const now = new Date().toISOString();
  let updated = 0;
  for (const id of ids) {
    const wish = await dbGet("wishlist", id);
    if (!wish) continue;
    selectedFields.forEach((field) => {
      if (field === "category") {
        wish.category = values.category;
        wish.type = values.category;
      } else if (field === "supplierId") {
        wish.supplierId = values.supplierId;
      } else if (field === "qty") {
        wish.qty = Math.max(0, values.qty);
      } else if (field === "estimatedCost") {
        wish.estimatedCost = Math.max(0, values.estimatedCost);
      } else {
        wish[field] = values[field];
      }
    });
    wish.updatedAt = now;
    wish.updatedBy = currentUser ? currentUser.username : "system";
    await dbPut("wishlist", wish);
    updated++;
  }
  if (selectedFields.includes("status") && values.status === "stocked") {
    moveWishlistItemsToGeneralList(ids);
  }
  closeWishlistBulkEdit();
  scheduleSync();
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast(
    updated + " wishlist item" + (updated === 1 ? "" : "s") + " updated",
    "ok",
  );
}
window.saveWishlistBulkEdit = saveWishlistBulkEdit;

function addSelectedWishlistItemsToSavedList(selectedListName) {
  const listName = String(selectedListName || "").trim();
  const selectedIds = getSelectedWishlistIds();
  if (!listName) return toast("Choose a saved list first", "info");
  if (!selectedIds.length) return toast("Select wishlist items first", "info");
  const list = getSavedWishlistLists().find((entry) => entry.name === listName);
  if (!list) return toast("Saved list not found", "err");
  const result = moveWishlistItemsToSavedList(selectedIds, list.id);
  if (!result.ok) return toast(result.reason, "info");
  _selectedWishlistIds.clear();
  renderWishlistPage();
  toast(
    selectedIds.length +
      " item" +
      (selectedIds.length === 1 ? "" : "s") +
      ' moved to "' +
      listName +
      '"',
    "ok",
  );
}
window.addSelectedWishlistItemsToSavedList =
  addSelectedWishlistItemsToSavedList;

function normalizeWishlistStatus(value) {
  const status = String(value || "")
    .trim()
    .toLowerCase();
  if (status === "planned" || status === "prospective" || status === "new")
    return "planned";
  if (
    status === "in_progress" ||
    status === "in-progress" ||
    status === "inprogress"
  )
    return "in_progress";
  if (status === "stocked" || status === "completed") return "stocked";
  if (status === "discarded") return "discarded";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "planned";
}

function labelWishlistStatus(value) {
  switch (normalizeWishlistStatus(value)) {
    case "planned":
      return "Planned";
    case "in_progress":
      return "In progress";
    case "stocked":
      return "Stocked";
    case "discarded":
      return "Discarded";
    case "cancelled":
      return "Cancelled";
    default:
      return "Planned";
  }
}

function wishStatus(wish) {
  return normalizeWishlistStatus(wish?.status);
}

function isWishlistSaleMonitorEntry(wish) {
  return String(wish?.source || "") === "sale-monitor";
}

function wishDateLabel(value) {
  if (!value) return "";
  const date = new Date(value + (value.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

async function markWishlistStockedById(
  wishId,
  itemId,
  stockedQty,
  actualBuyPrice,
) {
  if (!wishId || !db.objectStoreNames.contains("wishlist")) return;
  const wish = await dbGet("wishlist", wishId);
  if (!wish) return;
  const now = new Date().toISOString();
  const requestedQty = Number(wish.requestedQty || wish.qty || stockedQty || 0);
  const purchaseQty = Number(stockedQty || requestedQty);
  const previousPurchased = Number(wish.purchasedQty || 0);
  const totalPurchased = previousPurchased + purchaseQty;
  wish.requestedQty = requestedQty;
  wish.purchasedQty = totalPurchased;
  wish.qty = Math.max(0, requestedQty - totalPurchased);
  wish.status = totalPurchased >= requestedQty ? "stocked" : "planned";
  wish.purchaseStatus = totalPurchased >= requestedQty ? "stocked" : "partial";
  wish.stockedAt =
    totalPurchased >= requestedQty ? now : wish.stockedAt || null;
  if (totalPurchased >= requestedQty) wish.dayPurchaseDate = null;
  wish.stockedItemId = itemId || null;
  if (
    wish.purchaseBudgetId &&
    db.objectStoreNames.contains("purchase_budgets")
  ) {
    const budget = await dbGet("purchase_budgets", wish.purchaseBudgetId);
    if (budget) {
      if (!Array.isArray(budget.purchaseHistory)) budget.purchaseHistory = [];
      budget.purchaseHistory.push({
        wishId: wish.id,
        itemId: itemId || null,
        name: wish.name || wish.code || "Item",
        qty: purchaseQty,
        actualBuyPrice: Number(actualBuyPrice || wish.estimatedCost || 0),
        total: purchaseQty * Number(actualBuyPrice || wish.estimatedCost || 0),
        date: now,
        createdBy: currentUser ? currentUser.username : "system",
      });
      await dbPut("purchase_budgets", budget);
    }
  }
  await dbPut("wishlist", wish);
  scheduleSync();
  if (totalPurchased >= requestedQty) {
    removeWishFromAllPlanners(wishId);
  }
}

function normalizeWishVendorQuotes(wish) {
  if (!wish || !Array.isArray(wish.vendorQuotes)) return [];
  return wish.vendorQuotes
    .map((q) => ({
      id:
        q.id ||
        "vq_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      vendor: String(q.vendor || "").trim(),
      price: parseFloat(q.price),
      updatedAt: q.updatedAt || q.createdAt || new Date().toISOString(),
    }))
    .filter((q) => q.vendor && Number.isFinite(q.price) && q.price >= 0);
}

function sortWishVendorQuotes(quotes) {
  return [...quotes].sort(
    (a, b) => a.price - b.price || a.vendor.localeCompare(b.vendor),
  );
}

function getCheapestWishVendorQuote(quotes) {
  const sorted = sortWishVendorQuotes(quotes);
  return sorted.length ? sorted[0] : null;
}

/** Parse "... 36-42" from wish name to size numbers for grid. */
function parseWishShoeSizeRange(text) {
  const s = String(text || "");
  const m = s.match(/(\d+)\s*[-–-]\s*(\d+)\s*$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    min > max ||
    max - min > 40
  )
    return null;
  const sizes = [];
  for (let i = min; i <= max; i++) sizes.push(i);
  return { min, max, label: min + "–" + max, sizes };
}

function buildWishShoeOverlayHtml(wish) {
  const range =
    parseWishShoeSizeRange(wish?.name || "") ||
    parseWishShoeSizeRange(wish?.code || "");
  if (!range) return "";
  return '<span class="wd-shoe-badge">' + escapeHtml(range.label) + "</span>";
}

function renderWishShoeOverlay(wish) {
  const el = document.getElementById("wd-shoe-overlay");
  if (!el) return;
  const html = buildWishShoeOverlayHtml(wish);
  if (html) {
    el.innerHTML = html;
    el.hidden = false;
  } else {
    el.innerHTML = "";
    el.hidden = true;
  }
}

function buildWishVendorDetailHtml(quotes) {
  const sorted = sortWishVendorQuotes(quotes);
  if (!sorted.length) {
    return '<p class="wish-vendor-empty">No vendor prices yet - add one below, then Save</p>';
  }
  let html =
    '<div class="wd-vendor-table">' +
    '<div class="wd-vendor-row wd-vendor-row-hd"><span>Vendor</span><span>Amount</span></div>';
  sorted.forEach((q, i) => {
    const best = i === 0;
    html +=
      '<div class="wd-vendor-row' +
      (best ? " wd-vendor-row-best" : "") +
      '">' +
      '<span class="wd-vendor-name">' +
      escapeHtml(q.vendor) +
      "</span>" +
      '<span class="wd-vendor-amt">' +
      fmt(q.price) +
      (best ? '<span class="wd-best-tag">Best</span>' : "") +
      "</span>" +
      "</div>";
  });
  return html + "</div>";
}

function renderWishDetailItemInfo(wish) {
  const el = document.getElementById("wd-item-details");
  if (!el) return;
  const rows = [
    { label: "Name", value: wish.name, icon: "fa-tag" },
    {
      label: "Supply",
      value: wish.supplierId || wish.supplier,
      icon: "fa-truck",
    },
    { label: "Quantity", value: wish.qty > 0 ? wish.qty : "", icon: "fa-list" },
    {
      label: "Estimated Price",
      value: wish.estimatedCost > 0 ? fmt(wish.estimatedCost) : "",
      icon: "fa-coins",
      className: "price",
    },
  ];
  const html = rows
    .filter((r) => r.value)
    .map((r) => {
      if (r.className === "price") {
        return (
          '<div class="wish-detail-dl-row price-row">' +
          '<span class="wish-detail-price-icon">KSh</span>' +
          '<div class="wish-detail-price-copy"><dt>' +
          escapeHtml(r.label) +
          "</dt>" +
          "<dd>" +
          escapeHtml(String(r.value)) +
          "</dd></div>" +
          "</div>"
        );
      }
      return (
        '<div class="wish-detail-dl-row">' +
        '<span class="wish-detail-row-icon"><i class="fa-solid ' +
        r.icon +
        '"></i></span>' +
        "<dt>" +
        escapeHtml(r.label) +
        "</dt>" +
        '<dd class="' +
        (r.className || "") +
        '">' +
        escapeHtml(String(r.value)) +
        "</dd>" +
        "</div>"
      );
    })
    .join("");
  el.innerHTML = html || '<p class="wish-vendor-empty">No details</p>';
}

function buildWishTableHtml(rows, wishById) {
  const activeRows = rows.filter(
    (row) => wishStatus(wishById.get(row.wishId) || {}) !== "stocked",
  );
  const totalQty = activeRows.reduce(
    (sum, row) =>
      sum + Number((wishById.get(row.wishId) || {}).qty || row.qty || 0),
    0,
  );
  const totalAmount = activeRows.reduce((sum, row) => {
    const wish = wishById.get(row.wishId) || {};
    return (
      sum + Number(wish.qty || row.qty || 0) * Number(wish.estimatedCost || 0)
    );
  }, 0);
  const stockedMoveOptions = getSavedWishlistLists()
    .map(
      (list) =>
        '<option value="' +
        escapeHtml(list.id) +
        '">' +
        escapeHtml(list.name) +
        "</option>",
    )
    .join("");
  const bulkActions =
    '<div id="wishlist-bulk-actions" class="wishlist-bulk-actions" hidden>' +
    '<button type="button" id="wishlist-add-selected-btn" class="wish-bulk-btn" onclick="addSelectedItemsToPendingWishlistList()" hidden><i class="fa-solid fa-arrow-right"></i> Add to current list</button>' +
    '<button type="button" class="wish-bulk-btn wish-bulk-stocked" onclick="markSelectedWishlistItemsStocked()"><i class="fa-solid fa-check"></i> Mark Stocked</button>' +
    '<button type="button" class="wish-bulk-btn" onclick="moveSelectedWishlistItemsToGeneral()"><i class="fa-solid fa-arrow-left"></i> General List</button>' +
    '<select id="wishlist-stocked-destination" class="wish-bulk-destination" aria-label="Move stocked items to active list" onchange="if(this.value){moveSelectedStockedItemsToList(this.value);this.value=\'\';}"><option value="">Move stocked to...</option><option value="general">General List</option>' +
    stockedMoveOptions +
    "</select>" +
    '<button type="button" class="wish-bulk-btn" onclick="editSelectedWishlistItem()"><i class="fa-solid fa-pen"></i> Edit</button>' +
    '<button type="button" class="wish-bulk-btn" onclick="deleteSelectedWishlistItems()"><i class="fa-solid fa-trash"></i> Delete</button>' +
    "</div>";
  return (
    bulkActions +
    '<div class="wish-table-wrap"><table class="wish-table"><thead><tr><th scope="col" style="width:8%;"><span class="wish-column-label">Sel.</span><input type="checkbox" id="wish-select-all" aria-label="Select all visible wishlist items" onchange="toggleAllWishlistSelection(this.checked)"></th><th scope="col">Item</th><th scope="col">Supplier</th><th scope="col">Qty</th><th scope="col">Est. amount</th></tr></thead><tbody>' +
    rows
      .map((row) => {
        const wish = wishById.get(row.wishId) || {};
        const stocked = wishStatus(wish) === "stocked";
        const itemName = String(row.name || row.code || "").trim();
        const supply = String(wish.supplierId || wish.supplier || "").trim();
        const qty = Number(wish.qty || row.qty || 0);
        const estimatedPrice = Number(wish.estimatedCost || 0);
        const amount =
          qty > 0 && estimatedPrice > 0 ? fmt(qty * estimatedPrice) : "";
        const unit = String(wish.unit || "").trim();
        const statusLabel = labelWishlistStatus(wishStatus(wish));
        const statusClass =
          wishStatus(wish) === "in_progress"
            ? "wish-status-indicator in-progress"
            : wishStatus(wish) === "stocked"
              ? "wish-status-indicator stocked"
              : wishStatus(wish) === "cancelled"
                ? "wish-status-indicator cancelled"
                : "wish-status-indicator planned";
        const statusMarkup =
          wishStatus(wish) === "stocked" || _activeWishlistView === "stocked"
            ? ""
            : '<div class="wish-row-status"><span class="' +
              statusClass +
              '">' +
              escapeHtml(statusLabel) +
              "</span></div>";
        const isSelected = _selectedWishlistIds.has(Number(row.wishId));
        return (
          '<tr class="wish-row' +
          (stocked ? " is-stocked" : "") +
          '" data-wish-id="' +
          row.wishId +
          '" onclick="openWishlistDetail(' +
          row.wishId +
          ')">' +
          '<td class="wish-table-check-cell"><input type="checkbox" class="wish-select-item" value="' +
          row.wishId +
          '" aria-label="Select ' +
          escapeHtml(itemName) +
          '"' +
          (isSelected ? " checked" : "") +
          ' onchange="event.stopPropagation();updateWishlistSelection()"></td>' +
          '<td class="wish-table-name"><div class="wish-table-name-main">' +
          escapeHtml(itemName) +
          "</div>" +
          statusMarkup +
          "</td>" +
          "<td>" +
          escapeHtml(supply) +
          "</td>" +
          "<td>" +
          (qty > 0 ? qty + (unit ? " " + escapeHtml(unit) : "") : "") +
          "</td>" +
          '<td class="wish-table-amount">' +
          escapeHtml(amount) +
          "</td>" +
          "</tr>"
        );
      })
      .join("") +
    '</tbody><tfoot><tr><th colspan="3">Visible totals</th><th>' +
    fmtN(totalQty) +
    "</th><th>" +
    escapeHtml(fmt(totalAmount)) +
    "</th></tr></tfoot></table></div>"
  );
}

function clearWishDetailVendorForm() {
  ["wd-vendor-name", "wd-vendor-price"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

function renderWishVendorSection(wish) {
  const quotes = normalizeWishVendorQuotes(wish);
  const listEl = document.getElementById("wd-vendor-list");
  if (listEl) listEl.innerHTML = buildWishVendorDetailHtml(quotes);
}

async function openWishlistDetail(wishId) {
  const wish = await dbGet("wishlist", wishId);
  if (!wish) {
    toast("Wishlist item not found", "err");
    return;
  }
  if (!Array.isArray(wish.vendorQuotes)) wish.vendorQuotes = [];
  _currentWishDetailId = wishId;
  const sheet = document.getElementById("wishlist-detail-sheet");
  const photo = getWishPhoto(wishId);
  const photoImg = document.getElementById("wd-photo-img");
  const photoEmpty = document.getElementById("wd-photo-empty");
  if (photo && photoImg) {
    photoImg.src = photo;
    photoImg.style.display = "block";
    if (photoEmpty) photoEmpty.style.display = "none";
    const pv = _photoViewerRegistry.get("wishDetail");
    if (pv) requestAnimationFrame(() => pv.reset());
  } else {
    if (photoImg) {
      photoImg.src = "";
      photoImg.style.display = "none";
    }
    if (photoEmpty) photoEmpty.style.display = "flex";
  }
  const nameEl = document.getElementById("wd-name");
  const noteInput = document.getElementById("wd-note-input");
  if (nameEl) nameEl.textContent = wish.name || wish.code || "Item";
  const revertBtn = document.getElementById("wd-revert-btn");
  if (revertBtn) revertBtn.disabled = wishStatus(wish) !== "stocked";
  renderWishDetailItemInfo(wish);
  renderWishShoeOverlay(wish);
  if (noteInput) noteInput.value = wish.note || "";
  await renderPurchaseListOptions(
    "wd-purchase-list",
    wish.purchaseBudgetId || "",
  );
  [
    ["wd-category", wish.category || ""],
    ["wd-supplier", wish.supplierId || wish.supplier || ""],
  ].forEach(([fieldId, value]) => {
    const field = document.getElementById(fieldId);
    if (field) field.value = value;
  });
  clearWishDetailVendorForm();
  renderWishVendorSection(wish);
  if (sheet) sheet.classList.add("open");
}
window.openWishlistDetail = openWishlistDetail;

async function saveWishlistDetail() {
  const id = _currentWishDetailId;
  if (!id) return;
  const wish = await dbGet("wishlist", id);
  if (!wish) {
    toast("Wishlist item not found", "err");
    return;
  }
  if (!Array.isArray(wish.vendorQuotes)) wish.vendorQuotes = [];

  const noteInput = document.getElementById("wd-note-input");
  wish.note = noteInput ? String(noteInput.value || "").trim() : "";
  wish.category = Input.text("wd-category");
  wish.supplierId = Input.text("wd-supplier");
  wish.purchaseBudgetId =
    document.getElementById("wd-purchase-list")?.value || "";

  const vendorName = Input.text("wd-vendor-name").trim();
  const vendorPriceRaw = Input.money("wd-vendor-price");
  if (vendorName || vendorPriceRaw > 0) {
    if (!vendorName)
      return Validate.fail("Enter vendor name", "wd-vendor-name");
    if (!Validate.moneyRequired(vendorPriceRaw, "wd-vendor-price", "Amount"))
      return;
    const key = vendorName.toLowerCase();
    const existing = wish.vendorQuotes.find(
      (q) =>
        String(q.vendor || "")
          .trim()
          .toLowerCase() === key,
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.vendor = vendorName;
      existing.price = vendorPriceRaw;
      existing.updatedAt = now;
    } else {
      wish.vendorQuotes.push({
        id: "vq_" + Date.now(),
        vendor: vendorName,
        price: vendorPriceRaw,
        updatedAt: now,
      });
    }
    clearWishDetailVendorForm();
  }

  await dbPut("wishlist", wish);
  scheduleSync();
  renderWishDetailItemInfo(wish);
  renderWishVendorSection(wish);
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast("Saved", "ok");
}
window.saveWishlistDetail = saveWishlistDetail;

function closeWishlistDetail() {
  const sheet = document.getElementById("wishlist-detail-sheet");
  if (sheet) sheet.classList.remove("open");
  _currentWishDetailId = null;
}
window.closeWishlistDetail = closeWishlistDetail;

function wishlistDetailStock() {
  const id = _currentWishDetailId;
  closeWishlistDetail();
  if (id) startWishlistRestock(id);
}
window.wishlistDetailStock = wishlistDetailStock;

async function wishlistDetailRevert() {
  const id = _currentWishDetailId;
  if (!id) return;
  const wish = await dbGet("wishlist", id);
  if (!wish || wishStatus(wish) !== "stocked") return;
  wish.status = "planned";
  wish.stockedAt = null;
  wish.stockedItemId = null;
  wish.dayPurchaseDate = null;
  await dbPut("wishlist", wish);
  scheduleSync();
  closeWishlistDetail();
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast("Moved back to wishlist", "ok");
}
window.wishlistDetailRevert = wishlistDetailRevert;

async function wishlistDetailEdit() {
  const id = _currentWishDetailId;
  if (!id) return;
  closeWishlistDetail();
  await openEditWishlistItem(id);
}
window.wishlistDetailEdit = wishlistDetailEdit;

async function wishlistDetailDelete() {
  const id = _currentWishDetailId;
  if (!id) return;
  const wish = await dbGet("wishlist", id);
  const label = wish ? wish.name || wish.code || "this item" : "this item";
  if (wish && wishStatus(wish) === "stocked") {
    if (!confirm('Discard "' + label + '"?')) return;
    const now = new Date().toISOString();
    try {
      await runAtomicWishlistOperation(
        [id],
        (record) => {
          record.status = "discarded";
          record.discardedAt = now;
          record.updatedAt = now;
        },
        () => moveWishlistItemsToGeneralList([id]),
      );
    } catch (_) {
      return toast("Could not discard the item", "err");
    }
    scheduleSync();
    closeWishlistDetail();
    await renderWishlistPage();
    toast("Item discarded", "ok");
    return;
  }
  if (!confirm('Remove "' + label + '" from wishlist?')) return;
  closeWishlistDetail();
  await deleteWishlistItem(id);
}
window.wishlistDetailDelete = wishlistDetailDelete;

function showWishlistSection(section) {
  const listPanel = document.getElementById("wishlist-list");
  const addPanel = document.getElementById("wishlist-add-panel");
  const controls = document.getElementById("wishlist-controls");
  const normalizedSection =
    section === "day" || section === "stocked"
      ? "list"
      : section === "add"
        ? "add"
        : "list";
  const isAdd = normalizedSection === "add";
  if (isAdd) {
    const currentList = getSavedWishlistListForAdd();
    _wishlistAddToSavedListId = currentList ? currentList.id : "";
    const context = document.getElementById("wish-add-context");
    if (context) {
      context.hidden = !currentList;
      context.innerHTML = currentList
        ? '<i class="fa-solid fa-list-check"></i> Choose the destination list below. Main list is always the master list.'
        : "";
    }
  }
  _activeWishlistSection = normalizedSection;
  saveLastView();
  if (listPanel) listPanel.style.display = isAdd ? "none" : "block";
  if (addPanel) addPanel.style.display = isAdd ? "block" : "none";
  if (controls) controls.style.display = isAdd ? "none" : "block";
  if (isAdd) {
    renderWishlistSupplierOptions();
    renderWishlistUnitOptions();
    const typeInput = document.getElementById("wish-type");
    if (typeInput) typeInput.value = typeInput.value || "";
    mountWishTypeCascade();
    toggleWishAddMore(false);
    setTimeout(() => document.getElementById("wish-name")?.focus(), 80);
  } else if (listPanel) {
    listPanel.scrollTop = 0;
    renderWishlistPage();
  }
}

function setWishCurrentStep(stepName, shouldFocus) {
  document.querySelectorAll(".wish-question-step").forEach((step) => {
    const active = step.dataset.wishStep === stepName;
    step.classList.toggle("is-current", active);
    step.setAttribute("aria-hidden", active ? "false" : "true");
  });
  document.querySelectorAll(".wish-question-step-tab").forEach((tab) => {
    tab.classList.toggle("is-current", tab.dataset.stepTarget === stepName);
    tab.setAttribute(
      "aria-selected",
      tab.dataset.stepTarget === stepName ? "true" : "false",
    );
  });
  if (shouldFocus) {
    const current = document.querySelector(
      '.wish-question-step[data-wish-step="' + stepName + '"]',
    );
    current
      ?.querySelector("input, select, button")
      ?.focus({ preventScroll: true });
  }
}

function updateWishFormProgress() {
  const steps = [
    Boolean(Input.text("wish-name")),
    Boolean(
      Input.text("wish-type") ||
      Input.text("wish-category") ||
      Input.raw("wish-cost"),
    ),
    Boolean(Input.text("wish-supplier")),
    Boolean(Input.text("wish-note") || _wishFormPhotoData),
  ];
  const answered = steps.filter(Boolean).length;
  const label = document.getElementById("wish-form-progress-label");
  if (label) label.textContent = answered + " of 4 answered";
  const stepEls = Array.from(document.querySelectorAll(".wish-question-step"));
  document.querySelectorAll(".wish-question-step-tab").forEach((tab) => {
    const index = ["item", "target", "plan", "context"].indexOf(
      tab.dataset.stepTarget,
    );
    tab.classList.toggle("is-answered", !!steps[index]);
  });
  stepEls.forEach((step, index) => {
    step.classList.toggle("is-answered", !!steps[index]);
  });
}
window.updateWishFormProgress = updateWishFormProgress;

function focusWishStep(stepName) {
  const step = document.querySelector(
    '.wish-question-step[data-wish-step="' + stepName + '"]',
  );
  if (!step) return;
  setWishCurrentStep(stepName, false);
  step.scrollIntoView({ behavior: "smooth", block: "start" });
  step.querySelector("input, select, button")?.focus({ preventScroll: true });
}
window.focusWishStep = focusWishStep;
function toggleWishAddMore(forceOpen) {
  const panel = document.getElementById("wish-add-more");
  const btn = document.getElementById("wish-add-more-toggle");
  if (!panel || !btn) return;
  const open = typeof forceOpen === "boolean" ? forceOpen : panel.hidden;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.classList.toggle("is-open", open);
  const label = btn.querySelector(".wish-add-more-toggle-text");
  if (label)
    label.textContent = open ? "Hide other fields" : "Show other fields";
}
window.toggleWishAddMore = toggleWishAddMore;

window.showWishlistSection = showWishlistSection;

async function renderWishlistPage() {
  const list = document.getElementById("wishlist-list");
  if (!list) return;
  list.style.display = _activeWishlistView === "saved" ? "none" : "";
  const allWishes = db.objectStoreNames.contains("wishlist")
    ? await dbAll("wishlist")
    : [];
  const showList = _activeWishlistSection === "list";
  const showAdd = _activeWishlistSection === "add";
  const controls = document.getElementById("wishlist-controls");
  const savedLists = getSavedWishlistLists();
  if (controls) {
    if (showList) {
      controls.innerHTML =
        '<div class="wish-view-tabs" role="tablist" aria-label="Wishlist views">' +
        '<button type="button" class="wish-view-tab' +
        (_activeWishlistView === "saved" ? " active" : "") +
        '" role="tab" aria-selected="' +
        (_activeWishlistView === "saved") +
        '" onclick="chooseWishlistSavedList()"><i class="fa-solid fa-list-ul"></i> Wish lists</button>' +
        '<button type="button" class="wish-view-tab' +
        (_activeWishlistView === "main" ? " active" : "") +
        '" role="tab" aria-selected="' +
        (_activeWishlistView === "main") +
        '" onclick="setWishlistView(\'main\')"><i class="fa-solid fa-layer-group"></i> Main list</button>' +
        '<button type="button" class="wish-view-tab' +
        (_activeWishlistView === "stocked" ? " active" : "") +
        '" role="tab" aria-selected="' +
        (_activeWishlistView === "stocked") +
        '" onclick="setWishlistView(\'stocked\')">Stocked</button>' +
        "</div>" +
        (_activeWishlistView === "saved"
          ? renderSavedWishlistListsPanel(savedLists, allWishes)
          : "") +
        '<div id="wish-list-summary" class="wish-list-summary" aria-live="polite"></div>';
    } else {
      controls.innerHTML = "";
    }
  }
  let filteredWishes = allWishes
    .filter((wish) => !isWishlistSaleMonitorEntry(wish))
    .filter((wish) => {
      if (_activeWishlistView === "stocked")
        return wishStatus(wish) === "stocked";
      if (_activeWishlistView === "saved") {
        const savedList = savedLists.find(
          (list) => list.name === _activeWishlistSavedList,
        );
        return Boolean(
          savedList &&
          savedList.itemIds.includes(wish.id) &&
          wishStatus(wish) !== "stocked" &&
          wishStatus(wish) !== "discarded",
        );
      }
      return (
        wishStatus(wish) !== "stocked" &&
        wishStatus(wish) !== "discarded" &&
        !getWishlistListMembership(wish.id, savedLists)
      );
    })
    .sort((a, b) => {
      const aStocked = wishStatus(a) === "stocked" ? 1 : 0;
      const bStocked = wishStatus(b) === "stocked" ? 1 : 0;
      if (aStocked !== bStocked) return aStocked - bStocked;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
  const wishlistRecords = allWishes.filter(
    (wish) =>
      !isWishlistSaleMonitorEntry(wish) && wishStatus(wish) !== "discarded",
  );
  const activeCount = wishlistRecords.filter(
    (wish) => wishStatus(wish) !== "stocked",
  ).length;
  const stockedCount = wishlistRecords.filter(
    (wish) => wishStatus(wish) === "stocked",
  ).length;
  const visibleActiveWishes = filteredWishes.filter(
    (wish) => wishStatus(wish) !== "stocked",
  );
  const visibleQty = visibleActiveWishes.reduce(
    (sum, wish) => sum + Number(wish.qty || 0),
    0,
  );
  const visibleValue = visibleActiveWishes.reduce(
    (sum, wish) =>
      sum + Number(wish.qty || 0) * Number(wish.estimatedCost || 0),
    0,
  );
  const summary = document.getElementById("wish-list-summary");
  if (summary) {
    summary.style.display = _activeWishlistView === "saved" ? "none" : "";
    if (_activeWishlistView !== "saved") {
      summary.innerHTML =
        "<span><strong>" +
        filteredWishes.length +
        "</strong> shown</span>" +
        "<span><strong>" +
        activeCount +
        "</strong> to buy</span>" +
        "<span><strong>" +
        stockedCount +
        "</strong> stocked</span>" +
        "<span><strong>" +
        fmtN(visibleQty) +
        "</strong> units</span>" +
        "<span><strong>" +
        fmt(visibleValue) +
        "</strong> estimated</span>";
    }
  }
  const rows = filteredWishes.map((wish) => ({
    kind: "prospective",
    wishId: wish.id,
    name: wish.name || "Prospective item",
    type: wish.type || "",
    qty: wish.qty || 0,
  }));
  const wishSub = document.getElementById("wishlist-sub");
  if (wishSub)
    wishSub.textContent = rows.length
      ? rows.length + " item" + (rows.length === 1 ? "" : "s")
      : "Nothing yet";

  if (!rows.length) {
    list.innerHTML =
      '<div class="wish-empty"><div class="wish-empty-icon">+</div><p class="wish-empty-title">No item to display.</p>' +
      (!showAdd
        ? '<button type="button" class="wish-empty-btn" onclick="window.showWishlistSection(\'add\')">Add item</button>'
        : "") +
      "</div>";
    return;
  }

  const wishById = new Map();
  if (db.objectStoreNames.contains("wishlist")) {
    (await dbAll("wishlist")).forEach((w) => wishById.set(w.id, w));
  }
  list.innerHTML = buildWishTableHtml(rows, wishById);
  updateWishlistSelection();
}

async function toggleWishlistStockedState(wishId) {
  const wish = await dbGet("wishlist", wishId);
  if (!wish) return;
  const isStocked = wishStatus(wish) === "stocked";
  if (isStocked) {
    const label = wish.name || "this wishlist item";
    if (confirm('Revert "' + label + '" to the wishlist?')) {
      wish.status = "planned";
      wish.stockedAt = null;
      wish.stockedItemId = null;
      wish.dayPurchaseDate = null;
      await dbPut("wishlist", wish);
      scheduleSync();
      await renderWishlistPage();
      await renderStockMonitorSummary();
      toast("Moved back to wishlist", "ok");
      return;
    }
    if (
      confirm(
        'Delete "' + label + '" from the wishlist? This cannot be undone.',
      )
    ) {
      await deleteWishlistItem(wishId);
      toast("Wishlist item deleted", "ok");
      return;
    }
    await renderWishlistPage();
    return;
  }
  wish.status = "stocked";
  wish.stockedAt = new Date().toISOString();
  wish.stockedItemId = null;
  wish.dayPurchaseDate = null;
  try {
    await runAtomicWishlistOperation(
      [wishId],
      (record) => {
        record.status = wish.status;
        record.stockedAt = wish.stockedAt;
        record.stockedItemId = null;
        record.dayPurchaseDate = null;
      },
      () => {},
    );
  } catch (_) {
    return toast("Could not mark the item stocked", "err");
  }
  scheduleSync();
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast("Marked as stocked", "ok");
}
window.toggleWishlistStockedState = toggleWishlistStockedState;

async function saveWishlistItem() {
  const isEditing = !!_editingWishlistId;
  const name = Input.text("wish-name");
  const unitField = document.getElementById("wish-unit");
  const typeField = document.getElementById("wish-type");
  const noteField = document.getElementById("wish-note");
  const statusField = document.getElementById("wish-status");
  const unit = unitField ? Input.text("wish-unit") || "Pcs" : "Pcs";
  const type = typeField ? Input.text("wish-type") : "";
  const note = noteField ? Input.text("wish-note") : "";
  const status = statusField
    ? normalizeWishlistStatus(Input.text("wish-status"))
    : "planned";
  const qtyRaw = Input.int("wish-qty");
  const estimatedCost = Input.money("wish-cost");
  const supplierId = Input.text("wish-supplier");
  if (!name) return Validate.fail("Enter item name", "wish-name");
  if (!Validate.intOptional(qtyRaw, "wish-qty", "Quantity")) return;
  const qty = qtyRaw === null || qtyRaw <= 0 ? 0 : qtyRaw;

  if (isEditing) {
    const existing = await dbGet("wishlist", _editingWishlistId);
    if (!existing) {
      _editingWishlistId = null;
      toast("Wishlist item not found", "err");
      return;
    }
    Object.assign(existing, {
      name,
      unit,
      type: typeField ? type : existing.type || existing.category || "",
      category: typeField ? type : existing.category || existing.type || "",
      qty,
      estimatedCost: estimatedCost > 0 ? estimatedCost : 0,
      supplierId,
      note: noteField ? note : existing.note || "",
      status: statusField ? status : existing.status || "planned",
      updatedAt: new Date().toISOString(),
      updatedBy: currentUser ? currentUser.username : "system",
    });
    delete existing.code;
    delete existing.priority;
    delete existing.plannedPurchaseDate;
    await dbPut("wishlist", existing);
    if (
      wishStatus(existing) === "stocked" ||
      wishStatus(existing) === "discarded"
    ) {
      moveWishlistItemsToGeneralList([existing.id]);
    }
    _editingWishlistId = null;
    clearWishPhotoForm();
    ["wish-name", "wish-qty", "wish-cost", "wish-supplier"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    scheduleSync();
    showWishlistSection("list");
    await renderWishlistPage();
    await renderStockMonitorSummary();
    toast("Wishlist item updated", "ok");
    return;
  }

  const entry = {
    name,
    unit,
    qty,
    type,
    category: type,
    status,
    estimatedCost: estimatedCost > 0 ? estimatedCost : 0,
    note,
    supplierId,
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : "system",
  };
  entry.id = await dbAdd("wishlist", entry);
  const addList = _wishlistAddToSavedListId;
  _wishlistAddToSavedListId = "";
  if (addList) assignWishlistItemToSavedList(entry.id, addList);
  ["wish-name", "wish-qty", "wish-cost", "wish-supplier"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  clearWishPhotoForm();
  scheduleSync();
  if (addList) _activeWishlistView = "saved";
  showWishlistSection("list");
  await renderWishlistPage();
  await renderStockMonitorSummary();
  const budgetSummary = await computePurchaseBudget();
  toast(
    budgetSummary.unfunded > 0
      ? "Added to wishlist - budget warning"
      : "Added to wishlist",
    budgetSummary.unfunded > 0 ? "info" : "ok",
  );
}

async function openEditWishlistItem(wishId) {
  const wish = await dbGet("wishlist", wishId);
  if (!wish) {
    toast("Wishlist item not found", "err");
    return;
  }
  _editingWishlistId = Number(wishId);
  showWishlistSection("add");
  renderWishlistSupplierOptions();
  renderWishlistUnitOptions();
  const typeInput = document.getElementById("wish-type");
  if (typeInput) typeInput.value = wish.type || wish.category || "";
  mountWishTypeCascade();
  [
    ["wish-name", wish.name || ""],
    ["wish-unit", wish.unit || "Pcs"],
    ["wish-qty", Number(wish.qty || 0)],
    ["wish-cost", Number(wish.estimatedCost || 0)],
    ["wish-note", wish.note || ""],
    ["wish-status", normalizeWishlistStatus(wish.status)],
  ].forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  renderWishlistUnitOptions();
  const supplierEl = document.getElementById("wish-supplier");
  if (supplierEl) supplierEl.value = wish.supplierId || wish.supplier || "";
  const saveBtn = document.querySelector(".wish-save-btn");
  if (saveBtn)
    saveBtn.innerHTML =
      '<i class="fa-solid fa-floppy-disk"></i> Update wishlist item';
  const addTitle = document.querySelector(
    "#wishlist-add-panel .wish-section-title",
  );
  if (addTitle)
    addTitle.innerHTML =
      '<span class="wish-section-icon"><i class="fa-solid fa-pen"></i></span>Edit wishlist item';
  setTimeout(() => document.getElementById("wish-name")?.focus(), 100);
}
window.openEditWishlistItem = openEditWishlistItem;

function cancelWishlistEdit() {
  _editingWishlistId = null;
  const saveBtn = document.querySelector(".wish-save-btn");
  if (saveBtn)
    saveBtn.innerHTML =
      '<i class="fa-solid fa-floppy-disk"></i> Save to wishlist';
  const addTitle = document.querySelector(
    "#wishlist-add-panel .wish-section-title",
  );
  if (addTitle)
    addTitle.innerHTML =
      '<span class="wish-section-icon"><i class="fa-solid fa-cube"></i></span>What do you want to stock? <span class="add-required">*</span>';
  [
    "wish-name",
    "wish-unit",
    "wish-qty",
    "wish-cost",
    "wish-supplier",
    "wish-note",
    "wish-status",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const statusEl = document.getElementById("wish-status");
  if (statusEl) statusEl.value = "planned";
  const typeInput = document.getElementById("wish-type");
  if (typeInput) typeInput.value = "";
  mountWishTypeCascade();
  toggleWishAddMore(false);
  showWishlistSection("list");
}
window.cancelWishlistEdit = cancelWishlistEdit;

async function deleteWishlistItem(id, skipRender) {
  const wishId = Number(id);
  if (!Number.isInteger(wishId) || wishId < 1) return;
  const wish = await dbGet("wishlist", wishId);
  moveWishlistItemsToGeneralList([wishId]);
  await removeWishPhoto(wishId);
  await cascadeDeleteRecord("wishlist", wishId, wish);
  if (!skipRender) {
    await renderWishlistPage();
    await renderStockMonitor();
    await renderStockMonitorSummary();
  }
}

async function markWishlistStockedForItem(item) {
  if (!item || !db.objectStoreNames.contains("wishlist")) return;
  const wishlist = await dbAll("wishlist");
  const itemCode = (item.code || "").trim().toLowerCase();
  const itemName = (item.name || "").trim().toLowerCase();
  const codeMatches = wishlist.filter((wish) => {
    if (wishStatus(wish) === "stocked") return false;
    const wishCode = (wish.code || "").trim().toLowerCase();
    return itemCode && wishCode && itemCode === wishCode;
  });
  const nameMatches = wishlist.filter((wish) => {
    if (wishStatus(wish) === "stocked") return false;
    const wishName = (wish.name || "").trim().toLowerCase();
    return itemName && wishName && itemName === wishName;
  });
  const match = (codeMatches.length ? codeMatches : nameMatches).sort(
    (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
  )[0];
  if (!match) return;
  match.status = "stocked";
  match.stockedAt = new Date().toISOString();
  match.stockedItemId = item.id || null;
  await dbPut("wishlist", match);
  moveWishlistItemsToGeneralList([match.id]);
}

async function restockFromMonitor(itemId, size) {
  closeStockMonitor();
  if (size != null) {
    await openShoeSizeRestock(itemId, size);
    return;
  }
  await openSheet(itemId);
  setTimeout(() => {
    const panel = document.getElementById("restock-panel");
    if (panel && panel.style.display === "none") toggleRestock();
    const qty = document.getElementById("restock-qty");
    if (qty) qty.focus();
  }, 120);
}

async function startWishlistRestock(wishId) {
  const wish = await dbGet("wishlist", wishId);
  if (!wish) return;
  const existingItems = await dbAll("items");
  const existing = existingItems.find(
    (item) =>
      (wish.code &&
        item.code &&
        item.code.toLowerCase() === wish.code.toLowerCase()) ||
      (!wish.code &&
        wish.name &&
        item.name &&
        item.name.toLowerCase() === wish.name.toLowerCase()),
  );
  _wishStockingFromId = wishId;
  closeWishlistDetail();
  closeStockMonitor();
  clearForm();
  _wishStockingFromId = wishId;
  showPage("add");
  const photo = getWishPhoto(wishId);
  setTimeout(() => {
    setItemMode(false);
    if (existing && _purchaseProcessing?.wishId === wishId) {
      UI.el("edit-id").value = "restock_" + existing.id;
      UI.el("f-code").value = existing.code || wish.code || "";
      UI.el("f-name").value = existing.name || wish.name || "";
      UI.el("f-qty").value = _purchaseProcessing.qty;
      UI.el("f-buy").value = _purchaseProcessing.unitBuy;
      setRestockBanner(false);
      showRestockView({
        code: existing.code,
        name: existing.name,
        type: existing.type,
        stock: existing.qty || 0,
        buy: existing.buyPrice || wish.estimatedCost || 0,
        sell: existing.sellPrice || 0,
      });
      updateProfitPreview();
      return;
    }
    if (wish.type) setAddFormType(wish.type);
    if (UI.el("f-code")) UI.el("f-code").value = wish.code || "";
    if (UI.el("f-name")) UI.el("f-name").value = wish.name || "";
    if (UI.el("f-qty"))
      UI.el("f-qty").value =
        _purchaseProcessing?.wishId === wishId
          ? _purchaseProcessing.qty
          : wish.qty || 1;
    if (UI.el("f-buy"))
      UI.el("f-buy").value =
        _purchaseProcessing?.wishId === wishId
          ? _purchaseProcessing.unitBuy
          : wish.estimatedCost || "";
    if (photo) applyAddFormPhotoPreview(photo);
    else clearAddFormPhoto();
    setItemMode(false);
    setAddFormSubtitle("");
    setSaveBtnLabel("Save");
    updateProfitPreview();
  }, 80);
}

// Open a dedicated size detail sheet from the stock list

/* ===== photo-import.js ===== */
function openPhotoImport() {
  _piExtractedRows = [];
  _piImageDataUrl = "";
  var sheet = document.getElementById("photo-import-sheet");
  if (!sheet) return;
  _piShowStep("capture");
  var prevWrap = document.getElementById("pi-preview-wrap");
  if (prevWrap) prevWrap.style.display = "none";
  var img = document.getElementById("pi-image-preview");
  if (img) img.src = "";
  sheet.classList.add("active");
}

function closePhotoImport() {
  var sheet = document.getElementById("photo-import-sheet");
  if (sheet) sheet.classList.remove("active");
}

function _piShowStep(step) {
  var steps = ["capture", "loading", "preview", "importing"];
  for (var i = 0; i < steps.length; i++) {
    var el = document.getElementById("pi-step-" + steps[i]);
    if (el) el.style.display = steps[i] === step ? "" : "none";
  }
}

function onPhotoImportFileSelected(input) {
  if (!input || !input.files || !input.files[0]) return;
  var file = input.files[0];
  var reader = new FileReader();
  reader.onload = function (e) {
    _piImageDataUrl = e.target.result;
    // Show thumbnail briefly on capture step
    var img = document.getElementById("pi-image-preview");
    if (img) {
      img.src = _piImageDataUrl;
      img.style.display = "block";
    }
    // Auto-extract — no extra button tap needed
    extractFromPhoto();
  };
  reader.readAsDataURL(file);
}

async function extractFromPhoto() {
  if (!_piImageDataUrl) {
    toast("Please select an image first", "err");
    return;
  }
  var key = getGeminiKey();
  if (!key) {
    toast("Add your Gemini API key in Settings first", "err");
    return;
  }

  _piShowStep("loading");
  // Show photo thumbnail in loading screen for context
  var thumb = document.getElementById("pi-loading-thumb");
  if (thumb && _piImageDataUrl) {
    thumb.src = _piImageDataUrl;
    thumb.style.display = "block";
  }

  try {
    var base64Match = _piImageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!base64Match) throw new Error("Invalid image format");
    var mimeType = base64Match[1];
    var base64Data = base64Match[2];

    var prompt =
      "Look at this handwritten stock list image. Extract all inventory items you can see. " +
      "Return ONLY a valid JSON array (no markdown, no code fences, no explanation) where each element has these fields: " +
      '"name" (string, product name), "code" (string, short product code or abbreviation, uppercase, max 12 chars), ' +
      '"category" (string, product category if visible, else empty string), ' +
      '"qty" (number, quantity, default 0 if not visible), ' +
      '"buyPrice" (number, buying/cost price, default 0 if not visible), ' +
      '"sellPrice" (number, selling price; extract it when visible, otherwise return 0 so the user can enter it). ' +
      "Never omit the selling price field. " +
      "Return an empty array [] if no items are found. Output only the JSON array.";

    var url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=" +
      key;

    var body = {
      contents: [
        {
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
    };

    var response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      var errText = await response.text();
      throw new Error(
        "Gemini API error " + response.status + ": " + errText.slice(0, 200),
      );
    }

    var data = await response.json();
    var rawText = "";
    try {
      rawText = data.candidates[0].content.parts[0].text || "";
    } catch (_e) {
      throw new Error("Unexpected Gemini response format");
    }

    // Strip markdown code fences if present
    rawText = rawText.trim();
    rawText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    var parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) throw new Error("AI did not return an array");

    _piExtractedRows = parsed.map(function (r) {
      return {
        name: String(r.name || "").trim(),
        code: String(r.code || "")
          .trim()
          .toUpperCase(),
        category: String(r.category || "").trim(),
        qty: parseFloat(r.qty) || 0,
        buyPrice: parseFloat(r.buyPrice) || 0,
        sellPrice: parseFloat(r.sellPrice) || 0,
      };
    });

    if (_piExtractedRows.length === 0) {
      toast("No items found in image. Try a clearer photo.", "err");
      _piShowStep("capture");
      return;
    }

    _piRenderPreviewTable();
    _piShowStep("preview");
  } catch (err) {
    console.error("[PhotoImport] extractFromPhoto error:", err);
    toast("AI extraction failed: " + (err.message || "Unknown error"), "err");
    _piShowStep("capture");
  }
}

function _piRenderPreviewTable() {
  var tbody = document.getElementById("pi-preview-tbody");
  if (!tbody) return;

  var badge = document.getElementById("pi-count-badge");
  if (badge)
    badge.textContent =
      _piExtractedRows.length +
      " item" +
      (_piExtractedRows.length !== 1 ? "s" : "");

  // Build category options from global types array
  var catOptions = '<option value="">— None —</option>';
  var sortedTypes = (types || []).slice().sort(function (a, b) {
    return (a.name || "").localeCompare(b.name || "");
  });
  for (var ti = 0; ti < sortedTypes.length; ti++) {
    var t = sortedTypes[ti];
    catOptions +=
      '<option value="' +
      escapeHtml(t.name) +
      '">' +
      escapeHtml((t.emoji || "") + " " + t.name) +
      "</option>";
  }

  var html = "";
  for (var i = 0; i < _piExtractedRows.length; i++) {
    var row = _piExtractedRows[i];
    var catSel = catOptions.replace(
      'value="' + escapeHtml(row.category) + '"',
      'value="' + escapeHtml(row.category) + '" selected',
    );
    html +=
      '<tr id="pi-row-' +
      i +
      '">' +
      '<td><input class="pi-cell" type="text" value="' +
      escapeHtml(row.name) +
      '"' +
      ' onchange="_piUpdateRow(' +
      i +
      ',\'name\',this.value)" placeholder="Item name"></td>' +
      '<td><input class="pi-cell pi-mono" type="text" value="' +
      escapeHtml(row.code) +
      '"' +
      ' onchange="_piUpdateRow(' +
      i +
      ',\'code\',this.value)" placeholder="CODE" style="text-transform:uppercase;"></td>' +
      '<td><select class="pi-select" onchange="_piUpdateRow(' +
      i +
      ",'category',this.value)\">" +
      catSel +
      "</select></td>" +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' +
      row.qty +
      '" min="0"' +
      ' onchange="_piUpdateRow(' +
      i +
      ",'qty',this.value)\"></td>" +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' +
      row.buyPrice +
      '" min="0"' +
      ' onchange="_piUpdateRow(' +
      i +
      ",'buyPrice',this.value)\"></td>" +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' +
      row.sellPrice +
      '" min="1" required placeholder="Required"' +
      ' onchange="_piUpdateRow(' +
      i +
      ",'sellPrice',this.value)\"></td>" +
      '<td><button class="pi-del-btn" onclick="_piDeleteRow(' +
      i +
      ')" title="Remove row">' +
      '<i class="fa-solid fa-trash-can"></i></button></td>' +
      "</tr>";
  }
  tbody.innerHTML = html;
}

function _piUpdateRow(i, field, value) {
  if (!_piExtractedRows[i]) return;
  if (field === "qty" || field === "buyPrice" || field === "sellPrice") {
    _piExtractedRows[i][field] = parseFloat(value) || 0;
  } else {
    _piExtractedRows[i][field] = String(value || "").trim();
  }
}

function _piDeleteRow(i) {
  _piExtractedRows.splice(i, 1);
  _piRenderPreviewTable();
}

function piAddRow() {
  _piExtractedRows.push({
    name: "",
    code: "",
    category: "",
    qty: 0,
    buyPrice: 0,
    sellPrice: 0,
  });
  _piRenderPreviewTable();
  // Scroll to new row
  var tbody = document.getElementById("pi-preview-tbody");
  if (tbody) {
    var rows = tbody.querySelectorAll("tr");
    if (rows.length)
      rows[rows.length - 1].scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
  }
}

async function importPhotoItems() {
  // Collect current input values from DOM (user may have typed without triggering onchange)
  var tbody = document.getElementById("pi-preview-tbody");
  if (tbody) {
    var domRows = tbody.querySelectorAll('tr[id^="pi-row-"]');
    for (var di = 0; di < domRows.length; di++) {
      var inputs = domRows[di].querySelectorAll("input, select");
      var idx = parseInt(domRows[di].id.replace("pi-row-", ""), 10);
      if (isNaN(idx) || !_piExtractedRows[idx]) continue;
      var fields = ["name", "code", "category", "qty", "buyPrice", "sellPrice"];
      for (var fi = 0; fi < inputs.length && fi < fields.length; fi++) {
        var val = inputs[fi].value;
        var fld = fields[fi];
        if (fld === "qty" || fld === "buyPrice" || fld === "sellPrice") {
          _piExtractedRows[idx][fld] = parseFloat(val) || 0;
        } else {
          _piExtractedRows[idx][fld] = String(val || "").trim();
        }
      }
    }
  }

  // Validate rows
  var valid = [];
  var skipped = 0;
  for (var vi = 0; vi < _piExtractedRows.length; vi++) {
    var r = _piExtractedRows[vi];
    if (!r.name || !r.code) {
      skipped++;
      continue;
    }
    valid.push(r);
  }

  if (valid.length === 0) {
    toast("No valid rows (name + code required for each item)", "err");
    return;
  }

  var invalidPrices = [];
  for (var pi = 0; pi < valid.length; pi++) {
    var priceRow = valid[pi];
    var sellPrice = Number(priceRow.sellPrice);
    var buyPrice = Number(priceRow.buyPrice) || 0;
    if (!Number.isFinite(sellPrice) || sellPrice <= 0) {
      invalidPrices.push(priceRow.name + " (enter a selling price)");
    } else if (buyPrice > 0 && sellPrice < buyPrice) {
      invalidPrices.push(priceRow.name + " (selling price is below buying price)");
    }
  }
  if (invalidPrices.length) {
    _piShowStep("preview");
    toast(
      "Enter a valid selling price for: " + invalidPrices.join("; "),
      "err",
    );
    return;
  }

  _piShowStep("importing");

  var imported = 0;
  var restocked = 0;
  var errors = 0;

  for (var ii = 0; ii < valid.length; ii++) {
    var row = valid[ii];

    // Update progress UI
    var pct = Math.round(((ii + 1) / valid.length) * 100);
    var fill = document.getElementById("pi-progress-fill");
    var label = document.getElementById("pi-progress-label");
    if (fill) fill.style.width = pct + "%";
    if (label)
      label.textContent =
        "Importing " +
        (ii + 1) +
        " of " +
        valid.length +
        ": " +
        escapeHtml(row.name);

    try {
      var buy = parseFloat(row.buyPrice) || 0;
      var sell = parseFloat(row.sellPrice) || 0;
      var qty = parseFloat(row.qty) || 0;
      var profit = sell - buy;

      // Check if item with this code already exists
      var existing = null;
      for (var ei = 0; ei < allItems.length; ei++) {
        if (
          (allItems[ei].code || "").trim().toUpperCase() ===
          row.code.toUpperCase()
        ) {
          existing = allItems[ei];
          break;
        }
      }

      if (existing) {
        // Restock existing item
        existing.qty = (parseFloat(existing.qty) || 0) + qty;
        if (buy > 0) existing.buyPrice = buy;
        if (sell > 0) existing.sellPrice = sell;
        if (buy > 0 && sell > 0) existing.profit = profit;
        existing.updatedAt = new Date().toISOString();
        await dbPut("items", existing);
        await recordStockInvestment(
          existing,
          qty * buy,
          qty,
          "Photo import restock",
        );
        fbSyncItem(existing);
        restocked++;
      } else {
        // Create new item
        var now = new Date().toISOString();
        var newItem = {
          code: row.code.toUpperCase(),
          name: row.name,
          type: row.category || "",
          category: row.category || "",
          buyPrice: buy,
          sellPrice: sell,
          profit: profit,
          qty: qty,
          isRecord: false,
          isShoe: false,
          hasVariants: false,
          variant: "",
          createdAt: now,
          updatedAt: now,
        };
        newItem.fbId = stableItemFbId(newItem);
        var newId = await dbAdd("items", newItem);
        newItem.id = newId;
        await markWishlistStockedForItem(newItem);
        await recordStockInvestment(newItem, qty * buy, qty, "Photo import");
        fbSyncItem(newItem);
        imported++;
      }
    } catch (rowErr) {
      console.error("[PhotoImport] Row error for", row.code, rowErr);
      errors++;
    }
  }

  // Refresh app state
  allItems = await dbAll("items");
  await enrichShoeItems(allItems);
  renderList();
  renderDashboard();
  updateHeader();
  scheduleSync();

  closePhotoImport();

  var msg = "";
  if (imported > 0)
    msg += imported + " new item" + (imported !== 1 ? "s" : "") + " added. ";
  if (restocked > 0)
    msg += restocked + " item" + (restocked !== 1 ? "s" : "") + " restocked. ";
  if (skipped > 0)
    msg +=
      skipped +
      " row" +
      (skipped !== 1 ? "s" : "") +
      " skipped (missing name/code). ";
  if (errors > 0) msg += errors + " error" + (errors !== 1 ? "s" : "") + ".";

  if (errors > 0 && imported === 0 && restocked === 0) {
    toast(msg.trim() || "Import failed", "err");
  } else {
    toast(msg.trim() || "Import complete", "ok");
  }
}

// Window exports for photo import
window.openPhotoImport = openPhotoImport;
window.closePhotoImport = closePhotoImport;
window.onPhotoImportFileSelected = onPhotoImportFileSelected;
window.extractFromPhoto = extractFromPhoto;
window._piUpdateRow = _piUpdateRow;
window._piDeleteRow = _piDeleteRow;
window.piAddRow = piAddRow;
window.importPhotoItems = importPhotoItems;

// ===================================================================
// CUSTOMERS MODULE  — credit tracking, balances, transaction history
// ===================================================================

// ── Generate next customer ID: C-0001, C-0002, … ──────────────────

function mountInventoryPage() {
  if (_inventoryMounted) return;
  const stockSlot = document.getElementById("inventory-stock-slot");
  const wishSlot = document.getElementById("inventory-wishlist-slot");
  const controlSlot = document.getElementById("inventory-stock-control-slot");
  const addSlot = document.getElementById("inventory-add-slot");
  const stockPage = document.getElementById("page-list");
  const wishPage = document.getElementById("page-wishlist");
  const addPage = document.getElementById("page-add");
  if (
    !stockSlot ||
    !wishSlot ||
    !controlSlot ||
    !addSlot ||
    !stockPage ||
    !wishPage ||
    !addPage
  )
    return;

  [stockPage, wishPage, addPage].forEach((page) => {
    page.classList.remove("active");
    page.classList.add("inv-module");
  });
  stockSlot.appendChild(stockPage);
  wishSlot.appendChild(wishPage);
  addSlot.appendChild(addPage);
  _inventoryMounted = true;
}

function showInventoryTab(tab) {
  _activeInventoryTab = ["stock", "stock-control", "wishlist", "add"].includes(
    tab,
  )
    ? tab
    : tab === "monitor"
      ? "stock-control"
      : "stock";
  mountInventoryPage();
  const selectedTab =
    _activeInventoryTab === "add" ? "stock" : _activeInventoryTab;
  ["stock", "stock-control", "wishlist", "add"].forEach((name) => {
    const btn = document.getElementById("inventory-tab-" + name);
    const slot = document.getElementById("inventory-" + name + "-slot");
    if (btn) btn.classList.toggle("active", name === selectedTab);
    if (slot) slot.classList.toggle("active", name === _activeInventoryTab);
    if (btn) btn.setAttribute("aria-selected", String(name === selectedTab));
  });
  const sub = document.getElementById("inventory-sub");
  if (sub) {
    sub.textContent =
      {
        stock: "Browse products currently in stock, check quantities, and update item details.",
        "stock-control": "Review items that are out of stock or need attention.",
        wishlist: "Keep a list of products you may want to purchase.",
        add: "Add a new product or record incoming stock.",
      }[_activeInventoryTab] || "";
  }
  if (_activeInventoryTab === "stock") renderList();
  if (_activeInventoryTab === "wishlist" && typeof showWishlistSection === "function")
    showWishlistSection("list");
  if (_activeInventoryTab === "stock-control") renderStockMonitor();
  if (_activeInventoryTab === "add") {
    renderTypeSelect();
    updateProfitPreview();
    onTypeChange();
  }
  saveLastView();
}

function showStockControlTab(tab) {
  showInventoryTab(tab === "wishlist" ? "wishlist" : "stock-control");
}

function navigateToStock() {
  goDashNav("stock");
}
window.navigateToStock = navigateToStock;

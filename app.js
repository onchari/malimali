// ===================================================================
// DATABASE SCHEMA  v8  —  Mandela General Stores
// ===================================================================
let db;
const DB_NAME = 'InventoryApp';
const DB_VER  = 10;

// ── APP CONSTANTS ─────────────────────────────────────────────────────
const KEY_SESSION     = 'mg_session';
const KEY_LAST_PAGE   = 'mg_last_page';
const KEY_SHOE_GROUPS = 'mgs_shoe_groups';
const KEY_CURRENCY    = 'mgs_currency';
const KEY_DELETED_FIN = 'mgs_deleted_finances';
const KEY_DELETED_SALE = 'mgs_deleted_sales';
const CODE_MAX_QTY    = 9999;
const LOW_STOCK_LEVEL = 1;
const OUT_STOCK_LEVEL = 0;
const SHOE_GROUP_DEFAULTS = Object.freeze({
  S: Object.freeze({ min: 20, max: 28 }),
  M: Object.freeze({ min: 29, max: 36 }),
  L: Object.freeze({ min: 37, max: 45 }),
});

function initDB() {
  const req = indexedDB.open(DB_NAME, DB_VER);

  req.onupgradeneeded = e => {
    const d   = e.target.result;
    const old = e.oldVersion;

    // ── items ──────────────────────────────────────────────────────
    // One record per product SKU.
    // Normalized fields:
    //   buyPrice  (was: buy / defaultBuy)
    //   sellPrice (was: sell / defaultSell)
    //   variant   (was: size — only for non-shoe items)
    //   isShoe    — true → sizes stored in shoe_sizes
    if (!d.objectStoreNames.contains('items')) {
      const s = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      s.createIndex('idx_code',     'code',    { unique: true  });
      s.createIndex('idx_type',     'type',    { unique: false });
      s.createIndex('idx_fbid',     'fbId',    { unique: false });
      s.createIndex('idx_is_shoe',  'isShoe',  { unique: false });
    }

    // ── shoe_sizes ─────────────────────────────────────────────────
    // One record per item_code + size. FK: itemCode → items.code
    if (!d.objectStoreNames.contains('shoe_sizes')) {
      const ss = d.createObjectStore('shoe_sizes', { keyPath: 'id', autoIncrement: true });
      ss.createIndex('idx_item_code', 'itemCode', { unique: false });
      ss.createIndex('idx_code_size', 'codeSize', { unique: true  }); // "CODE_42"
      ss.createIndex('idx_item_id',   'itemId',   { unique: false });
      ss.createIndex('idx_fbid',      'fbId',     { unique: false });
    }

    // ── sales ──────────────────────────────────────────────────────
    // One record per transaction line.
    // businessDate (normalized, was: business_date in old records)
    if (!d.objectStoreNames.contains('sales')) {
      const sa = d.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
      sa.createIndex('idx_item_id',       'itemId',       { unique: false });
      sa.createIndex('idx_item_code',     'itemCode',     { unique: false });
      sa.createIndex('idx_business_date', 'businessDate', { unique: false });
      sa.createIndex('idx_date',          'date',         { unique: false });
      sa.createIndex('idx_sold_by',       'soldBy',       { unique: false });
      sa.createIndex('idx_payment',       'paymentMethod',{ unique: false });
      sa.createIndex('idx_fbid',          'fbId',         { unique: false });
    }

    // ── finances ───────────────────────────────────────────────────
    // Money flow: investments, expenses, withdrawals
    if (!d.objectStoreNames.contains('finances')) {
      const fi = d.createObjectStore('finances', { keyPath: 'id', autoIncrement: true });
      fi.createIndex('idx_type',       'type',      { unique: false });
      fi.createIndex('idx_date',       'date',      { unique: false });
      fi.createIndex('idx_created_by', 'createdBy', { unique: false });
      fi.createIndex('idx_fbid',       'fbId',      { unique: false });
    }

    // ── business_days ──────────────────────────────────────────────
    // Daily session records. All fields camelCase.
    if (!d.objectStoreNames.contains('business_days')) {
      const bd = d.createObjectStore('business_days', { keyPath: 'id', autoIncrement: true });
      bd.createIndex('idx_business_date', 'businessDate', { unique: true  }); // one per day
      bd.createIndex('idx_status',        'status',       { unique: false });
      bd.createIndex('idx_fbid',          'fbId',         { unique: false });
    }

    // ── types ──────────────────────────────────────────────────────
    if (!d.objectStoreNames.contains('types')) {
      d.createObjectStore('types', { keyPath: 'id', autoIncrement: true });
    }

    // Prospective items the business wants to stock later.
    if (!d.objectStoreNames.contains('wishlist')) {
      const wl = d.createObjectStore('wishlist', { keyPath: 'id', autoIncrement: true });
      wl.createIndex('idx_status',     'status',    { unique: false });
      wl.createIndex('idx_type',       'type',      { unique: false });
      wl.createIndex('idx_created_at', 'createdAt', { unique: false });
      wl.createIndex('idx_fbid',       'fbId',      { unique: false });
    }

    // NOTE: day_sessions store (legacy) intentionally NOT created in v9.
    //       Existing data migrated to business_days by migrateData().
  };

  req.onerror = e => {
    console.error('[DB] Open error:', e.target.error);
    toast('Database error — try refreshing', 'err');
  };

  req.onsuccess = e => {
    db = e.target.result;
    db.onerror = ev => console.error('[DB] Unhandled error:', ev.target.error);

    loadTypes().then(async () => {
      updateCurrencyUI();
      await migrateData();
      const sessionRestored = checkSession();
      if (!sessionRestored) return;

      await loadActiveDay();
      renderDashboard();
      renderList();
      renderSummary();
      renderSellPage();
      updateLowStockBadge();

      const rawLastPage = localStorage.getItem(KEY_LAST_PAGE) || 'dash';
      const lastPage = (rawLastPage === 'day' || rawLastPage === 'finance') ? 'operations' : rawLastPage;
      const allowedPage = currentUser && currentUser.tabs.includes(lastPage)
        ? lastPage : currentUser.tabs[0];
      _origShowPage(allowedPage);
    });
  };
}

// Migrate old field names → normalized v9 names
// ── IndexedDB helpers ─────────────────────────────────────────────
function _dbReady(rej) {
  if (!db) { const e = new Error('Database not ready'); if (rej) rej(e); return false; } return true;
}
function dbAll(store) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx = db.transaction(store, 'readonly');
      tx.objectStore(store).getAll().onsuccess = e => res(e.target.result || []);
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}
function dbGet(store, id) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx = db.transaction(store, 'readonly');
      tx.objectStore(store).get(id).onsuccess = e => res(e.target.result);
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}
function dbAdd(store, data) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).add(data);
      req.onsuccess = e => res(e.target.result);
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}
function dbPut(store, data) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(data);
      req.onsuccess = e => res(e.target.result);
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}
function dbDelete(store, id) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id).onsuccess = e => res(e.target.result);
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}


// ===================================================================
// CODING STANDARDS APPLIED
//
// 1. Class: DB           — IndexedDB abstraction (DRY, SRP)
// 2. Class: UI           — DOM access layer (DRY, encapsulation)
// 3. Class: ShoeState    — shoe form state (SRP, encapsulation)
// 4. Class: SavingOverlay— progress UI (SRP, reusability)
// 5. DRY: refreshUI()   — single refresh chain replaces repeated blocks
// 6. CONST: STORES, CSS  — no magic strings
// ===================================================================

// ── Standard 6: Named constants — no magic strings ─────────────────
const STORES = Object.freeze({
  ITEMS:    'items',
  SALES:    'sales',
  SIZES:    'shoe_sizes',
  FINANCES: 'finances',
  BDAYS:    'business_days',
  TYPES:    'types',
  WISHLIST: 'wishlist',
  SESSIONS: 'day_sessions',
});

const CSS = Object.freeze({
  ACTIVE:   'active',
  OPEN:     'open',
  SHOW:     'show',
  LOW:      'low',
  OUT:      'out',
  SELECTED: 'selected',
  SZ_ACTIVE:'sz-active',
  SG_ACTIVE:'sg-active',
});

// ── Standard 1: DB class — wraps IndexedDB, single place for DB access
class DB {
  static all(store)       { return dbAll(store); }
  static get(store, id)   { return dbGet(store, id); }
  static add(store, data) { return dbAdd(store, data); }
  static put(store, data) { return dbPut(store, data); }
  static del(store, id)   { return dbDelete(store, id); }

  // Convenience: all items with shoe enrichment
  static async items() {
    const items = await dbAll(STORES.ITEMS);
    await enrichShoeItems(items);
    return items;
  }

  // Convenience: sales for a given business date
  static async salesForDay(businessDate) {
    const all = await dbAll(STORES.SALES);
    return all.filter(s => (s.businessDate || s.business_date) === businessDate);
  }

  // Convenience: clear all stores atomically (used by resetAllData)
  static async clearAll(storeNames) {
    return new Promise((res, rej) => {
      const valid = storeNames.filter(s => db.objectStoreNames.contains(s));
      if (!valid.length) { res(); return; }
      const tx = db.transaction(valid, 'readwrite');
      tx.onerror   = e => rej(e.target.error);
      tx.oncomplete = () => res();
      valid.forEach(s => tx.objectStore(s).clear());
    });
  }
}

// ── Standard 2: UI class — all DOM access in one place ─────────────
class UI {
  // Get element (cached per session, cleared on page transition)
  static el(id) {
    return document.getElementById(id);
  }

  // Set text content safely
  static setText(id, val) {
    const el = this.el(id);
    if (el) el.textContent = (val == null ? '' : val);
  }

  // Set input value
  static setVal(id, val) {
    const el = this.el(id);
    if (el) el.value = (val == null ? '' : val);
  }

  // Show/hide by display style
  static show(id, display = 'block') {
    const el = this.el(id);
    if (el) el.style.display = display;
  }
  static hide(id) {
    const el = this.el(id);
    if (el) el.style.display = 'none';
  }

  // Toggle a CSS class
  static toggle(id, cls, force) {
    const el = this.el(id);
    if (el) el.classList.toggle(cls, force);
  }

  // Set/get attribute
  static attr(id, attr, val) {
    const el = this.el(id);
    if (!el) return undefined;
    if (val !== undefined) el.setAttribute(attr, val);
    return el.getAttribute(attr);
  }

  // Get input value trimmed
  static val(id) {
    const el = this.el(id);
    return el ? el.value.trim() : '';
  }

  // Bulk set text — { elementId: value, ... }
  static setMany(map) {
    Object.entries(map).forEach(([id, val]) => this.setText(id, val));
  }

  // Enable / disable element
  static setEnabled(id, enabled) {
    const el = this.el(id);
    if (!el) return;
    el.disabled = !enabled;
    el.style.opacity  = enabled ? '' : '0.45';
    el.style.cursor   = enabled ? '' : 'not-allowed';
  }
}


// ── Core shoe helpers — defined early so all functions can use them ─
function isFootwearType(typeName) {
  if (!typeName) return false;
  const n = typeName.toLowerCase();
  return n.includes('shoe') || n.includes('footwear') || n.includes('boot') ||
         n.includes('sandal') || n.includes('slipper') || n.includes('sneaker');
}

async function getShoeSizes(itemCode) {
  if (!itemCode) return [];
  const all = await dbAll('shoe_sizes');
  return all.filter(s => s.itemCode === itemCode).sort((a, b) => a.size - b.size);
}

async function enrichShoeItems(items) {
  const allSz = await dbAll('shoe_sizes');
  items.forEach(item => {
    if (item.isShoe) {
      const sizes = allSz.filter(s => s.itemCode === item.code);
      item.qty = sizes.reduce((t, s) => t + (s.qty || 0), 0);
    }
  });
}


// ═══════════════════════════════════════════════════════════
// VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════
const Validate = {
  // Highlight a field red and focus it
  _shake(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.borderColor = 'var(--red)';
    el.focus();
    setTimeout(() => { el.style.borderColor = ''; }, 2000);
  },
  fail(msg, fieldId) {
    toast('⚠️ ' + msg, 'err');
    if (fieldId) this._shake(fieldId);
    return false;
  },
  // Price rules
  price(buy, sell, buyFieldId, sellFieldId) {
    if (!buy || buy <= 0)  return this.fail('Enter buying price (must be > 0)', buyFieldId);
    if (!sell || sell <= 0) return this.fail('Enter selling price (must be > 0)', sellFieldId);
    if (sell < buy)        return this.fail('Selling price (' + fmt(sell) + ') cannot be less than buying price (' + fmt(buy) + ')', sellFieldId);
    return true;
  },
  // Qty rules for new stock
  qty(qty, qtyFieldId) {
    if (qty === '' || qty === null || isNaN(qty)) return this.fail('Enter a quantity', qtyFieldId);
    if (qty < 0)  return this.fail('Quantity cannot be negative', qtyFieldId);
    if (qty === 0) return this.fail('Quantity must be at least 1 when adding new stock', qtyFieldId);
    if (qty > 999999) return this.fail('Quantity exceeds maximum (999,999)', qtyFieldId);
    return true;
  },
  // Qty rules for restock (adding to existing — 0 not allowed)
  restockQty(qty, qtyFieldId) {
    if (!qty || isNaN(qty) || qty <= 0) return this.fail('Enter a quantity to add (must be at least 1)', qtyFieldId);
    if (qty > 999999) return this.fail('Quantity exceeds maximum (999,999)', qtyFieldId);
    return true;
  },
  // Stock available check for selling
  stock(wantQty, inStock, itemName) {
    if (inStock <= 0) return this.fail((itemName || 'Item') + ' is out of stock', null);
    if (wantQty > inStock) return this.fail('Only ' + inStock + ' in stock — cannot sell ' + wantQty, null);
    if (wantQty <= 0) return this.fail('Quantity to sell must be at least 1', null);
    return true;
  },
  // Sale price check
  salePrice(priceUsed, buyPrice, sellPrice) {
    if (!priceUsed || priceUsed <= 0) return this.fail('Enter a selling price', null);
    // The saved sell price is only the projected/default price. The actual
    // sale price may be lower after bargaining, even below cost if approved.
    return true;
  },
};

// ── Standard 3: ShoeState class — encapsulates all shoe form state ──
class ShoeState {
  constructor() {
    this.reset();
  }

  reset() {
    this.group      = null;       // active group: 'S'|'M'|'L'
    this.sizes      = new Set();  // selected size numbers
    this.shownGroups= new Set();  // groups whose buttons are rendered
    this.perSizeMode= false;      // true = per-size pricing
  }

  // Add or remove a size
  toggleSize(s) {
    if (this.sizes.has(s)) this.sizes.delete(s);
    else                   this.sizes.add(s);
  }

  // Sorted array of selected sizes
  get sortedSizes() {
    return [...this.sizes].sort((a, b) => a - b);
  }

  // True if at least one size selected
  get hasSelection() {
    return this.sizes.size > 0;
  }

  // Derive group from a size number
  groupFor(size) {
    const groups = getShoeGroups();
    for (const [g, cfg] of Object.entries(groups)) {
      if (size >= cfg.min && size <= cfg.max) return g;
    }
    return 'S';
  }

  // Remove all sizes belonging to a group
  clearGroup(g) {
    const groups = getShoeGroups();
    const cfg = groups[g];
    if (!cfg) return;
    for (let s = cfg.min; s <= cfg.max; s++) this.sizes.delete(s);
    this.shownGroups.delete(g);
    if (this.group === g) this.group = null;
  }
}

// ── Standard 4: SavingOverlay class — progress UI ──────────────────
class SavingOverlay {
  constructor() {
    this._timer      = null;
    this._progress   = 0;
    this._circumference = 213.6;
    this._targetBtn  = null;
  }

  show(label = 'Saving…', targetBtn = null) {
    const overlay = UI.el('saving-overlay');
    const arc     = UI.el('saving-arc');
    const lbl     = UI.el('saving-label');
    // Default to save-btn; caller can pass a different button (e.g. Confirm Sale)
    const btn     = targetBtn || UI.el('save-btn');
    this._targetBtn = btn;
    if (!overlay) return;

    if (btn) { btn.disabled = true; btn.style.opacity = '0.45'; btn.style.pointerEvents = 'none'; }
    if (arc) arc.style.strokeDashoffset = this._circumference;
    if (lbl) lbl.textContent = label;
    overlay.style.display = 'flex';

    this._progress = 0;
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._progress = Math.min(this._progress + (85 / 30), 85);
      if (arc) arc.style.strokeDashoffset = this._circumference * (1 - this._progress / 100);
      if (this._progress >= 85) clearInterval(this._timer);
    }, 50);
  }

  hide() {
    clearInterval(this._timer);
    const arc = UI.el('saving-arc');
    const btn = this._targetBtn || UI.el('save-btn');
    if (arc) arc.style.strokeDashoffset = 0; // snap to 100%

    setTimeout(() => {
      const overlay = UI.el('saving-overlay');
      if (overlay) overlay.style.display = 'none';
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.pointerEvents = ''; }
      this._targetBtn = null;
    }, 350);
  }
}

// ── Singleton instances ─────────────────────────────────────────────
const _overlay   = new SavingOverlay();
const _shoeState = new ShoeState();

// ── Standard 5: DRY — single UI refresh chain ──────────────────────
// Replaces 15+ repeated blocks of:
//   allItems = await dbAll('items');
//   await enrichShoeItems(allItems);
//   renderList(); renderDashboard(); updateHeader();
//   scheduleSync();
async function refreshUI(opts = {}) {
  const { sync = true, dashboard = true, list = true, header = true, badge = true } = opts;
  allItems = await DB.items();
  if (list)      renderList();
  if (dashboard) renderDashboard();
  if (header)    updateHeader();
  if (badge)     try { updateLowStockBadge(); } catch(_) { /* intentionally ignored */ }
  if (sync)      scheduleSync();
}


async function migrateData() {
  // ── v9 migrations ────────────────────────────────────────────────
  // Runs on every startup; idempotent — safe to run multiple times.
  let fixed = 0;

  try {
    // ── 1. items: unify buy/sell fields ────────────────────────────
    // Old: { buy, sell } for standard; { defaultBuy, defaultSell } for shoes
    // New: { buyPrice, sellPrice } for ALL items (unified)
    const items = await dbAll('items');
    for (const item of items) {
      let changed = false;

      // Migrate buy → buyPrice
      if (item.buy != null && item.buyPrice == null) {
        item.buyPrice = item.buy;
        changed = true;
      }
      // Migrate defaultBuy → buyPrice (shoes)
      if (item.defaultBuy != null && item.buyPrice == null) {
        item.buyPrice = item.defaultBuy;
        changed = true;
      }
      // Migrate sell → sellPrice
      if (item.sell != null && item.sellPrice == null) {
        item.sellPrice = item.sell;
        changed = true;
      }
      // Migrate defaultSell → sellPrice (shoes)
      if (item.defaultSell != null && item.sellPrice == null) {
        item.sellPrice = item.defaultSell;
        changed = true;
      }
      // Migrate size → variant (avoid confusion with shoe sizes)
      if (item.size != null && item.variant == null) {
        item.variant = item.size;
        changed = true;
      }
      // Older shoe parent records accidentally stored S/M/L in category.
      if (item.isShoe && (!item.category || ['S', 'M', 'L'].includes(item.category))) {
        item.category = item.type || 'Footwear';
        changed = true;
      }
      // Ensure profit is computed
      if (item.buyPrice != null && item.sellPrice != null) {
        const expected = item.sellPrice - item.buyPrice;
        if (item.profit !== expected) { item.profit = expected; changed = true; }
      }
      // Ensure required fields
      if (!item.createdAt) { item.createdAt = new Date().toISOString(); changed = true; }
      if (!item.code) continue; // skip corrupt records

      if (changed) { await dbPut('items', item); fixed++; }
    }
    console.log(`[MIGRATE v9] items: ${fixed} updated`);

    // ── 2. shoe_sizes: ensure all required fields ──────────────────
    const sizes = await dbAll('shoe_sizes');
    let szFixed = 0;
    for (const sz of sizes) {
      let changed = false;
      if (!sz.codeSize && sz.itemCode && sz.size != null) {
        sz.codeSize = sz.itemCode + '_' + sz.size;
        changed = true;
      }
      // Migrate buyPrice/sellPrice if using old names
      if (sz.buy != null && sz.buyPrice == null)   { sz.buyPrice  = sz.buy;  changed = true; }
      if (sz.sell != null && sz.sellPrice == null)  { sz.sellPrice = sz.sell; changed = true; }
      if (!sz.createdAt) { sz.createdAt = new Date().toISOString(); changed = true; }
      if (changed) { await dbPut('shoe_sizes', sz); szFixed++; }
    }
    console.log(`[MIGRATE v9] shoe_sizes: ${szFixed} updated`);

    // ── 3. sales: normalize businessDate field ─────────────────────
    const sales = await dbAll('sales');
    let sFixed = 0;
    for (const s of sales) {
      let changed = false;
      // Normalize business_date → businessDate
      if (s.business_date && !s.businessDate) {
        s.businessDate = s.business_date;
        delete s.business_date;
        changed = true;
      }
      // Ensure required fields
      if (!s.paymentMethod) { s.paymentMethod = 'cash';   changed = true; }
      if (!s.soldBy)         { s.soldBy = 'system';       changed = true; }
      if (!s.itemCode && s.code) { s.itemCode = s.code;   changed = true; }
      if (!s.itemName && s.name) { s.itemName = s.name;   changed = true; }
      if (!s.buyPrice && s.buyPrice !== 0) {
        s.buyPrice = s.buy || 0; changed = true;
      }
      if (!s.sellPrice && s.sellPrice !== 0) {
        s.sellPrice = s.sell || s.price || 0; changed = true;
      }
      if (changed) { await dbPut('sales', s); sFixed++; }
    }
    console.log(`[MIGRATE v9] sales: ${sFixed} updated`);

    // ── 4. business_days: normalize to camelCase ───────────────────
    const bdays = await dbAll('business_days');
    let bdFixed = 0;
    for (const bd of bdays) {
      let changed = false;
      // business_date → businessDate
      if (bd.business_date && !bd.businessDate) {
        bd.businessDate = bd.business_date;
        // Keep business_date for backward-compat index — it still has that index
        changed = true;
      }
      // opened_at → openedAt
      if (bd.opened_at && !bd.openedAt) { bd.openedAt = bd.opened_at; changed = true; }
      if (bd.closed_at && !bd.closedAt) { bd.closedAt = bd.closed_at; changed = true; }
      if (bd.reopened_count != null && bd.reopenedCount == null) {
        bd.reopenedCount = bd.reopened_count; changed = true;
      }
      if (changed) { await dbPut('business_days', bd); bdFixed++; }
    }
    console.log(`[MIGRATE v9] business_days: ${bdFixed} updated`);

    // ── 5. finances: ensure required fields ────────────────────────
    const finances = await dbAll('finances');
    let fFixed = 0;
    for (const f of finances) {
      let changed = false;
      if (!f.createdAt) { f.createdAt = new Date().toISOString(); changed = true; }
      if (!f.category)  { f.category  = 'other'; changed = true; }
      if (!f.currency)  { f.currency  = localStorage.getItem(KEY_CURRENCY) || 'KES'; changed = true; }
      if (changed) { await dbPut('finances', f); fFixed++; }
    }
    console.log(`[MIGRATE v9] finances: ${fFixed} updated`);

    console.log('[MIGRATE v9] Complete ✅');
  } catch(e) {
    console.warn('[MIGRATE v9] Error:', e.message);
  }
}


// ===== STATE =====
let types = [];
let allItems = [];
let activeTypeFilter = 'all';
let selectedEmoji = '📦';
let currency = localStorage.getItem('inv_currency') || 'KES';
let currentDetailId = null;

// ===== HELPERS =====
function fmtN(n) { return Number(n || 0).toLocaleString(); }

// ── Core utilities ─────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function sanitiseCode(raw) {
  return (raw || '').trim().toUpperCase().replace(/[^A-Z0-9\-.]/g, '');
}

function fmt(n) {
  const cur = (typeof currency !== 'undefined' ? currency : 'KES');
  const val = parseFloat(n) || 0;
  return cur + ' ' + val.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function toast(msg, type = '') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show ' + (type || '');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => { t.className = 'toast'; }, 2800);
}
function getTypeObj(name) { return types.find(t => t.name === name) || { name, emoji: '📦', color: '#334155' }; }

// ===== PAGES =====
let _operationsMounted = false;
let _activeOperationsTab = 'day';
let _inventoryMounted = false;
let _activeInventoryTab = 'stock';

function mountInventoryPage() {
  if (_inventoryMounted) return;
  const stockSlot = document.getElementById('inventory-stock-slot');
  const wishSlot = document.getElementById('inventory-wishlist-slot');
  const addSlot = document.getElementById('inventory-add-slot');
  const stockPage = document.getElementById('page-list');
  const wishPage = document.getElementById('page-wishlist');
  const addPage = document.getElementById('page-add');
  if (!stockSlot || !wishSlot || !addSlot || !stockPage || !wishPage || !addPage) return;

  [stockPage, wishPage, addPage].forEach(page => {
    page.classList.remove('page', 'active');
    page.classList.add('inv-module');
  });
  stockSlot.appendChild(stockPage);
  wishSlot.appendChild(wishPage);
  addSlot.appendChild(addPage);
  _inventoryMounted = true;
}

function showInventoryTab(tab) {
  const allowed = ['stock', 'wishlist', 'monitor', 'add'];
  _activeInventoryTab = allowed.includes(tab) ? tab : 'stock';
  mountInventoryPage();
  allowed.forEach(name => {
    const btn = document.getElementById('inventory-tab-' + name);
    const slot = document.getElementById('inventory-' + name + '-slot');
    if (btn) btn.classList.toggle('active', name === _activeInventoryTab);
    if (slot) slot.classList.toggle('active', name === _activeInventoryTab);
  });
  const sub = document.getElementById('inventory-sub');
  if (sub) {
    sub.textContent = {
      stock: 'Current stock list',
      wishlist: 'Prospective items to stock',
      monitor: 'Out of stock and not accounted items',
      add: 'Add or restock inventory'
    }[_activeInventoryTab] || '';
  }
  if (_activeInventoryTab === 'stock') renderList();
  if (_activeInventoryTab === 'wishlist') renderWishlistPage();
  if (_activeInventoryTab === 'monitor') renderStockMonitor();
  if (_activeInventoryTab === 'add') {
    renderTypeSelect();
    updateProfitPreview();
  }
}

function mountOperationsPage() {
  if (_operationsMounted) return;
  const daySlot = document.getElementById('ops-day-slot');
  const finSlot = document.getElementById('ops-finance-slot');
  const dayPage = document.getElementById('page-day');
  const finPage = document.getElementById('page-finance');
  if (!daySlot || !finSlot || !dayPage || !finPage) return;

  dayPage.classList.remove('page', 'active');
  finPage.classList.remove('page', 'active');
  dayPage.classList.add('op-module');
  finPage.classList.add('op-module');
  daySlot.appendChild(dayPage);
  finSlot.appendChild(finPage);
  _operationsMounted = true;
}

function showOperationsTab(tab) {
  _activeOperationsTab = tab === 'finance' ? 'finance' : 'day';
  mountOperationsPage();
  ['day', 'finance'].forEach(name => {
    const btn = document.getElementById('ops-tab-' + name);
    const slot = document.getElementById('ops-' + name + '-slot');
    if (btn) btn.classList.toggle('active', name === _activeOperationsTab);
    if (slot) slot.classList.toggle('active', name === _activeOperationsTab);
  });
  if (_activeOperationsTab === 'day') {
    updateDayLiveStats();
    renderDaySessionsList();
    renderDayState();
  } else {
    renderFinancePage();
  }
}

function showPage(id) {
  if (id === 'list' || id === 'wishlist' || id === 'add' || id === 'monitor') {
    _activeInventoryTab = id === 'list' ? 'stock' : id;
    id = 'inventory';
  }
  if (id === 'day' || id === 'finance') {
    _activeOperationsTab = id;
    id = 'operations';
  }
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const pageEl = document.getElementById('page-' + id);
  if (pageEl) pageEl.classList.add('active');
  const tabEl = document.getElementById('tab-' + id);
  if (tabEl) tabEl.classList.add('active');
  if (id === 'dash') renderDashboard();
  if (id === 'inventory') showInventoryTab(_activeInventoryTab);
  if (id === 'operations') showOperationsTab(_activeOperationsTab);
  if (id === 'day') { updateDayLiveStats(); renderDaySessionsList(); renderDayState(); }
  if (id === 'sell') { renderSellPage(); setTimeout(()=>document.getElementById('sell-search').focus(),150); }
  if (id === 'history') { renderHistoryPage(); }
  if (id === 'finance')  { renderFinancePage(); }
}

// Guard: wrap showPage to enforce tab access by role
// Defined immediately after showPage so _origShowPage is available at startup
const _origShowPage = showPage;
showPage = function(id) {
  const requestedId = id;
  const allowedId = (id === 'list' || id === 'wishlist' || id === 'add' || id === 'monitor') ? 'inventory' : id;
  if (currentUser && !currentUser.tabs.includes(allowedId) && !currentUser.tabs.includes(requestedId)) {
    toast('⛔ Access denied', 'err');
    return;
  }
  if (currentUser) localStorage.setItem(KEY_LAST_PAGE, allowedId);
  _origShowPage(id);
};

// ===== TYPES =====
const DEFAULT_TYPES = [
  { name: 'Footwear', emoji: '👟', color: '#1e3a5f' },
  { name: 'Clothes', emoji: '👕', color: '#2d1b4e' },
  { name: 'Plastics', emoji: '🪣', color: '#1a3a2a' },
  { name: 'Gas', emoji: '⛽', color: '#1e7a3e' },
  { name: 'Electronics', emoji: '📱', color: '#1e2a3a' },
  { name: 'Food', emoji: '🍱', color: '#3a2a1a' },
  { name: 'Cosmetics', emoji: '💄', color: '#3a1a2a' },
  { name: 'General', emoji: '📦', color: '#1e293b' },
];

async function loadTypes() {
  try {
  types = await dbAll('types');
  if (types.length === 0) {
    for (const t of DEFAULT_TYPES) await dbAdd('types', t);
    types = await dbAll('types');
  }
  if (!types.some(t => isFootwearType(t.name))) {
    await dbAdd('types', DEFAULT_TYPES[0]);
    types = await dbAll('types');
  }
  if (!types.some(t => (t.name || '').toLowerCase() === 'gas')) {
    const gasType = DEFAULT_TYPES.find(t => t.name === 'Gas');
    if (gasType) {
      await dbAdd('types', gasType);
      types = await dbAll('types');
    }
  }
  renderTypeSelect();
  renderTypeChips();
  } catch(e) { console.error("[loadTypes]", e); toast("Error: " + e.message, "err"); }
}

function renderTypeSelect() {
  const sel = UI.el('f-type');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select type —</option>' +
    types.map(t => `<option value="${t.name}" ${t.name === cur ? 'selected' : ''}>${t.emoji} ${t.name}</option>`).join('');
}

function renderTypeChips() {
  const chips = document.getElementById('type-chips');
  chips.innerHTML = `<span class="chip ${activeTypeFilter === 'all' ? 'active' : ''}" onclick="setTypeFilter('all', this)">All</span>` +
    types.map(t => `<span class="chip ${activeTypeFilter === t.name ? 'active' : ''}" onclick="setTypeFilter('${t.name}', this)">${t.emoji} ${t.name}</span>`).join('');
}

function setTypeFilter(name, el) {
  activeTypeFilter = name;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  renderList();
}

async function renderTypes() {
  try {
  types = await dbAll('types');
  renderTypeSelect();
  const list = document.getElementById('types-list');
  if (!types.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px;">No types yet</div>'; return; }
  list.innerHTML = types.map(t => `
    <div class="type-row">
      <div class="type-name"><span>${t.emoji}</span>${t.name}</div>
      <button class="type-del" onclick="deleteType(${t.id})">✕</button>
    </div>`).join('');
  } catch(e) { console.error("[renderTypes]", e); toast("Error: " + e.message, "err"); }
}

function pickEmoji(el) {
  document.querySelectorAll('.ep').forEach(e => e.classList.remove('sel'));
  el.classList.add('sel');
  selectedEmoji = el.dataset.e;
}

async function addType() {
  try {
  const name = document.getElementById('new-type-name').value.trim();
  if (!name) { toast('Enter a type name', 'err'); return; }
  if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Type already exists', 'err'); return; }
  await dbAdd('types', { name, emoji: selectedEmoji, color: '#1e293b' });
  document.getElementById('new-type-name').value = '';
  await loadTypes();
  renderTypes();
  toast('✅ Type added!', 'ok');
  } catch(e) { console.error("[addType]", e); toast("Error: " + e.message, "err"); }
}

async function deleteType(id) {
  try {
  const allItems = await dbAll('items');
  const typeObj = types.find(t => t.id === id);
  const inUse = allItems.filter(i => i.type === (typeObj ? typeObj.name : '')).length;
  let msg = 'Delete type "' + (typeObj ? typeObj.name : 'this type') + '"?';
  if (inUse > 0) msg += '\n\n⚠️ ' + inUse + ' item(s) use this type. They will keep showing but the type filter will not work.';
  if (!confirm(msg)) return;
  await dbDelete('types', id);
  await loadTypes();
  renderTypes();
  } catch(e) { console.error("[deleteType]", e); toast("Error: " + e.message, "err"); }
}

// ===== PROFIT PREVIEW =====
function updateProfitPreview() {
  const buy  = parseFloat(UI.el('f-buy').value)  || 0;
  const sell = parseFloat(UI.el('f-sell').value) || 0;
  const qty  = parseInt(UI.el('f-qty').value)    || 0;
  const preview = UI.el('profit-preview');
  if (!preview) return;

  if (buy > 0 && sell > 0) {
    const profit = sell - buy;
    const margin = sell > 0 ? ((profit / sell) * 100).toFixed(1) : 0;
    const profitColor = profit >= 0 ? 'var(--green)' : 'var(--red)';

    // Compact pill values
    const ppProfit = document.getElementById('pp-profit');
    const ppMargin = document.getElementById('pp-margin');
    const ppTotal  = document.getElementById('pp-total');
    const ppTotalRow = document.getElementById('pp-total-row');

    if (ppProfit) { ppProfit.textContent = (profit >= 0 ? '+' : '') + fmt(profit); ppProfit.style.color = profitColor; }
    if (ppMargin) { ppMargin.textContent = margin + '%'; ppMargin.style.color = profit >= 0 ? 'var(--accent)' : 'var(--red)'; }

    if (qty > 0) {
      if (ppTotal)    { ppTotal.textContent = (profit >= 0 ? '+' : '') + fmt(profit * qty); ppTotal.style.color = profitColor; }
      if (ppTotalRow) ppTotalRow.style.display = '';
    } else {
      if (ppTotalRow) ppTotalRow.style.display = 'none';
    }

    // Hidden fields kept for compatibility
    const ppBuy  = document.getElementById('pp-buy');
    const ppSell = document.getElementById('pp-sell');
    if (ppBuy)  ppBuy.textContent  = fmt(buy);
    if (ppSell) ppSell.textContent = fmt(sell);

    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}


// ===== ITEM PHOTO MANAGEMENT =====
function getItemPhoto(itemId) {
  return localStorage.getItem('item_photo_' + itemId) || null;
}
function setItemPhoto(itemId, dataUrl) {
  try {
    localStorage.setItem('item_photo_' + itemId, dataUrl);
  } catch(e) {
    // localStorage full — remove and retry
    toast('⚠️ Storage full, photo not saved', 'err');
  }
}
function removeItemPhoto(itemId) {
  localStorage.removeItem('item_photo_' + itemId);
}

function triggerPhotoUpload(itemId, event) {
  event.stopPropagation();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment'; // opens camera on mobile
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    // Compress to max 400px wide
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 600;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', 0.72);
        setItemPhoto(itemId, compressed);
        renderList();
        toast('📸 Photo saved!', 'ok');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

// ===== ADD FORM PHOTO =====
let _addFormPhotoData = null;

function triggerAddPhotoUpload() {
  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center;';
  menu.innerHTML = '<div style="background:var(--surface);border-radius:20px 20px 0 0;width:100%;max-width:520px;padding:20px 18px 32px;">'
    + '<div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:16px;text-align:center;">Add Item Photo</div>'
    + '<button onclick="this.closest(\'[style*=fixed]\').remove();_doAddPhoto(\'camera\')" style="width:100%;padding:16px;background:var(--accent);color:white;border:none;border-radius:var(--r);font-size:16px;font-weight:700;cursor:pointer;font-family:var(--sans);margin-bottom:10px;">📸 Take Photo</button>'
    + '<button onclick="this.closest(\'[style*=fixed]\').remove();_doAddPhoto(\'gallery\')" style="width:100%;padding:16px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--r);font-size:16px;font-weight:700;cursor:pointer;font-family:var(--sans);margin-bottom:10px;">🖼️ Choose from Gallery</button>'
    + '<button onclick="this.closest(\'[style*=fixed]\').remove()" style="width:100%;padding:13px;background:transparent;color:var(--muted);border:none;font-size:15px;cursor:pointer;font-family:var(--sans);">Cancel</button>'
    + '</div>';
  document.body.appendChild(menu);
}

function _doAddPhoto(source) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (source === 'camera') input.capture = 'environment';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 800;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        _addFormPhotoData = canvas.toDataURL('image/jpeg', 0.75);
        const photoImg = document.getElementById('add-photo-img');
        const placeholder = document.getElementById('add-photo-placeholder');
        const removeBtn = document.getElementById('add-photo-remove');
        if (photoImg) { photoImg.src = _addFormPhotoData; photoImg.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
        if (removeBtn) removeBtn.style.display = 'block';
        toast('📸 Photo ready!', 'ok');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

function removeAddPhoto(event) {
  event.stopPropagation();
  _addFormPhotoData = null;
  const photoImg = document.getElementById('add-photo-img');
  const placeholder = document.getElementById('add-photo-placeholder');
  const removeBtn = document.getElementById('add-photo-remove');
  if (photoImg) { photoImg.src = ''; photoImg.style.display = 'none'; }
  if (placeholder) placeholder.style.display = 'flex';
  if (removeBtn) removeBtn.style.display = 'none';
}

function clearAddFormPhoto() {
  _addFormPhotoData = null;
  const el = document.getElementById('add-photo-img');
  const ph = document.getElementById('add-photo-placeholder');
  const rb = document.getElementById('add-photo-remove');
  if (el) { el.src = ''; el.style.display = 'none'; }
  if (ph) ph.style.display = 'flex';
  if (rb) rb.style.display = 'none';
}

// ===== SAVE ITEM =====
// Legacy shims — delegates to _overlay singleton
function showSaving(label) {
  const overlay = document.getElementById('saving-overlay');
  const arc     = document.getElementById('saving-arc');
  const lbl     = document.getElementById('saving-label');
  const btn     = UI.el('save-btn');
  if (!overlay) return;

  // Gray out save button
  if (btn) { btn.disabled = true; btn.style.opacity = '0.45'; btn.style.pointerEvents = 'none'; }

  // Reset arc
  const circumference = 213.6;
  if (arc) { arc.style.strokeDashoffset = circumference; }
  if (lbl) lbl.textContent = label || 'Saving…';

  overlay.style.display = 'flex';

  // Animate arc 0 → 85% over ~1.5s (final 15% completes on hideSaving)
  let progress = 0;
  const target = 85;
  const steps  = 30;
  const stepSize = target / steps;
  clearInterval(_savingTimer);
  _savingTimer = setInterval(() => {
    progress = Math.min(progress + stepSize, target);
    if (arc) arc.style.strokeDashoffset = circumference * (1 - progress / 100);
    if (progress >= target) clearInterval(_savingTimer);
  }, 50);
}

function hideSaving() {
  clearInterval(_savingTimer);

  const overlay = document.getElementById('saving-overlay');
  const arc     = document.getElementById('saving-arc');
  const btn     = UI.el('save-btn');

  // Snap arc to 100%
  if (arc) arc.style.strokeDashoffset = 0;

  // Re-enable button IMMEDIATELY so user can retry on validation fail
  if (btn) {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }

  // Hide overlay after short pause so user sees the complete circle
  setTimeout(() => {
    if (overlay) overlay.style.display = 'none';
  }, 350);
}

async function saveItem() {
  _overlay.show('Saving…');
  try {
    // Use hidden input; fall back to JS variable if input got cleared unexpectedly
    const editIdRaw = UI.el('edit-id')?.value || (_editingItemId ? String(_editingItemId) : '');

    // SHOE SIZE EDIT
    // SHOE SIZE RESTOCK — adds qty to existing, never replaces
    if (editIdRaw && editIdRaw.startsWith('shoe_restock_')) {
      const parts = editIdRaw.replace('shoe_restock_','').split('_');
      const itemId = parseInt(parts[0]); const size = parseInt(parts[1]);
      const item = await dbGet('items', itemId);
      const allSz = await getShoeSizes(item ? item.code : '');
      const sizeRec = allSz.find(s => s.size === size);
      if (!sizeRec) { toast('Size record not found', 'err'); return; }
      const addQty = parseInt(UI.el('f-qty')?.value);
      if (isNaN(addQty) || addQty <= 0) { toast('\u26a0\ufe0f Enter quantity to add', 'err'); return; }
      const buy = parseFloat(UI.el('f-buy')?.value);
      const sell = parseFloat(UI.el('f-sell')?.value);
      const nextBuy = !isNaN(buy) ? buy : (sizeRec.buyPrice || item?.buyPrice || item?.buy || 0);
      const nextSell = !isNaN(sell) ? sell : (sizeRec.sellPrice || item?.sellPrice || item?.sell || 0);
      if (!Validate.price(nextBuy, nextSell, 'f-buy', 'f-sell')) return;
      const newQty = (sizeRec.qty || 0) + addQty;
      if (newQty > 999999) { toast('\u26a0\ufe0f Exceeds max 999,999', 'err'); return; }
      sizeRec.qty = newQty;
      sizeRec.buyPrice = nextBuy;
      sizeRec.sellPrice = nextSell;
      sizeRec.profit = nextSell - nextBuy;
      sizeRec.updatedAt = new Date().toISOString();
      await dbPut('shoe_sizes', sizeRec);
      if (item) {
        const updSz = await getShoeSizes(item.code);
        item.qty = updSz.reduce((t, s) => t + s.qty, 0);
        item.buyPrice = nextBuy;
        item.sellPrice = nextSell;
        item.profit = nextSell - nextBuy;
        item.updatedAt = new Date().toISOString();
        item.updatedBy = currentUser ? currentUser.username : 'system';
        await dbPut('items', item); fbSyncItem(item);
      }
      await recordStockInvestment(item || sizeRec, addQty * nextBuy, addQty, 'Shoe restock');
      // Sync shoe size to Firebase
      if (fbReady && fbDb) {
        try {
          const { doc, setDoc } = await waitForFbImports();
          if (!sizeRec.fbId) sizeRec.fbId = 'sz_' + sizeRec.codeSize;
          await setDoc(doc(fbDb, 'shoe_sizes', sizeRec.fbId), sanitiseForFirestore({...sizeRec}));
        } catch(e) { console.warn('[SYNC] shoe restock:', e.message); }
      }
      clearForm();
      allItems = await dbAll('items'); await enrichShoeItems(allItems);
      renderList(); renderDashboard(); updateHeader(); scheduleSync();
      toast('\U0001f4e6 Size ' + size + ': +' + addQty + ' → ' + newQty, 'ok');
      showPage('list'); return;
    }

    if (editIdRaw && editIdRaw.startsWith('shoe_edit_')) {
      const parts=editIdRaw.replace('shoe_edit_','').split('_');
      const itemId=parseInt(parts[0]); const size=parseInt(parts[1]);
      const item=await dbGet('items',itemId);
      const allSz=await getShoeSizes(item?item.code:'');
      const sizeRec=allSz.find(s=>s.size===size);
      if(!sizeRec){toast('Size record not found','err');return;}
      const qty=parseInt(UI.el('f-qty')?.value);
      const buy=parseFloat(UI.el('f-buy')?.value)||sizeRec.buyPrice||0;
      const sell=parseFloat(UI.el('f-sell')?.value)||sizeRec.sellPrice||0;
      if (isNaN(qty) || qty < 0) return Validate.fail('Enter a valid quantity (0 or more)', 'f-qty');
      if (!Validate.price(buy, sell, 'f-buy', 'f-sell')) return;
      sizeRec.qty=qty;sizeRec.buyPrice=buy;sizeRec.sellPrice=sell;
      sizeRec.profit=sell-buy;sizeRec.updatedAt=new Date().toISOString();
      await dbPut('shoe_sizes',sizeRec);
      if(item){
        const updSz=await getShoeSizes(item.code);
        item.qty=updSz.reduce((t,s)=>t+s.qty,0);
        item.buyPrice=buy;item.sellPrice=sell;
        item.updatedAt=new Date().toISOString();
        item.updatedBy=currentUser?currentUser.username:'system';
        await dbPut('items',item);fbSyncItem(item);
      }
      ['f-code','f-type','f-name','f-size'].forEach(id=>{const el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='';el.style.cursor='';}});
      const banner=document.getElementById('restock-mode-banner');if(banner)banner.style.display='none';
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('\u2705 Size '+size+' updated \u00b7 '+qty+' pairs \u00b7 '+fmt(sell),'ok');
      showPage('list');return;
    }

    // RESTOCK MODE
    if(editIdRaw&&editIdRaw.startsWith('restock_')){
      const existing=await dbGet('items',parseInt(editIdRaw.replace('restock_','')));
      if(!existing){toast('\u26a0\ufe0f Item not found','err');exitRestockMode();return;}
      const qtyEl=UI.el('f-qty');
      const addQty=parseInt(qtyEl?qtyEl.value.trim():'0');
      if(!addQty||addQty<=0){toast('\u26a0\ufe0f Enter quantity to add','err');if(qtyEl)qtyEl.focus();return;}
      if(addQty>CODE_MAX_QTY&&!confirm('Adding '+addQty+' units — confirm?'))return;
      const newQty=existing.qty+addQty;
      if(newQty>999999){toast('\u26a0\ufe0f Exceeds max 999,999','err');return;}
      existing.qty=newQty;existing.updatedAt=new Date().toISOString();
      await dbPut('items',existing);fbSyncItem(existing);
      await recordStockInvestment(existing, addQty * (existing.buyPrice || existing.buy || 0), addQty, 'Restock');
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      exitRestockMode();
      toast('\U0001f4e6 '+existing.code+': +'+addQty+' → '+newQty,'ok');return;
    }

    // COMMON FIELDS
    const type=UI.el('f-type')?.value||'';
    const code=sanitiseCode(UI.el('f-code')?.value||'');
    const name=(UI.el('f-name')?.value||'').trim().replace(/[ \t]+/g,' ')||(type+' '+code);
    if(!type){toast('\u26a0\ufe0f Select an item type','err');return;}
    if(!code){toast('\u26a0\ufe0f Enter item code','err');return;}
    if (!editIdRaw) {
      const codeMatches = await findCodeMatchesForSave(code);
      if (codeMatches.some(i => i.code === code)) {
        showCodeDropdown(codeMatches, code);
        toast('\u26a0\ufe0f Item code already exists — select it from the dropdown', 'err');
        UI.el('f-code')?.focus();
        return;
      }
    }

    // SHOE MODE
    if(isFootwearType(type)&&!editIdRaw){
      const savedCount=await saveShoeItems(code,name,type);
      if(!savedCount)return;
      clearForm();clearAddFormPhoto();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('\u2705 '+savedCount+' shoe size(s) saved!','ok');return;
    }

    // STANDARD ADD / EDIT
    const size=UI.el('f-size')?.value.trim()||'';
    const qtyRaw=UI.el('f-qty')?.value||'';
    const qty=parseInt(qtyRaw);
    const buy=parseFloat(UI.el('f-buy')?.value)||0;
    const sell=parseFloat(UI.el('f-sell')?.value)||0;
    if (!size) return Validate.fail('Enter a size or variant (e.g. N/A, Medium, 42)', 'f-size');
    if (qtyRaw === '' || isNaN(qty)) return Validate.fail('Enter a quantity', 'f-qty');
    if (!editIdRaw) {
      // New item: qty must be ≥ 1
      if (!Validate.qty(qty, 'f-qty')) return;
    } else {
      // Edit: qty can be 0 (stock may be legitimately depleted via sales)
      if (qty < 0) return Validate.fail('Quantity cannot be negative', 'f-qty');
    }
    if (qty > CODE_MAX_QTY && !confirm('Adding ' + qty + ' units — confirm?')) return;
    if (!Validate.price(buy, sell, 'f-buy', 'f-sell')) return;
    const profit=sell-buy;
    const item={type,code,name,variant:size,buyPrice:buy,sellPrice:sell,profit,qty,createdAt:new Date().toISOString()};

    if(editIdRaw){
      const resolvedId = parseInt(editIdRaw);
      if (!resolvedId || isNaN(resolvedId)) { toast('⚠️ Cannot save: item ID missing', 'err'); return; }
      const original=await dbGet('items', resolvedId);
      // Merge: start from original to preserve all fields (isShoe, photo refs, etc)
      // then overwrite only what the form controls
      const saved = Object.assign({}, original || {}, {
        id:        resolvedId,
        type, code, name,
        variant:   size,
        buyPrice:  buy,
        sellPrice: sell,
        profit,
        qty,
        createdAt: original ? (original.createdAt || item.createdAt) : item.createdAt,
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser ? currentUser.username : 'system',
        fbId:      original ? original.fbId : undefined,
      });
      await dbPut('items', saved);
      if(_addFormPhotoData)setItemPhoto(saved.id,_addFormPhotoData);
      fbSyncItem(saved);
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('\u2705 Item updated!','ok');showPage('list');
    }else{
      const newId=await dbAdd('items',item);item.id=newId;
      if(_addFormPhotoData)setItemPhoto(newId,_addFormPhotoData);
      await recordStockInvestment(item, qty * buy, qty, 'New stock');
      await markWishlistStockedForItem(item);
      fbSyncItem(item);
      clearForm();clearAddFormPhoto();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      showPage('list');
      showSplash(name,sell,profit);
    }

  }catch(err){
    if(err.name==='ConstraintError'){
      toast('\u26a0\ufe0f Code already exists — select from dropdown to restock','err');
    }else{
      toast('\u26a0\ufe0f Save failed: '+(err.message||'Unknown error'),'err');
      console.error('[SAVE]',err);
    }
  }finally{
    _overlay.hide();
  }
}

function clearForm() {
  UI.el('edit-id').value   = '';
  _editingItemId = null;  // clear JS-side edit tracker
  UI.el('f-type').value    = '';
  UI.el('f-code').value    = '';
  UI.el('f-name').value    = '';
  UI.el('f-size').value    = '';
  UI.el('f-qty').value     = '';
  UI.el('f-buy').value     = '';
  UI.el('f-sell').value    = '';
  const pp = UI.el('profit-preview');
  if (pp) pp.style.display = 'none';
  const sb = UI.el('save-btn');
  if (sb) sb.textContent = '+ Add to Inventory';
  const ml = UI.el('form-mode-label');
  if (ml) ml.textContent = 'New Item';
  const ce = UI.el('cancel-edit-btn');
  if (ce) ce.style.display = 'none';

  // Re-enable any locked fields
  ['f-code','f-type','f-name','f-size','f-qty','f-buy','f-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; }
  });

  // Reset shoe state
  _shoeState.reset(); // ShoeState class handles all shoe form state

  // Reset mode tabs to default (shared)
  const modeShared  = document.getElementById('mode-tab-shared');
  const modePerSize = document.getElementById('mode-tab-persize');
  if (modeShared)  modeShared.classList.add('active');
  if (modePerSize) modePerSize.classList.remove('active');
  const shoePanel  = UI.el('shoe-size-panel');
  const stdPricing = UI.el('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  if (shoePanel)  shoePanel.style.display  = 'none';
  if (stdPricing) stdPricing.style.display = 'block';
  if (sizeField)  sizeField.style.display  = 'block';
  const szGrid  = UI.el('shoe-sizes-grid');
  const szWrap  = UI.el('shoe-rows-wrap');
  const szInner = UI.el('sz-grid');
  if (szGrid)  szGrid.style.display  = 'none';
  if (szWrap)  szWrap.style.display  = 'none';
  if (szInner) szInner.innerHTML = '';
  const sum = UI.el('shoe-selected-summary');
  if (sum) sum.innerHTML = '';
  ['shoe-shared-qty','shoe-shared-buy','shoe-shared-sell'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });

  // Hide restock banner
  const banner = document.getElementById('restock-mode-banner');
  if (banner) banner.style.display = 'none';

  clearCodeMatchSelect();
  hideCodeDropdown();
}

// Code autocomplete helpers
let _codeDropdownActive = false;
let _editOriginItemId   = null;
let _editingItemId      = null;  // tracks current edit ID reliably (backup to hidden input)
let _selectedShoeSize   = null;
let _selectedShoeSizes  = new Set();
let _bulkShoeRestock    = null;

async function findCodeMatchesForSave(code) {
  const clean = sanitiseCode(code);
  if (!clean) return [];
  const source = (allItems && allItems.length) ? allItems : await dbAll('items');
  const seen = new Set();
  const unique = [];
  for (const item of source) {
    if (!item.code || seen.has(item.code)) continue;
    seen.add(item.code);
    unique.push(item);
  }
  const exact = unique.filter(i => i.code === clean);
  const startsWith = unique.filter(i => i.code !== clean && i.code.startsWith(clean));
  const contains = unique.filter(i => i.code !== clean && !i.code.startsWith(clean) && i.code.includes(clean));
  const nameMatch = unique.filter(i =>
    i.name &&
    i.name.toUpperCase().includes(clean) &&
    !exact.includes(i) &&
    !startsWith.includes(i) &&
    !contains.includes(i)
  );
  return [...exact, ...startsWith, ...contains, ...nameMatch].slice(0, 10);
}

async function onCodeInput() {
  const raw   = UI.el('f-code').value;
  const clean = sanitiseCode(raw);
  UI.el('f-code').value = clean;
  if (!clean) { clearCodeMatchSelect(); hideCodeDropdown(); return; }
  const source = (allItems && allItems.length) ? allItems : await dbAll('items');

  // De-duplicate by code then search: exact → startsWith → contains
  const seen = new Set();
  const unique = [];
  for (const item of source) {
    if (!item.code || seen.has(item.code)) continue;
    seen.add(item.code);
    unique.push(item);
  }
  const exact      = unique.filter(i => i.code === clean);
  const startsWith = unique.filter(i => i.code !== clean && i.code.startsWith(clean));
  const contains   = unique.filter(i => i.code !== clean && !i.code.startsWith(clean) && i.code.includes(clean));
  const nameMatch  = unique.filter(i => !seen.has('NAME_'+i.code) && i.name && i.name.toUpperCase().includes(clean) && !exact.includes(i) && !startsWith.includes(i) && !contains.includes(i));
  const matches    = [...exact, ...startsWith, ...contains, ...nameMatch].slice(0, 10);

  if (!matches.length) { clearCodeMatchSelect('No match'); hideCodeDropdown(); return; }
  showCodeDropdown(matches, clean);
}

function showCodeDropdown(items, typedCode) {
  const select = document.getElementById('code-match-select');
  if (select) {
    select.onchange = () => selectExistingItemFromDropdown(select.value);
    select.disabled = !items.length;
    select.style.opacity = items.length ? '1' : '0.55';
    select.style.cursor = items.length ? 'pointer' : 'not-allowed';
    select.innerHTML = '<option value="">Select code</option>' +
      items.map(item => '<option value="' + item.id + '">' + escapeHtml(item.code) + '</option>').join('');
    hideCodeDropdown();
    return;
  }

  let dd = document.getElementById('code-dropdown');
  if (!dd) {
    dd = document.createElement('div');
    dd.id = 'code-dropdown';
    dd.className = 'code-dd';
    const cf = UI.el('f-code');
    if (cf) cf.parentNode.appendChild(dd);
  }
  dd.innerHTML = items.map(item => {
    const isExact = item.code === typedCode;
    return `<div class="code-dd-item${isExact?' code-dd-exact':''}" onclick="selectExistingItem(${item.id})">
      <div class="code-dd-code">${escapeHtml(item.code)}</div>
    </div>`;
  }).join('');
  dd.style.display = 'block';
}

function hideCodeDropdown() {
  const dd = document.getElementById('code-dropdown');
  if (dd) dd.style.display = 'none';
}

function clearCodeMatchSelect(label = 'Code match') {
  const select = document.getElementById('code-match-select');
  if (!select) return;
  select.innerHTML = '<option value="">' + escapeHtml(label) + '</option>';
  select.value = '';
  select.disabled = true;
  select.style.opacity = '0.55';
  select.style.cursor = 'not-allowed';
}

function selectExistingItemFromDropdown(value) {
  const id = parseInt(value);
  if (!id) return;
  selectExistingItem(id);
}

async function selectExistingItem(itemId) {
  try {
    const item = await dbGet('items', itemId);
    if (!item) { toast('⚠️ Item not found', 'err'); hideCodeDropdown(); return; }
    hideCodeDropdown();

    // If on the Add page: open the item's detail sheet directly
    // This lets the user see, restock, edit or sell without creating a duplicate
    showPage('list');
    setTimeout(async () => {
      await openSheet(itemId);
    }, 80);

  } catch(e) { console.error("[selectExistingItem]", e); toast("Error: " + e.message, "err"); }
}

function exitRestockMode() {
  _codeDropdownActive = false;
  clearForm();
}

async function recordStockInvestment(item, amount, qty, sourceLabel) {
  const value = parseFloat(amount) || 0;
  if (value <= 0) return null;
  const entry = {
    type: 'stock_purchase',
    amount: value,
    description: (sourceLabel || 'Stock added') + ': ' + (item.name || item.code || 'Item') +
      (qty ? ' x ' + qty : ''),
    category: 'stock',
    itemCode: item.code || '',
    qty: qty || 0,
    date: todayDateStr(),
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : 'system',
    auto: true,
  };
  entry.id = await dbAdd('finances', entry);
  return entry;
}


function cancelEdit() { clearForm(); clearAddFormPhoto(); showPage('list'); }

// ===== RENDER LIST =====
async function renderList() {
  allItems = await dbAll('items');
  const search = (UI.el('search')?.value || '').toLowerCase();
  renderTypeChips();
  _renderSizeGroupFilter();

  // Filter non-shoe items normally
  let filtered = allItems.filter(item => {
    const q = search;
    const matchSearch = !q ||
      (item.name || '').toLowerCase().includes(q) ||
      (item.code || '').toLowerCase().includes(q) ||
      (item.variant || item.size || '').toLowerCase().includes(q) ||
      (item.type || '').toLowerCase().includes(q);
    const matchType = activeTypeFilter === 'all' || item.type === activeTypeFilter;
    return matchSearch && matchType;
  }).sort((a, b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));

  updateHeader();

  const list = UI.el('item-list');
  if (!list) return;

  if (!filtered.length) {
    list.style.border = 'none';
    list.innerHTML = `<div class="empty">
      <div class="e-icon">${allItems.length ? '🔍' : '📦'}</div>
      <p>${allItems.length ? 'No items match your search.' : 'No items yet.\nTap ➕ Add Item to get started.'}</p>
    </div>`;
    renderStockMonitorSummary();
    return;
  }

  // Sales index for profit display
  const allSales    = await dbAll('sales');
  const salesByItem = {};
  const salesBySize = {}; // for shoe sizes: key = "CODE_size"
  allSales.forEach(s => {
    if (!salesByItem[s.itemId]) salesByItem[s.itemId] = { qty: 0 };
    salesByItem[s.itemId].qty += (s.qty || 1);
    if (s.itemCode && (s.itemSize || s.size)) {
      const k = s.itemCode + '_' + (s.itemSize || s.size);
      if (!salesBySize[k]) salesBySize[k] = 0;
      salesBySize[k] += (s.qty || 1);
    }
  });

  // Load all shoe sizes once
  const allSizes = await dbAll('shoe_sizes');

  const cards = [];

  for (const item of filtered) {
    const t = getTypeObj(item.type);

    if (item.isShoe) {
      // ── SHOE ITEM — one card per SIZE ─────────────────────────────
      const sizes = allSizes
        .filter(s => s.itemCode === item.code)
        .sort((a, b) => a.size - b.size);

      if (!sizes.length) {
        // Shoe parent with no sizes yet — show placeholder
        cards.push(`
          <div class="item-card item-card-shoe-header" onclick="openSheet(${item.id})">
            <div class="item-top">
              <div class="item-icon" style="background:${t.color || 'var(--surface2)'};">${t.emoji}</div>
              <div class="item-body">
                <div class="item-code">${escapeHtml(item.code)}</div>
                <div class="item-name">${escapeHtml(item.name || '')}</div>
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
      const groupTotalPcs  = sizes.reduce((s,sz)=>s+(sz.qty||0), 0);
      const groupSoldPcs   = sizes.reduce((s,sz)=>s+(salesBySize[item.code+'_'+sz.size]||0), 0);
      const groupBuyCost   = sizes.reduce((s,sz)=>s+((sz.buyPrice||item.buyPrice||item.buy||0)*(sz.qty||0)), 0);
      let _grpRevenue = 0;
      allSales.filter(s=>s.itemCode===item.code).forEach(s=>{ _grpRevenue += s.revenue||0; });
      const allOut     = sizes.every(sz=>sz.qty<=0);
      const hasOut     = sizes.some(sz=>sz.qty<=0);
      const isExpanded = (UI.el('search')?.value||'').length > 0 || (_expandedShoeGroups&&_expandedShoeGroups.has(item.code));

      cards.push(`
        <div class="shoe-group-header" onclick="toggleShoeGroup('${escapeHtml(item.code)}')" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${t.color||'#1e3a5f'};">${t.emoji}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(item.code)}</span>
              ${allOut?'<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>':hasOut?'<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>':''}
            </div>
            <span class="shoe-group-name">${escapeHtml(item.name||'')}</span>
            <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>📦 ${groupTotalPcs} pcs</span><span>🛒 ${groupSoldPcs} sold</span>
              <span>💸 ${fmt(groupBuyCost)}</span><span style="color:var(--accent2);">💰 ${fmt(_grpRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <span class="tag tag-cyan" style="font-size:10px;">${escapeHtml(item.type)}</span>
            <span style="font-size:16px;color:var(--muted);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded?180:0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) { cards.push('<div style="height:4px;"></div>'); }
      else {
        const activeSgf = window._activeSizeGroupFilter||'all';
        const filteredSizes = activeSgf==='all' ? sizes : sizes.filter(sz=>sz.sizeGroup===activeSgf);
        filteredSizes.forEach(sz => {
          const price      = sz.sellPrice||item.sellPrice||0;
          const buy        = sz.buyPrice||item.buyPrice||0;
          const isOut      = sz.qty<=0;
          const isLow      = !isOut&&sz.qty<=LOW_STOCK_LEVEL;
          const stockColor = isOut?'tag-red':isLow?'tag-amber':'tag-green';
          const stockLabel = isOut?'✕ Out':sz.qty+' prs';
          const soldQty    = salesBySize[item.code+'_'+sz.size]||0;
          cards.push(`
            <div class="item-card shoe-size-row${isOut?' shoe-out-card':''}" onclick="openShoeSizeCard('${escapeHtml(item.code)}',${sz.size})">
              ${isOut?'<div class="out-of-stock-overlay"><span>⛔ OUT OF STOCK · RESTOCK</span></div>':''}
              <div class="item-top">
                <div class="shoe-size-badge ${isOut?'out':isLow?'low':''}">${sz.size}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(item.name||item.code)}</div>
                  <div class="item-tags">
                    ${sz.sizeGroup?`<span class="tag tag-gray">${sz.sizeGroup==='S'?'Children':sz.sizeGroup==='M'?'Teens':'Adults'}</span>`:''}
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

    } else {
      // ── STANDARD ITEM — single card ───────────────────────────────
      const stockColor = item.qty === 0 ? 'tag-red' : item.qty <= LOW_STOCK_LEVEL ? 'tag-amber' : 'tag-green';
      const stockLabel = item.qty === 0 ? '✕ Out'   : item.qty + ' pcs';
      const soldQty    = (salesByItem[item.id] || {}).qty || 0;
      const sellPrice  = item.sellPrice || item.sell || 0;
      const buyPrice   = item.buyPrice  || item.buy  || 0;

      cards.push(`
        <div class="item-card${item.qty<=0?' shoe-out-card':''}" onclick="openSheet(${item.id})">
          ${item.qty<=0 ? '<div class="out-of-stock-overlay"><span>⛔ OUT OF STOCK · RESTOCK</span></div>' : ''}
          <div class="item-top">
            <div class="item-icon" style="background:${t.color||'var(--surface2)'};">${t.emoji}</div>
            <div class="item-body">
              <div class="item-code">${escapeHtml(item.code)}${(item.variant||item.size)?' · '+escapeHtml(item.variant||item.size):''}</div>
              <div class="item-name">${escapeHtml(item.name||'')}</div>
              <div class="item-tags">
                <span class="tag tag-cyan">${escapeHtml(item.type)}</span>
                <span class="tag tag-gray">${soldQty} sold</span>
                <span class="tag ${stockColor}">${stockLabel}</span>
              </div>
            </div>
            <div class="item-right">
              <div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(sellPrice)}</div>
              <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">Buy: ${fmt(buyPrice)}</div>
            </div>
          </div>
        </div>`);
    }
  }

  list.style.border = '';
  list.innerHTML = cards.join('');
  renderStockMonitorSummary();
}

async function getStockMonitorRows() {
  const items = await dbAll('items');
  await enrichShoeItems(items);
  const sizes = await dbAll('shoe_sizes');
  const wishlist = db.objectStoreNames.contains('wishlist') ? await dbAll('wishlist') : [];
  const rows = [];

  items.forEach(item => {
    if (item.isShoe) {
      sizes
        .filter(sz => sz.itemCode === item.code && (sz.qty || 0) <= 0)
        .forEach(sz => rows.push({
          kind: 'out',
          itemId: item.id,
          size: sz.size,
          name: item.name || item.code,
          code: item.code,
          type: item.type || '',
          qty: 0,
          buyPrice: sz.buyPrice || item.buyPrice || item.buy || 0,
          label: 'Out of stock - size ' + sz.size
        }));
    } else if ((item.qty || 0) <= 0) {
      rows.push({
        kind: 'out',
        itemId: item.id,
        name: item.name || item.code,
        code: item.code,
        type: item.type || '',
        qty: 0,
        buyPrice: item.buyPrice || item.buy || 0,
        label: 'Out of stock'
      });
    }
  });

  wishlist
    .filter(w => (w.status || 'prospective') !== 'stocked')
    .forEach(w => rows.push({
      kind: (w.status || '') === 'unaccounted' ? 'unaccounted' : 'prospective',
      wishId: w.id,
      name: w.name || w.code || 'Prospective item',
      code: w.code || '',
      type: w.type || '',
      qty: w.qty || 0,
      buyPrice: w.estimatedCost || 0,
      note: w.note || '',
      label: (w.status || '') === 'unaccounted' ? 'Not accounted' : 'Prospective'
    }));

  return rows.sort((a, b) => {
    const order = { out: 0, unaccounted: 1, prospective: 2 };
    if (a.kind !== b.kind) return (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
    return (a.name || '').localeCompare(b.name || '');
  });
}

function filterStockRows(rows, kind) {
  return kind ? rows.filter(r => r.kind === kind) : rows;
}

async function renderStockMonitorSummary() {
  const btn = document.querySelector('.stock-monitor-btn');
  const sub = document.getElementById('stock-monitor-sub');
  if (!btn && !sub) return;
  const rows = await getStockMonitorRows();
  const outCount = rows.filter(r => r.kind === 'out').length;
  const wishCount = rows.filter(r => r.kind === 'prospective').length;
  if (btn) btn.classList.toggle('active', outCount > 0);
  if (sub) sub.textContent = outCount + ' out of stock';
  const wishSub = document.getElementById('wishlist-sub');
  if (wishSub) wishSub.textContent = wishCount + ' prospective items';
}

function renderWishlistTypeOptions() {
  const sel = document.getElementById('wish-type');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Category</option>' +
    types.map(t => '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</option>').join('');
  if (current) sel.value = current;
}

async function openStockMonitor() {
  await renderStockMonitor();
  const sheet = document.getElementById('stock-monitor-sheet');
  if (sheet) sheet.classList.add('open');
}

function closeStockMonitor() {
  const sheet = document.getElementById('stock-monitor-sheet');
  if (sheet) sheet.classList.remove('open');
}

async function renderStockMonitor() {
  const targets = [
    { list: document.getElementById('stock-monitor-list'), counts: document.getElementById('stock-monitor-counts'), sheetOnly: true },
    { list: document.getElementById('inventory-monitor-list'), counts: document.getElementById('inventory-monitor-counts'), sheetOnly: false }
  ].filter(t => t.list);
  if (!targets.length) return;
  const allRows = await getStockMonitorRows();
  const rows = allRows.filter(row => row.kind === 'out' || row.kind === 'unaccounted');
  const outCount = rows.filter(row => row.kind === 'out').length;
  const unaccountedCount = rows.filter(row => row.kind === 'unaccounted').length;
  const html = rows.length ? rows.map(row => {
    const cls = row.kind === 'out' ? 'out' : 'unaccounted';
    const status = row.kind === 'out'
      ? '<span class="tag tag-red">Out of stock</span>'
      : '<span class="tag tag-blue">Not accounted</span>';
    const restockAction = row.kind === 'out'
      ? 'restockFromMonitor(' + row.itemId + (row.size ? ',' + row.size : '') + ')'
      : 'startWishlistRestock(' + row.wishId + ')';
    const deleteBtn = row.kind !== 'out'
      ? '<button class="stock-monitor-action delete" onclick="event.stopPropagation();deleteWishlistItem(' + row.wishId + ')" title="Remove"><i class="fa-solid fa-trash"></i></button>'
      : '';
    return '<div class="stock-monitor-row ' + cls + '" onclick="' + restockAction + '" role="button" tabindex="0">' +
      '<div class="stock-monitor-body">' +
        '<div class="stock-monitor-name">' + escapeHtml(row.name) + '</div>' +
        '<div class="stock-monitor-meta">' +
          escapeHtml(row.code || 'No code') + (row.type ? ' · ' + escapeHtml(row.type) : '') +
          (row.qty ? ' · target ' + row.qty : '') +
          (row.buyPrice ? ' · ' + fmt(row.buyPrice) : '') +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;">' + status +
          (row.size ? '<span class="tag tag-gray">Size ' + escapeHtml(row.size) + '</span>' : '') +
          (row.note ? '<span class="tag tag-gray">' + escapeHtml(row.note) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="stock-monitor-actions">' +
        '<button class="stock-monitor-action restock" onclick="event.stopPropagation();' + restockAction + '" title="Restock"><i class="fa-solid fa-boxes-stacked"></i></button>' +
        deleteBtn +
      '</div>' +
    '</div>';
  }).join('') : '<div class="empty" style="padding:28px 12px;"><div class="e-icon">OK</div><p>No monitored items.</p></div>';

  targets.forEach(target => {
    if (target.counts) {
      target.counts.innerHTML =
        '<div class="stock-monitor-pill red">' + outCount + ' Out of stock</div>' +
        '<div class="stock-monitor-pill blue">' + unaccountedCount + ' Not accounted</div>';
    }
    target.list.innerHTML = html;
  });
}

async function renderWishlistPage() {
  renderWishlistTypeOptions();
  await renderStockMonitorSummary();
  const list = document.getElementById('wishlist-list');
  if (!list) return;
  const rows = filterStockRows(await getStockMonitorRows(), 'prospective');
  if (!rows.length) {
    list.innerHTML = '<div class="empty" style="padding:36px 12px;"><div class="e-icon">+</div><p>No prospective items yet.</p></div>';
    return;
  }
  list.innerHTML = rows.map(row => {
    return '<div class="stock-monitor-row prospective" onclick="startWishlistRestock(' + row.wishId + ')" role="button" tabindex="0">' +
      '<div class="stock-monitor-body">' +
        '<div class="stock-monitor-name">' + escapeHtml(row.name) + '</div>' +
        '<div class="stock-monitor-meta">' +
          escapeHtml(row.code || 'No code') + (row.type ? ' · ' + escapeHtml(row.type) : '') +
          (row.qty ? ' · target ' + row.qty : '') +
          (row.buyPrice ? ' · ' + fmt(row.buyPrice) : '') +
        '</div>' +
        '<div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap;">' +
          '<span class="tag tag-amber">Prospective</span>' +
          (row.note ? '<span class="tag tag-gray">' + escapeHtml(row.note) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="stock-monitor-actions">' +
        '<button class="stock-monitor-action restock" onclick="event.stopPropagation();startWishlistRestock(' + row.wishId + ')" title="Restock"><i class="fa-solid fa-boxes-stacked"></i></button>' +
        '<button class="stock-monitor-action delete" onclick="event.stopPropagation();deleteWishlistItem(' + row.wishId + ')" title="Remove"><i class="fa-solid fa-trash"></i></button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function saveWishlistItem() {
  const name = (document.getElementById('wish-name')?.value || '').trim();
  const code = (document.getElementById('wish-code')?.value || '').trim().toUpperCase();
  const type = document.getElementById('wish-type')?.value || '';
  const qty = parseInt(document.getElementById('wish-qty')?.value || '0');
  const estimatedCost = parseFloat(document.getElementById('wish-cost')?.value || '0') || 0;
  const note = (document.getElementById('wish-note')?.value || '').trim();
  if (!name && !code) return Validate.fail('Enter item name or code', 'wish-name');
  const entry = {
    name,
    code,
    type,
    qty: qty > 0 ? qty : 1,
    estimatedCost,
    note,
    status: 'prospective',
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : 'system'
  };
  entry.id = await dbAdd('wishlist', entry);
  ['wish-name','wish-code','wish-qty','wish-cost','wish-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  scheduleSync();
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast('Added to wishlist', 'ok');
}

async function deleteWishlistItem(id) {
  await dbDelete('wishlist', id);
  scheduleSync();
  await renderWishlistPage();
  await renderStockMonitor();
  await renderStockMonitorSummary();
}

async function markWishlistStockedForItem(item) {
  if (!item || !db.objectStoreNames.contains('wishlist')) return;
  const wishlist = await dbAll('wishlist');
  const itemCode = (item.code || '').trim().toLowerCase();
  const itemName = (item.name || '').trim().toLowerCase();
  for (const wish of wishlist) {
    if ((wish.status || 'prospective') === 'stocked') continue;
    const wishCode = (wish.code || '').trim().toLowerCase();
    const wishName = (wish.name || '').trim().toLowerCase();
    const matchesCode = itemCode && wishCode && itemCode === wishCode;
    const matchesName = itemName && wishName && itemName === wishName;
    if (!matchesCode && !matchesName) continue;
    wish.status = 'stocked';
    wish.stockedAt = new Date().toISOString();
    wish.stockedItemId = item.id || null;
    await dbPut('wishlist', wish);
  }
}

async function restockFromMonitor(itemId, size) {
  closeStockMonitor();
  if (size != null) {
    await openShoeSizeRestock(itemId, size);
    return;
  }
  await openSheet(itemId);
  setTimeout(() => {
    const panel = document.getElementById('restock-panel');
    if (panel && panel.style.display === 'none') toggleRestock();
    const qty = document.getElementById('restock-qty');
    if (qty) qty.focus();
  }, 120);
}

async function startWishlistRestock(wishId) {
  const wish = await dbGet('wishlist', wishId);
  if (!wish) return;
  closeStockMonitor();
  clearForm();
  showPage('add');
  setTimeout(() => {
    const typeEl = UI.el('f-type');
    if (typeEl && wish.type) {
      typeEl.value = wish.type;
      onTypeChange();
    }
    if (UI.el('f-code')) UI.el('f-code').value = wish.code || '';
    if (UI.el('f-name')) UI.el('f-name').value = wish.name || '';
    if (UI.el('f-qty')) UI.el('f-qty').value = wish.qty || 1;
    if (UI.el('f-buy')) UI.el('f-buy').value = wish.estimatedCost || '';
    updateProfitPreview();
  }, 80);
}

// Open a dedicated size detail sheet from the stock list
async function openShoeSizeCard(itemCode, size) {
  const items   = await dbAll('items');
  const item    = items.find(i => i.code === itemCode);
  if (!item) { toast('Item not found', 'err'); return; }

  const allSz  = await getShoeSizes(itemCode);
  const sizeRec = allSz.find(s => s.size === size);
  if (!sizeRec) { toast('Size record not found', 'err'); return; }

  const price    = sizeRec.sellPrice || item.sellPrice || 0;
  const buy      = sizeRec.buyPrice  || item.buyPrice  || 0;
  const profit   = price - buy;
  const isOut    = sizeRec.qty <= 0;
  const isLow    = !isOut && sizeRec.qty <= LOW_STOCK_LEVEL;
  const stockCol = isOut ? 'var(--red)' : isLow ? '#d97706' : 'var(--green)';
  const stockLbl = isOut ? 'Out of stock' : sizeRec.qty + ' pairs in stock';

  // Reuse or create size action sheet
  let sheet = document.getElementById('shoe-size-action-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'shoe-size-action-sheet';
    sheet.className = 'sheet-overlay';
    sheet.innerHTML = '<div class="sheet" id="shoe-size-action-inner"></div>';
    sheet.addEventListener('click', e => { if (e.target === sheet) closeShoeSizeActions(); });
    document.body.appendChild(sheet);
  }

  const inner = document.getElementById('shoe-size-action-inner');
  inner.innerHTML = `
    <div class="sheet-handle"></div>

    <!-- Size header -->
    <div style="display:flex;align-items:center;gap:14px;padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:16px;">
      <div class="shoe-size-badge ${isOut?'out':isLow?'low':''}" style="width:64px;height:64px;font-size:28px;">${size}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:18px;font-weight:900;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.name || item.code)}</div>
        <div style="font-size:12px;font-family:var(--mono);color:var(--muted);margin-top:2px;">${escapeHtml(item.code)} · ${sizeRec.sizeGroup==='S'?'Children':sizeRec.sizeGroup==='M'?'Teens':'Adults'}</div>
        <div style="font-size:13px;font-weight:700;color:${stockCol};margin-top:4px;">${stockLbl}</div>
      </div>
    </div>

    <!-- Price stats -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px;">
      <div class="sh-stat-box"><div class="sh-stat-lbl">Buy</div><div class="sh-stat-val muted">${fmt(buy)}</div></div>
      <div class="sh-stat-box"><div class="sh-stat-lbl">Sell</div><div class="sh-stat-val accent2">${fmt(price)}</div></div>
      <div class="sh-stat-box ${profit>0?'accent-bg':''}"><div class="sh-stat-lbl">Profit</div><div class="sh-stat-val ${profit>0?'green':'muted'}">${fmt(profit)}</div></div>
    </div>

    <!-- Action buttons -->
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${!isOut ? `
        <button onclick="closeShoeSizeActions();closeSheet();openSellShoeModal(${item.id},${size})"
                style="width:100%;padding:16px;background:#1e7a3e;color:white;border:none;border-radius:var(--r);font-size:16px;font-weight:800;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:10px;">
          <i class="fa-solid fa-cash-register"></i> Sell — Size ${size}
        </button>` : isOut ? `
        <div style="padding:12px;text-align:center;font-size:13px;color:var(--muted);background:var(--surface2);border-radius:var(--r);">Out of stock — restock first</div>` : ''}
      <button onclick="closeShoeSizeActions();openShoeSizeRestock(${item.id},${size})"
              style="width:100%;padding:14px;background:#dbeafe;color:#1d4ed8;border:1px solid #93c5fd;border-radius:var(--r);font-size:15px;font-weight:800;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:10px;">
        <i class="fa-solid fa-boxes-stacked"></i> Restock — Size ${size}
      </button>
      <button onclick="closeShoeSizeActions();openShoeSizeEdit(${item.id},${size})"
              style="width:100%;padding:14px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--r);font-size:15px;font-weight:800;cursor:pointer;font-family:var(--sans);display:flex;align-items:center;justify-content:center;gap:10px;">
        <i class="fa-solid fa-pen-to-square"></i> Edit Price — Size ${size}
      </button>
      <button onclick="closeShoeSizeActions()"
              style="width:100%;padding:13px;background:transparent;border:1px solid var(--border);border-radius:var(--r);font-size:14px;color:var(--muted);cursor:pointer;font-family:var(--sans);">
        Close
      </button>
    </div>`;

  sheet.classList.add('open');
}
window.openShoeSizeCard = openShoeSizeCard;


// ===== DETAIL SHEET =====

async function renderShoeDetailGrid(item) {
  const wrap = document.getElementById('sh-shoe-sizes');
  if (!wrap || !item) return;

  const sizes = (await getShoeSizes(item.code))
    .filter(s => Number.isFinite(Number(s.size)))
    .sort((a, b) => Number(a.size) - Number(b.size));

  if (!sizes.length) {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = 'block';
  wrap.innerHTML =
    '<div class="sh-detail-size-grid">' +
      sizes.map(s => {
        const n = Number(s.size);
        const selected = _selectedShoeSizes.has(n);
        const state = s.qty <= 0 ? ' out' : s.qty <= LOW_STOCK_LEVEL ? ' low' : '';
        return '<button type="button" class="sh-detail-size-btn' + state + (selected ? ' selected' : '') + '"' +
          ' data-sh-size="' + n + '" onclick="toggleDetailShoeSize(' + item.id + ',' + n + ')">' + n + '</button>';
      }).join('') +
    '</div>';

  _updateDetailShoeSelectionBar(item.id);
}

function toggleDetailShoeSize(itemId, size) {
  size = Number(size);
  if (_selectedShoeSizes.has(size)) _selectedShoeSizes.delete(size);
  else _selectedShoeSizes.add(size);

  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  _selectedShoeSize = selected.length ? selected[selected.length - 1] : null;

  document.querySelectorAll('#sh-shoe-sizes [data-sh-size]').forEach(btn => {
    btn.classList.toggle('selected', _selectedShoeSizes.has(Number(btn.dataset.shSize)));
  });
  _updateDetailShoeSelectionBar(itemId);
}
window.toggleDetailShoeSize = toggleDetailShoeSize;

function _updateDetailShoeSelectionBar(itemId) {
  const bar = document.getElementById('sh-selected-size-bar');
  if (!bar) return;
  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  if (!selected.length) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'block';
  bar.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
      '<span style="font-family:var(--mono);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + selected.join(', ') + '</span>' +
      '<button onclick="restockSelectedShoeSizes(' + itemId + ')" style="padding:7px 12px;background:var(--green);color:white;border:none;border-radius:var(--r);font-size:12px;font-weight:800;cursor:pointer;font-family:var(--sans);flex-shrink:0;">Restock</button>' +
    '</div>';
}

async function restockSelectedShoeSizes(itemId) {
  const selected = [..._selectedShoeSizes].sort((a, b) => a - b);
  if (!selected.length) { toast('Select size first', 'err'); return; }
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
  let sheet = document.getElementById('bulk-shoe-restock-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'bulk-shoe-restock-sheet';
    sheet.className = 'sheet-overlay';
    sheet.innerHTML = '<div class="sheet" id="bulk-shoe-restock-inner"></div>';
    sheet.addEventListener('click', e => { if (e.target === sheet) closeBulkShoeRestock(); });
    document.body.appendChild(sheet);
  }

  const inner = document.getElementById('bulk-shoe-restock-inner');
  inner.innerHTML =
    '<div class="sheet-handle"></div>' +
    '<div class="sheet-title">Restock Sizes</div>' +
    '<div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent);margin-bottom:12px;">' + sizes.join(', ') + '</div>' +
    '<input id="bulk-shoe-restock-qty" type="number" min="1" inputmode="numeric" placeholder="Qty to add to each size" ' +
      'style="width:100%;padding:13px 14px;border:1.5px solid var(--border);border-radius:var(--r);font-size:16px;font-weight:800;font-family:var(--mono);background:var(--bg);outline:none;margin-bottom:12px;">' +
    '<button onclick="confirmBulkShoeRestock()" style="width:100%;padding:15px;background:var(--green);color:white;border:none;border-radius:var(--r);font-size:15px;font-weight:900;cursor:pointer;font-family:var(--sans);">Add Stock</button>' +
    '<button onclick="closeBulkShoeRestock()" style="width:100%;padding:13px;background:transparent;border:1.5px solid var(--border);border-radius:var(--r);font-size:14px;font-weight:700;color:var(--muted);cursor:pointer;font-family:var(--sans);margin-top:8px;">Cancel</button>';

  sheet.classList.add('open');
  setTimeout(() => document.getElementById('bulk-shoe-restock-qty')?.focus(), 80);
}

function closeBulkShoeRestock() {
  const sheet = document.getElementById('bulk-shoe-restock-sheet');
  if (sheet) sheet.classList.remove('open');
}
window.closeBulkShoeRestock = closeBulkShoeRestock;

async function confirmBulkShoeRestock() {
  if (!_bulkShoeRestock) return;
  const qty = parseInt(document.getElementById('bulk-shoe-restock-qty')?.value || '0');
  if (!Validate.restockQty(qty, 'bulk-shoe-restock-qty')) return;

  const { itemId, sizes } = _bulkShoeRestock;
  const item = await dbGet('items', itemId);
  if (!item) { toast('Item not found', 'err'); return; }

  const records = await getShoeSizes(item.code);
  const changed = [];
  for (const size of sizes) {
    const rec = records.find(s => Number(s.size) === Number(size));
    if (!rec) continue;
    rec.qty = (rec.qty || 0) + qty;
    rec.updatedAt = new Date().toISOString();
    await dbPut('shoe_sizes', rec);
    changed.push(rec);
  }

  const fresh = await getShoeSizes(item.code);
  item.qty = fresh.reduce((t, s) => t + (s.qty || 0), 0);
  item.updatedAt = new Date().toISOString();
  await dbPut('items', item);
  await recordStockInvestment(
    item,
    changed.reduce((sum, rec) => sum + qty * (rec.buyPrice || rec.buy || item.buyPrice || item.buy || 0), 0),
    qty * changed.length,
    'Shoe restock'
  );
  fbSyncItem(item);

  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      for (const rec of changed) {
        if (!rec.fbId) { rec.fbId = 'sz_' + rec.codeSize; await dbPut('shoe_sizes', rec); }
        await setDoc(doc(fbDb, 'shoe_sizes', rec.fbId), sanitiseForFirestore({ ...rec }));
      }
    } catch(e) { console.warn('[SYNC] bulk shoe restock:', e.message); }
  }

  scheduleSync();
  closeBulkShoeRestock();
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList(); renderDashboard(); updateHeader();
  toast('Added ' + qty + ' to ' + changed.length + ' sizes', 'ok');
  await openSheet(itemId);
}
window.confirmBulkShoeRestock = confirmBulkShoeRestock;

function openSellFromSheet() {
  const id = currentDetailId;
  closeSheet();
  setTimeout(async () => {
    const item = await dbGet('items', id);
    if (!item) { toast('Item not found', 'err'); return; }
    if (item.isShoe) {
      if (!_selectedShoeSize) {
        toast('⚠️ Select a size first from the detail sheet', 'err');
        setTimeout(() => openSheet(id), 150);
        return;
      }
      openSellShoeModal(id, _selectedShoeSize);
    } else {
      if (item.qty <= 0) { toast('⚠️ Out of stock', 'err'); return; }
      openSellModal(id);
    }
  }, 120);
}

function triggerSheetPhotoUpload(event) {
  event.stopPropagation();
  // Show choice: camera or gallery
  const menu = document.createElement('div');
  menu.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center;';
  menu.innerHTML = `<div style="background:var(--surface);border-radius:20px 20px 0 0;width:100%;max-width:520px;padding:20px 18px 32px;">
    <div style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:16px;text-align:center;">Add Photo</div>
    <button onclick="this.closest('[style*=fixed]').remove();_capturePhoto(${currentDetailId},'camera')" style="width:100%;padding:16px;background:var(--accent);color:white;border:none;border-radius:var(--r);font-size:16px;font-weight:700;cursor:pointer;font-family:var(--sans);margin-bottom:10px;">📸 Take Photo</button>
    <button onclick="this.closest('[style*=fixed]').remove();_capturePhoto(${currentDetailId},'gallery')" style="width:100%;padding:16px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:var(--r);font-size:16px;font-weight:700;cursor:pointer;font-family:var(--sans);margin-bottom:10px;">🖼️ Choose from Gallery</button>
    <button onclick="this.closest('[style*=fixed]').remove()" style="width:100%;padding:13px;background:transparent;color:var(--muted);border:none;font-size:15px;cursor:pointer;font-family:var(--sans);">Cancel</button>
  </div>`;
  document.body.appendChild(menu);
}

function _capturePhoto(itemId, source) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (source === 'camera') input.capture = 'environment';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxW = 800;
        const scale = Math.min(1, maxW / img.width);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const compressed = canvas.toDataURL('image/jpeg', 0.75);
        setItemPhoto(itemId, compressed);
        // Update sheet photo live
        const photoImg = document.getElementById('sh-photo-img');
        const fallback = document.getElementById('sh-photo-fallback');
        const panWrap = document.getElementById('sh-photo-pan');
        if (photoImg) { photoImg.src = compressed; }
        if (panWrap) panWrap.style.display = 'block';
        if (fallback) fallback.style.display = 'none';
        if (typeof window._resetPhotoPan === 'function') window._resetPhotoPan();
        const btn = document.getElementById('sh-photo-btn');
        if (btn) btn.textContent = '📷 Photo';
        renderList();
        toast('📸 Photo saved!', 'ok');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function openSheet(id) {
  currentDetailId = id;
  const item = await dbGet('items', id);
  if (!item) return;
  const t = getTypeObj(item.type);
  const sales = await dbAll('sales');
  const itemSales = sales.filter(s => s.itemId === id);
  const soldQty = itemSales.reduce((a,s) => a+s.qty, 0);
  const revenue = itemSales.reduce((a,s) => a+s.revenue, 0);
  const profitMade = itemSales.reduce((a,s) => a+s.profit, 0);

  // Photo or emoji fallback
  const photo = getItemPhoto(id);
  const photoImg = document.getElementById('sh-photo-img');
  const photoFallback = document.getElementById('sh-photo-fallback');
  const photoPan = document.getElementById('sh-photo-pan') || document.getElementById('sh-photo-area-inner');
  if (photo) {
    photoImg.src = photo;
    if (photoPan) { const panEl=document.getElementById('sh-photo-pan'); if(panEl) panEl.style.display='block'; }
    photoFallback.style.display = 'none';
  } else {
    if (photoPan) photoPan.style.display = 'none';
    photoFallback.style.display = 'flex';
    photoFallback.style.background = t.color || 'var(--surface2)';
  }
  // Reset pan/zoom every time sheet opens
  if (typeof window._resetPhotoPan === 'function') window._resetPhotoPan();

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('sh-photo-btn', photo ? '📷 Change' : '📷 Add Photo');
  set('sh-icon', t.emoji);
  set('sh-name', item.name);
  set('sh-code', item.code + (item.size ? ' · ' + item.size : ''));
  set('sh-type', item.type);
  const tbadge = document.getElementById('sh-type-badge'); if (tbadge) tbadge.textContent = t.emoji + ' ' + item.type;
  set('sh-size', item.size || '—');
  set('sh-buy', fmt(item.buy));
  set('sh-sell', fmt(item.sell));
  set('sh-profit', fmt(item.profit));
  set('sh-qty', item.qty + ' pcs');
  set('sh-code-large', item.code + (item.size ? ' · ' + item.size : ''));

  // ── SHOE ITEMS — load fresh sizes, show size grid ─────────────
  const priceCols = document.getElementById('sh-price-cols');
  const sizeSec   = document.getElementById('sh-shoe-sizes');
  const sizebar   = document.getElementById('sh-selected-size-bar');
  _selectedShoeSize = null; // reset selection
  _selectedShoeSizes = new Set();

  if (item.isShoe) {
    const freshSizes = await getShoeSizes(item.code);
    const totalQty   = freshSizes.reduce((t,s) => t+s.qty, 0);
    item.qty         = totalQty;
    // Show shoe buy/sell from defaults
    set('sh-buy',  fmt(item.defaultBuy  || 0));
    set('sh-sell', fmt(item.defaultSell || 0));
    set('sh-qty',  totalQty + ' prs');
    if (sizeSec) sizeSec.style.display = 'block';
    if (sizebar) { sizebar.style.display = 'none'; sizebar.textContent = ''; }
    await renderShoeDetailGrid(item);
  } else {
    set('sh-buy',  fmt(item.buy  || 0));
    set('sh-sell', fmt(item.sell || 0));
    set('sh-qty',  item.qty);
    if (sizeSec) sizeSec.style.display = 'none';
    if (sizebar) sizebar.style.display = 'none';
  }

  // Out of stock
  const outBadge = document.getElementById('sh-out-badge');
  const sellBtn = document.getElementById('sh-sell-btn');
  if (item.qty <= 0 && !item.isShoe) {
    if (outBadge) outBadge.style.display = 'block';
    if (sellBtn) { sellBtn.disabled = true; sellBtn.style.opacity = '0.4'; sellBtn.style.cursor = 'not-allowed'; sellBtn.textContent = 'OUT OF STOCK'; }
  } else {
    if (outBadge) outBadge.style.display = 'none';
    if (sellBtn) { sellBtn.disabled = false; sellBtn.style.opacity = '1'; sellBtn.style.cursor = 'pointer'; sellBtn.textContent = item.isShoe ? 'SELECT SIZE & SELL' : 'SELL'; }
  }
  set('sh-total', fmt(item.buy * item.qty));
  set('sh-sold', soldQty);
  set('sh-revenue', fmt(revenue));
  set('sh-profit-made', fmt(profitMade));

  document.getElementById('detail-sheet').classList.add('open');

  // Show/hide action buttons based on day state
  const dayOpen = isDayOpen();
  const status  = activeDay ? activeDay.status : 'PENDING';

  const shSellBtn  = document.getElementById('sh-sell-btn');
  const delBtn     = document.querySelector('#detail-sheet .btn-del');
  const editBtn    = document.querySelector('#detail-sheet .btn-edit');
  const restockBtn = document.querySelector('[onclick="toggleRestock()"]');
  const actionRow  = document.getElementById('sh-action-row');

  if (dayOpen) {
    // OPEN: show all action buttons
    [shSellBtn, delBtn, editBtn, restockBtn].forEach(b => { if (b) { b.style.display = ''; b.style.opacity = '1'; b.style.pointerEvents = 'auto'; } });
    if (actionRow) actionRow.style.display = '';
  } else {
    // Not OPEN: hide write actions, show read-only notice
    [shSellBtn, delBtn, editBtn, restockBtn].forEach(b => { if (b) { b.style.display = 'none'; } });
    if (actionRow) actionRow.style.display = 'none';
  }

  // Status-specific notice in the detail sheet
  let notice = document.getElementById('sh-day-notice');
  if (!dayOpen) {
    const noticeText = {
      PENDING:    '📅 Open the business day to edit or sell items.',
      PAUSED:     '⏸ Day is paused — resume to make changes.',
      CLOSED:     '🌙 Day is closed — reopen from the Day tab to make changes.',
      RECONCILED: '✅ Day is reconciled and permanently archived.',
      LOCKED:     '🔒 This is an archived day — read only.',
    };
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'sh-day-notice';
      notice.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;margin-bottom:10px;font-size:12px;font-weight:600;color:var(--text2);text-align:center;';
      const infoArea = document.querySelector('#detail-sheet .sheet > div:last-child');
      if (infoArea) infoArea.insertBefore(notice, infoArea.firstChild);
    }
    notice.textContent = noticeText[status] || '🔒 Actions unavailable.';
    notice.style.display = 'block';
  } else {
    if (notice) notice.style.display = 'none';
  }
}

function closeSheet() {
  const sheet = document.getElementById('detail-sheet');
  if (sheet) sheet.classList.remove('open');
  const ov = document.getElementById('saving-overlay');
  if (ov) ov.style.display = 'none';
}

async function deleteItem() {
  try {
  const toDelete = await dbGet('items', currentDetailId);
  if (!toDelete) { toast('Item not found', 'err'); return; }
  // Warn if item has sales history
  const allSales = await dbAll('sales');
  const itemSales = allSales.filter(s => s.itemId === currentDetailId || s.itemCode === toDelete.code);
  let msg = 'Delete "' + (toDelete.name || toDelete.code) + '"?';
  if (itemSales.length > 0) msg += '\n\n⚠️ This item has ' + itemSales.length + ' sale record(s). The sales history will remain but the item cannot be restocked.';
  if (!confirm(msg)) return;
  await dbDelete('items', currentDetailId);
  if (toDelete && toDelete.fbId) fbDeleteItem(toDelete.fbId);
  closeSheet();
  allItems = await dbAll('items');
  renderList();
  renderDashboard();
  renderSummary();
  updateHeader();
  toast('Item deleted');
  } catch(e) { console.error("[deleteItem]", e); toast("Error: " + e.message, "err"); }
}

async function editItem() {
  try {
  const item = await dbGet('items', currentDetailId);
  if (!item) { toast('Item not found.', 'err'); return; }
  closeSheet();

  if (item.isShoe) {
    const size = _selectedShoeSize;
    if (!size) { toast('⚠️ Select a size first before editing', 'err'); setTimeout(()=>openSheet(item.id),100); return; }
    const sizes = await getShoeSizes(item.code);
    const sizeRec = sizes.find(s => s.size === size);
    if (!sizeRec) { toast('Size record not found', 'err'); return; }
    _editingItemId = null;  // shoe edits use shoe_edit_ prefix, not _editingItemId
    UI.el('edit-id').value = 'shoe_edit_' + item.id + '_' + size;
    UI.el('f-type').value  = item.type || '';
    UI.el('f-code').value  = item.code || '';
    UI.el('f-name').value  = item.name || '';
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = sizeRec.qty ?? '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || item.defaultBuy  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || item.defaultSell || '';
    showPage('add');
    ['f-code','f-type','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled=true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; }
    });
    const shoePanel  = UI.el('shoe-size-panel');
    const stdPricing = UI.el('std-pricing-section');
    const sizeField  = document.getElementById('f-size-field');
    if (shoePanel)  shoePanel.style.display  = 'none';
    if (stdPricing) stdPricing.style.display = 'block';
    if (sizeField)  sizeField.style.display  = 'block';
    UI.el('save-btn').textContent = '💾 Save Size ' + size;
    UI.el('form-mode-label').textContent = '✏️ Edit · ' + item.code + ' Size ' + size;
    UI.el('cancel-edit-btn').style.display = 'block';
    _editOriginItemId = item.id;
    updateProfitPreview();
    return;
  }

  // ── STANDARD ITEM EDIT ────────────────────────────────────────
  _editingItemId = item.id;   // store reliably in JS variable
  showPage('add');
  UI.el('edit-id').value = item.id;
  UI.el('f-type').value  = item.type  || '';
  UI.el('f-code').value  = item.code  || '';
  UI.el('f-name').value  = item.name  || '';
  UI.el('f-size').value  = item.variant || item.size || '';   // normalized field name
  UI.el('f-qty').value   = item.qty   ?? '';
  UI.el('f-buy').value   = item.buyPrice  || item.buy  || '';  // normalized field name
  UI.el('f-sell').value  = item.sellPrice || item.sell || '';  // normalized field name
  // Lock code and type — identifying fields
  ['f-code','f-type'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled=true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; }
  });
  UI.el('save-btn').textContent = '💾 Save Changes';
  UI.el('form-mode-label').textContent = '✏️ Edit · ' + (item.name || item.code);
  UI.el('cancel-edit-btn').style.display = 'block';
  _editOriginItemId = item.id;
  updateProfitPreview();
  const existingPhoto = getItemPhoto(item.id);
  if (existingPhoto) {
    _addFormPhotoData = existingPhoto;
    const photoImg    = document.getElementById('add-photo-img');
    const placeholder = document.getElementById('add-photo-placeholder');
    const removeBtn   = document.getElementById('add-photo-remove');
    if (photoImg)    { photoImg.src = existingPhoto; photoImg.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (removeBtn)   removeBtn.style.display = 'block';
  }
  } catch(e) { console.error("[editItem]", e); toast("Error: " + e.message, "err"); }
}

// ===== DASHBOARD =====
// ── Dashboard period state ──────────────────────────────────
let _dashPeriod = 'today';

function dashSetPeriod(p) {
  _dashPeriod = p;
  document.querySelectorAll('[id^="dash-period-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('dash-period-' + p);
  if (btn) btn.classList.add('active');
  renderDashboard();
}

function _dashDateRange() {
  const today = todayDateStr();
  if (_dashPeriod === 'today') return { from: today, to: today };
  if (_dashPeriod === 'week')  { const d=new Date(); d.setDate(d.getDate()-6); return { from:d.toISOString().split('T')[0], to:today }; }
  if (_dashPeriod === 'month') { const d=new Date(); d.setDate(1); return { from:d.toISOString().split('T')[0], to:today }; }
  return { from: null, to: null };
}

async function renderDashboard() {
  const allItems = await dbAll('items');
  const allSales = await dbAll('sales');
  const range    = _dashDateRange();
  const today    = todayDateStr();

  // Filter sales by period
  const sales = allSales.filter(s => {
    const d = s.businessDate || (s.date||'').split('T')[0];
    if (!range.from) return true;
    return d >= range.from && d <= range.to;
  });

  // ── Stock metrics (always all-time) ──────────────────────
  const totalItems  = allItems.length;
  const totalQty    = allItems.reduce((s,i) => s+(i.qty||0), 0);
  const stockCost   = allItems.reduce((s,i) => s+((i.buyPrice||i.buy||0)*(i.qty||0)), 0);
  const stockRetail = allItems.reduce((s,i) => s+((i.sellPrice||i.sell||0)*(i.qty||0)), 0);
  const potProfit   = stockRetail - stockCost;

  // ── Period sales metrics ──────────────────────────────────
  const totalRevenue      = sales.reduce((s,x) => s+(x.revenue||0), 0);
  const totalProfitEarned = sales.reduce((s,x) => s+(x.profit||0), 0);
  const totalPiecesSold   = sales.reduce((s,x) => s+(x.qty||0), 0);
  const totalSalesCount   = sales.length;
  const margin = totalRevenue > 0 ? (totalProfitEarned/totalRevenue*100) : 0;
  const avgSale = totalSalesCount > 0 ? totalRevenue/totalSalesCount : 0;

  // ── KPI tiles ─────────────────────────────────────────────
  const setEl = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  setEl('d-revenue',      fmt(totalRevenue));
  setEl('d-profit-earned',fmt(totalProfitEarned));
  setEl('d-margin',       margin.toFixed(1)+'%');
  setEl('d-items',        fmtN(totalItems));
  setEl('d-qty',          fmtN(totalQty));
  setEl('d-total-sold',   fmtN(totalSalesCount));
  setEl('d-pieces-sold',  fmtN(totalPiecesSold));
  setEl('d-stock-val',    fmt(stockCost));
  setEl('d-retail-total', fmt(stockRetail));
  setEl('d-potential-profit', fmt(potProfit));
  // Compat
  setEl('d-cost-total', fmt(stockCost));
  setEl('d-remaining',  fmt(stockRetail));

  // Margin colour
  const mEl = document.getElementById('d-margin');
  if (mEl) mEl.style.color = margin >= 20 ? 'var(--green)' : margin >= 10 ? 'var(--amber)' : 'var(--red)';

  // ── Sold vs remaining bar ─────────────────────────────────
  const barWrap = document.getElementById('d-stock-bar-wrap');
  const totalEver = totalPiecesSold + totalQty;
  if (barWrap && totalEver > 0) {
    barWrap.style.display = '';
    const soldPct = (totalPiecesSold / totalEver * 100).toFixed(1);
    const remPct  = (totalQty / totalEver * 100).toFixed(1);
    const barSold = document.getElementById('d-stock-bar-sold');
    if (barSold) barSold.style.width = soldPct + '%';
    setEl('d-bar-sold-lbl', fmtN(totalPiecesSold) + ' sold (' + soldPct + '%)');
    setEl('d-bar-rem-lbl',  fmtN(totalQty) + ' remaining (' + remPct + '%)');
  } else if (barWrap) { barWrap.style.display = 'none'; }

  // ── Today at a Glance (only show on Today period) ─────────
  const todayWrap = document.getElementById('d-today-wrap');
  if (todayWrap) {
    if (_dashPeriod === 'today') {
      const todaySales = allSales.filter(s => (s.businessDate||(s.date||'').split('T')[0]) === today);
      const tRev  = todaySales.reduce((s,x)=>s+(x.revenue||0),0);
      const tProf = todaySales.reduce((s,x)=>s+(x.profit||0),0);
      const tQty  = todaySales.reduce((s,x)=>s+(x.qty||0),0);
      todayWrap.style.display = '';
      const grid = document.getElementById('d-today-grid');
      if (grid) grid.innerHTML = [
        { label:'Revenue', val:fmt(tRev), color:'var(--green)' },
        { label:'Profit',  val:fmt(tProf), color: tProf>=0?'var(--accent2)':'var(--red)' },
        { label:'Pieces',  val:fmtN(tQty), color:'var(--accent)' },
      ].map(k=>`<div class="stat-box" style="padding:10px 8px;"><div class="stat-val" style="font-size:15px;color:${k.color};">${k.val}</div><div class="stat-lbl">${k.label}</div></div>`).join('');
    } else {
      todayWrap.style.display = 'none';
    }
  }

  // ── 7-day sparkline ───────────────────────────────────────
  const sparkWrap = document.getElementById('d-sparkline-wrap');
  const sparkEl   = document.getElementById('d-sparkline');
  const sparkLbls = document.getElementById('d-sparkline-labels');
  if (sparkWrap && sparkEl) {
    const days7 = Array.from({length:7},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(6-i)); return d.toISOString().split('T')[0]; });
    const dayRevs = days7.map(date => allSales.filter(s=>(s.businessDate||(s.date||'').split('T')[0])===date).reduce((s,x)=>s+(x.revenue||0),0));
    const hasData = dayRevs.some(v=>v>0);
    sparkWrap.style.display = hasData ? '' : 'none';
    if (hasData) {
      const maxRev = Math.max(...dayRevs, 1);
      const weekTotal = dayRevs.reduce((s,v)=>s+v,0);
      setEl('d-spark-total', fmt(weekTotal));
      sparkEl.innerHTML = dayRevs.map((v,i)=>{
        const h = Math.max(3, Math.round(v/maxRev*44));
        const isToday = days7[i]===today;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:48px;">
          <div title="${fmt(v)}" style="width:100%;background:${isToday?'var(--accent2)':'var(--accent)'};border-radius:3px 3px 0 0;height:${h}px;opacity:${v>0?1:0.2};"></div>
        </div>`;
      }).join('');
      if (sparkLbls) sparkLbls.innerHTML = days7.map((d,i)=>`<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);font-weight:${days7[i]===today?800:600};">${new Date(d+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short'}).slice(0,2)}</div>`).join('');
    }
  }

  // ── Alerts ────────────────────────────────────────────────
  const outStk = allItems.filter(i => i.qty === 0);
  const lowStk = allItems.filter(i => i.qty > 0 && i.qty <= LOW_STOCK_LEVEL);
  const alertEl = document.getElementById('d-alerts');
  if (alertEl) {
    let html = '';
    if (outStk.length) html += `<div style="background:var(--red-light);border:1px solid rgba(192,57,43,0.25);border-radius:var(--r);padding:10px 12px;margin-bottom:6px;font-size:12px;color:var(--red);font-weight:600;">⚠️ <strong>${outStk.length}</strong> out of stock — ${outStk.slice(0,4).map(i=>escapeHtml(i.code)).join(', ')}${outStk.length>4?' +more':''}</div>`;
    if (lowStk.length) html += `<div style="background:var(--amber-light);border:1px solid #f5d9a0;border-radius:var(--r);padding:10px 12px;margin-bottom:6px;font-size:12px;color:var(--amber);font-weight:600;">📉 <strong>${lowStk.length}</strong> running low — ${lowStk.slice(0,4).map(i=>escapeHtml(i.code)).join(', ')}${lowStk.length>4?' +more':''}</div>`;
    alertEl.innerHTML = html;
  }

  // ── Insights ──────────────────────────────────────────────
  const insights = [];
  if (totalItems === 0) {
    insights.push({ icon:'📦', text:'No items yet — tap ➕ Add to get started', color:'var(--muted)' });
  } else {
    if (totalSalesCount > 0) {
      insights.push({ icon:'🛒', text:`${fmtN(totalSalesCount)} sale${totalSalesCount!==1?'s':''} · avg ${fmt(avgSale)} per sale`, color:'var(--accent2)' });
    }
    if (margin < 0 && totalRevenue > 0) insights.push({ icon:'🚨', text:`Negative margin (${margin.toFixed(1)}%) — selling below cost!`, color:'var(--red)' });
    else if (margin < 10 && totalRevenue > 0) insights.push({ icon:'⚠️', text:`Low margin ${margin.toFixed(1)}% — consider reviewing prices`, color:'#d97706' });
    else if (margin >= 30 && totalRevenue > 0) insights.push({ icon:'🎯', text:`Strong margin: ${margin.toFixed(1)}%`, color:'var(--green)' });

    // Best selling item in period
    if (sales.length > 0) {
      const itemRev = {};
      sales.forEach(s => { itemRev[s.itemCode]=(itemRev[s.itemCode]||0)+(s.revenue||0); });
      const bestCode = Object.entries(itemRev).sort((a,b)=>b[1]-a[1])[0];
      if (bestCode) {
        const bestItem = allItems.find(i=>i.code===bestCode[0]);
        insights.push({ icon:'🏆', text:`Best seller: <strong>${escapeHtml(bestItem?.name||bestCode[0])}</strong> (${fmt(bestCode[1])})`, color:'var(--accent2)' });
      }
    }

    // Best selling category
    if (sales.length > 0) {
      const typeRev = {};
      sales.forEach(s => { typeRev[s.itemType||s.type]=(typeRev[s.itemType||s.type]||0)+(s.revenue||0); });
      const bestType = Object.entries(typeRev).filter(([k])=>k).sort((a,b)=>b[1]-a[1])[0];
      if (bestType) insights.push({ icon:'📂', text:`Top category: <strong>${escapeHtml(bestType[0])}</strong> (${fmt(bestType[1])})`, color:'var(--accent)' });
    }

    // Potential profit still in stock
    if (potProfit > 0) insights.push({ icon:'💎', text:`Potential profit in stock: <strong>${fmt(potProfit)}</strong>`, color:'var(--green)' });

    // Stock turnover
    if (totalPiecesSold > 0 && totalQty > 0) {
      const ratio = (totalPiecesSold/(totalPiecesSold+totalQty)*100).toFixed(0);
      insights.push({ icon:'🔄', text:`${ratio}% of all stock has been sold`, color:'var(--accent)' });
    }
    if (insights.length === 0 && totalItems > 0) insights.push({ icon:'✅', text:'Stock levels healthy — all good', color:'var(--green)' });
  }

  const insightsEl = document.getElementById('d-insights');
  if (insightsEl) {
    insightsEl.innerHTML = insights.length ? insights.map(ins =>
      `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin-bottom:5px;">
        <span style="font-size:16px;flex-shrink:0;">${ins.icon}</span>
        <span style="font-size:12px;font-weight:600;color:${ins.color};line-height:1.5;">${ins.text}</span>
      </div>`
    ).join('') : '';
  }

  // ── Top sellers (period) ──────────────────────────────────
  const topSellersEl = document.getElementById('d-top-sellers');
  if (topSellersEl) {
    if (sales.length === 0) {
      topSellersEl.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px;">No sales in this period</div>`;
    } else {
      const codeRev = {};
      const codeQty = {};
      sales.forEach(s => {
        codeRev[s.itemCode]=(codeRev[s.itemCode]||0)+(s.revenue||0);
        codeQty[s.itemCode]=(codeQty[s.itemCode]||0)+(s.qty||0);
      });
      const topSellers = Object.entries(codeRev).sort((a,b)=>b[1]-a[1]).slice(0,5);
      const maxRev = topSellers[0]?.[1] || 1;
      topSellersEl.innerHTML = topSellers.map(([code,rev],idx) => {
        const item = allItems.find(i=>i.code===code);
        const t    = getTypeObj(item?.type||'');
        const pct  = Math.max(8, Math.round(rev/maxRev*100));
        const qty  = codeQty[code]||0;
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:16px;">${t.emoji}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item?.name||code)}</div>
              <div style="font-size:10px;font-family:var(--mono);color:var(--muted);">${escapeHtml(code)} · ${fmtN(qty)} pcs sold</div>
            </div>
            <div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(rev)}</div>
          </div>
          <div style="background:var(--surface2);border-radius:3px;height:5px;overflow:hidden;">
            <div style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));width:${pct}%;border-radius:3px;"></div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── Top items by stock value ──────────────────────────────
  const topEl = document.getElementById('d-top-items');
  if (topEl) {
    const sorted = [...allItems].sort((a,b)=>((b.sellPrice||b.sell||0)*b.qty)-((a.sellPrice||a.sell||0)*a.qty)).slice(0,5);
    if (!sorted.length) { topEl.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:8px 0;">No items yet</div>`; }
    else {
      const maxVal = (sorted[0].sellPrice||sorted[0].sell||0)*sorted[0].qty || 1;
      topEl.innerHTML = sorted.map(item => {
        const sell = item.sellPrice||item.sell||0;
        const buy  = item.buyPrice||item.buy||0;
        const val  = sell * item.qty;
        const pct  = Math.max(6, Math.round(val/maxVal*100));
        const t    = getTypeObj(item.type);
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="font-size:16px;">${t.emoji}</span>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.name||item.code)}</div>
              <div style="font-size:10px;font-family:var(--mono);color:var(--muted);">${escapeHtml(item.code)} · ${fmtN(item.qty)} pcs · buy ${fmt(buy)}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(val)}</div>
              <div style="font-size:9px;color:var(--green);font-weight:700;">+${fmt((sell-buy)*item.qty)} pot.</div>
            </div>
          </div>
          <div style="background:var(--surface2);border-radius:3px;height:5px;overflow:hidden;">
            <div style="height:100%;background:linear-gradient(90deg,var(--accent3),var(--accent2));width:${pct}%;border-radius:3px;"></div>
          </div>
        </div>`;
      }).join('');
    }
  }

  // ── By type ───────────────────────────────────────────────
  const byType = {};
  allItems.forEach(item => {
    const tp = item.type || 'Unknown';
    if (!byType[tp]) byType[tp] = { qty:0, cost:0, retail:0, count:0, sold:0 };
    byType[tp].qty    += item.qty||0;
    byType[tp].cost   += (item.buyPrice||item.buy||0)*(item.qty||0);
    byType[tp].retail += (item.sellPrice||item.sell||0)*(item.qty||0);
    byType[tp].count++;
  });
  sales.forEach(s => {
    const tp = s.itemType||s.type||'Unknown';
    if (!byType[tp]) byType[tp] = { qty:0, cost:0, retail:0, count:0, sold:0 };
    byType[tp].sold += s.revenue||0;
  });

  const typeEl = document.getElementById('d-by-type');
  if (typeEl) {
    if (!Object.keys(byType).length) { typeEl.innerHTML=''; }
    else {
      typeEl.innerHTML = Object.entries(byType).sort((a,b)=>b[1].retail-a[1].retail).map(([type,data]) => {
        const t = getTypeObj(type);
        const margin = data.retail > 0 ? ((data.retail-data.cost)/data.retail*100).toFixed(0) : 0;
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);padding:12px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <span style="font-size:22px;">${t.emoji}</span>
            <div style="flex:1;">
              <div style="font-weight:700;font-size:13px;">${escapeHtml(type)}</div>
              <div style="font-size:10px;font-family:var(--mono);color:var(--muted);">${data.count} SKU${data.count!==1?'s':''} · ${fmtN(data.qty)} pcs in stock</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10px;font-weight:700;color:var(--green);">Margin ${margin}%</div>
              ${data.sold>0?`<div style="font-size:10px;color:var(--accent2);font-weight:600;">Sold ${fmt(data.sold)}</div>`:''}
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div class="detail-box" style="padding:8px;"><div class="detail-key" style="font-size:9px;">COST VALUE</div><div class="detail-val" style="font-size:12px;color:var(--text2);">${fmt(data.cost)}</div></div>
            <div class="detail-box" style="padding:8px;"><div class="detail-key" style="font-size:9px;">RETAIL VALUE</div><div class="detail-val" style="font-size:12px;color:var(--accent2);">${fmt(data.retail)}</div></div>
          </div>
        </div>`;
      }).join('');
    }
  }
}

// renderSummary removed — content merged into renderDashboard
function renderSummary() { renderDashboard(); }

// ===== HEADER =====
function updateHeader() {
  // header simplified - no counts displayed
}

// ===== CURRENCY =====
function saveCurrency() {
  currency = document.getElementById('currency-sel').value;
  localStorage.setItem('inv_currency', currency);
  updateCurrencyUI();
  renderList();
  toast('Currency: ' + currency, 'ok');
}
function updateCurrencyUI() {
  const sel = document.getElementById('currency-sel');
  if (sel) sel.value = currency;
  const bp = document.getElementById('bp-cur');
  if (bp) bp.textContent = currency;
  const sp = document.getElementById('sp-cur');
  if (sp) sp.textContent = currency;
  const sc = document.getElementById('splash-cur');
  if (sc) sc.textContent = currency;
}

// ===== SPLASH =====
function showSplash(name, sell, profit) {
  const splash = document.getElementById('splash');
  const circle = document.getElementById('splash-circle');
  const tick = document.getElementById('splash-tick');
  const msg = document.getElementById('splash-msg');
  const sub = document.getElementById('splash-sub');
  const profitWrap = document.getElementById('splash-profit-wrap');
  const profitVal = document.getElementById('splash-val');

  sub.textContent = name;
  profitVal.textContent = fmtN(sell);
  // Show profit insight in splash
  const profitLine = document.getElementById('splash-profit-insight');
  if (profitLine) {
    profitLine.textContent = 'Profit: ' + (profit >= 0 ? '+' : '') + fmt(profit) + ' (' + (sell > 0 ? ((profit/sell)*100).toFixed(0) : 0) + '%)';
    profitLine.style.color = profit >= 0 ? 'var(--green)' : 'var(--red)';
  }
  profitWrap.style.display = sell > 0 ? 'block' : 'none';

  circle.style.transform = 'scale(0)';
  tick.style.strokeDashoffset = '65';
  msg.style.opacity = '0';
  sub.style.opacity = '0';
  profitWrap.style.opacity = '0';
  splash.style.opacity = '1';
  splash.style.transition = '';
  splash.style.display = 'flex';

  requestAnimationFrame(() => requestAnimationFrame(() => {
    circle.style.transform = 'scale(1)';
    tick.style.strokeDashoffset = '0';
    msg.style.opacity = '1';
    sub.style.opacity = '1';
    profitWrap.style.opacity = '1';
  }));

  setTimeout(() => {
    splash.style.opacity = '0';
    splash.style.transition = 'opacity 0.35s ease';
    setTimeout(() => {
      splash.style.display = 'none';
    }, 350);
  }, 2200);
}

// ===== EXPORT =====





// ===== MAKE A SALE =====
let currentSellItemId = null;
let _selectedPayment  = 'cash';  // cash | mpesa
let _isShoeSale       = false;
let _sellShoeItem     = null;
let _sellShoeSize     = null;    // full sizeRec object

async function searchSell() {
  try {
  const q = (document.getElementById('sell-search').value || '').trim().toLowerCase();
  const results = document.getElementById('sell-results');
  if (!q) { results.innerHTML = ''; return; }
  const items = await dbAll('items');
  const matched = items.filter(i =>
    i.name.toLowerCase().includes(q) ||
    i.code.toLowerCase().includes(q) ||
    (i.size || '').toLowerCase().includes(q)
  );
  if (!matched.length) {
    results.innerHTML = '<div class="empty" style="padding:24px 0;"><div class="e-icon" style="font-size:36px;">🔍</div><p>No items found</p></div>';
    return;
  }
  results.innerHTML = matched.map(item => {
    const t = getTypeObj(item.type);
    const outOfStock = item.qty === 0;
    const stockColor = outOfStock ? 'var(--red)' : item.qty <= 3 ? 'var(--amber)' : 'var(--green)';
    return `<div class="item-card" onclick="${outOfStock ? '' : 'openSellModal(' + item.id + ')'}"
      style="margin-bottom:10px;${outOfStock ? 'opacity:0.5;pointer-events:none;' : 'cursor:pointer;'}">
      <div class="item-top">
        <div class="item-icon" style="background:${t.color||'var(--surface2)'};">${t.emoji}</div>
        <div class="item-body">
          <div class="item-code">${item.code}${item.size ? ' · ' + item.size : ''}</div>
          <div class="item-name">${item.name || ''}</div>
          <div class="item-tags">
            <span class="tag tag-cyan">${item.type}</span>
            <span class="tag" style="background:${outOfStock?'var(--red-light)':item.qty<=3?'var(--amber-light)':'var(--green-light)'};color:${stockColor};">
              ${outOfStock ? '✕ Out of stock' : item.qty + ' pcs'}
            </span>
          </div>
        </div>
        <div class="item-right">
          <div style="font-size:18px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(item.sell)}</div>
          <div style="font-size:11px;color:var(--green);font-family:var(--mono);margin-top:3px;">+${fmt(item.profit)} profit</div>
          ${!outOfStock ? '<div style="margin-top:8px;background:var(--accent);color:white;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;text-align:center;">💸 Sell</div>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  } catch(e) { console.error("[searchSell]", e); toast("Error: " + e.message, "err"); }
}

async function searchSell() {
  try {
    const q = (document.getElementById('sell-search')?.value || '').trim().toLowerCase();
    const results = document.getElementById('sell-results');
    if (!results) return;
    const items = await dbAll('items');
    const sizes = await dbAll('shoe_sizes');
    const rows = [];

    items.forEach(item => {
      const t = getTypeObj(item.type);
      const hay = [item.name, item.code, item.size, item.variant, item.type].join(' ').toLowerCase();
      if (item.isShoe) {
        sizes.filter(sz => sz.itemCode === item.code && (sz.qty || 0) > 0).forEach(sz => {
          const sizeHay = (hay + ' ' + sz.size + ' ' + (sz.sizeGroup || '')).toLowerCase();
          if (q && !sizeHay.includes(q)) return;
          const price = sz.sellPrice || item.sellPrice || item.sell || 0;
          const buy = sz.buyPrice || item.buyPrice || item.buy || 0;
          rows.push({ item, t, label: item.name || item.code, meta: item.code + ' - Size ' + sz.size, qty: sz.qty || 0, price, profit: price - buy, action: 'openSellShoeModal(' + item.id + ',' + sz.size + ')', extraTag: '<span class="tag tag-gray">Size ' + escapeHtml(sz.size) + '</span>' });
        });
        return;
      }
      if ((item.qty || 0) <= 0) return;
      if (q && !hay.includes(q)) return;
      const price = item.sellPrice || item.sell || 0;
      const buy = item.buyPrice || item.buy || 0;
      rows.push({ item, t, label: item.name || item.code, meta: item.code + (item.size || item.variant ? ' - ' + (item.size || item.variant) : ''), qty: item.qty || 0, price, profit: price - buy, action: 'openSellModal(' + item.id + ')', extraTag: '' });
    });

    rows.sort((a, b) => (a.label || '').localeCompare(b.label || ''));
    const visibleRows = rows.slice(0, 120);
    const offStockButton = '<button onclick="openOffStockSale()" class="stock-add-wish-btn" style="margin-bottom:12px;background:#1d4ed8;"><i class="fa-solid fa-plus"></i> Sell item not in stock</button>';
    if (!visibleRows.length) {
      results.innerHTML = '<div class="empty" style="padding:24px 0;"><div class="e-icon" style="font-size:36px;">Search</div><p>No available stock found.</p></div>' + offStockButton;
      return;
    }
    results.innerHTML = offStockButton + visibleRows.map(row => {
      const stockColor = row.qty <= 3 ? 'var(--amber)' : 'var(--green)';
      return '<div class="item-card" onclick="' + row.action + '" style="margin-bottom:10px;cursor:pointer;">' +
        '<div class="item-top">' +
          '<div class="item-icon" style="background:' + (row.t.color || 'var(--surface2)') + ';">' + row.t.emoji + '</div>' +
          '<div class="item-body">' +
            '<div class="item-code">' + escapeHtml(row.meta) + '</div>' +
            '<div class="item-name">' + escapeHtml(row.label || '') + '</div>' +
            '<div class="item-tags">' +
              '<span class="tag tag-cyan">' + escapeHtml(row.item.type || '') + '</span>' +
              row.extraTag +
              '<span class="tag" style="background:' + (row.qty <= 3 ? 'var(--amber-light)' : 'var(--green-light)') + ';color:' + stockColor + ';">' + row.qty + ' pcs</span>' +
            '</div>' +
          '</div>' +
          '<div class="item-right">' +
            '<div style="font-size:18px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(row.price) + '</div>' +
            '<div style="font-size:11px;color:' + (row.profit >= 0 ? 'var(--green)' : 'var(--red)') + ';font-family:var(--mono);margin-top:3px;">' + (row.profit >= 0 ? '+' : '') + fmt(row.profit) + ' profit</div>' +
            '<div style="margin-top:8px;background:var(--accent);color:white;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;text-align:center;">Sell</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) { console.error("[searchSell]", e); toast("Error: " + e.message, "err"); }
}

function selectPayment(method) {
  _selectedPayment = method;
  // Reset all payment buttons
  document.querySelectorAll('.pay-btn').forEach(btn => btn.classList.remove('active'));
  // Activate selected
  const idMap = { cash: 'pay-cash', mpesa: 'pay-mpesa', Cash: 'pay-cash', 'M-Pesa': 'pay-mpesa' };
  const btnId = idMap[method] || 'pay-cash';
  const btn = document.getElementById(btnId);
  if (btn) btn.classList.add('active');
}

function renderOffstockTypeOptions() {
  const sel = document.getElementById('off-type');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Category</option>' +
    types.map(t => '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.name) + '</option>').join('');
  if (cur) sel.value = cur;
}

function openOffStockSale() {
  renderOffstockTypeOptions();
  const sheet = document.getElementById('offstock-sale-sheet');
  if (sheet) sheet.classList.add('open');
  setTimeout(() => document.getElementById('off-name')?.focus(), 80);
}

function closeOffStockSale() {
  const sheet = document.getElementById('offstock-sale-sheet');
  if (sheet) sheet.classList.remove('open');
}

async function confirmOffStockSale() {
  const name = (document.getElementById('off-name')?.value || '').trim();
  const code = sanitiseCode(document.getElementById('off-code')?.value || '');
  const type = document.getElementById('off-type')?.value || '';
  const size = (document.getElementById('off-size')?.value || '').trim();
  const qty = parseInt(document.getElementById('off-qty')?.value || '0');
  const buyPrice = parseFloat(document.getElementById('off-buy')?.value || '0') || 0;
  const sellPrice = parseFloat(document.getElementById('off-sell')?.value || '0') || 0;
  const paymentMethod = document.getElementById('off-payment')?.value || 'cash';
  if (!name && !code) return Validate.fail('Enter item name or code', 'off-name');
  if (!type) return Validate.fail('Select a category', 'off-type');
  if (!Validate.restockQty(qty, 'off-qty')) return;
  if (!Validate.salePrice(sellPrice, buyPrice, sellPrice)) return;

  const revenue = qty * sellPrice;
  const profit = qty * (sellPrice - buyPrice);
  const sale = {
    itemId: null,
    itemCode: code,
    itemName: name || code,
    itemType: type,
    itemSize: size,
    qty,
    buyPrice,
    sellPrice,
    actualPrice: sellPrice,
    revenue,
    profit,
    overridden: false,
    paymentMethod,
    unaccounted: true,
    soldBy: currentUser ? currentUser.username : 'system',
    businessDate: todayDateStr(),
    date: new Date().toISOString(),
  };
  sale.id = await dbAdd('sales', sale);
  try { fbSyncSale(sale); } catch(_) { /* intentionally ignored */ }

  const monitorRow = {
    name: name || code,
    code,
    type,
    qty,
    estimatedCost: buyPrice,
    note: 'Sold before stock count',
    status: 'unaccounted',
    saleId: sale.id,
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : 'system'
  };
  monitorRow.id = await dbAdd('wishlist', monitorRow);

  try {
    const finEntry = {
      type: 'revenue',
      amount: revenue,
      costAmount: buyPrice * qty,
      profit,
      description: 'Sale not accounted: ' + (name || code) + ' x ' + qty,
      category: 'sales',
      paymentMethod,
      saleId: sale.id,
      itemCode: code,
      date: todayDateStr(),
      createdAt: new Date().toISOString(),
      createdBy: currentUser ? currentUser.username : 'system',
    };
    finEntry.id = await dbAdd('finances', finEntry);
  } catch(e) {
    console.warn('[FINANCE] Off-stock auto-record failed:', e.message);
  }

  ['off-name','off-code','off-size','off-qty','off-buy','off-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = id === 'off-qty' ? '1' : '';
  });
  closeOffStockSale();
  await renderStockMonitor();
  await renderSellPage();
  try { renderDashboard(); } catch(_) { /* intentionally ignored */ }
  try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
  scheduleSync();
  toast('Sale recorded · monitor marked NOT ACCOUNTED', 'ok');
}

async function openSellModal(itemId) {
  try {
  const item = await dbGet('items', itemId);
  if (!item) { toast('⚠️ Item not found', 'err'); return; }
  if (item.qty <= 0) {
    toast('⚠️ ' + (item.name || item.code) + ' is out of stock — restock first', 'err');
    return;
  }
  currentSellItemId = itemId;
  const t = getTypeObj(item.type);
  document.getElementById('sm-icon').textContent = t.emoji;
  document.getElementById('sm-icon').style.background = t.color || 'var(--surface2)';
  document.getElementById('sm-name').textContent = item.name;
  document.getElementById('sm-meta').textContent = item.code + (item.size ? ' · ' + item.size : '');
  document.getElementById('sm-stock').textContent = item.qty;
  const _itemSell = item.sellPrice || item.sell || 0;
  const _itemBuy  = item.buyPrice  || item.buy  || 0;
  document.getElementById('sm-sell').textContent = fmt(_itemSell);
  const _smProfit = document.getElementById('sm-profit');
  if (_smProfit) _smProfit.textContent = (_itemSell - _itemBuy >= 0 ? '+' : '') + fmt(_itemSell - _itemBuy);
  const _tpel=document.getElementById('sm-total-profit'); if(_tpel) _tpel.textContent = (_itemSell - _itemBuy >= 0 ? '+' : '') + fmt(_itemSell - _itemBuy);
  document.getElementById('sm-cur').textContent = currency;
  document.getElementById('sm-qty').value = 1;
  document.getElementById('sm-qty').max = item.qty;
  document.getElementById('sm-actual').value = '';
  updateSellModal();
  selectPayment('cash'); // reset payment method
  document.getElementById('sell-modal').classList.add('open');
  } catch(e) { console.error("[openSellModal]", e); toast("Error: " + e.message, "err"); }
}

function closeSellModal() {
  const modal = document.getElementById('sell-modal');
  if (modal) modal.classList.remove('open');
  currentSellItemId = null;
  _isShoeSale   = false;
  _sellShoeItem = null;
  _sellShoeSize = null;
}

async function updateSellModal() {
  try {
  if (!currentSellItemId) return;
  const item = await dbGet('items', currentSellItemId);
  // For shoe sales use the specific size record prices & stock
  const basePrice = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.sellPrice || item.sellPrice || item.sell || 0) : (item.sell || item.sellPrice || 0);
  const baseBuy   = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.buyPrice  || item.buyPrice  || item.buy  || 0) : (item.buy  || item.buyPrice  || 0);
  const maxStock  = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.qty || 0) : (item.qty || 0);
  const qty = Math.max(1, parseInt(document.getElementById('sm-qty').value) || 1);
  const actualRaw = parseFloat(document.getElementById('sm-actual').value);
  const priceUsed = (!isNaN(actualRaw) && actualRaw > 0) ? actualRaw : basePrice;
  const totalRev = qty * priceUsed;
  const totalProfit = qty * (priceUsed - baseBuy);
  const overridden = !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== basePrice;
  document.getElementById('sm-price-used').textContent = fmt(priceUsed) + (overridden ? ' (custom)' : ' (default)');
  document.getElementById('sm-total-rev').textContent = fmt(totalRev);
  document.getElementById('sm-total-profit').textContent = (totalProfit >= 0 ? '+' : '') + fmt(totalProfit);
  document.getElementById('sm-total-profit').style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('sm-qty').max = maxStock;
  // Update per-item profit display + warn if below cost
  const profitPerItem = priceUsed - baseBuy;
  const smProfit = document.getElementById('sm-profit');
  if (smProfit) {
    smProfit.textContent = (profitPerItem >= 0 ? '+' : '') + fmt(profitPerItem);
    smProfit.style.color = profitPerItem >= 0 ? 'var(--green)' : 'var(--red)';
  }
  // Warn confirm button if below-cost
  const confirmBtn = document.getElementById('confirm-sale-btn');
  if (confirmBtn) {
    if (priceUsed < baseBuy && priceUsed > 0) {
      confirmBtn.style.background = 'var(--red)';
      confirmBtn.title = 'Warning: selling below cost price';
    } else {
      confirmBtn.style.background = '';
      confirmBtn.title = '';
    }
  }
  } catch(e) { console.error("[updateSellModal]", e); toast("Error: " + e.message, "err"); }
}

function adjSellQty(d) {
  const inp = document.getElementById('sm-qty');
  let v = (parseInt(inp.value) || 1) + d;
  const max = parseInt(inp.max) || 9999;
  if (v > max) { toast('⚠️ Only ' + max + ' in stock', 'err'); v = max; }
  inp.value = Math.max(1, v);
  updateSellModal();
}

async function confirmSale() {
  if (!currentSellItemId) return;

  // Gray out confirm button + show progress overlay
  const _confirmBtn = document.getElementById('confirm-sale-btn');
  _overlay.show('Processing Sale…', _confirmBtn);

  try {

  const item = await dbGet('items', currentSellItemId);
  if (!item) { toast('Item not found', 'err'); closeSellModal(); _overlay.hide(); return; }

  // ── Read form values ───────────────────────────────────────────
  const qtyEl     = document.getElementById('sm-qty');
  const actualEl  = document.getElementById('sm-actual');
  const qty       = Math.max(1, parseInt(qtyEl?.value || '1') || 1);
  const actualRaw = parseFloat(actualEl?.value || '');

  // ── Prices — use normalized sellPrice/buyPrice ─────────────────
  const sellPrice = _isShoeSale && _sellShoeSize
    ? (_sellShoeSize.sellPrice || item.sellPrice || item.sell || 0)
    : (item.sellPrice || item.sell || 0);
  const buyPrice  = _isShoeSale && _sellShoeSize
    ? (_sellShoeSize.buyPrice  || item.buyPrice  || item.buy  || 0)
    : (item.buyPrice  || item.buy  || 0);

  const priceUsed = (!isNaN(actualRaw) && actualRaw > 0) ? actualRaw : sellPrice;

  // ── Validate stock ─────────────────────────────────────────────
  const maxQty = _isShoeSale && _sellShoeSize ? _sellShoeSize.qty : item.qty;
  const itemLabel = item.name || item.code;
  if (!Validate.stock(qty, maxQty, itemLabel)) return;

  // ── Validate sale price ────────────────────────────────────────
  if (!Validate.salePrice(priceUsed, buyPrice, sellPrice)) return;

  const revenue = qty * priceUsed;
  const profit  = qty * (priceUsed - buyPrice);

  const paymentMethod = _selectedPayment || 'cash';

  const sale = {
    itemId:        item.id,
    itemCode:      item.code,
    itemName:      item.name || item.code,
    itemType:      item.type || '',
    itemSize:      _isShoeSale && _sellShoeSize ? String(_sellShoeSize.size) : (item.variant || item.size || ''),
    qty,
    buyPrice,
    sellPrice,
    actualPrice:   priceUsed,
    revenue,
    profit,
    overridden:    !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== sellPrice,
    paymentMethod,
    soldBy:        currentUser ? currentUser.username : 'system',
    businessDate:  todayDateStr(), // auto-assigned by date
    date:          new Date().toISOString(),
  };

  // ── Deduct stock ───────────────────────────────────────────────
  if (_isShoeSale && _sellShoeSize) {
    _sellShoeSize.qty = Math.max(0, (_sellShoeSize.qty || 0) - qty);
    _sellShoeSize.updatedAt = new Date().toISOString();
    await dbPut('shoe_sizes', _sellShoeSize);
    const allSz = await getShoeSizes(item.code);
    item.qty = allSz.reduce((t, s) => t + s.qty, 0);
    if (fbReady && fbDb) {
      try {
        const { doc, setDoc } = await waitForFbImports();
        if (!_sellShoeSize.fbId) _sellShoeSize.fbId = 'sz_' + _sellShoeSize.codeSize;
        await setDoc(doc(fbDb, 'shoe_sizes', _sellShoeSize.fbId), sanitiseForFirestore({..._sellShoeSize}));
      } catch(e) { console.warn('[SYNC] shoe size:', e.message); }
    }
  } else {
    item.qty = Math.max(0, item.qty - qty);
  }
  await dbPut('items', item);

  // ── Record sale ────────────────────────────────────────────────
  const newSaleId = await dbAdd('sales', sale);
  sale.id = newSaleId;
  fbSyncItem(item);
  fbSyncSale(sale);

  // ── AUTO-RECORD TO FINANCES ────────────────────────────────────
  // Every sale automatically creates a finance revenue entry
  try {
    const finEntry = {
      type:        'revenue',
      amount:      revenue,
      costAmount:  buyPrice * qty,
      profit:      profit,
      description: 'Sale: ' + (item.name || item.code) +
                   (_isShoeSale && _sellShoeSize ? ' (Size ' + _sellShoeSize.size + ')' : '') +
                   ' × ' + qty,
      category:    'sales',
      paymentMethod,
      saleId:      newSaleId,
      itemCode:    item.code,
      date:        todayDateStr(),
      createdAt:   new Date().toISOString(),
      createdBy:   currentUser ? currentUser.username : 'system',
    };
    finEntry.id = await dbAdd('finances', finEntry);
    // Sync to Firebase
    if (fbReady && fbDb) {
      try {
        const { doc, setDoc } = await waitForFbImports();
        const fbFinId = 'fin_sale_' + newSaleId;
        finEntry.fbId = fbFinId;
        await setDoc(doc(fbDb, 'finances', fbFinId), sanitiseForFirestore({...finEntry}));
        await dbPut('finances', finEntry);
      } catch(e) { console.warn('[SYNC] finance entry:', e.message); }
    }
  } catch(e) {
    console.warn('[FINANCE] Auto-record failed:', e.message);
  }

  // ── Close all overlays ─────────────────────────────────────────
  closeSellModal();       // sell modal
  closeSheet();           // detail sheet (if open)
  closeShoeSizeActions(); // size action sheet (if open)

  // ── Reset sell search if on sell page ─────────────────────────
  const sellSearch = document.getElementById('sell-search');
  const sellResults = document.getElementById('sell-results');
  if (sellSearch)  sellSearch.value = '';
  if (sellResults) sellResults.innerHTML = '';

  // ── Refresh UI ─────────────────────────────────────────────────
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList();
  renderDashboard();
  updateHeader();
  updateLowStockBadge();
  scheduleSync();
  try { renderSellPage(); } catch(_) { /* intentionally ignored */ }
  try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
  // Refresh finance page if it's currently visible
  try {
    const financeVisible = document.getElementById('page-finance')?.classList.contains('active') ||
      (document.getElementById('page-operations')?.classList.contains('active') && _activeOperationsTab === 'finance');
    if (financeVisible) {
      renderFinancePage();
    }
  } catch(_) { /* intentionally ignored */ }

  toast('✅ ' + fmt(revenue) + ' · Profit: ' + fmt(profit), 'ok');

  } catch(err) {
    console.error('[confirmSale]', err);
    toast('⚠️ Sale failed: ' + (err.message || 'Unknown error'), 'err');
  } finally {
    _overlay.hide();
  }
}

async function renderSellPage() {
  try {
  const sales = await dbAll('sales');
  const todayStr = new Date().toISOString().split('T')[0];
  const todaySales = sales.filter(s => s.date.startsWith(todayStr));
  const todayRev = todaySales.reduce((a, s) => a + s.revenue, 0);
  const todayProfit = todaySales.reduce((a, s) => a + s.profit, 0);
  document.getElementById('sell-today-rev').textContent = fmt(todayRev);
  document.getElementById('sell-today-profit').textContent = fmt(todayProfit);
  await searchSell();

  // Apply date filter
  const filterEl = document.getElementById('sales-filter');
  const period = filterEl ? filterEl.value : 'today';
  const filtered = filterSalesByPeriod([...sales].sort((a,b) => new Date(b.date)-new Date(a.date)), period).slice(0,100);

  const hist = document.getElementById('sell-history');
  if (!filtered.length) {
    hist.innerHTML = '<div class="empty" style="padding:24px 0;"><div class="e-icon" style="font-size:36px;">💸</div><p>No sales for this period</p></div>';
    return;
  }
  const periodRevenue = filtered.reduce((a,s)=>a+s.revenue,0);
  const periodProfit = filtered.reduce((a,s)=>a+s.profit,0);
  hist.innerHTML =
    '<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:2px solid var(--border);margin-bottom:4px;">' +
    '<span style="font-size:12px;color:var(--muted);">' + filtered.length + ' sales</span>' +
    '<span style="font-size:12px;font-family:var(--mono);color:var(--accent2);">' + fmt(periodRevenue) + ' · <span style="color:var(--green);">+' + fmt(periodProfit) + '</span></span>' +
    '</div>' +
    filtered.map(s => {
      const t = getTypeObj(s.type || s.itemType);
      const d = new Date(s.date);
      const timeStr = d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) + ' ' +
                      d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
      return `<div style="display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--border);">
        <div style="font-size:20px;">${t.emoji}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${s.itemName} × ${s.qty}</div>
          <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">${timeStr}${s.overridden ? ' · <span style="color:var(--amber);">custom price</span>' : ''}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(s.revenue)}</div>
          <div style="font-size:11px;font-family:var(--mono);color:${s.profit>=0?'var(--green)':'var(--red)'};">${s.profit>=0?'+':''}${fmt(s.profit)}</div>
        </div>
        <button onclick="deleteSale(${s.id})" style="background:var(--red-light);border:none;color:var(--red);border-radius:6px;padding:6px 8px;cursor:pointer;font-size:13px;flex-shrink:0;">🗑</button>
      </div>`;
    }).join('');
  } catch(e) { console.error("[renderSellPage]", e); toast("Error: " + e.message, "err"); }
}

// close sell modal on backdrop click
const _sellModal = document.getElementById('sell-modal');
if (_sellModal) _sellModal.addEventListener('click', function(e) {
  if (e.target === this) closeSellModal();
});


function addSyncLog() {} // bell removed


function toggleNotifPanel(){const p=document.getElementById('notif-panel');const b=document.getElementById('notif-backdrop');if(!p)return;const open=p.style.display!=='none';p.style.display=open?'none':'block';if(b)b.style.display=open?'none':'block';}
function clearNotifs(){const l=document.getElementById('notif-list');if(l)l.innerHTML='<div style="color:var(--muted);font-size:13px;padding:8px;">No events yet</div>';}
function addNotif(msg){const l=document.getElementById('notif-list');if(!l)return;const e=document.createElement('div');e.style.cssText='padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;';e.textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+' '+msg;l.insertBefore(e,l.firstChild);}
function closePastSessionSheet(){const s=document.getElementById('past-session-sheet');if(s)s.classList.remove('open');}

// ═══════════════════════════════════════════════════════════════
// FACTORY RESET — clears ALL local data and Firebase
// Only accessible to Super User in Settings
// ═══════════════════════════════════════════════════════════════
// ── Full database rebuild — wipes all data and starts fresh ────────
async function resetAndRebuildDB() {
  const msg =
    '⚠️ FULL DATABASE RESET\n\n' +
    'This will:\n' +
    '• Delete ALL items, sales, finances, shoe sizes\n' +
    '• Delete ALL business day records\n' +
    '• Clear Firebase cloud data if connected\n' +
    '• Recreate the database schema clean (v' + DB_VER + ')\n\n' +
    'Your login and preferences are kept.\n' +
    'This CANNOT be undone. Type RESET to confirm:';

  const input = prompt(msg);
  if (input !== 'RESET') { toast('Reset cancelled', ''); return; }

  try {
    toast('🗑️ Rebuilding database…', '');

    // 1. Clear all IndexedDB data stores
    await DB.clearAll([
      STORES.ITEMS, STORES.SALES, STORES.SIZES,
      STORES.FINANCES, STORES.BDAYS, STORES.TYPES, STORES.WISHLIST,
    ]);
    console.log('[DB] All stores cleared');

    // 2. Clear Firebase if connected
    if (fbReady && fbDb) {
      try {
        const { collection, getDocs, writeBatch, doc } = await waitForFbImports();
        for (const col of [STORES.ITEMS, STORES.SALES, STORES.SIZES, STORES.FINANCES, STORES.BDAYS, STORES.WISHLIST]) {
          const snap = await getDocs(collection(fbDb, col));
          if (snap.empty) continue;
          let batch = writeBatch(fbDb); let n = 0;
          for (const d of snap.docs) {
            batch.delete(doc(fbDb, col, d.id));
            if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); n = 0; }
          }
          if (n > 0) await batch.commit();
        }
        console.log('[DB] Firebase cleared');
      } catch(e) { console.warn('[DB] Firebase clear partial:', e.message); }
    }

    // 3. Reset in-memory state
    allItems  = [];
    activeDay = null;
    types     = [];

    // 4. Clear relevant localStorage keys (keep session + prefs)
    const keep = {
      [KEY_SESSION]:     localStorage.getItem(KEY_SESSION),
      [KEY_CURRENCY]:    localStorage.getItem(KEY_CURRENCY),
      [KEY_SHOE_GROUPS]: localStorage.getItem(KEY_SHOE_GROUPS),
    };
    localStorage.clear();
    Object.entries(keep).forEach(([k, v]) => v && localStorage.setItem(k, v));

    // 5. Reload default types and re-render
    await loadTypes();
    renderList();
    renderDashboard();
    updateHeader();
    try { updateLowStockBadge(); } catch(_) { /* intentionally ignored */ }

    toast('✅ Database rebuilt clean — fresh start!', 'ok');
    console.log('[DB] Rebuild complete v' + DB_VER);

  } catch(e) {
    toast('❌ Rebuild failed: ' + e.message, 'err');
    console.error('[DB]', e);
  }
}
window.resetAndRebuildDB = resetAndRebuildDB;

async function resetAllData() {
  const confirmed = confirm(
    '⚠️ RESET ALL DATA\n\n' +
    'This will permanently delete:\n' +
    '• All inventory items\n' +
    '• All sales records\n' +
    '• All business day records\n' +
    '• All shoe size records\n\n' +
    'Firebase will also be cleared if connected.\n\n' +
    'This CANNOT be undone. Proceed?'
  );
  if (!confirmed) return;

  try {
    toast('🗑️ Clearing database…', '');

    // ── 1. Clear IndexedDB using store.clear() ────────────────────
    // This is atomic and reliable — clears entire store in one op
    const stores = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes', 'finances', 'wishlist'];
    await new Promise((resolve, reject) => {
      const tx = db.transaction(
        stores.filter(s => db.objectStoreNames.contains(s)),
        'readwrite'
      );
      tx.onerror = e => reject(e.target.error);
      tx.oncomplete = () => resolve();
      stores.forEach(s => {
        if (db.objectStoreNames.contains(s)) {
          tx.objectStore(s).clear();
        }
      });
    });
    console.log('[RESET] IndexedDB cleared');

    // ── 2. Clear Firebase if connected ────────────────────────────
    if (fbReady && fbDb) {
      try {
        const { collection, getDocs, deleteDoc, doc, writeBatch } = await waitForFbImports();
        for (const col of ['items', 'sales', 'business_days', 'shoe_sizes', 'wishlist']) {
          const snap = await getDocs(collection(fbDb, col));
          if (!snap.empty) {
            // Use batched deletes (max 500 per batch)
            let batch = writeBatch(fbDb);
            let count = 0;
            for (const d of snap.docs) {
              batch.delete(doc(fbDb, col, d.id));
              count++;
              if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
            }
            if (count > 0) await batch.commit();
          }
        }
        console.log('[RESET] Firebase cleared');
      } catch(e) {
        console.warn('[RESET] Firebase partial:', e.message);
        toast('⚠️ Firebase may not be fully cleared: ' + e.message, 'err');
      }
    }

    // ── 3. Reset in-memory state ──────────────────────────────────
    allItems = [];
    activeDay = null;

    // ── 4. Reset localStorage (keep session + preferences) ───────
    const keep = {
      [KEY_SESSION]:     localStorage.getItem(KEY_SESSION),
      [KEY_CURRENCY]:    localStorage.getItem(KEY_CURRENCY),
      [KEY_SHOE_GROUPS]: localStorage.getItem(KEY_SHOE_GROUPS),
    };
    localStorage.clear();
    Object.entries(keep).forEach(([k,v]) => { if (v) localStorage.setItem(k, v); });

    // ── 5. Reload default types + refresh UI ─────────────────────
    await loadTypes();
    renderList();
    renderDashboard();
    updateHeader();
    try { renderSellPage(); } catch(e) {}
    try { updateLowStockBadge(); } catch(e) {}

    toast('✅ All data cleared — fresh start!', 'ok');
    console.log('[RESET] Complete');

  } catch(e) {
    toast('❌ Reset failed: ' + e.message, 'err');
    console.error('[RESET] Error:', e);
  }
}

// ===== FIREBASE SYNC =====
let fbApp = null, fbDb = null, fbUnsub = null;
let fbReady = false;
let _localWriting = false; // prevents echo: set true when we write to Firestore
let syncQueue = [];
let isSyncing = false;

function setFbStatus(status) {
  const dot = document.getElementById('fb-status-dot');
  const txt = document.getElementById('fb-status-text');
  const colors = { off:'var(--muted)', connecting:'var(--amber)', on:'var(--green)', error:'var(--red)', syncing:'#3b82f6' };
  const now = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const labels = {
    off: 'Not connected',
    connecting: 'Connecting to Firebase…',
    on:  '✅ Connected · Last sync ' + now,
    error: '❌ Sync error — tap Reconnect in Settings',
    syncing: '⏳ Syncing…'
  };
  if (dot) { dot.style.background = colors[status]; dot.style.boxShadow = status==='on' ? '0 0 6px var(--green)' : 'none'; }
  if (txt) txt.textContent = labels[status];

  // Update sync bar under header
  const bar = document.getElementById('sync-bar');
  const barDot = document.getElementById('sync-bar-dot');
  const barTxt = document.getElementById('sync-bar-text');
  const barTime = document.getElementById('sync-bar-time');
  if (!bar) return;
  const barColors = { off:'#888', connecting:'#f59e0b', on:'#4ade80', error:'#f87171', syncing:'#60a5fa' };
  const barLabels = { off:'Offline', connecting:'Connecting…', on:'Live', error:'Sync Error', syncing:'Syncing…' };
  bar.style.display = 'flex';
  if (barDot) barDot.style.background = barColors[status] || '#888';
  if (barTxt) barTxt.textContent = barLabels[status] || status;
  if (barTime && (status === 'on' || status === 'syncing')) barTime.textContent = now;
  if (status === 'on') {
    // Auto hide after 5s
    clearTimeout(window._syncBarTimer);
    window._syncBarTimer = setTimeout(() => { if (bar) bar.style.display = 'none'; }, 5000);
  } else {
    clearTimeout(window._syncBarTimer);
    bar.style.display = 'flex';
  }
}

// ===== HARDCODED FIREBASE CONFIG =====
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCCHwRweqKLQeXFOOiqNLbZ2vJAzdZAD2U",
  authDomain: "mandela-generals.firebaseapp.com",
  projectId: "mandela-generals",
  storageBucket: "mandela-generals.firebasestorage.app",
  messagingSenderId: "467998749242",
  appId: "1:467998749242:web:222226a3a0e767eb067b03",
  measurementId: "G-W184ZWRGJH"
};

async function initFirebase() {
  try {
    setFbStatus('connecting');
    const {
      initializeApp, getApp, getApps,
      getFirestore, onSnapshot, collection
    } = await waitForFbImports();

    // Reuse existing Firebase app to avoid "duplicate app" errors
    const apps = getApps();
    fbApp  = apps.find(a => a.name === 'mandela') || initializeApp(FIREBASE_CONFIG, 'mandela');
    fbDb   = getFirestore(fbApp);
    fbReady = true;

    // Unsub old listeners before creating new ones
    if (typeof fbUnsub === 'function')           { fbUnsub(); }
    if (typeof window._fbUnsubSales === 'function') { window._fbUnsubSales(); }
    if (typeof window._fbUnsubBd    === 'function') { window._fbUnsubBd(); }
    fbUnsub = null; window._fbUnsubSales = null; window._fbUnsubBd = null;

    // ── items listener ───────────────────────────────────────────
    fbUnsub = onSnapshot(collection(fbDb, 'items'), async snap => {
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
      if (!changes.length) return;
      const localItems = await dbAll('items');
      const byFbId = Object.fromEntries(localItems.filter(i=>i.fbId).map(i=>[i.fbId,i]));
      const byCode = Object.fromEntries(localItems.filter(i=>i.code).map(i=>[i.code,i]));
      let changed = false;
      for (const c of changes) {
        const data = { ...c.doc.data(), fbId: c.doc.id };
        delete data.id;
        if (c.type === 'removed') {
          const loc = byFbId[c.doc.id];
          if (loc) { await dbDelete('items', loc.id); changed = true; }
        } else {
          const ex = byFbId[c.doc.id] || byCode[data.code];
          if (ex) { data.id = ex.id; await dbPut('items', data); }
          else    { try { await dbAdd('items', data); } catch(_) { /* intentionally ignored */ } }
          changed = true;
        }
      }
      if (changed) {
        allItems = await dbAll('items');
        await enrichShoeItems(allItems);
        renderList(); renderDashboard(); updateHeader();
        setFbStatus('on');
      }
    }, err => { setFbStatus('error'); console.error('[FB] items listener:', err.message); });

    // ── sales listener ───────────────────────────────────────────
    window._fbUnsubSales = onSnapshot(collection(fbDb, 'sales'), async snap => {
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
      if (!changes.length) return;
      const localSales = await dbAll('sales');
      const byFbId = Object.fromEntries(localSales.filter(s=>s.fbId).map(s=>[s.fbId,s]));
      for (const c of changes) {
        const data = { ...c.doc.data(), fbId: c.doc.id };
        delete data.id;
        if (c.type === 'removed') {
          const loc = byFbId[c.doc.id];
          if (loc) await dbDelete('sales', loc.id);
        } else {
          const ex = byFbId[c.doc.id];
          if (ex) { data.id = ex.id; await dbPut('sales', data); }
          else    { try { await dbAdd('sales', data); } catch(_) { /* intentionally ignored */ } }
        }
      }
      try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
      try { renderDashboard(); } catch(_) { /* intentionally ignored */ }
    }, err => { console.error('[FB] sales listener:', err.message); });

    setFbStatus('on');
    toast('☁️ Firebase connected', 'ok');
    // Pull remote data to catch any changes made on other devices
    await pullFromFirebase(true);

  } catch(e) {
    setFbStatus('error');
    fbReady = false;
    console.error('[FB] initFirebase error:', e);
    toast('Firebase error: ' + e.message, 'err');
  }
}


function waitForFbImports() {
  return new Promise((res, rej) => {
    let attempts = 0;
    const check = () => {
      if (window._fbImports) { res(window._fbImports); return; }
      if (window._fbImports === null) { rej(new Error('Firebase SDK failed to load')); return; }
      if (++attempts > 150) { rej(new Error('Firebase SDK timeout after 15s')); return; }
      setTimeout(check, 100);
    };
    check();
  });
}

async function saveFirebaseConfig() {
  try {
  // Config is hardcoded — just reconnect
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  fbApp = null; fbDb = null; fbReady = false;
  await initFirebase();
  } catch(e) { console.error("[saveFirebaseConfig]", e); toast("Error: " + e.message, "err"); }
}

async function fbSyncItem(item) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    if (!item.fbId) {
      item.fbId = 'item_' + (item.code || 'x').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now();
      await dbPut('items', item);
    }
    const data = sanitiseForFirestore({ ...item, updatedAt: new Date().toISOString() });
    _localWriting = true;
    await setDoc(doc(fbDb, 'items', item.fbId), data);
    // Reset write lock after Firestore echo window
    setTimeout(() => { _localWriting = false; }, 2000);
  } catch(e) { _localWriting = false; console.error('[SYNC] fbSyncItem error:', e.message); }
}

async function fbDeleteItem(fbId) {
  if (!fbReady || !fbDb || !fbId) return;
  try {
    const { doc, deleteDoc } = await waitForFbImports();
    await deleteDoc(doc(fbDb, 'items', fbId));
  } catch (e) { console.error('fbDeleteItem error', e); }
}

async function fbSyncSale(sale) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    if (!sale.fbId) {
      const safeDate = (sale.date||new Date().toISOString()).replace(/[^0-9]/g,'').slice(0,14);
      sale.fbId = 'sale_' + safeDate + '_' + (sale.itemCode||'x').replace(/[^a-zA-Z0-9_-]/g,'_') + '_' + (sale.id||Math.random().toString(36).slice(2,6));
      if (sale.id) await dbPut('sales', sale);
    }
    const data = sanitiseForFirestore({ ...sale });
    _localWriting = true;
    await setDoc(doc(fbDb, 'sales', sale.fbId), data);
    setTimeout(() => { _localWriting = false; }, 2000);
  } catch(e) { _localWriting = false; console.error('[SYNC] fbSyncSale error:', e.message); }
}

function sanitiseForFirestore(obj){
  const out={};
  for(const[k,v]of Object.entries(obj)){
    if(k==='id')continue;
    if(v===undefined){out[k]=null;continue;}
    if(v!==null&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Date)){out[k]=sanitiseForFirestore(v);}
    else out[k]=v;
  }
  return out;
}

function _financeDeleteMarkers() {
  try { return JSON.parse(localStorage.getItem(KEY_DELETED_FIN) || '[]'); }
  catch(_) { return []; }
}

function _financeSignature(entry) {
  if (!entry) return '';
  return [
    entry.type || '',
    Number(entry.amount || 0).toFixed(2),
    entry.date || '',
    entry.createdAt || '',
    entry.description || '',
    entry.category || '',
    entry.saleId || ''
  ].join('|');
}

function _rememberDeletedFinance(entry) {
  const markers = _financeDeleteMarkers()
    .filter(m => Date.now() - (m.deletedAt || 0) < 30 * 24 * 60 * 60 * 1000);
  const marker = {
    fbId: entry && entry.fbId ? entry.fbId : '',
    sig: _financeSignature(entry),
    deletedAt: Date.now()
  };
  if (!markers.some(m => (marker.fbId && m.fbId === marker.fbId) || (marker.sig && m.sig === marker.sig))) {
    markers.push(marker);
  }
  localStorage.setItem(KEY_DELETED_FIN, JSON.stringify(markers.slice(-250)));
}

function _isDeletedFinanceRemote(fbId, entry) {
  const sig = _financeSignature(entry);
  return _financeDeleteMarkers().some(m =>
    (fbId && m.fbId && m.fbId === fbId) ||
    (sig && m.sig && m.sig === sig)
  );
}

function _financeRecordsMatch(local, remote) {
  if (!local || !remote) return false;
  if (local.fbId && remote.fbId && local.fbId === remote.fbId) return true;
  if (local.saleId && remote.saleId && String(local.saleId) === String(remote.saleId)) return true;
  return _financeSignature(local) === _financeSignature(remote);
}

function _saleDeleteMarkers() {
  try { return JSON.parse(localStorage.getItem(KEY_DELETED_SALE) || '[]'); }
  catch(_) { return []; }
}

function _saleSignature(sale) {
  if (!sale) return '';
  return [
    sale.itemCode || '',
    sale.itemSize || sale.size || '',
    Number(sale.qty || 0).toFixed(2),
    Number(sale.revenue || 0).toFixed(2),
    Number(sale.profit || 0).toFixed(2),
    sale.paymentMethod || '',
    sale.businessDate || '',
    sale.date || ''
  ].join('|');
}

function _rememberDeletedSale(sale) {
  const markers = _saleDeleteMarkers()
    .filter(m => Date.now() - (m.deletedAt || 0) < 30 * 24 * 60 * 60 * 1000);
  const marker = {
    fbId: sale && sale.fbId ? sale.fbId : '',
    sig: _saleSignature(sale),
    deletedAt: Date.now()
  };
  if (!markers.some(m => (marker.fbId && m.fbId === marker.fbId) || (marker.sig && m.sig === marker.sig))) {
    markers.push(marker);
  }
  localStorage.setItem(KEY_DELETED_SALE, JSON.stringify(markers.slice(-250)));
}

function _isDeletedSaleRemote(fbId, sale) {
  const sig = _saleSignature(sale);
  return _saleDeleteMarkers().some(m =>
    (fbId && m.fbId && m.fbId === fbId) ||
    (sig && m.sig && m.sig === sig)
  );
}

function _salesMatch(local, remote) {
  if (!local || !remote) return false;
  if (local.fbId && remote.fbId && local.fbId === remote.fbId) return true;
  return _saleSignature(local) === _saleSignature(remote);
}

async function fbDeleteFinanceEntry(entry) {
  if (!fbReady || !fbDb || !entry) return 0;
  try {
    const { collection, doc, getDocs, deleteDoc } = await waitForFbImports();
    const snap = await getDocs(collection(fbDb, 'finances'));
    const deletes = [];
    for (const d of snap.docs) {
      const remote = { ...d.data(), fbId: d.id };
      if (d.id === entry.fbId || _financeRecordsMatch(entry, remote)) {
        deletes.push(deleteDoc(doc(fbDb, 'finances', d.id)));
      }
    }
    await Promise.all(deletes);
    return deletes.length;
  } catch (e) {
    console.warn('[SYNC] delete finance:', e.message);
    return 0;
  }
}

async function fbDeleteSale(sale) {
  if (!fbReady || !fbDb || !sale) return 0;
  try {
    const { collection, doc, getDocs, deleteDoc } = await waitForFbImports();
    const snap = await getDocs(collection(fbDb, 'sales'));
    const deletes = [];
    for (const d of snap.docs) {
      const remote = { ...d.data(), fbId: d.id };
      if (d.id === sale.fbId || _salesMatch(sale, remote)) {
        deletes.push(deleteDoc(doc(fbDb, 'sales', d.id)));
      }
    }
    await Promise.all(deletes);
    return deletes.length;
  } catch (e) {
    console.warn('[SYNC] delete sale:', e.message);
    return 0;
  }
}

async function forcePushToFirebase(silent = false) {
  if (!fbReady || !fbDb) { if (!silent) toast('⚠️ Connect Firebase first', 'err'); return; }
  if (!silent) setFbStatus('syncing');
  const items = await dbAll('items');
  const sales = await dbAll('sales');
  const { doc, setDoc, writeBatch } = await waitForFbImports();
  try {
    let batch = writeBatch(fbDb);
    let count = 0;

    for (const item of items) {
      // Use stable fbId: prefer existing fbId, else generate from code + createdAt
      if (!item.fbId) {
        // Stable ID: code + size — same item always maps to same Firestore doc
        item.fbId = 'itm_' + (item.code || 'x').toLowerCase().replace(/[^a-z0-9]/g,'') + '_' + (item.size || 'ns').toLowerCase().replace(/[^a-z0-9]/g,'');
        await dbPut('items', item);
      }
      batch.set(doc(fbDb, 'items', item.fbId), sanitiseForFirestore({ ...item, updatedAt: new Date().toISOString() }));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    for (const sale of sales) {
      if (!sale.fbId) {
        sale.fbId = 'sale_' + (sale.date || '').replace(/[:.TZ-]/g,'').slice(0,17) + '_' + Math.random().toString(36).slice(2,6);
        await dbPut('sales', sale);
      }
      batch.set(doc(fbDb, 'sales', sale.fbId), sanitiseForFirestore({ ...sale }));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push shoe_sizes
    const shoeSizes = await dbAll('shoe_sizes');
    for (const sz of shoeSizes) {
      if (!sz.codeSize) continue;
      if (!sz.fbId) { sz.fbId = 'sz_' + sz.codeSize; await dbPut('shoe_sizes', sz); }
      batch.set(doc(fbDb, 'shoe_sizes', sz.fbId), sanitiseForFirestore({...sz}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push finances
    const finances = await dbAll('finances');
    for (const f of finances) {
      if (!f.fbId) { f.fbId = 'fin_' + (f.createdAt||'').replace(/[:.TZ]/g,'-') + '_' + (f.id||Math.random().toString(36).slice(2,6)); await dbPut('finances', f); }
      batch.set(doc(fbDb, 'finances', f.fbId), sanitiseForFirestore({...f}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push business_days
    const bdays = await dbAll('business_days');
    for (const bd of bdays) {
      if (!bd.fbId) { bd.fbId = 'bd_' + (bd.business_date||'unknown'); await dbPut('business_days', bd); }
      batch.set(doc(fbDb, 'business_days', bd.fbId), sanitiseForFirestore({...bd}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push wishlist
    const wishlist = db.objectStoreNames.contains('wishlist') ? await dbAll('wishlist') : [];
    for (const w of wishlist) {
      if (!w.fbId) {
        w.fbId = 'wish_' + (w.createdAt || '').replace(/[:.TZ]/g, '-') + '_' + (w.id || Math.random().toString(36).slice(2, 6));
        await dbPut('wishlist', w);
      }
      batch.set(doc(fbDb, 'wishlist', w.fbId), sanitiseForFirestore({...w}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    if (count > 0) await batch.commit();
    setFbStatus('on');
    if (!silent) toast('⬆️ Synced ' + items.length + ' items · ' + sales.length + ' sales · ' + shoeSizes.length + ' sizes', 'ok');
  } catch(e) {
    setFbStatus('error');
    if (!silent) toast('Sync error: ' + e.message, 'err');
    console.error('[SYNC] push error:', e);
  }
}

async function pullFromFirebase(silent = false) {
  if (!fbReady || !fbDb) {
    if (!silent) toast('⚠️ Not connected to Firebase', 'err');
    console.warn('[SYNC] pullFromFirebase called but not ready. fbReady=', fbReady, 'fbDb=', !!fbDb);
    return;
  }
  if (!silent) setFbStatus('syncing');
  try {
    const { collection, doc, getDocs, deleteDoc } = await waitForFbImports();

    // Pull items
    console.log('[SYNC] Pulling items from Firebase...');
    const itemSnap = await getDocs(collection(fbDb, 'items'));
    console.log('[SYNC] Firebase has', itemSnap.size, 'items');

    // Batch: load all local items once, build index by fbId and code
    const localItems = await dbAll('items');
    const itemsByFbId = Object.fromEntries(localItems.filter(i=>i.fbId).map(i=>[i.fbId,i]));
    const itemsByCode = Object.fromEntries(localItems.filter(i=>i.code).map(i=>[i.code,i]));
    let itemsAdded = 0, itemsUpdated = 0;
    for (const d of itemSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      delete data.id;
      const existing = itemsByFbId[d.id] || itemsByCode[data.code];
      if (existing) {
        data.id = existing.id;
        await dbPut('items', data);
        itemsUpdated++;
      } else {
        try { await dbAdd('items', data); itemsAdded++; } catch(_) { /* intentionally ignored */ }
      }
    }
    console.log('[SYNC] Items: added=' + itemsAdded + ' updated=' + itemsUpdated);

    // Pull sales — batch local load
    const saleSnap = await getDocs(collection(fbDb, 'sales'));
    const localSales = await dbAll('sales');
    const salesByFbId = Object.fromEntries(localSales.filter(s=>s.fbId).map(s=>[s.fbId,s]));
    let salesAdded = 0, salesUpdated = 0;
    for (const d of saleSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      delete data.id;
      if (_isDeletedSaleRemote(d.id, data)) {
        deleteDoc(doc(fbDb, 'sales', d.id)).catch(() => {});
        continue;
      }
      const existing = salesByFbId[d.id];
      if (existing) {
        data.id = existing.id;
        await dbPut('sales', data);
        salesUpdated++;
      } else {
        try { await dbAdd('sales', data); salesAdded++; } catch(_) { /* intentionally ignored */ }
      }
    }
    console.log('[SYNC] Sales: added=' + salesAdded + ' updated=' + salesUpdated);

    // Pull shoe_sizes
    try {
      const szSnap = await getDocs(collection(fbDb, 'shoe_sizes'));
      const localSizes = await dbAll('shoe_sizes');
      const szByFbId = Object.fromEntries(localSizes.filter(s=>s.fbId).map(s=>[s.fbId,s]));
      const szByCS   = Object.fromEntries(localSizes.filter(s=>s.codeSize).map(s=>[s.codeSize,s]));
      for (const d of szSnap.docs) {
        const data = { ...d.data(), fbId: d.id }; delete data.id;
        const ex = szByFbId[d.id] || szByCS[data.codeSize];
        if (ex) { data.id = ex.id; await dbPut('shoe_sizes', data); }
        else    { try { await dbAdd('shoe_sizes', data); } catch(_) { /* intentionally ignored */ } }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull finances
    try {
      const finSnap = await getDocs(collection(fbDb, 'finances'));
      const localFin = await dbAll('finances');
      const finByFbId = Object.fromEntries(localFin.filter(f=>f.fbId).map(f=>[f.fbId,f]));
      for (const d of finSnap.docs) {
        const data = { ...d.data(), fbId: d.id }; delete data.id;
        if (_isDeletedFinanceRemote(d.id, data)) {
          deleteDoc(doc(fbDb, 'finances', d.id)).catch(() => {});
          continue;
        }
        const ex = finByFbId[d.id];
        if (ex) { data.id = ex.id; await dbPut('finances', data); }
        else    { try { await dbAdd('finances', data); } catch(_) { /* intentionally ignored */ } }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull wishlist
    try {
      if (db.objectStoreNames.contains('wishlist')) {
        const wishSnap = await getDocs(collection(fbDb, 'wishlist'));
        const localWish = await dbAll('wishlist');
        const wishByFbId = Object.fromEntries(localWish.filter(w=>w.fbId).map(w=>[w.fbId,w]));
        for (const d of wishSnap.docs) {
          const data = { ...d.data(), fbId: d.id }; delete data.id;
          const ex = wishByFbId[d.id];
          if (ex) { data.id = ex.id; await dbPut('wishlist', data); }
          else    { try { await dbAdd('wishlist', data); } catch(_) { /* intentionally ignored */ } }
        }
      }
    } catch(_) { /* intentionally ignored */ }

    await refreshUI({ sync: false });
    try { renderSellPage(); } catch(_) { /* intentionally ignored */ }
    setFbStatus('on');

    const msg = '⬇️ ' + itemSnap.size + ' items, ' + saleSnap.size + ' sales from Firebase';
    if (!silent) toast(msg, 'ok');
    else if (itemSnap.size > 0) toast(msg, 'ok');
    console.log('[SYNC] Pull complete:', msg);
  } catch (e) {
    setFbStatus('error');
    console.error('[SYNC] Pull error:', e);
    if (!silent) toast('Pull failed: ' + e.message, 'err');
  }
}

function disconnectFirebase() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  fbApp = null; fbDb = null; fbReady = false;
  localStorage.removeItem('fb_config');
  document.getElementById('fb-config-input').value = '';
  setFbStatus('off');
  toast('Firebase disconnected', '');
}




async function runSyncDebug() {
  const log = document.getElementById('debug-log');
  const localEl = document.getElementById('debug-local-items');
  const fbEl = document.getElementById('debug-fb-items');
  const addLog = msg => { if (log) { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; } console.log('[DEBUG]', msg); };

  log.textContent = '';
  addLog('Starting sync debug...');
  addLog('fbReady=' + fbReady + ' fbDb=' + !!fbDb + ' online=' + navigator.onLine);

  const localItems = await dbAll('items');
  if (localEl) localEl.textContent = localItems.length;
  addLog('Local items: ' + localItems.length);
  addLog('Items with fbId: ' + localItems.filter(i => i.fbId).length);

  if (!fbReady || !fbDb) {
    addLog('❌ Firebase not connected! Reconnecting...');
    await initFirebase();
    if (!fbReady) { addLog('❌ Reconnect failed'); return; }
    addLog('✅ Reconnected');
  }

  try {
    const { collection, getDocs } = await waitForFbImports();
    const snap = await getDocs(collection(fbDb, 'items'));
    if (fbEl) fbEl.textContent = snap.size;
    addLog('Firebase items: ' + snap.size);

    if (snap.size === 0 && localItems.length > 0) {
      addLog('⚠️ Firebase empty but local has ' + localItems.length + ' items');
      addLog('Pushing all local items now...');
      await forcePushToFirebase(false);
      addLog('✅ Push complete');
    } else if (snap.size > 0) {
      addLog('Pulling ' + snap.size + ' items from Firebase...');
      await pullFromFirebase(false);
      addLog('✅ Pull complete. Local now: ' + (await dbAll('items')).length);
    } else {
      addLog('Both empty. Add items and push.');
    }
  } catch(e) {
    addLog('❌ Error: ' + e.message);
    console.error('[DEBUG]', e);
  }
}




// ===================================================================
// DAY MODE CONTROL - enable/disable tabs based on day status
// ===================================================================

// Tabs that require an open day
const DAY_RESTRICTED_TABS = ['dash', 'add', 'list'];

function setDayMode(isOpen) {
  const status = activeDay ? activeDay.status : 'PENDING';
  // Dashboard: accessible when OPEN or PAUSED (progress view), blocked otherwise
  const dashOk = isOpen || status === 'PAUSED';
  const dashBtn = document.getElementById('tab-dash');
  if (dashBtn && dashBtn.style.display !== 'none') {
    dashBtn.classList.toggle('disabled', !dashOk);
    if (!dashOk) dashBtn.classList.remove('active');
  }

  // Add tab: only when OPEN
  const addBtn = document.getElementById('tab-add');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.classList.toggle('disabled', !isOpen);
    if (!isOpen) addBtn.classList.remove('active');
  }

  // Stock tab: viewable always, but grayed to signal read-only when not OPEN
  const listBtn = document.getElementById('tab-list');
  if (listBtn && listBtn.style.display !== 'none') {
    listBtn.classList.toggle('disabled', !isOpen);
    if (!isOpen) listBtn.classList.remove('active');
  }

  // Redirect if on a now-blocked page
  if (!isOpen) {
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pageId = activePage.id.replace('page-', '');
      if (pageId === 'add') _origShowPage('day');
      if (pageId === 'dash' && !dashOk) _origShowPage('day');
      if (pageId === 'list') renderList(); // refresh to show/hide action buttons
    }
  }
}

function showDayClosedOverlay(pageId) {
  const overlay = document.getElementById('day-closed-overlay');
  const msg = document.getElementById('day-closed-msg');
  if (!overlay) return;
  const status = activeDay ? activeDay.status : 'PENDING';
  if (status === 'LOCKED') {
    msg.textContent = 'Open today\'s business day from the Day tab to continue.';
  } else if (status === 'CLOSED') {
    msg.textContent = 'The business day is closed. You can reopen it from the Day tab before 11:59 PM.';
  } else {
    msg.textContent = 'Please open the business day first to access this section.';
  }
  overlay.classList.add('show');
}

function hideDayClosedOverlay() {
  const overlay = document.getElementById('day-closed-overlay');
  if (overlay) overlay.classList.remove('show');
}

// ===================================================================
// BUSINESS DAY MANAGEMENT
//
// Simple two-state model:
//   OPEN   → day is active, all operations allowed
//   CLOSED → day is closed, operations blocked
//
// Rules:
//   • User can open and close the day as many times as needed
//     within the same calendar date
//   • On date change, the system auto-creates and opens a new day
//   • At midnight, current day closes automatically
//   • Past days are LOCKED (read-only archive)
// ===================================================================

let activeDay = null;
let dayCheckTimer = null;
let _warned1145 = null; // date string of the last 11:45 PM warning shown

// ── DATE / TIME HELPERS ──────────────────────────────────────────────
function todayDateStr() {
  // Use local date, not UTC — important for UTC+3 (Nairobi) where
  // new Date().toISOString() returns UTC which drifts 3 hours behind local time
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtFullDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

// ── STATE CHECKS ─────────────────────────────────────────────────────
// isDayOpen() removed — system always active, date-based tracking
function isDayOpen() { return true; }

// requireOpenDay removed — always returns true
function requireOpenDay() { return true; }

// ── LOAD ACTIVE DAY ON APP START ─────────────────────────────────────
// Called once at startup. Finds or creates today's day record.
// Also locks any past days that were left OPEN or CLOSED overnight.
async function loadActiveDay() {
  // Replaced by automatic date-based tracking
  // activeDay kept for backward-compat but not required
  try {
    const today = todayDateStr();
    let bday = await getBusinessDay(today);
    if (!bday) bday = await createDayRecord(today);
    activeDay = bday;
  } catch(e) { console.warn('[DAY]', e.message); }
}

async function refreshDayTab() {
  const today = todayDateStr();
  const bday = await getBusinessDay(today);
  if (bday) {
    activeDay = bday;
    updateDayBanner();
    if (isDayOpen()) updateDayLiveStats();
  }
  renderDaySessionsList();
}

// ── CREATE A NEW DAY RECORD ──────────────────────────────────────────
async function createDayRecord(dateStr) {
  const id = await dbAdd('business_days', {
    businessDate:   dateStr,
    business_date:  dateStr,   // keep for legacy index
    status:        'CLOSED',   // starts CLOSED, user opens it manually
    openedAt:      null,
    closedAt:      null,
    reopenedCount: 0,
    salesCount:    0,
    revenue:       0,
    profit:        0,
    itemsSold:     0,
    notes:         '',
    createdAt:     new Date().toISOString(),
  });
  return await dbGet('business_days', id);
}

// ── GET BUSINESS DAY ─────────────────────────────────────────────────
async function getBusinessDay(dateStr) {
  const all = await dbAll('business_days');
  return all.find(d => d.business_date === dateStr) || null;
}

// ── OPEN DAY ─────────────────────────────────────────────────────────
async function openDay() {
  const today = todayDateStr();
  let bday = await getBusinessDay(today);
  if (!bday) bday = await createDayRecord(today);

  if (bday.status === 'OPEN')   { toast('Day is already open!', 'err'); return; }
  if (bday.status === 'LOCKED') { toast('🔒 This day is archived.', 'err'); return; }

  const isReopen = bday.status === 'CLOSED' && !!bday.opened_at;

  if (!bday.opened_at) {
    // First open of the day — snapshot opening stock value
    const items = await dbAll('items');
    bday.openingStockCost   = items.reduce((s, i) => s + i.buy * i.qty, 0);
    bday.openingStockRetail = items.reduce((s, i) => s + i.sell * i.qty, 0);
  }

  bday.status          = 'OPEN';
  bday.opened_at       = bday.opened_at || new Date().toISOString();
  bday.last_opened_at  = new Date().toISOString();
  if (isReopen) bday.reopened_count = (bday.reopened_count || 0) + 1;

  await dbPut('business_days', bday);
  activeDay = bday;
  setDayMode(true);
  updateDayBanner();
  updateDayLiveStats();
  renderDaySessionsList();
  toast(isReopen ? '🔓 Day reopened! Continue recording.' : '🌅 Business day opened!', 'ok');
}

// ── CLOSE DAY ────────────────────────────────────────────────────────
async function closeDay() {
  if (!isDayOpen()) { toast('No open day to close.', 'err'); return; }

  const sales = await dbAll('sales');
  const _dayDate = (activeDay.businessDate || activeDay.business_date);
  const daySales = sales.filter(s => (s.businessDate||s.business_date) === _dayDate);
  const revenue   = daySales.reduce((s, x) => s + x.revenue, 0);
  const profit    = daySales.reduce((s, x) => s + x.profit, 0);
  const itemsSold = daySales.reduce((s, x) => s + x.qty, 0);
  // Note: tracks NEW items added today (by createdAt).
  // Restocks to existing items are not separately tracked — a future
  // 'stock_events' log store would capture this properly.
  const todayStart = today + 'T00:00:00';
  const items     = await dbAll('items');
  const purchases = items.filter(i => i.createdAt && i.createdAt >= todayStart);
  const closingStockCost = items.reduce((s, i) => s + i.buy * i.qty, 0);
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;
  const avgSale = daySales.length > 0 ? (revenue / daySales.length) : 0;
  const openT = activeDay.opened_at ? fmtTime(activeDay.opened_at) : '?';
  const nowT  = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // Populate summary sheet
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ds-date',       fmtFullDate((activeDay.businessDate || activeDay.business_date)));
  set('ds-time-range', openT + ' → ' + nowT);
  set('ds-revenue',    fmt(revenue));
  set('ds-profit',     fmt(profit));
  set('ds-margin',     margin + '%');
  set('ds-avg-sale',   fmt(avgSale));
  set('ds-sales',      daySales.length);
  set('ds-items-sold', itemsSold);
  set('ds-custom-price', daySales.filter(s => s.overridden).length);
  set('ds-opening-stock', fmt(activeDay.openingStockCost || 0));
  set('ds-closing-stock', fmt(closingStockCost));
  set('ds-purchases',     purchases.length);
  set('ds-purchases-val', fmt(purchases.reduce((s, i) => s + i.buy * i.qty, 0)));

  // Stock movement bar
  const opening = activeDay.openingStockCost || 0;
  const pct = opening > 0 ? Math.min(100, Math.round(((opening - closingStockCost) / opening) * 100)) : 0;
  const bar = document.getElementById('ds-stock-bar');
  const lbl = document.getElementById('ds-stock-pct-label');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = pct + '%';

  // Verdict
  const verdictEl = document.getElementById('ds-verdict');
  if (verdictEl) {
    let verdict = '😴 Quiet day. ' + daySales.length + ' sales.';
    let vBg = 'var(--surface2)', vColor = 'var(--muted)';
    if (daySales.length > 0) {
      const m = parseFloat(margin);
      if (m >= 30) { verdict = '🔥 Excellent! ' + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else if (m >= 15) { verdict = '✅ Good day! ' + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else { verdict = '👍 Decent. ' + margin + '% margin.'; vBg = 'var(--amber-light)'; vColor = 'var(--amber)'; }
    }
    verdictEl.style.cssText = 'background:' + vBg + ';color:' + vColor + ';border:1px solid ' + vColor + ';border-radius:var(--r);padding:14px 16px;margin-bottom:14px;text-align:center;';
    verdictEl.innerHTML = '<div style="font-size:16px;font-weight:800;">' + verdict + '</div>';
  }

  // Notes reset
  const notes = document.getElementById('ds-notes');
  if (notes) notes.value = '';

  // Show confirm button, hide pause button
  const confirmBtn = document.getElementById('ds-confirm-btn');
  const pauseBtn   = document.getElementById('ds-pause-btn');
  if (confirmBtn) { confirmBtn.style.display = 'block'; confirmBtn.textContent = '🌙 Confirm Close Day'; }
  if (pauseBtn)   pauseBtn.style.display = 'none';

  document.getElementById('day-summary-sheet').classList.add('open');
}

// ── CONFIRM CLOSE ────────────────────────────────────────────────────
async function confirmCloseDay() {
  const notes = (document.getElementById('ds-notes') || {}).value || '';
  const now   = new Date();
  const sales = await dbAll('sales');
  const _dayDate = (activeDay.businessDate || activeDay.business_date);
  const daySales = sales.filter(s => (s.businessDate||s.business_date) === _dayDate);
  const items = await dbAll('items');
  const todayStart2 = (activeDay.businessDate || activeDay.business_date) + 'T00:00:00';
  const purchases = items.filter(i => i.createdAt && i.createdAt >= todayStart2);

  activeDay.status       = 'CLOSED';
  activeDay.closed_at    = now.toISOString();
  activeDay.notes        = notes;
  activeDay.salesCount   = daySales.length;
  activeDay.revenue      = daySales.reduce((s, x) => s + x.revenue, 0);
  activeDay.profit       = daySales.reduce((s, x) => s + x.profit, 0);
  activeDay.itemsSold    = daySales.reduce((s, x) => s + x.qty, 0);
  activeDay.purchasesCount = purchases.length;
  activeDay.purchaseCost   = purchases.reduce((s, i) => s + i.buy * i.qty, 0);
  activeDay.closingStockCost = items.reduce((s, i) => s + i.buy * i.qty, 0);

  await dbPut('business_days', activeDay);
  document.getElementById('day-summary-sheet').classList.remove('open');
  setDayMode(false);
  updateDayBanner();
  renderDaySessionsList();
  renderDashboard();
  _origShowPage('day');
  toast('🌙 Day closed. Tap Open Day to continue anytime.', 'ok');
  scheduleSync();
}

// cancelCloseDay: handled by day reconciliation flow below

// ── BANNER LIVE CLOCK — refresh duration display every minute ────────
let _bannerClockTimer = null;
function startBannerClock() {
  if (_bannerClockTimer) clearInterval(_bannerClockTimer);
  _bannerClockTimer = setInterval(() => {
    if (isDayOpen()) updateDayBanner(); // refreshes the "Xh Ym running" text
  }, 60000);
}

// ── AUTO SCHEDULER ───────────────────────────────────────────────────
// Checks every 30s for time-triggered actions
// ── VOID SALE ─────────────────────────────────────────────────────
async function voidSale(saleId) {
  try {
  const _voidSale = await dbGet('sales', saleId);
  const _voidMsg = _voidSale
    ? 'Void sale of "' + (_voidSale.itemName || _voidSale.itemCode || 'item') + '"' +
      (_voidSale.itemSize ? ' (Size ' + _voidSale.itemSize + ')' : '') +
      ' × ' + (_voidSale.qty||1) + ' for ' + fmt(_voidSale.revenue||0) + '?\n\nStock will be restored.'
    : 'Void this sale? Stock will be restored.';
  if (!confirm(_voidMsg)) return;
  const sale = await dbGet('sales', saleId);
  if (!sale) { toast('Sale not found', 'err'); return; }

  // Restore stock
  const item = await dbGet('items', sale.itemId);
  if (item) {
    if (item.isShoe && (sale.itemSize || sale.size)) {
      // Restore shoe size qty
      const sizes = await getShoeSizes(item.code);
      const sz = sizes.find(s => s.size === parseInt(sale.itemSize || sale.size));
      if (sz) {
        sz.qty += (sale.qty || 1);
        sz.updatedAt = new Date().toISOString();
        await dbPut('shoe_sizes', sz);
        const allSz = await getShoeSizes(item.code);
        item.qty = allSz.reduce((t,s) => t+s.qty, 0);
      } else {
        item.qty += (sale.qty || 1);
      }
    } else {
      item.qty += (sale.qty || 1);
    }
    item.updatedAt = new Date().toISOString();
    await dbPut('items', item);
    fbSyncItem(item);
  }

  // Delete sale record
  _rememberDeletedSale(sale);
  await fbDeleteSale(sale);
  await fbDeleteFinanceEntry({
    type: 'revenue',
    saleId: sale.id,
    amount: sale.revenue,
    date: sale.businessDate || (sale.date || '').split('T')[0],
    description: 'Sale: ' + (sale.itemName || sale.itemCode || 'item')
  });
  await dbDelete('sales', saleId);

  // Refresh
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList(); renderDashboard(); updateHeader();
  if (activeDay) updateDayLiveStats();
  scheduleSync();
  toast('↩️ Sale voided · stock restored', 'ok');
  } catch(e) { console.error("[voidSale]", e); toast("Error: " + e.message, "err"); }
}

function startDayTimer() { /* replaced by automatic date tracking */ }
async function lockBusinessDay(bday) {
  bday.status = 'LOCKED';
  bday.final_locked_at = new Date().toISOString();
  await dbPut('business_days', bday);
}

// ── DAY BANNER ───────────────────────────────────────────────────────
function updateDayBanner() {
  if (!activeDay) return;
  const { status, opened_at, closed_at, last_opened_at, auto_closed, reopened_count } = activeDay;
  const banner    = document.getElementById('day-banner');
  const icon      = document.getElementById('day-banner-icon');
  const badge     = document.getElementById('day-status-badge');
  const title     = document.getElementById('day-banner-title');
  const sub       = document.getElementById('day-banner-sub');
  const actionArea = document.getElementById('day-action-area');
  const liveSection = document.getElementById('day-live');
  if (!banner) return;

  const BTN = 'width:100%;padding:16px;border:none;border-radius:var(--r);font-size:16px;font-weight:800;cursor:pointer;font-family:var(--sans);';

  if (status === 'OPEN') {
    const mins = opened_at ? Math.floor((Date.now() - new Date(opened_at)) / 60000) : 0;
    const dur  = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
    banner.style.cssText = 'background:var(--green-light);border:2px solid #a8d8b5;border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = '🌅';
    badge.textContent = 'OPEN';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#dcfce7;color:#16a34a;';
    title.textContent = 'Business Day Open';
    title.style.color = 'var(--green)';
    sub.textContent   = 'Opened ' + fmtTime(opened_at)
      + ' · ' + dur + ' running'
      + (reopened_count > 0 ? ' · Reopened ' + reopened_count + 'x' : '');
    if (actionArea) actionArea.innerHTML = '';  // Day tab handles its own buttons now
    setDayMode(true);
    updateDayLiveStats();
  } else if (status === 'CLOSED') {
    banner.style.cssText = 'background:#fef3c7;border:2px solid #f5d9a0;border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = '🌙';
    badge.textContent = 'CLOSED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#fef3c7;color:#92400e;';
    title.textContent = 'Business Day Closed';
    title.style.color = '#d97706';
    sub.textContent   = closed_at
      ? 'Closed at ' + fmtTime(closed_at) + (auto_closed ? ' · auto' : '') + (reopened_count > 0 ? ' · Opened ' + (reopened_count + 1) + 'x today' : '') + ' · Tap to reopen'
      : 'Tap Open Day to begin — ' + fmtFullDate(todayDateStr());
    if (actionArea) actionArea.innerHTML = '';
    setDayMode(false);
    updateDayLiveStats();
  } else if (status === 'LOCKED') {
    banner.style.cssText = 'background:var(--surface2);border:2px solid var(--border);border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = '🔒';
    badge.textContent = 'LOCKED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:var(--surface2);color:var(--muted);';
    title.textContent = 'Archived Day';
    title.style.color = 'var(--muted)';
    sub.textContent   = fmtFullDate((activeDay.businessDate || activeDay.business_date)) + ' — read only';
    if (actionArea) actionArea.innerHTML = '';
    setDayMode(false);
    updateDayLiveStats();
  }
}

// ── LIVE STATS — full cash flow summary ─────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay) return;
  const today  = activeDay.businessDate || activeDay.business_date || todayDateStr();
  const sales  = await dbAll('sales');
  const fins   = await dbAll('finances');

  // Filter to today
  const daySales = sales.filter(s => (s.businessDate||s.business_date||(s.date||'').split('T')[0]) === today);
  const dayFins  = fins.filter(e  => (e.date||(e.createdAt||'').split('T')[0]) === today);

  // ── Sales split by payment method ──────────────────────────
  const cashSales  = daySales.filter(s => !s.paymentMethod || s.paymentMethod === 'cash');
  const mpesaSales = daySales.filter(s => s.paymentMethod === 'mpesa');
  const cashRev    = cashSales.reduce((a,s)=>a+(s.revenue||0), 0);
  const mpesaRev   = mpesaSales.reduce((a,s)=>a+(s.revenue||0), 0);
  const totalRev   = daySales.reduce((a,s)=>a+(s.revenue||0), 0);
  const totalProf  = daySales.reduce((a,s)=>a+(s.profit||0), 0);
  const margin     = totalRev > 0 ? (totalProf/totalRev*100) : 0;
  const salesCount = daySales.length;

  // ── Finance entries today ──────────────────────────────────
  const injected   = dayFins.filter(e=>e.type==='injection'||e.type==='investment').reduce((a,e)=>a+(e.amount||0), 0);
  const stockBought= dayFins.filter(e=>e.type==='stock_purchase').reduce((a,e)=>a+(e.amount||0), 0);
  const expenses   = dayFins.filter(e=>e.type==='expense').reduce((a,e)=>a+(e.amount||0), 0);
  const withdrawn  = dayFins.filter(e=>e.type==='withdrawal').reduce((a,e)=>a+(e.amount||0), 0);

  // ── Cash position ──────────────────────────────────────────
  // Cash at hand = cash sales + cash injections − withdrawals − cash expenses − stock bought with cash
  const cashAtHand = cashRev + injected - withdrawn - expenses - stockBought;
  const mpesaBal   = mpesaRev;
  const netFlow    = totalRev + injected - withdrawn - expenses - stockBought;
  const totalIn    = cashRev + mpesaRev + injected;
  const totalOut   = stockBought + expenses + withdrawn;

  // ── Populate UI ────────────────────────────────────────────
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const setColor = (id, c) => { const el = document.getElementById(id); if (el) el.style.color = c; };

  // Money In
  set('day-cash-sales',       fmt(cashRev));
  set('day-cash-sales-count', cashSales.length + ' sale' + (cashSales.length!==1?'s':''));
  set('day-mpesa-sales',      fmt(mpesaRev));
  set('day-mpesa-sales-count', mpesaSales.length + ' sale' + (mpesaSales.length!==1?'s':''));
  set('day-injected',         fmt(injected));
  const injEntries = dayFins.filter(e=>e.type==='injection'||e.type==='investment');
  set('day-injected-desc',    injEntries.length ? injEntries.map(e=>e.description||'Injection').slice(0,2).join(', ') : 'no injections today');
  set('day-total-in',         fmt(totalIn));

  // Money Out
  set('day-stock-purchased',  fmt(stockBought));
  const stockEntries = dayFins.filter(e=>e.type==='stock_purchase');
  set('day-stock-purchased-desc', stockEntries.length ? stockEntries.length + ' purchase' + (stockEntries.length!==1?'s':'') : 'no purchases today');
  set('day-expenses',         fmt(expenses));
  const expEntries = dayFins.filter(e=>e.type==='expense');
  set('day-expenses-desc',    expEntries.length ? expEntries.length + ' expense' + (expEntries.length!==1?'s':'') : 'no expenses today');
  set('day-withdrawn',        fmt(withdrawn));
  const wdEntries = dayFins.filter(e=>e.type==='withdrawal');
  set('day-withdrawn-desc',   wdEntries.length ? wdEntries.length + ' withdrawal' + (wdEntries.length!==1?'s':'') : 'none today');
  set('day-total-out',        fmt(totalOut));

  // Cash position
  set('day-cash-at-hand',   (cashAtHand>=0?'':'-') + fmt(Math.abs(cashAtHand)));
  set('day-mpesa-balance',  fmt(mpesaBal));
  set('day-net-flow',       (netFlow>=0?'+':'') + fmt(netFlow));
  setColor('day-cash-at-hand', cashAtHand >= 0 ? 'var(--accent)' : 'var(--red)');
  setColor('day-net-flow',     netFlow    >= 0 ? 'var(--green)'  : 'var(--red)');
  const netEl = document.getElementById('day-net-flow');
  if (netEl && netEl.closest) {
    const wrap = netEl.closest('div[style*="green-light"]');
    if (wrap) wrap.style.background = netFlow >= 0 ? 'var(--green-light)' : 'var(--red-light)';
  }

  // Sales breakdown
  set('day-sales-count', salesCount);
  set('day-revenue',     fmt(totalRev));
  set('day-profit',      fmt(totalProf));
  set('day-margin-pct',  margin.toFixed(1) + '%');
  setColor('day-margin-pct', margin >= 20 ? 'var(--green)' : margin >= 10 ? '#d97706' : 'var(--red)');

  // ── Sales + Finance transactions list ─────────────────────
  const sl = document.getElementById('day-sales-list');
  if (sl) {
    // Merge sales and finance entries into one timeline
    const txns = [
      ...daySales.map(s => ({
        time:  s.date || s.createdAt,
        type:  'sale',
        label: (s.itemName||s.itemCode||'Sale') + (s.itemSize ? ' ·'+s.itemSize : ''),
        sub:   (s.paymentMethod||'cash').toUpperCase() + ' · ' + (s.qty||1) + ' pc' + ((s.qty||1)!==1?'s':''),
        amt:   s.revenue||0,
        color: 'var(--green)',
        sign:  '+',
        id:    s.id,
        canVoid: true,
      })),
      ...dayFins.map(e => {
        const isMinus = e.type==='expense'||e.type==='withdrawal'||e.type==='stock_purchase';
        const icons = {injection:'💉',investment:'💵',stock_purchase:'🛍️',expense:'💸',withdrawal:'🏧',other:'📝'};
        return {
          time:  e.date ? e.date+'T12:00:00' : e.createdAt,
          type:  'finance',
          label: icons[e.type]||'📝' + ' ' + (e.description||e.type),
          sub:   e.type.replace('_',' '),
          amt:   e.amount||0,
          color: isMinus ? 'var(--red)' : 'var(--green)',
          sign:  isMinus ? '-' : '+',
          id:    e.id,
          canVoid: false,
        };
      }),
    ].sort((a,b) => new Date(b.time)-new Date(a.time));

    if (!txns.length) {
      sl.innerHTML = '<div class="day-empty">No transactions yet today</div>';
    } else {
      sl.innerHTML = txns.map(t =>
        `<div class="day-txn-row">
          <div style="flex:1;min-width:0;">
            <div class="day-txn-label">${escapeHtml(t.label)}</div>
            <div class="day-txn-sub">${t.time ? fmtTime(t.time) : ''} · ${t.sub}</div>
          </div>
          <div class="day-txn-amt" style="color:${t.color};">${t.sign}${fmt(t.amt)}</div>
          ${t.canVoid && isDayOpen() ? `<button onclick="voidSale(${t.id})" style="font-size:9px;padding:3px 8px;background:var(--red-light);color:var(--red);border:1px solid var(--red);border-radius:4px;cursor:pointer;font-weight:700;flex-shrink:0;">Void</button>` : ''}
        </div>`
      ).join('');
    }
  }
}

// ── PAST SESSIONS LIST ────────────────────────────────────────────────
async function renderDaySessionsList() {
  const all = await dbAll('business_days');
  const today = todayDateStr();
  const past = all
    .filter(d => d.business_date !== today && (d.status === 'CLOSED' || d.status === 'LOCKED'))
    .sort((a, b) => b.business_date.localeCompare(a.business_date));

  const list = document.getElementById('day-sessions-list');
  if (!list) return;

  if (!past.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No past sessions yet</div>';
    return;
  }

  list.innerHTML = past.map(s => {
    const profitColor = (s.profit||0) >= 0 ? 'var(--green)' : 'var(--red)';
    const locked = s.status === 'LOCKED';
    return '<div class="card" style="margin-bottom:8px;padding:14px;cursor:pointer;" onclick="viewPastSession(' + s.id + ')">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
      '<div>' +
        '<div style="font-size:14px;font-weight:800;color:var(--text);">' + fmtFullDate(s.business_date) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">' +
          (s.opened_at ? fmtTime(s.opened_at) : '—') + ' → ' +
          (s.closed_at ? fmtTime(s.closed_at) : 'auto') +
          (s.reopened_count > 0 ? ' · Reopened ' + s.reopened_count + 'x' : '') +
        '</div>' +
      '</div>' +
      (locked
        ? '<span style="font-size:10px;background:var(--surface2);color:var(--muted);padding:2px 8px;border-radius:20px;font-weight:700;"><i class="fa-solid fa-lock" style="margin-right:3px;"></i>Locked</span>'
        : '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:20px;font-weight:700;"><i class="fa-solid fa-moon" style="margin-right:3px;"></i>Closed</span>'
      ) +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(s.revenue||0) + '</div><div style="font-size:10px;color:var(--muted);">Revenue</div></div>' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:' + profitColor + ';">' + fmt(s.profit||0) + '</div><div style="font-size:10px;color:var(--muted);">Profit</div></div>' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent);">' + (s.salesCount||0) + '</div><div style="font-size:10px;color:var(--muted);">Sales</div></div>' +
      '</div>' +
      (s.notes ? '<div style="margin-top:8px;font-size:12px;color:var(--muted);font-style:italic;">"' + s.notes + '"</div>' : '') +
      '</div>';
  }).join('');
}
// ═══════════════════════════════════════════════════════════
// RESTOCK
// ═══════════════════════════════════════════════════════════
function toggleRestock() {
  const panel = document.getElementById('restock-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display === 'block') {
    document.getElementById('restock-qty').value = '';
    document.getElementById('restock-qty').focus();
  }
}

async function confirmRestock() {
  const restockBtn = document.querySelector('#restock-panel button');
  if (restockBtn) { restockBtn.disabled = true; restockBtn.style.opacity = '0.5'; }
  try {
    const qty = parseInt(document.getElementById('restock-qty').value);
    if (!Validate.restockQty(qty, 'restock-qty')) return;
    const item = await dbGet('items', currentDetailId);
    if (!item) { toast('⚠️ Item not found', 'err'); return; }
    item.qty += qty;
    item.updatedAt = new Date().toISOString();
    await dbPut('items', item);
    await recordStockInvestment(item, qty * (item.buyPrice || item.buy || 0), qty, 'Restock');
    fbSyncItem(item);
    scheduleSync();
    const qtyEl = document.getElementById('sh-qty');
    if (qtyEl) qtyEl.textContent = item.qty + (item.isShoe ? ' prs' : ' pcs');
    document.getElementById('restock-panel').style.display = 'none';
    allItems = await dbAll('items');
    await enrichShoeItems(allItems);
    renderList(); renderDashboard(); updateHeader();
    updateLowStockBadge();
    toast('✅ Added ' + qty + (item.isShoe ? ' prs' : ' pcs') + ' to ' + (item.name || item.code), 'ok');
  } catch(e) {
    console.error('[confirmRestock]', e);
    toast('⚠️ Restock failed: ' + e.message, 'err');
  } finally {
    if (restockBtn) { restockBtn.disabled = false; restockBtn.style.opacity = ''; }
  }
}

// ═══════════════════════════════════════════════════════════
// LOW STOCK BADGE IN HEADER
// ═══════════════════════════════════════════════════════════
async function updateLowStockBadge() {
  try {
  const items = await dbAll('items');
  const badge = document.getElementById('low-stock-badge');
  // low stock badge removed from header
  } catch(e) { console.error("[updateLowStockBadge]", e); toast("Error: " + e.message, "err"); }
}

// ═══════════════════════════════════════════════════════════
// DELETE SALE
// ═══════════════════════════════════════════════════════════
async function deleteSale(saleId) {
  try {
  if (!confirm('Delete this sale record? Stock will NOT be restored.')) return;
  const sale = await dbGet('sales', saleId);
  if (sale) {
    _rememberDeletedSale(sale);
    await fbDeleteSale(sale);
    await fbDeleteFinanceEntry({
      type: 'revenue',
      saleId: sale.id,
      amount: sale.revenue,
      date: sale.businessDate || (sale.date || '').split('T')[0],
      description: 'Sale: ' + (sale.itemName || sale.itemCode || 'item')
    });
  }
  await dbDelete('sales', saleId);
  renderSellPage();
  renderDashboard();
  toast('Sale record deleted', '');
  } catch(e) { console.error("[deleteSale]", e); toast("Error: " + e.message, "err"); }
}

// ═══════════════════════════════════════════════════════════
// SALES EXPORT BY DATE FILTER
// ═══════════════════════════════════════════════════════════

function filterSalesByPeriod(sales, period) {
  const now = new Date();
  return sales.filter(s => {
    const d = new Date(s.date);
    if (period === 'today') {
      return d.toDateString() === now.toDateString();
    } else if (period === 'week') {
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      return d >= weekAgo;
    } else if (period === 'month') {
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }
    return true; // all
  });
}

// ═══════════════════════════════════════════════════════════
// DAY REPORT EXPORT
// ═══════════════════════════════════════════════════════════


// ===== CLOSE SHEET ON BACKDROP =====
const _detailSheet = document.getElementById('detail-sheet');
if (_detailSheet) _detailSheet.addEventListener('click', function(e) {
  if (e.target === this) closeSheet();
});
const _daySummarySheet = document.getElementById('day-summary-sheet');
if (_daySummarySheet) _daySummarySheet.addEventListener('click', function(e) {
  if (e.target === this) cancelCloseDay();
});
const _pastSessionSheet = document.getElementById('past-session-sheet');
if (_pastSessionSheet) _pastSessionSheet.addEventListener('click', function(e) {
  if (e.target === this) closePastSessionSheet();
});

// ===== SERVICE WORKER + OFFLINE + INSTALL =====
let swRegistration = null;
let deferredInstallPrompt = null;

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(reg => {
    swRegistration = reg;
    _setUpdateLastCheck();
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'BACKGROUND_SYNC') {
        if (fbReady && fbDb && navigator.onLine) forcePushToFirebase(true).then(()=>pullFromFirebase(true));
      }
    });
    function onNewWorker(worker) {
      _pendingWorker = worker;
      _showUpdateState('available');
      // Also add red dot on settings tab
      const t = document.getElementById('tab-settings');
      if (t && !document.getElementById('update-dot')) {
        const d = document.createElement('span'); d.id = 'update-dot';
        d.style.cssText = 'position:absolute;top:4px;right:4px;width:8px;height:8px;background:var(--red);border-radius:50%;';
        t.style.position = 'relative'; t.appendChild(d);
      }
      // Show the big fullscreen update banner
      _showUpdateBanner();
    }
    reg.addEventListener('updatefound',()=>{const w=reg.installing;w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)onNewWorker(w);});});
    if(reg.waiting&&navigator.serviceWorker.controller)onNewWorker(reg.waiting);
    setInterval(()=>reg.update().then(()=>_setUpdateLastCheck()).catch(()=>{}), 30*60*1000);
  }).catch(()=>{});
  let _reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_reloading) return; _reloading = true;
    // Update progress bars (both banner + settings card)
    ['update-progress-bar','upd-progress-bar'].forEach(id=>{const el=document.getElementById(id);if(el)el.style.width='100%';});
    ['update-progress-pct','upd-progress-pct'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='100%';});
    ['update-progress-label','upd-progress-label'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='Reloading…';});
    // Show success state in banner
    const btnArea = document.getElementById('upd-btn-area');
    const progressWrap = document.getElementById('upd-progress-wrap');
    const successEl = document.getElementById('upd-success');
    if (btnArea)     btnArea.style.display     = 'none';
    if (progressWrap)progressWrap.style.display= 'none';
    if (successEl)   successEl.style.display   = 'block';
    setTimeout(() => window.location.reload(), 1200);
  });
}

// Register background sync when going offline
window.addEventListener('offline', () => {
  if (swRegistration && swRegistration.sync) {
    swRegistration.sync.register('firebase-sync').catch(() => {});
  }
});

// ── INSTALL PROMPT (Add to Home Screen) ─────────────────────────────────

function detectBrowser() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('samsungbrowser')) return 'samsung';
  if (ua.includes('firefox') || ua.includes('fxios')) return 'firefox';
  if (ua.includes('edg/')) return 'edge';
  if (ua.includes('chrome') || ua.includes('crios')) return 'chrome';
  if (ua.includes('safari') && !ua.includes('chrome')) return 'safari';
  return 'chrome'; // default to chrome steps
}

function getInstallSteps() {
  const browser = detectBrowser();
  const steps = {
    samsung: [
      '1️⃣  Tap the <strong>⋮ menu</strong> at the top right',
      '2️⃣  Tap <strong>"Add page to"</strong> → <strong>"Home screen"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ],
    firefox: [
      '1️⃣  Tap the <strong>⋮ menu</strong> at the top right',
      '2️⃣  Tap <strong>"Install"</strong> or <strong>"Add to Home Screen"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ],
    safari: [
      '1️⃣  Tap the <strong>Share button ↑</strong> at the bottom',
      '2️⃣  Scroll down → tap <strong>"Add to Home Screen"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ],
    chrome: [
      '1️⃣  Tap the <strong>⋮ menu</strong> at the top right',
      '2️⃣  Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ],
    edge: [
      '1️⃣  Tap the <strong>... menu</strong> at the bottom',
      '2️⃣  Tap <strong>"Add to phone"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ],
    other: [
      '1️⃣  Open your <strong>browser menu</strong>',
      '2️⃣  Look for <strong>"Add to Home Screen"</strong>',
      '3️⃣  Tap <strong>Add</strong> — done! ✅'
    ]
  };
  return steps[browser] || steps.other;
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (!window.matchMedia('(display-mode: standalone)').matches) {
    setTimeout(showInstallBanner, 2000);
  }
});

window.addEventListener('appinstalled', () => {
  hideInstallBanner();
  toast('✅ App installed on home screen!', 'ok');
  deferredInstallPrompt = null;
});

function showInstallBanner() {
  if (localStorage.getItem('install_dismissed')) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  const banner = document.getElementById('install-banner');
  if (!banner) return;

  // Show native button if Chrome prompt available
  if (deferredInstallPrompt) {
    document.getElementById('install-native').style.display = 'block';
  }

  // Always show manual steps for the detected browser
  const steps = getInstallSteps();
  document.getElementById('install-steps-content').innerHTML =
    steps.map(s => '<div>' + s + '</div>').join('');

  banner.style.display = 'block';
}

function hideInstallBanner() {
  const banner = document.getElementById('install-banner');
  if (banner) banner.style.display = 'none';
}

async function triggerInstall() {
  try {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
      hideInstallBanner();
      localStorage.setItem('install_dismissed', '1');
    }
    deferredInstallPrompt = null;
  }
  } catch(e) { console.error("[triggerInstall]", e); toast("Error: " + e.message, "err"); }
}

function dismissInstall(permanent) {
  hideInstallBanner();
  if (permanent) localStorage.setItem('install_dismissed', '1');
}

// Show install banner on load if not already installed and not dismissed
setTimeout(() => {
  if (!window.matchMedia('(display-mode: standalone)').matches &&
      !localStorage.getItem('install_dismissed')) {
    showInstallBanner();
  }
}, 3000);



// ===== USER MENU =====
let userMenuOpen = false;

function toggleUserMenu() {
  userMenuOpen = !userMenuOpen;
  const dd = document.getElementById('user-dropdown');
  if (dd) dd.style.display = userMenuOpen ? 'block' : 'none';
}

function closeUserMenu() {
  userMenuOpen = false;
  const dd = document.getElementById('user-dropdown');
  if (dd) dd.style.display = 'none';
}

// Close on outside click
document.addEventListener('click', e => {
  if (!userMenuOpen) return;
  const wrap = document.getElementById('user-menu-wrap');
  if (wrap && !wrap.contains(e.target)) closeUserMenu();
});

function showUserProfile() {
  closeUserMenu();
  if (!currentUser) return;
  const roleColors = { super: '#92400e', user: '#1d4ed8', clerk: 'var(--green)' };
  const roleLabels = { super: '🟡 Super User — Full Access', user: '🔵 User — Standard Access', clerk: '🟢 Clerk — Limited Access' };
  const tabLabels = { dash: 'Dashboard', inventory: 'Inventory', list: 'Stock', wishlist: 'Wishlist', add: 'Add Item', sell: 'Sale', operations: 'Operations', settings: 'Settings' };
  document.getElementById('profile-name').textContent = currentUser.name;
  document.getElementById('profile-username').textContent = currentUser.username;
  const roleEl = document.getElementById('profile-role');
  roleEl.textContent = currentUser.roleLabel;
  roleEl.style.color = roleColors[currentUser.role] || 'var(--muted)';
  document.getElementById('profile-access').textContent = roleLabels[currentUser.role] || currentUser.roleLabel;
  document.getElementById('profile-access').style.color = roleColors[currentUser.role];
  document.getElementById('profile-tabs').textContent = currentUser.tabs.map(t => tabLabels[t] || t).join(', ');
  document.getElementById('profile-sheet').classList.add('open');
}

function closeProfileSheet() {
  document.getElementById('profile-sheet').classList.remove('open');
}

function tidySettingsPage() {
  const primarySync = document.querySelector('#firebase-setup-card button[onclick="runSyncDebug()"]');
  if (primarySync) primarySync.textContent = 'Sync Now';
  document.querySelectorAll('#page-settings button[onclick="runSyncDebug()"]').forEach(btn => {
    if (btn !== primarySync) btn.style.display = 'none';
  });
}

// backdrop close
document.addEventListener('DOMContentLoaded', () => {
  const ps = document.getElementById('profile-sheet');
  if (ps) ps.addEventListener('click', e => { if (e.target === ps) closeProfileSheet(); });
});

// ===== AUTH / LOGIN =====
const USERS = [
  {
    username: 'onchari',
    pin: '1234',
    pinHash: '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
    name: 'Onchari',
    role: 'super',
    roleLabel: 'Super User',
    // Super: access to everything
    tabs: ['dash','inventory','sell','history','operations','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    pinHash: '38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','inventory','sell','history','operations']
  },
  {
    username: 'trevor',
    pin: '3456',
    pinHash: 'ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd',
    name: 'Trevor',
    role: 'clerk',
    roleLabel: 'Clerk',
    // Clerk: view stock + add stock
    tabs: ['inventory','sell']
  }
];

async function hashPin(pin) {
  try {
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(pin)));
      return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
    }
  } catch(e) {}
  return null;
}

let _loginAttempts = 0, _loginLockedUntil = 0;
let currentUser = null;



function applyRoleRestrictions(user) {
  tidySettingsPage();
  // Show/hide nav tabs based on role
  const allTabs = ['dash','inventory','sell','list','wishlist','add','history','operations','finance','day','settings'];
  allTabs.forEach(tab => {
    const btn = document.getElementById('tab-' + tab);
    if (btn) {
      btn.style.display = user.tabs.includes(tab) ? '' : 'none';
    }
  });

  // Clerk specific: only show Add page with a simplified header
  if (user.role === 'clerk') {
    const header = document.querySelector('.header-title');
    if (header) header.textContent = 'Add Stock — Mandela';

  }
}

function confirmLogout() {
  if (confirm('Sign out of Mandela General Stores?')) {
    logout();
  }
}

function logout() {
  currentUser = null;
  localStorage.removeItem(KEY_SESSION);
  localStorage.removeItem('mg_last_page');
  // Reset nav tabs visibility
  ['dash','inventory','list','wishlist','add','sell','history','operations','finance','day','types','settings'].forEach(tab => {
    const btn = document.getElementById('tab-' + tab);
    if (btn) btn.style.display = '';
  });
  // Reset header
  const header = document.querySelector('.header-title');
  if (header) header.textContent = 'Mandela General Stores';

  const wrap2 = document.getElementById('user-menu-wrap'); if (wrap2) wrap2.style.display = 'none'; const pill2 = document.getElementById('user-pill'); if (pill2) pill2.style.display = 'none'; closeUserMenu();
  // Clear inputs and show login
  document.getElementById('login-user').value = '';
  document.getElementById('login-pin').value = '';
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}



function attemptLogin() {
  const username = document.getElementById('login-user').value.trim().toLowerCase();
  const pin = document.getElementById('login-pin').value.trim();
  const err = document.getElementById('login-error');

  const user = USERS.find(u => u.username === username && u.pin === pin);
  if (!user) {
    err.style.display = 'block';
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
    if (typeof shakeLogin !== 'undefined') shakeLogin();
    return;
  }

  err.style.display = 'none';
  currentUser = user; // SET BEFORE showPage is called
  localStorage.setItem(KEY_SESSION, JSON.stringify({ username: user.username, ts: Date.now() }));

  // Hide login screen
  document.getElementById('login-screen').style.display = 'none';

  // Apply role restrictions
  applyRoleRestrictions(user);

  // Update user pill
  const pill = document.getElementById('user-pill');
  if (pill) {
    pill.style.display = 'inline-flex';
    pill.innerHTML = '<i class="fa-solid fa-user" style="font-size:12px;"></i> ' + user.name;
  }

  // Go to day page if day not open, otherwise last visited page
  const rawLastPage = localStorage.getItem(KEY_LAST_PAGE) || 'dash';
  const lastPage = (rawLastPage === 'day' || rawLastPage === 'finance') ? 'operations' : rawLastPage;
  const allowedPage = user.tabs.includes(lastPage) ? lastPage : user.tabs[0];

  // Check day status
  // No forced redirect to day — user navigates manually
  _origShowPage(allowedPage);
  toast('Welcome, ' + user.name + '! 👋', 'ok');
}

function checkSession() {
  const saved = localStorage.getItem(KEY_SESSION);
  if (!saved) {
    document.getElementById('login-screen').style.display = 'flex';
    return false;
  }
  try {
    const data = JSON.parse(saved);
    // Support both old format {username, pin} and new format {username, ts}
    const username = data.username;
    const ts       = data.ts || 0;
    const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days — never expire on normal use
    const expired  = ts > 0 && (Date.now() - ts) > SESSION_TTL;
    const user     = USERS.find(u => u.username === username);

    if (user && !expired) {
      // Refresh timestamp
      localStorage.setItem(KEY_SESSION, JSON.stringify({ username, ts: Date.now() }));
      currentUser = user;
      document.getElementById('login-screen').style.display = 'none';
      applyRoleRestrictions(user);
      const pill = document.getElementById('user-pill');
      if (pill) {
        pill.style.display = 'inline-flex';
        pill.innerHTML = '<i class="fa-solid fa-user" style="font-size:12px;"></i> ' + user.name;
      }
      const wrap = document.getElementById('user-menu-wrap');
      if (wrap) wrap.style.display = 'block';
      return true;
    } else {
      localStorage.removeItem(KEY_SESSION);
      document.getElementById('login-screen').style.display = 'flex';
      return false;
    }
  } catch(e) {
    localStorage.removeItem(KEY_SESSION);
    document.getElementById('login-screen').style.display = 'flex';
    return false;
  }
}


// ===== JQUERY ENHANCEMENTS =====


window.addEventListener('unhandledrejection',e=>{
  console.error('[UNHANDLED]',e.reason);
  if(e.reason&&e.reason.message&&e.reason.message.includes('Database'))toast('⚠️ '+e.reason.message,'err');
});

// ── APP UPDATE SYSTEM ─────────────────────────────────────────────
let _pendingWorker = null;
let _updateBannerDismissed = false;

function _showUpdateState(state) {
  ['current','available','installing'].forEach(s => {
    const el = document.getElementById('update-state-' + s);
    if (el) el.style.display = s === state ? '' : 'none';
  });
}

function _setUpdateLastCheck() {
  const el = document.getElementById('update-last-check');
  if (el) el.textContent = 'Checked: ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
}

function _showUpdateBanner() {
  const banner = document.getElementById('app-update-banner');
  if (!banner) return;
  // Reset state
  const progress   = document.getElementById('upd-progress-wrap');
  const success    = document.getElementById('upd-success');
  const btnArea    = document.getElementById('upd-btn-area');
  const installBtn = document.getElementById('upd-install-btn');
  const laterBtn   = document.getElementById('upd-later-btn');
  if (progress)   progress.style.display   = 'none';
  if (success)    success.style.display    = 'none';
  if (btnArea)    btnArea.style.display    = 'flex';
  if (installBtn) { installBtn.disabled = false; installBtn.style.opacity = '1'; installBtn.textContent = '⬇️ Install Update Now'; }
  if (laterBtn)   laterBtn.style.display  = 'block';
  // Show banner
  banner.style.display = 'flex';
}

function dismissAppUpdate() {
  const banner = document.getElementById('app-update-banner');
  if (banner) banner.style.display = 'none';
  _updateBannerDismissed = true;
  // Keep the dot on settings tab so they can still find it
  toast('Update ready — tap Settings to install when ready', '');
}

function applyAppUpdate() {
  if (!_pendingWorker) return;
  const installBtn = document.getElementById('upd-install-btn');
  const laterBtn   = document.getElementById('upd-later-btn');
  const progress   = document.getElementById('upd-progress-wrap');
  const bar        = document.getElementById('upd-progress-bar');
  const pctEl      = document.getElementById('upd-progress-pct');
  const lblEl      = document.getElementById('upd-progress-label');

  // Hide buttons, show progress
  if (installBtn) { installBtn.disabled = true; installBtn.style.opacity = '0.4'; }
  if (laterBtn)   laterBtn.style.display = 'none';
  if (progress)   progress.style.display = 'block';

  // Animated progress steps
  const steps = [
    { pct:15,  lbl:'Downloading update…',     delay:0   },
    { pct:35,  lbl:'Verifying files…',         delay:400 },
    { pct:55,  lbl:'Installing…',              delay:700 },
    { pct:75,  lbl:'Clearing old cache…',      delay:1100},
    { pct:90,  lbl:'Finalising…',              delay:1500},
  ];
  steps.forEach(({pct, lbl, delay}) => {
    setTimeout(() => {
      if (bar)   bar.style.width    = pct + '%';
      if (pctEl) pctEl.textContent  = pct + '%';
      if (lblEl) lblEl.textContent  = lbl;
    }, delay);
  });

  // Trigger the actual SW skip-waiting
  _pendingWorker.postMessage({ type: 'SKIP_WAITING' });
  // controllerchange will fire → reloads page; we also update settings card
  _showUpdateState('installing');
}

// Legacy alias kept for settings page button
function installAppUpdate() { applyAppUpdate(); }

// ===================================================================
// FINANCE MODULE
// Tracks: investments, expenses, withdrawals, other money flows
// ===================================================================

let _finFilter = 'all';

// ── Finance period state ────────────────────────────────────
let _finPeriod = 'today';  // today | week | month | all

function finSetPeriod(period) {
  _finPeriod = period;
  document.querySelectorAll('[id^="fin-period-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('fin-period-' + period);
  if (btn) btn.classList.add('active');
  renderFinancePage();
}

function _finDateRange() {
  const now   = new Date();
  const today = todayDateStr();
  if (_finPeriod === 'today') return { from: today, to: today };
  if (_finPeriod === 'week') {
    const d = new Date(now);
    d.setDate(d.getDate() - 6);
    return { from: d.toISOString().split('T')[0], to: today };
  }
  if (_finPeriod === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: d.toISOString().split('T')[0], to: today };
  }
  return { from: null, to: null }; // all
}

function _finInRange(date, range) {
  if (!range.from) return true;
  return date >= range.from && date <= range.to;
}

async function renderFinancePage() {
  const dateEl = document.getElementById('fin-date');
  if (dateEl && !dateEl.value) dateEl.value = todayDateStr();

  const allEntries = await dbAll('finances');

  const poolTypes = ['revenue','injection','investment','stock_purchase','expense','withdrawal','other'];
  const poolEntries = allEntries.filter(e => poolTypes.includes(e.type));

  // ── KPIs (all time) ──────────────────────────────────────
  const invested  = poolEntries.filter(e=>e.type==='injection'||e.type==='investment'||e.type==='stock_purchase').reduce((s,e)=>s+(e.amount||0),0);
  const salesPool = poolEntries.filter(e=>e.type==='revenue').reduce((s,e)=>s+(e.amount||0),0);
  const stockCostReleased = poolEntries.filter(e=>e.type==='revenue').reduce((s,e)=>s+(e.costAmount||Math.max(0,(e.amount||0)-(e.profit||0))),0);
  const expenses  = poolEntries.filter(e=>e.type==='expense'||e.type==='other').reduce((s,e)=>s+(e.amount||0),0);
  const withdrawn = poolEntries.filter(e=>e.type==='withdrawal').reduce((s,e)=>s+(e.amount||0),0);
  const businessPool = invested - stockCostReleased - expenses;
  const net       = salesPool - withdrawn;

  const setT = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=fmt(v); };
  const setLabel = (id, text) => {
    const el = document.getElementById(id);
    const lbl = el && el.parentElement ? el.parentElement.querySelector('.fin-kpi-lbl') : null;
    if (lbl) lbl.textContent = text;
  };
  setLabel('fin-net', 'Sales Pool');
  setLabel('fin-invested', 'Business Pool');
  setLabel('fin-expenses', 'Business Spent');
  setLabel('fin-withdrawn', 'Sales Out');
  const finTypeEl = document.getElementById('fin-type');
  if (finTypeEl) {
    const optionLabels = {
      injection: 'Cash to Business Pool',
      investment: 'Owner Investment',
      stock_purchase: 'Stock Added',
      expense: 'Business Expense',
      withdrawal: 'Sales Withdrawal',
      other: 'Other Business Spend'
    };
    Object.entries(optionLabels).forEach(([value, label]) => {
      const opt = finTypeEl.querySelector('option[value="' + value + '"]');
      if (opt) opt.textContent = label;
    });
  }
  const filterInvestment = document.getElementById('fin-filter-investment');
  const filterExpense = document.getElementById('fin-filter-expense');
  if (filterInvestment) filterInvestment.textContent = 'Business';
  if (filterExpense) filterExpense.textContent = 'Out';
  setT('fin-revenue',  0);
  setT('fin-profit',   0);
  setT('fin-invested', businessPool);
  setT('fin-expenses', expenses);
  setT('fin-withdrawn',withdrawn);

  const marginEl = document.getElementById('fin-margin');
  if (marginEl) {
    marginEl.textContent = '0%';
    marginEl.style.color = 'var(--text)';
  }
  const netEl  = document.getElementById('fin-net');
  const netKpi = document.getElementById('fin-net-kpi');
  if (netEl)  { netEl.textContent = (net>=0?'':'-')+fmt(Math.abs(net)); netEl.style.color = net>=0?'var(--green)':'var(--red)'; }
  if (netKpi) { netKpi.className = 'fin-kpi '+(net>=0?'green':'red'); }

  // ── Transaction list ─────────────────────────────────────
  let listEntries;
  if (_finFilter === 'all') {
    listEntries = poolEntries;
  } else if (_finFilter === 'investment') {
    listEntries = poolEntries.filter(e=>e.type==='injection'||e.type==='investment'||e.type==='stock_purchase');
  } else if (_finFilter === 'expense') {
    listEntries = poolEntries.filter(e=>e.type==='expense'||e.type==='withdrawal'||e.type==='other');
  } else {
    listEntries = poolEntries.filter(e=>e.type===_finFilter);
  }
  const sorted = [...listEntries].sort((a,b)=>new Date(b.date||b.createdAt)-new Date(a.date||a.createdAt));

  const summaryLine = document.getElementById('fin-summary-line');
  if (summaryLine) {
    const total = listEntries.reduce((s,e)=>s+e.amount,0);
    summaryLine.textContent = sorted.length + ' entr'+(sorted.length===1?'y':'ies')+' · '+fmt(total);
  }

  renderFinList(sorted);
}


function _renderFinChart(allEntries, allSales) {
  const chartWrap = document.getElementById('fin-chart-wrap');
  const chart     = document.getElementById('fin-chart');
  const labels    = document.getElementById('fin-chart-labels');
  if (!chart || !chartWrap) return;

  // Build last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }

  const dayData = days.map(date => {
    const revE = allEntries.filter(e=>e.type==='revenue'&&e.category==='sales'&&(e.date||'').split('T')[0]===date);
    const rev  = revE.length ? revE.reduce((s,e)=>s+e.amount,0) : allSales.filter(s=>(s.businessDate||(s.date||'').split('T')[0])===date).reduce((s,s2)=>s+(s2.revenue||0),0);
    const exp  = allEntries.filter(e=>e.type==='expense'&&(e.date||'').split('T')[0]===date).reduce((s,e)=>s+e.amount,0);
    return { date, rev, exp, net: rev - exp };
  });

  const hasData = dayData.some(d => d.rev > 0 || d.exp > 0);
  chartWrap.style.display = hasData ? '' : 'none';
  if (!hasData) return;

  const maxVal = Math.max(...dayData.map(d => Math.max(d.rev, d.exp)), 1);
  const barW   = 'calc(' + (100/7) + '% - 3px)';

  chart.innerHTML = dayData.map(d => {
    const revH = Math.round((d.rev / maxVal) * 56);
    const expH = Math.round((d.exp / maxVal) * 56);
    return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;height:60px;justify-content:flex-end;">' +
      (d.rev > 0 ? '<div title="Revenue: ' + fmt(d.rev) + '" style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;height:' + revH + 'px;"></div>' : '<div style="height:' + revH + 'px;"></div>') +
    '</div>';
  }).join('');

  labels.innerHTML = dayData.map(d => {
    const label = new Date(d.date + 'T12:00:00').toLocaleDateString('en-GB',{weekday:'short'}).slice(0,2);
    return '<div style="flex:1;text-align:center;font-size:9px;color:var(--muted);font-weight:600;">' + label + '</div>';
  }).join('');
}

function renderFinList(entries) {
  const list = document.getElementById('fin-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px;color:var(--muted);font-size:13px;">No entries yet.<br><span style="font-size:11px;">Use the form above to record a transaction.</span></div>';
    return;
  }
  const cfgMap = {
    revenue:       { icon:'KES', color:'var(--accent2)', label:'Sale to Sales Pool', out:false },
    injection:     { icon:'💉', color:'var(--green)', label:'Injection',      out:false },
    investment:    { icon:'💵', color:'var(--green)', label:'Investment',     out:false },
    stock_purchase:{ icon:'🛍️', color:'#1d4ed8',      label:'Stock Purchase', out:true  },
    expense:       { icon:'💸', color:'var(--red)',   label:'Expense',        out:true  },
    withdrawal:    { icon:'🏧', color:'#d97706',      label:'Withdrawal',     out:true  },
    other:         { icon:'📝', color:'var(--muted)', label:'Other',          out:false },
  };
  const rows = entries.map((e, i) => {
    let c  = cfgMap[e.type] || cfgMap.other;
    if (e.type === 'stock_purchase') c = { ...c, label: 'Stock Investment', out: false };
    if (e.type === 'expense') c = { ...c, label: 'Business Expense', out: true };
    if (e.type === 'withdrawal') c = { ...c, label: 'Sales Withdrawal', out: true };
    if (e.type === 'other') c = { ...c, out: true };
    const ds = e.date || (e.createdAt||'').split('T')[0];
    const fd = ds ? new Date(ds+'T12:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—';
    const bg = i % 2 === 0 ? 'var(--surface)' : '#f7faf7';
    const delBtn = (currentUser&&currentUser.role==='super')
      ? '<button onclick="deleteFinanceEntry('+e.id+')" style="font-size:10px;color:var(--muted);background:none;border:none;cursor:pointer;padding:2px 4px;flex-shrink:0;">✕</button>'
      : '';
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:'+bg+';border-bottom:1px solid var(--border);">' +
      '<span style="font-size:18px;flex-shrink:0;">'+c.icon+'</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHtml(e.description||c.label)+'</div>' +
        '<div style="font-size:10px;color:var(--muted);margin-top:1px;">'+c.label+' · '+fd+'</div>' +
      '</div>' +
      '<div style="font-size:14px;font-weight:900;font-family:var(--mono);color:'+c.color+';flex-shrink:0;">'+(c.out?'-':'+')+fmt(e.amount)+'</div>' +
      delBtn +
    '</div>';
  });
  list.innerHTML = '<div style="border:1.5px solid var(--border);border-radius:var(--r-lg);overflow:hidden;">' + rows.join('') + '</div>';
}

async function saveFinanceEntry() {
  const type   = document.getElementById('fin-type').value;
  const amount = parseFloat(document.getElementById('fin-amount').value);
  const desc   = (document.getElementById('fin-desc').value||'').trim();
  const date   = document.getElementById('fin-date').value || todayDateStr();
  const cat    = (document.getElementById('fin-category')?.value) || 'general';

  const validTypes = ['injection','investment','stock_purchase','expense','withdrawal','other'];
  if (!type || !validTypes.includes(type)) return Validate.fail('Select a transaction type', 'fin-type');
  if (!amount || amount <= 0)  return Validate.fail('Enter a valid amount (must be > 0)', 'fin-amount');
  if (amount > 99999999)       return Validate.fail('Amount too large — check the value', 'fin-amount');
  if (!desc)                   return Validate.fail('Enter a description for this transaction', 'fin-desc');
  if (desc.length > 200)       return Validate.fail('Description too long (max 200 characters)', 'fin-desc');
  if (!date)                   return Validate.fail('Select a date', 'fin-date');
  // Warn if future date
  if (date > todayDateStr() && !confirm('Date is in the future — are you sure?')) return;

  const entry = { type, amount, description: desc, category: cat, date,
    createdAt: new Date().toISOString(), createdBy: currentUser ? currentUser.username : 'system' };
  entry.id = await dbAdd('finances', entry);

  // Sync to Firebase
  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      const fbId = 'fin_manual_' + Date.now();
      entry.fbId = fbId;
      await setDoc(doc(fbDb, 'finances', fbId), sanitiseForFirestore({...entry}));
      await dbPut('finances', entry);
    } catch(e) { console.warn('[SYNC] finance entry:', e.message); }
  }

  // Clear form after save
  document.getElementById('fin-type').value   = '';
  document.getElementById('fin-amount').value = '';
  document.getElementById('fin-desc').value   = '';
  document.getElementById('fin-date').value   = todayDateStr();
  const ftEl = document.getElementById('fin-type');
  if (ftEl) ftEl.style.background = '';

  renderFinancePage();
  scheduleSync();
  toast('✅ ' + (type==='investment'?'Investment':'Expense') + ' recorded: ' + fmt(amount), 'ok');
}

async function deleteFinanceEntry(id) {
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  const entry = await dbGet('finances', id);
  if (entry) {
    _rememberDeletedFinance(entry);
    await fbDeleteFinanceEntry(entry);
  }
  await dbDelete('finances', id);
  renderFinancePage();
  toast('Transaction deleted', '');
}

function filterFinance(type) {
  _finFilter = type;
  // Only 3 filter buttons: all, investment, expense
  ['all','investment','expense'].forEach(t => {
    const b = document.getElementById('fin-filter-' + t);
    if (b) b.classList.toggle('active', t === type);
  });
  renderFinancePage();
}

function updateFinTypeColor() {
  const sel = document.getElementById('fin-type');
  if (!sel) return;
  const colors = {
    injection:'#dcfce7', investment:'#dcfce7',
    stock_purchase:'#dbeafe', expense:'#fee2e2',
    withdrawal:'#fef3c7', other:'var(--surface2)'
  };
  sel.style.background = colors[sel.value] || '';
  const catEl = document.getElementById('fin-category');
  if (catEl) {
    const autoCat = {
      injection:'owner_capital', investment:'owner_capital',
      stock_purchase:'stock', expense:'general',
      withdrawal:'cash_drawer', other:'general'
    };
    catEl.value = autoCat[sel.value] || 'general';
  }
}


// ── Shoe group expand/collapse ────────────────────────────────────
let _expandedShoeGroups = new Set();
window._activeSizeGroupFilter = 'all';

function toggleShoeGroup(code) {
  if (_expandedShoeGroups.has(code)) {
    _expandedShoeGroups.delete(code);
  } else {
    _expandedShoeGroups.add(code);
  }
  renderList();
}
window.toggleShoeGroup = toggleShoeGroup;

function setSizeGroupFilter(group) {
  window._activeSizeGroupFilter = group;
  document.querySelectorAll('[id^="sgf-"]').forEach(b=>b.classList.remove('active'));
  const btn = document.getElementById('sgf-'+group);
  if (btn) btn.classList.add('active');
  renderList();
}
window.setSizeGroupFilter = setSizeGroupFilter;

function _renderSizeGroupFilter() {
  const wrap = document.getElementById('shoe-size-filter');
  if (!wrap) return;
  // Show only when a shoe type is active or search has results with shoes
  const hasShoe = allItems.some(i=>i.isShoe && (activeTypeFilter==='all'||i.type===activeTypeFilter));
  wrap.style.display = hasShoe ? 'flex' : 'none';
}


// ═══════════════════════════════════════════════════════════
// DAY RECONCILIATION — FLOW CONTROLLER
// Steps keyed by date in localStorage:
//   no data        → step: open  (show Open Day btn)
//   opened_only    → step: opening_form (show opening balances form)
//   opening_locked → step: close_btn (show Close Day btn)
//   closing_form   → step: closing_form (show closing form)
//   reconciled     → step: reconciled (insights only)
// ═══════════════════════════════════════════════════════════

const DAY_RECON_KEY = date => 'mgs_recon_' + date;

function _getDayRecon(date) {
  try { return JSON.parse(localStorage.getItem(DAY_RECON_KEY(date)) || 'null'); }
  catch(e) { return null; }
}
function _saveDayRecon(date, data) {
  try { localStorage.setItem(DAY_RECON_KEY(date), JSON.stringify(data)); } catch(e) {}
}
function _clearDayRecon(date) {
  try { localStorage.removeItem(DAY_RECON_KEY(date)); } catch(e) {}
}

// ── Show correct step ────────────────────────────────────────────
function renderDayState() {
  const today = activeDay
    ? (activeDay.businessDate || activeDay.business_date)
    : todayDateStr();

  // Update header
  const titleEl = document.getElementById('day-banner-title');
  const subEl   = document.getElementById('day-banner-sub');
  const iconEl  = document.getElementById('day-banner-icon');
  if (titleEl) titleEl.textContent = fmtFullDate(today);
  if (subEl)   subEl.textContent   = today;
  if (iconEl)  iconEl.textContent  = '📅';

  const data  = _getDayRecon(today);
  const step  = data ? data.step : 'open';
  const isOpen = activeDay && (activeDay.status === 'OPEN');

  // All step divs
  const steps = ['open','opening-form','close-btn','closing-form','reconciled'];
  steps.forEach(s => {
    const el = document.getElementById('day-step-' + s);
    if (el) el.style.display = 'none';
  });
  const openLocked = document.getElementById('day-opening-locked');
  if (openLocked) openLocked.style.display = 'none';

  // Determine which step to show
  if (step === 'reconciled') {
    if (openLocked) openLocked.style.display = '';
    _renderOpeningSummary(data);
    const el = document.getElementById('day-step-reconciled');
    if (el) el.style.display = '';
    _renderReconcileInsights(data, today);

  } else if (step === 'closing_form') {
    if (openLocked) openLocked.style.display = '';
    _renderOpeningSummary(data);
    const el = document.getElementById('day-step-closing-form');
    if (el) el.style.display = '';

  } else if (step === 'opening_locked' || (data && data.opening)) {
    if (openLocked) openLocked.style.display = '';
    _renderOpeningSummary(data);
    const el = document.getElementById('day-step-close-btn');
    if (el) el.style.display = '';

  } else if (step === 'opening_form' || isOpen) {
    const el = document.getElementById('day-step-opening-form');
    if (el) el.style.display = '';

  } else {
    // Default: show Open Day button
    const el = document.getElementById('day-step-open');
    if (el) el.style.display = '';
  }
}
window.renderDayState = renderDayState;

// ── openDay: existing logic + advance to opening form ────────────
// Wrap the existing openDay to also advance the state
const _origOpenDay = openDay;
openDay = async function() {
  await _origOpenDay();
  const today = todayDateStr();
  const data  = _getDayRecon(today);
  if (!data) {
    _saveDayRecon(today, { step: 'opening_form', date: today });
  }
  renderDayState();
};
window.openDay = openDay;

// ── lockOpeningBalances ──────────────────────────────────────────
function lockOpeningBalances() {
  const cash  = parseFloat(document.getElementById('op-cash')?.value)  || 0;
  const till  = parseFloat(document.getElementById('op-till')?.value)  || 0;
  const mpesa = parseFloat(document.getElementById('op-mpesa')?.value) || 0;
  if (cash === 0 && till === 0 && mpesa === 0) {
    toast('⚠️ Enter at least one opening balance', 'err'); return;
  }
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  _saveDayRecon(today, {
    step: 'opening_locked', date: today,
    lockedAt: new Date().toISOString(),
    opening: { cash, till, mpesa, total: cash + till + mpesa }
  });
  toast('🌅 Opening balances locked', 'ok');
  renderDayState();
}
window.lockOpeningBalances = lockOpeningBalances;

// ── initCloseDay: show closing form ─────────────────────────────
function initCloseDay() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data  = _getDayRecon(today) || {};
  _saveDayRecon(today, { ...data, step: 'closing_form' });
  renderDayState();
}
window.initCloseDay = initCloseDay;

// ── cancelCloseDay (from closing form Cancel btn) ────────────────
function cancelCloseDay() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data  = _getDayRecon(today) || {};
  _saveDayRecon(today, { ...data, step: 'opening_locked' });
  renderDayState();
}
window.cancelCloseDay = cancelCloseDay;

// ── reconcileDay: save closing, compute insights, lock ───────────
async function reconcileDay() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data  = _getDayRecon(today);
  if (!data || !data.opening) { toast('⚠️ Record opening balances first', 'err'); return; }

  const injected  = parseFloat(document.getElementById('cl-injected')?.value)  || 0;
  const cash      = parseFloat(document.getElementById('cl-cash')?.value)       || 0;
  const till      = parseFloat(document.getElementById('cl-till')?.value)       || 0;
  const mpesa     = parseFloat(document.getElementById('cl-mpesa')?.value)      || 0;
  const expenses  = parseFloat(document.getElementById('cl-expenses')?.value)   || 0;
  const withdrawn = parseFloat(document.getElementById('cl-withdrawn')?.value)  || 0;

  if (cash === 0 && till === 0 && mpesa === 0) {
    toast('⚠️ Enter at least Cash at Hand, Till, or M-Pesa', 'err'); return;
  }

  // ── System figures (this day only) ──────────────────────
  const allSales = await dbAll('sales');
  const allFins  = await dbAll('finances');
  const daySales = allSales.filter(s =>
    (s.businessDate||s.business_date||(s.date||'').split('T')[0]) === today);
  const dayFins  = allFins.filter(e =>
    (e.date||(e.createdAt||'').split('T')[0]) === today && e.type !== 'reconciliation');

  const sysCashRev   = daySales.filter(s=>!s.paymentMethod||s.paymentMethod==='cash').reduce((a,s)=>a+(s.revenue||0),0);
  const sysMpesaRev  = daySales.filter(s=>s.paymentMethod==='mpesa').reduce((a,s)=>a+(s.revenue||0),0);
  const sysTotalRev  = daySales.reduce((a,s)=>a+(s.revenue||0),0);
  const sysTotalProf = daySales.reduce((a,s)=>a+(s.profit||0),0);
  const salesCount   = daySales.length;
  const margin       = sysTotalRev > 0 ? (sysTotalProf/sysTotalRev*100) : 0;

  // ── THE TWO FORMULAS ────────────────────────────────────
  //
  // CORRECT DAY MONEY
  // = what you SHOULD have in hand right now
  // = Opening + Sales + Injected − Expenses − Withdrawn
  //
  const opTotal    = (data.opening.cash||0) + (data.opening.till||0) + (data.opening.mpesa||0);
  const correctDay = opTotal + sysTotalRev + injected - expenses - withdrawn;

  // ACTUAL DAY MONEY
  // = what you physically hold right now
  // = Cash at Hand + Amount in Till + M-Pesa Float
  const actualDay  = cash + till + mpesa;

  // VARIANCE = Actual − Correct
  // Zero = perfect balance
  // Positive = surplus (more cash than expected)
  // Negative = shortage (less cash than expected)
  const variance   = actualDay - correctDay;

  // ── Per-pocket expected closing (for detail view) ────────
  // What should be in each pocket right now:
  const expCash  = (data.opening.cash||0) + (data.opening.till||0) + sysCashRev  + injected - expenses - withdrawn;
  const expMpesa = (data.opening.mpesa||0) + sysMpesaRev;
  const physCash  = cash + till;
  const physMpesa = mpesa;
  const cashVar   = physCash  - expCash;
  const mpesaVar  = physMpesa - expMpesa;
  const netMove   = sysTotalRev + injected - expenses - withdrawn;

  // ── Save state ───────────────────────────────────────────
  const reconciled = {
    step: 'reconciled', date: today,
    lockedAt: data.lockedAt, opening: data.opening,
    reconciledAt: new Date().toISOString(),
    closing:  { injected, cash, till, mpesa, expenses, withdrawn },
    system:   { sysCashRev, sysMpesaRev, sysTotalRev, sysTotalProf, salesCount, margin },
    analysis: {
      opTotal, correctDay, actualDay, variance,
      expCash, expMpesa, physCash, physMpesa, cashVar, mpesaVar, netMove
    }
  };
  _saveDayRecon(today, reconciled);

  await _doCloseDay();

  await dbAdd('finances', {
    type:'reconciliation', amount:actualDay,
    description:'Day reconcile · '+today, category:'reconciliation', date:today,
    createdAt:new Date().toISOString(), createdBy:currentUser?currentUser.username:'system',
    details: reconciled
  });
  scheduleSync();

  toast('✅ Day closed & reconciled', 'ok');
  renderDayState();
  renderDaySessionsList();
}
window.reconcileDay = reconcileDay;

// ── Internal: close the business day record ──────────────────────
async function _doCloseDay() {
  if (!activeDay) return;
  const now      = new Date();
  const today    = activeDay.businessDate || activeDay.business_date;
  const allSales = await dbAll('sales');
  const daySales = allSales.filter(s=>(s.businessDate||s.business_date)===today);
  const items    = await dbAll('items');
  activeDay.status       = 'CLOSED';
  activeDay.closed_at    = now.toISOString();
  activeDay.salesCount   = daySales.length;
  activeDay.revenue      = daySales.reduce((s,x)=>s+x.revenue,0);
  activeDay.profit       = daySales.reduce((s,x)=>s+x.profit,0);
  activeDay.itemsSold    = daySales.reduce((s,x)=>s+x.qty,0);
  activeDay.closingStockCost = items.reduce((s,i)=>s+i.buy*i.qty,0);
  await dbPut('business_days', activeDay);
  setDayMode(false);
  renderDashboard();
}

// ── Render locked opening summary ───────────────────────────────
function _renderOpeningSummary(data) {
  const el = document.getElementById('day-opening-summary');
  if (!el || !data || !data.opening) return;
  const o   = data.opening;
  const f   = v => v ? fmt(v) : '—';
  const t   = new Date(data.lockedAt||0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);">'+f(o.cash)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">💵 Cash</div></div>' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);">'+f(o.till)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">🏧 Till</div></div>' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);color:#6366f1;">'+f(o.mpesa)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">📱 M-Pesa</div></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid #a8d8b5;padding-top:8px;">' +
      '<span style="font-size:10px;color:var(--muted);">Locked '+t+'</span>' +
      '<span style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">Total: '+fmt(o.total||0)+'</span>' +
    '</div>';
}

// ── Render reconcile insights ────────────────────────────────────
function _renderReconcileInsights(data, today) {
  const el = document.getElementById('day-reconcile-insights');
  if (!el || !data || !data.closing) return;
  const o  = data.opening;
  const cl = data.closing;
  const sy = data.system;
  const an = data.analysis;

  const absV = Math.abs(an.variance);
  const isOk = absV <= 5;
  const isWn = !isOk && absV <= 300;
  const vc   = isOk ? 'var(--green)' : isWn ? '#d97706' : 'var(--red)';
  const vi   = isOk ? '✅' : an.variance > 0 ? '⬆️' : '⬇️';
  const vl   = isOk ? 'Balanced'
             : an.variance > 0 ? '+'+fmt(an.variance)+' surplus'
             : fmt(absV)+' short';
  const clf  = v => Math.abs(v) <= 5 ? 'rc-ok' : Math.abs(v) <= 300 ? 'rc-warn' : 'rc-bad';

  // ── Per-pocket row ─────────────────────────────────────
  const pocketRow = (icon, lbl, opening, expected, physical) => {
    const v   = physical - expected;
    const cls = clf(v);
    const vs  = Math.abs(v) <= 5 ? '✅' : v > 0 ? '⬆️ +'+fmt(v) : '⬇️ -'+fmt(Math.abs(v));
    const vc2 = Math.abs(v) <= 5 ? 'var(--green)' : v > 0 ? '#d97706' : 'var(--red)';
    return '<div class="'+cls+'" style="padding:10px 12px;border-bottom:1px solid var(--border);">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">' +
        '<div style="display:flex;align-items:center;gap:7px;">' +
          '<span style="font-size:15px;">'+icon+'</span>' +
          '<span style="font-size:12px;font-weight:800;color:var(--text);">'+lbl+'</span>' +
        '</div>' +
        '<span style="font-size:11px;font-weight:800;color:'+vc2+';">'+vs+'</span>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;text-align:center;">' +
        '<div style="background:var(--surface2);border-radius:var(--r);padding:5px 4px;">' +
          '<div style="font-size:12px;font-weight:900;font-family:var(--mono);color:var(--muted);">'+fmt(opening)+'</div>' +
          '<div style="font-size:9px;color:var(--muted);margin-top:1px;font-weight:600;text-transform:uppercase;">Opening</div>' +
        '</div>' +
        '<div style="background:#eef4ff;border-radius:var(--r);padding:5px 4px;">' +
          '<div style="font-size:12px;font-weight:900;font-family:var(--mono);color:var(--accent);">'+fmt(expected)+'</div>' +
          '<div style="font-size:9px;color:var(--muted);margin-top:1px;font-weight:600;text-transform:uppercase;">Expected</div>' +
        '</div>' +
        '<div style="background:'+(Math.abs(v)<=5?'var(--green-light)':Math.abs(v)<=300?'#fef3c7':'var(--red-light)')+';border-radius:var(--r);padding:5px 4px;">' +
          '<div style="font-size:12px;font-weight:900;font-family:var(--mono);color:'+vc2+';">'+fmt(physical)+'</div>' +
          '<div style="font-size:9px;color:var(--muted);margin-top:1px;font-weight:600;text-transform:uppercase;">Physical</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  };

  // ── Insights ──────────────────────────────────────────
  const ins = [];
  if (isOk) {
    ins.push({i:'🎯',c:'rc-ok',  t:'Perfect — every shilling accounted for!'});
  } else if (an.variance > 0) {
    ins.push({i:'⬆️',c:'rc-warn',t:'Surplus of '+fmt(an.variance)+'. More cash than expected. Check for unrecorded injection, or a deposit not captured.'});
  } else {
    ins.push({i:'⬇️',c:'rc-bad', t:'Short by '+fmt(absV)+'. Less cash than expected. Check for unrecorded expense, undeclared withdrawal, or theft.'});
  }
  if (Math.abs(an.cashVar)  > 50 && Math.abs(an.mpesaVar) <= 50)
    ins.push({i:'💵',c:clf(an.cashVar),  t:'Cash discrepancy ('+fmt(Math.abs(an.cashVar))+'). M-Pesa is balanced — issue is in physical cash.'});
  if (Math.abs(an.mpesaVar) > 50 && Math.abs(an.cashVar)  <= 50)
    ins.push({i:'📱',c:clf(an.mpesaVar), t:'M-Pesa discrepancy ('+fmt(Math.abs(an.mpesaVar))+'). Cash is balanced — check M-Pesa statement.'});
  if (Math.abs(an.cashVar)  > 50 && Math.abs(an.mpesaVar) > 50)
    ins.push({i:'⚠️',c:'rc-bad',         t:'Both Cash and M-Pesa are off. Recount everything carefully.'});
  if (cl.expenses > 0 && sy.sysTotalRev > 0 && cl.expenses > sy.sysTotalRev * 0.35)
    ins.push({i:'💸',c:'rc-warn',t:'Expenses ('+fmt(cl.expenses)+') are '+((cl.expenses/sy.sysTotalRev)*100).toFixed(0)+'% of revenue — high for today.'});
  if (sy.margin < 10 && sy.sysTotalRev > 0)
    ins.push({i:'📉',c:'rc-warn',t:'Low margin: '+sy.margin.toFixed(1)+'%. Review prices or costs.'});
  else if (sy.margin >= 30 && sy.sysTotalRev > 0)
    ins.push({i:'🎉',c:'rc-ok', t:'Great margin: '+sy.margin.toFixed(1)+'%!'});
  if (an.netMove < 0)
    ins.push({i:'🚨',c:'rc-bad',t:'Net movement is negative ('+fmt(an.netMove)+'). Business paid out more than it earned today.'});
  if (sy.salesCount === 0)
    ins.push({i:'😴',c:'rc-warn',t:'No sales recorded today.'});

  el.innerHTML =
    // ── Sales summary ──────────────────────────────────
    '<div class="day-section-label">📊 Today Summary</div>' +
    '<div style="border:1.5px solid #a8d8b5;border-radius:var(--r-lg);overflow:hidden;margin-bottom:8px;">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;text-align:center;background:var(--surface);">' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:16px;font-weight:900;font-family:var(--mono);color:var(--green);">'+sy.salesCount+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Sales</div></div>' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">'+fmt(sy.sysTotalRev)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Revenue</div></div>' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">'+fmt(sy.sysTotalProf)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Profit</div></div>' +
        '<div style="padding:10px 4px;"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--accent);">'+sy.margin.toFixed(1)+'%</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Margin</div></div>' +
      '</div>' +
      (cl.injected > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>💉 Injected</span><span style="font-weight:800;color:var(--green);">+'+fmt(cl.injected)+'</span></div>' : '') +
      (cl.expenses  > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>💸 Expenses</span><span style="font-weight:800;color:var(--red);">-'+fmt(cl.expenses)+'</span></div>' : '') +
      (cl.withdrawn > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>🏧 Withdrawn</span><span style="font-weight:800;color:#d97706;">-'+fmt(cl.withdrawn)+'</span></div>' : '') +
      '<div style="display:flex;justify-content:space-between;padding:9px 12px;border-top:1px solid #a8d8b5;background:#f0faf4;font-size:12px;font-weight:800;">' +
        '<span style="color:var(--green);">Net Movement</span>' +
        '<span style="font-family:var(--mono);color:'+(an.netMove>=0?'var(--green)':'var(--red)')+';">'+(an.netMove>=0?'+':'')+fmt(an.netMove)+'</span>' +
      '</div>' +
    '</div>' +

    // ── The two money totals ────────────────────────────
    '<div class="day-section-label">⚖️ Day Money Check</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
      '<div style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Should Have</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:2;margin-bottom:8px;">' +
          'Opening: <b>'+fmt(an.opTotal)+'</b><br>+ Sales: <b>'+fmt(sy.sysTotalRev)+'</b>' +
          (cl.injected>0?'<br>+ Injected: <b>'+fmt(cl.injected)+'</b>':'') +
          (cl.expenses>0?'<br>− Expenses: <b>'+fmt(cl.expenses)+'</b>':'') +
          (cl.withdrawn>0?'<br>− Withdrawn: <b>'+fmt(cl.withdrawn)+'</b>':'') +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:var(--accent);border-top:1px solid var(--border);padding-top:8px;">'+fmt(an.correctDay)+'</div>' +
      '</div>' +
      '<div style="background:'+(isOk?'var(--green-light)':isWn?'#fef3c7':'var(--red-light)')+';border:1.5px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Actually Have</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:2;margin-bottom:8px;">' +
          'Cash: <b>'+fmt(cl.cash)+'</b><br>Till: <b>'+fmt(cl.till)+'</b><br>M-Pesa: <b>'+fmt(cl.mpesa)+'</b>' +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:'+vc+';border-top:1px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';padding-top:8px;">'+fmt(an.actualDay)+'</div>' +
      '</div>' +
    '</div>' +
      '<div style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Correct Day Money</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:1.8;margin-bottom:8px;">' +
          'Opening: '+fmt(an.opTotal)+'<br>' +
          '+ Sales: '+fmt(sy.sysTotalRev)+(cl.injected>0?'<br>+ Injected: '+fmt(cl.injected):'')+(cl.expenses>0?'<br>+ Expenses: '+fmt(cl.expenses):'')+(cl.withdrawn>0?'<br>+ Withdrawn: '+fmt(cl.withdrawn):'') +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:var(--text);border-top:1px solid var(--border);padding-top:8px;">'+fmt(an.correctDay)+'</div>' +
      '</div>' +
      '<div style="background:'+(isOk?'var(--green-light)':isWn?'#fef3c7':'var(--red-light)')+';border:1.5px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Actual Day Money</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:1.8;margin-bottom:8px;">' +
          'Cash: '+fmt(cl.cash)+'<br>Till: '+fmt(cl.till)+'<br>M-Pesa: '+fmt(cl.mpesa) +
          (cl.expenses>0?'<br>+ Expenses: '+fmt(cl.expenses):'') +
          (cl.withdrawn>0?'<br>+ Withdrawn: '+fmt(cl.withdrawn):'') +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:'+vc+';border-top:1px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';padding-top:8px;">'+fmt(an.actualDay)+'</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:'+(isOk?'var(--green-light)':isWn?'#fef3c7':'var(--red-light)')+';border:1.5px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';border-radius:var(--r-lg);margin-bottom:8px;">' +
      '<span style="font-size:13px;font-weight:800;color:'+vc+';">Variance</span>' +
      '<span style="font-size:20px;font-weight:900;font-family:var(--mono);color:'+vc+';">'+vi+' '+vl+'</span>' +
    '</div>' +

    // ── Per-pocket detail ───────────────────────────────
    '<div class="day-section-label">🔍 Pocket Detail</div>' +
    '<div style="border:1.5px solid var(--border);border-radius:var(--r-lg);overflow:hidden;margin-bottom:8px;">' +
      pocketRow('💵', 'Cash (Hand + Till)', (o.cash||0)+(o.till||0), an.expCash,  an.physCash) +
      pocketRow('📱', 'M-Pesa Float',        o.mpesa||0,              an.expMpesa, an.physMpesa) +
    '</div>' +

    // ── Insights ─────────────────────────────────────────
    '<div class="day-section-label">💡 Insights</div>' +
    ins.map(i=>'<div class="'+i.c+'" style="display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border-radius:var(--r);margin-bottom:5px;font-size:12px;font-weight:600;line-height:1.4;"><span style="font-size:16px;flex-shrink:0;">'+i.i+'</span><span>'+i.t+'</span></div>').join('') +
    '<div style="text-align:center;font-size:10px;color:var(--muted);padding:6px 0;">Reconciled at '+new Date(data.reconciledAt||0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</div>';
}

// ── dayStartOver ─────────────────────────────────────────────────
function dayStartOver() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  if (!confirm('Clear today\'s reconciliation and start over?')) return;
  _clearDayRecon(today);
  ['op-cash','op-till','op-mpesa','cl-injected','cl-cash','cl-till','cl-mpesa','cl-expenses','cl-withdrawn']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  toast('Cleared', '');
  renderDayState();
}
window.dayStartOver = dayStartOver;

// ── Auto-close at 11:59 PM ───────────────────────────────────────
function _checkAutoClose() {
  const now = new Date();
  if (now.getHours() === 23 && now.getMinutes() === 59) {
    const today = todayDateStr();
    const data  = _getDayRecon(today);
    // Only auto-close if day is open but not yet reconciled
    if (activeDay && activeDay.status === 'OPEN' && (!data || data.step !== 'reconciled')) {
      toast('🌙 Auto-closing day at 11:59 PM…', '');
      // Move to closing_form step so user sees it's needed on next open
      _saveDayRecon(today, { ...(data||{}), step: 'closing_form', date: today, autoClosedAt: now.toISOString() });
      _doCloseDay();
      renderDayState();
      renderDaySessionsList();
    }
  }
}
// Check every minute
setInterval(_checkAutoClose, 60000);


// ═══════════════════════════════════════════════════════════
// INITIALISATION
// ═══════════════════════════════════════════════════════════
initDB();
setTimeout(initFirebase, 800);

// ── Debounced sync ──────────────────────────────────────────
let _autoSyncTimer = null;
function scheduleSync() {
  if (!navigator.onLine || !fbReady || !fbDb) return;
  clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(() => {
    forcePushToFirebase(true).catch(() => {});
  }, 2000);
}

// ═══════════════════════════════════════════════════════════
// WINDOW EXPORTS — all onclick= handlers
// ═══════════════════════════════════════════════════════════
window.addType = addType;
window.adjSellQty = adjSellQty;
window.applyAppUpdate = applyAppUpdate;
window.attemptLogin = attemptLogin;
window.cancelEdit = cancelEdit;
window.clearNotifs = clearNotifs;
window.closePastSessionSheet = closePastSessionSheet;
window.closeProfileSheet = closeProfileSheet;
window.closeSellModal = closeSellModal;
window.closeSheet = closeSheet;
window.closeUserMenu = closeUserMenu;
window.confirmCloseDay = confirmCloseDay;
window.confirmLogout = confirmLogout;
window.confirmRestock = confirmRestock;
window.confirmSale = confirmSale;
window.dashSetPeriod = dashSetPeriod;
window.deleteItem = deleteItem;
window.disconnectFirebase = disconnectFirebase;
window.dismissAppUpdate = dismissAppUpdate;
window.dismissInstall = dismissInstall;
window.editItem = editItem;
window.filterFinance = filterFinance;
window.forcePushToFirebase = forcePushToFirebase;
window.installAppUpdate = installAppUpdate;
window.onCodeInput = onCodeInput;
window.openStockMonitor = openStockMonitor;
window.openOffStockSale = openOffStockSale;
window.openSellFromSheet = openSellFromSheet;
window.pickEmoji = pickEmoji;
window.pullFromFirebase = pullFromFirebase;
window.removeAddPhoto = removeAddPhoto;
window.renderList = renderList;
window.renderSellPage = renderSellPage;
window.selectExistingItemFromDropdown = selectExistingItemFromDropdown;
window.resetAllData = resetAllData;
window.runSyncDebug = runSyncDebug;
window.saveCurrency = saveCurrency;
window.saveFinanceEntry = saveFinanceEntry;
window.saveFirebaseConfig = saveFirebaseConfig;
window.saveItem = saveItem;
window.saveWishlistItem = saveWishlistItem;
window.searchSell = searchSell;
window.selectPayment = selectPayment;
window.showPage = showPage;
window.showInventoryTab = showInventoryTab;
window.showOperationsTab = showOperationsTab;
window.showUserProfile = showUserProfile;
window.toggleNotifPanel = toggleNotifPanel;
window.toggleRestock = toggleRestock;
window.toggleUserMenu = toggleUserMenu;
window.triggerAddPhotoUpload = triggerAddPhotoUpload;
window.triggerInstall = triggerInstall;
window.triggerSheetPhotoUpload = triggerSheetPhotoUpload;
window.updateFinTypeColor = updateFinTypeColor;
window.updateProfitPreview = updateProfitPreview;
window.updateSellModal = updateSellModal;
window.closeStockMonitor = closeStockMonitor;
window.closeOffStockSale = closeOffStockSale;
window.confirmOffStockSale = confirmOffStockSale;
window.deleteWishlistItem = deleteWishlistItem;
window.restockFromMonitor = restockFromMonitor;
window.startWishlistRestock = startWishlistRestock;

function onTypeChange() {
  const typeEl     = UI.el('f-type');
  const type       = typeEl ? typeEl.value : '';
  const shoePanel  = UI.el('shoe-size-panel');
  const stdPricing = UI.el('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  if (!shoePanel || !stdPricing) return;

  const isShoe = isFootwearType(type);
  shoePanel.style.display  = isShoe ? 'block' : 'none';
  stdPricing.style.display = isShoe ? 'none'  : 'block';
  if (sizeField) sizeField.style.display = isShoe ? 'none' : 'block';

  if (isShoe) {
    _shoeState.group      = null; _shoeState.sizes      = new Set(); _shoeState.perSizeMode= false; _shoeState.shownGroups= new Set();
    renderShoeGroupButtons();
    const szGrid = UI.el('shoe-sizes-grid');
    const szWrap = UI.el('shoe-rows-wrap');
    const szInner = UI.el('sz-grid');
    if (szGrid)  szGrid.style.display  = 'none';
    if (szWrap)  szWrap.style.display  = 'none';
    if (szInner) szInner.innerHTML = '';
    const sum = UI.el('shoe-selected-summary');
    if (sum) sum.innerHTML = '';
  }
}
window.onTypeChange = onTypeChange;

async function renderHistoryPage() {
  const today     = todayDateStr();
  const todayFull = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  UI.setText('hist-today-date', todayFull);

  const allSales = await dbAll('sales');

  // ── Today ──────────────────────────────────────────────────
  const todaySales = allSales.filter(s => (s.businessDate || s.date?.slice(0,10)) === today);
  const todayRev   = todaySales.reduce((s,x) => s + (x.revenue||0), 0);
  const todayProf  = todaySales.reduce((s,x) => s + (x.profit||0),  0);

  UI.setText('hist-today-revenue', fmt(todayRev));
  UI.setText('hist-today-profit',  fmt(todayProf));
  UI.setText('hist-today-sales',   todaySales.length);

  // Today — profit tile colour
  const profEl = document.getElementById('hist-today-profit');
  if (profEl) profEl.style.color = todayProf >= 0 ? 'var(--green)' : 'var(--red)';

  const todayList = UI.el('hist-today-list');
  if (todayList) {
    if (!todaySales.length) {
      todayList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No sales today yet.</div>';
    } else {
      todayList.innerHTML = [...todaySales]
        .sort((a,b) => new Date(b.date) - new Date(a.date))
        .map(s => _histSaleRow(s, 'full')).join('');
    }
  }

  // ── Past records ───────────────────────────────────────────
  const filterEl = UI.el('hist-period-filter');
  const filterVal = filterEl ? filterEl.value : '30';
  const days      = filterVal === 'all' ? null : (parseInt(filterVal) || 30);
  const cutoff    = days ? new Date(Date.now() - days * 86400000) : null;

  const byDate = {};
  allSales.forEach(s => {
    const d = s.businessDate || s.date?.slice(0,10) || today;
    if (d === today) return;
    if (cutoff && new Date(d + 'T12:00:00') < cutoff) return;
    if (!byDate[d]) byDate[d] = { sales:[], revenue:0, profit:0, cost:0 };
    byDate[d].sales.push(s);
    byDate[d].revenue += (s.revenue || 0);
    byDate[d].profit  += (s.profit  || 0);
    byDate[d].cost    += ((s.revenue||0) - (s.profit||0));
  });

  const datesSorted = Object.keys(byDate).sort((a,b) => b.localeCompare(a));
  const recList = UI.el('hist-records-list');
  if (!recList) return;

  if (!datesSorted.length) {
    recList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:24px 0;text-align:center;">No records in this period.</div>';
    return;
  }

  // Totals summary for the selected period
  const periodRev  = datesSorted.reduce((s,d) => s + byDate[d].revenue, 0);
  const periodProf = datesSorted.reduce((s,d) => s + byDate[d].profit,  0);
  const periodSales= datesSorted.reduce((s,d) => s + byDate[d].sales.length, 0);
  const pMargin    = periodRev > 0 ? (periodProf / periodRev * 100).toFixed(1) : '0.0';

  const summaryHtml = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:10px;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 8px;text-align:center;">
        <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--accent2);">${fmt(periodRev)}</div>
        <div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:2px;">Revenue</div>
      </div>
      <div style="background:var(--green-light);border:1px solid var(--green);border-radius:var(--r);padding:10px 8px;text-align:center;">
        <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">${fmt(periodProf)}</div>
        <div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:2px;">Profit</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 8px;text-align:center;">
        <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--text);">${pMargin}%</div>
        <div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:2px;">Margin</div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:10px 8px;text-align:center;">
        <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--text);">${periodSales}</div>
        <div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-top:2px;">Sales</div>
      </div>
    </div>`;

  recList.innerHTML = summaryHtml + datesSorted.map(date => {
    const day   = byDate[date];
    const label = new Date(date + 'T12:00:00').toLocaleDateString('en-GB',
                  { weekday:'short', day:'numeric', month:'short', year:'numeric' });
    const margin = day.revenue > 0 ? (day.profit / day.revenue * 100).toFixed(0) : '0';
    const profColor = day.profit >= 0 ? 'var(--green)' : 'var(--red)';
    const rows  = [...day.sales]
      .sort((a,b) => new Date(b.date) - new Date(a.date))
      .map(s => _histSaleRow(s, 'compact')).join('');

    return `
      <div class="hist-day-card">
        <div class="hist-day-header">
          <div>
            <div style="font-size:14px;font-weight:800;">${label}</div>
            <div style="font-size:11px;color:var(--muted);">${day.sales.length} sale${day.sales.length!==1?'s':''}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(day.revenue)}</div>
            <div style="font-size:11px;font-weight:700;font-family:var(--mono);color:${profColor};">profit ${fmt(day.profit)} <span style="color:var(--muted);font-weight:600;">(${margin}%)</span></div>
          </div>
        </div>
        ${rows}
      </div>`;
  }).join('');
}

// ── Shared sale row renderer ────────────────────────────────
function _histSaleRow(s, mode) {
  const profColor = (s.profit||0) >= 0 ? 'var(--green)' : 'var(--red)';
  const profSign  = (s.profit||0) >= 0 ? '+' : '';
  if (mode === 'full') {
    return `
      <div class="hist-sale-row">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escapeHtml(s.itemName||s.itemCode||'Item')}${s.itemSize?' · Size '+escapeHtml(s.itemSize):''}
          </div>
          <div style="font-size:11px;color:var(--muted);">
            ${s.qty} × ${fmt(s.actualPrice||s.sellPrice||0)} · ${s.paymentMethod||'cash'} · ${fmtTime(s.date)}
          </div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(s.revenue||0)}</div>
          <div style="font-size:11px;font-weight:700;font-family:var(--mono);color:${profColor};">${profSign}${fmt(s.profit||0)}</div>
        </div>
      </div>`;
  }
  // compact — used in past records
  return `
    <div class="hist-sale-row" style="border-top:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${escapeHtml(s.itemName||s.itemCode||'Item')}${s.itemSize?' · Sz '+escapeHtml(s.itemSize):''}
        </div>
        <div style="font-size:10px;color:var(--muted);">${s.qty} × ${fmt(s.actualPrice||s.sellPrice||0)} · ${s.paymentMethod||'cash'} · ${fmtTime(s.date)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-size:12px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(s.revenue||0)}</div>
        <div style="font-size:11px;font-weight:700;font-family:var(--mono);color:${profColor};">${profSign}${fmt(s.profit||0)}</div>
      </div>
    </div>`;
}
window.renderHistoryPage = renderHistoryPage;

function selectSizeGroup(g) {
  const groups = getShoeGroups();
  const { min, max } = groups[g];
  const sizes = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const grid  = UI.el('sz-grid');
  if (!grid) return;

  if (!_shoeState.shownGroups.has(g)) {
    _shoeState.group = g;
    _shoeState.shownGroups.add(g);

    const block = document.createElement('div');
    block.id = 'sz-group-block-' + g;
    block.className = 'sz-group-block sz-group-block-' + g;
    block.style.order = { S: 1, M: 2, L: 3 }[g] || 9;
    block.style.gridColumn = { S: 1, M: 2, L: 3 }[g] || 'auto';

    const label = document.createElement('div');
    label.className = 'sz-group-divider';
    label.innerHTML = '<span class="sz-group-tag sz-group-' + g + '" style="cursor:pointer;">' +
      (g==='S'?'Small / Children':g==='M'?'Medium / Teens':'Large / Adults') +
      ' (' + min + '–' + max + ') ✕</span>';
    label.onclick = () => deselectSizeGroup(g);
    block.appendChild(label);

    const row = document.createElement('div');
    row.className = 'sz-group-sizes';
    sizes.forEach(s => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sz-btn' + (_shoeState.sizes.has(s) ? ' sz-active' : '');
      btn.id = 'sz-' + s;
      btn.textContent = s;
      btn.onclick = () => toggleShoeSize(s);
      row.appendChild(btn);
    });
    block.appendChild(row);
    grid.appendChild(block);

    const szGrid = UI.el('shoe-sizes-grid');
    if (szGrid) szGrid.style.display = 'block';
  } else {
    deselectSizeGroup(g);
    return;
  }

  renderShoeGroupButtons();
  const szWrap = UI.el('shoe-rows-wrap');
  if (szWrap && _shoeState.sizes.size > 0) szWrap.style.display = 'block';
  // Rebuild per-size rows if in per-size mode
  if (_shoeState.perSizeMode) renderShoeRows();
}
window.selectSizeGroup = selectSizeGroup;

function setShoeMode(mode) {
  _shoeState.perSizeMode = (mode === 'persize');

  // Update tab buttons
  document.getElementById('mode-tab-shared') .classList.toggle('active', !_shoeState.perSizeMode);
  document.getElementById('mode-tab-persize').classList.toggle('active',  _shoeState.perSizeMode);

  // Show/hide panels
  const sharedWrap  = document.getElementById('shoe-shared-wrap');
  const perSizeWrap = document.getElementById('shoe-per-size-wrap');
  if (sharedWrap)  sharedWrap.style.display  = _shoeState.perSizeMode ? 'none'  : 'block';
  if (perSizeWrap) perSizeWrap.style.display = _shoeState.perSizeMode ? 'block' : 'none';

  // Rebuild per-size rows when switching to per-size
  if (_shoeState.perSizeMode) renderShoeRows();
}
window.setShoeMode = setShoeMode;

// ── Restored shoe functions ──────────────────────────────────────







async function upsertShoeSize(record) {
  const all = await dbAll('shoe_sizes');
  const existing = all.find(s => s.itemCode === record.itemCode && s.size === record.size);
  if (existing) {
    const updated = { ...existing, ...record, id: existing.id };
    await dbPut('shoe_sizes', updated);
    return updated;
  } else {
    record.codeSize = record.itemCode + '_' + record.size;
    try {
      const id = await dbAdd('shoe_sizes', record);
      record.id = id;
      return record;
    } catch(e) {
      if (e.name === 'ConstraintError') {
        // Unique codeSize violation — find and update existing
        const byCS = all.find(s => s.codeSize === record.codeSize);
        if (byCS) {
          const updated = { ...byCS, ...record, id: byCS.id };
          await dbPut('shoe_sizes', updated);
          return updated;
        }
      }
      throw e;
    }
  }
}

async function saveShoeItems(baseCode, baseName, type) {
  if (_shoeState.sizes.size === 0) { toast('⚠️ Select at least one size', 'err'); return false; }

  if (!_shoeState.group) {
    const firstSize = [..._shoeState.sizes][0];
    _shoeState.group = _shoeState.groupFor(firstSize) || 'S';
  }

  let sharedQty = 0, sharedBuy = 0, sharedSell = 0;
  if (!_shoeState.perSizeMode) {
    sharedQty  = parseInt(UI.el('shoe-shared-qty')?.value  || '0') || 0;
    sharedBuy  = parseFloat(UI.el('shoe-shared-buy')?.value  || '0') || 0;
    sharedSell = parseFloat(UI.el('shoe-shared-sell')?.value || '0') || 0;
    if (sharedQty  <= 0) { toast('⚠️ Enter quantity per size (must be > 0)', 'err'); return false; }
    if (sharedBuy  <= 0) { toast('⚠️ Enter buying price',  'err'); return false; }
    if (sharedSell <= 0) { toast('⚠️ Enter selling price', 'err'); return false; }
    if (sharedSell < sharedBuy) { toast('⚠️ Sell price cannot be less than buy price', 'err'); return false; }
  }

  const sorted  = _shoeState.sortedSizes;
  const allItms = await dbAll('items');
  let product   = allItms.find(i => i.code === baseCode);

  if (!product) {
    const pid = await dbAdd('items', {
      code: baseCode, name: baseName || (type + ' ' + baseCode),
      type, category: type, isShoe: true,
      buyPrice:  _shoeState.perSizeMode ? 0 : sharedBuy,
      sellPrice: _shoeState.perSizeMode ? 0 : sharedSell,
      profit:    _shoeState.perSizeMode ? 0 : sharedSell - sharedBuy,
      qty: 0, createdAt: new Date().toISOString(),
    });
    product = await dbGet('items', pid);
  } else if (!_shoeState.perSizeMode) {
    product.buyPrice  = sharedBuy;
    product.sellPrice = sharedSell;
    product.profit    = sharedSell - sharedBuy;
    await dbPut('items', product);
  }

  let saved = 0;
  let stockCost = 0;
  let stockQty = 0;
  const perSizeErrors = [];
  for (const size of sorted) {
    let qty, buy, sell;
    if (_shoeState.perSizeMode) {
      qty  = parseInt(UI.el('shr-qty-'  + size)?.value || '0') || 0;
      buy  = parseFloat(UI.el('shr-buy-'  + size)?.value || '0') || 0;
      sell = parseFloat(UI.el('shr-sell-' + size)?.value || '0') || 0;
      if (qty  <= 0) { perSizeErrors.push('Size ' + size + ': qty must be > 0'); continue; }
      if (buy  <= 0) { perSizeErrors.push('Size ' + size + ': buy price required'); continue; }
      if (sell <= 0) { perSizeErrors.push('Size ' + size + ': sell price required'); continue; }
    } else { qty = sharedQty; buy = sharedBuy; sell = sharedSell; }

    await upsertShoeSize({
      itemCode: baseCode, itemId: product.id,
      size, sizeGroup: _shoeState.group,
      qty, buyPrice: buy, sellPrice: sell, profit: sell - buy,
      codeSize: baseCode + '_' + size,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    saved++;
    stockCost += qty * buy;
    stockQty += qty;
  }

  if (perSizeErrors.length) toast('⚠️ Skipped: ' + perSizeErrors.join(' · '), 'err');
  if (saved === 0) { toast('⚠️ No sizes saved — fill all required fields', 'err'); return false; }

  const allSz = await getShoeSizes(baseCode);
  product.qty = allSz.reduce((t, s) => t + s.qty, 0);
  await dbPut('items', product);
  await recordStockInvestment(product, stockCost, stockQty, 'Shoe stock');
  await markWishlistStockedForItem(product);
  fbSyncItem(product);

  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      for (const sz of allSz) {
        if (!sz.fbId) { sz.fbId = 'sz_' + sz.codeSize; await dbPut('shoe_sizes', sz); }
        await setDoc(doc(fbDb, 'shoe_sizes', sz.fbId), sanitiseForFirestore({...sz}));
      }
    } catch(e) { console.warn('[SYNC] shoe_sizes:', e.message); }
  }
  return saved;
}
window.saveShoeItems = saveShoeItems;

function deselectSizeGroup(g) {
  const groups = getShoeGroups();
  if (!groups[g]) return;
  const { min, max } = groups[g];
  for (let s = min; s <= max; s++) _shoeState.sizes.delete(s);
  const block = document.getElementById('sz-group-block-' + g);
  if (block) block.remove();
  _shoeState.shownGroups.delete(g);
  if (_shoeState.group === g) _shoeState.group      = null;
  const grid   = UI.el('sz-grid');
  const szGrid = UI.el('shoe-sizes-grid');
  if (szGrid && grid && grid.children.length === 0) szGrid.style.display = 'none';
  const szWrap = UI.el('shoe-rows-wrap');
  if (szWrap && _shoeState.sizes.size === 0) szWrap.style.display = 'none';
  renderShoeGroupButtons();
  renderShoeSummary();
  renderShoeRows();
}
window.deselectSizeGroup = deselectSizeGroup;

function toggleShoeSize(s) {
  if (_shoeState.sizes.has(s)) _shoeState.sizes.delete(s); else _shoeState.sizes.add(s);

  // Update button appearance
  document.querySelectorAll('.sz-btn').forEach(b => {
    b.classList.toggle('sz-active', _shoeState.sizes.has(parseInt(b.textContent)));
  });

  const szWrap = UI.el('shoe-rows-wrap');
  if (szWrap) szWrap.style.display = _shoeState.sizes.size > 0 ? 'block' : 'none';

  // If switching to persize and rows already rendered, rebuild them
  if (_shoeState.perSizeMode) renderShoeRows();
  renderShoeSummary();
}
window.toggleShoeSize = toggleShoeSize;

// ── Shoe size action handlers ─────────────────────────────────────
async function openShoeSizeRestock(itemId, size) {
  const item = await dbGet('items', itemId);
  if (!item) { toast('Item not found', 'err'); return; }
  const sizes  = await getShoeSizes(item.code);
  const sizeRec = sizes.find(s => s.size === size);
  if (!sizeRec) { toast('Size record not found', 'err'); return; }
  showPage('add');
  setTimeout(() => {
    UI.el('f-type').value  = item.type  || '';
    UI.el('f-code').value  = item.code  || '';
    UI.el('f-name').value  = item.name  || '';
    UI.el('edit-id').value = 'shoe_restock_' + itemId + '_' + size;
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || '';
    onTypeChange();
    const shoePanel = UI.el('shoe-size-panel');
    const stdPricing = UI.el('std-pricing-section');
    const sizeField = document.getElementById('f-size-field');
    if (shoePanel) shoePanel.style.display = 'none';
    if (stdPricing) stdPricing.style.display = 'block';
    if (sizeField) sizeField.style.display = 'block';
    ['f-code','f-type','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = true; el.style.opacity = '0.45'; el.style.cursor = 'not-allowed'; }
    });
    const qtyEl = UI.el('f-qty');
    if (qtyEl) { qtyEl.disabled = false; qtyEl.style.opacity = '1'; qtyEl.style.cursor = ''; qtyEl.focus(); }
    ['f-buy','f-sell'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = false; el.style.opacity = '1'; el.style.cursor = ''; }
    });
    UI.el('save-btn').textContent = '📦 Add to Stock — Size ' + size + ' (currently ' + (sizeRec.qty||0) + ')';
    UI.el('form-mode-label').textContent = '📦 Restock Size ' + size + ' · Current: ' + (sizeRec.qty||0);
    UI.el('cancel-edit-btn').style.display = 'block';
  }, 100);
}
window.openShoeSizeRestock = openShoeSizeRestock;

async function openShoeSizeEdit(itemId, size) {
  const item = await dbGet('items', itemId);
  if (!item) { toast('Item not found', 'err'); return; }
  const sizes   = await getShoeSizes(item.code);
  const sizeRec = sizes.find(s => s.size === size);
  if (!sizeRec) { toast('Size record not found', 'err'); return; }
  showPage('add');
  setTimeout(() => {
    UI.el('f-type').value  = item.type  || '';
    UI.el('f-code').value  = item.code  || '';
    UI.el('f-name').value  = item.name  || '';
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = sizeRec.qty   ?? '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || '';
    UI.el('edit-id').value = 'shoe_edit_' + itemId + '_' + size;
    onTypeChange();
    ['f-code','f-type','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = true; el.style.opacity = '0.45'; el.style.cursor = 'not-allowed'; }
    });
    UI.el('save-btn').textContent = '💾 Save Size ' + size;
    UI.el('form-mode-label').textContent = '✏️ Edit Size ' + size + ' — ' + item.code;
    UI.el('cancel-edit-btn').style.display = 'block';
    updateProfitPreview();
  }, 100);
}
window.openShoeSizeEdit = openShoeSizeEdit;

async function openSellShoeModal(itemId, size) {
  const item = await dbGet('items', itemId);
  if (!item) { toast('Item not found', 'err'); return; }
  const sizes   = await getShoeSizes(item.code);
  const sizeRec = sizes.find(s => s.size === size);
  if (!sizeRec || sizeRec.qty <= 0) { toast('Size ' + size + ' is out of stock', 'err'); return; }
  _isShoeSale   = true;
  _sellShoeItem = item;
  _sellShoeSize = sizeRec;
  currentSellItemId = itemId;
  const t = getTypeObj(item.type);
  const el = id => document.getElementById(id);
  if (el('sm-icon'))  { el('sm-icon').textContent = t.emoji; el('sm-icon').style.background = t.color || 'var(--surface2)'; }
  if (el('sm-name'))  el('sm-name').textContent  = item.name + ' (Size ' + size + ')';
  if (el('sm-meta'))  el('sm-meta').textContent  = item.code + ' · Size ' + size;
  if (el('sm-stock')) el('sm-stock').textContent = sizeRec.qty;
  if (el('sm-sell'))  el('sm-sell').textContent  = fmt(sizeRec.sellPrice || item.sellPrice || 0);
  if (el('sm-cur'))   el('sm-cur').textContent   = currency;
  if (el('sm-qty'))   { el('sm-qty').value = 1; el('sm-qty').max = sizeRec.qty; }
  if (el('sm-actual')) el('sm-actual').value = '';
  const sellModal = document.getElementById('sell-modal');
  if (sellModal) sellModal.classList.add('open');
  updateSellModal();
}
window.openSellShoeModal = openSellShoeModal;

async function closeShoeSizeActions() {
  const sheet = document.getElementById('shoe-size-action-sheet');
  if (sheet) sheet.classList.remove('open');
}
window.closeShoeSizeActions = closeShoeSizeActions;

// ── Restored missing shoe functions ─────────────────────────────


function getShoeGroups() {
  const saved = localStorage.getItem(KEY_SHOE_GROUPS);
  if (!saved) return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  try { return JSON.parse(saved); } catch(e) { return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS)); }
}
function _getGroupSizes(g) {
  const groups = getShoeGroups();
  if (!groups[g]) return [];
  const { min, max } = groups[g];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}
function renderShoeGroupButtons() {
  const groups = getShoeGroups();
  ['S','M','L'].forEach(g => {
    const btn = document.getElementById('sg-btn-' + g);
    const rng = document.getElementById('sg-range-' + g);
    const hasSelected = _getGroupSizes(g).some(s => _shoeState.sizes.has(s));
    if (btn) btn.classList.toggle('sg-active', hasSelected || _shoeState.shownGroups.has(g));
    if (rng && groups[g]) rng.textContent = groups[g].min + '–' + groups[g].max;
  });
}
function renderShoeRows() {
  const rows = document.getElementById('shoe-rows');
  if (!rows) return;
  if (!_shoeState.perSizeMode) { rows.innerHTML = ''; return; }
  const sorted = _shoeState.sortedSizes;
  rows.innerHTML = sorted.map(s =>
    '<div class="shoe-row">' +
    '<span class="shoe-sz-lbl">' + s + '</span>' +
    '<input type="number" class="shoe-cell" id="shr-qty-' + s + '" min="0" inputmode="numeric" placeholder="Qty">' +
    '<input type="number" class="shoe-cell" id="shr-buy-' + s + '" min="0" inputmode="decimal" placeholder="Buy">' +
    '<input type="number" class="shoe-cell" id="shr-sell-' + s + '" min="0" inputmode="decimal" placeholder="Sell">' +
    '</div>'
  ).join('');
}
function renderShoeSummary() {
  const el = UI.el('shoe-selected-summary');
  if (!el) return;
  if (_shoeState.sizes.size === 0) { el.innerHTML = ''; return; }
  const sorted = _shoeState.sortedSizes;
  el.innerHTML = '<div class="shoe-pills-row">' +
    sorted.map(s => '<span class="shoe-pill">' + s + '</span>').join('') +
    '<span style="font-size:11px;color:var(--muted);margin-left:4px;align-self:center;">' +
    sorted.length + ' size' + (sorted.length>1?'s':'') + ' selected</span></div>';
  const saveBtn = UI.el('save-btn');
  const panel   = UI.el('shoe-size-panel');
  if (saveBtn && panel && panel.style.display !== 'none') {
    saveBtn.textContent = '+ Save ' + sorted.length + ' shoe size' + (sorted.length>1?'s':'');
  }
}
function togglePerSizeMode() { setShoeMode(_shoeState.perSizeMode ? 'shared' : 'persize'); }

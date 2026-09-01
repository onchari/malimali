// ===================================================================
// DATABASE SCHEMA  v12 -  Mandela General Stores
// ===================================================================
let db;
// DB_NAME is resolved per-environment in initDB() - production and development
// use entirely separate local IndexedDB databases so dev work can never
// touch real shop data. See getFirebaseEnv() / KEY_FIREBASE_ENV below.
let DB_NAME = 'InventoryApp';
const DB_VER  = 12;

// ── APP CONSTANTS ─────────────────────────────────────────────────────
const KEY_SESSION      = 'mg_session';
const KEY_LAST_PAGE    = 'mg_last_page';
const KEY_FIREBASE_ENV = 'mg_firebase_env';
const KEY_SHOE_GROUPS  = 'mgs_shoe_groups';
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
  // Development runs on a completely separate local database from production.
  // A rebuild/reset can therefore only ever touch DB_NAME for the CURRENT
  // environment - it is structurally impossible for a dev-mode rebuild to
  // reach the production database, and vice versa.
  DB_NAME = getFirebaseEnv() === 'development' ? 'InventoryApp_dev' : 'InventoryApp';
  const req = indexedDB.open(DB_NAME, DB_VER);

  req.onupgradeneeded = e => {
    const d   = e.target.result;
    const old = e.oldVersion;

    // ── items ──────────────────────────────────────────────────────
    // One record per product SKU.
    // Normalized fields:
    //   buyPrice  (was: buy / defaultBuy)
    //   sellPrice (was: sell / defaultSell)
    //   variant   (was: size - only for non-shoe items)
    //   isShoe    - true to sizes stored in shoe_sizes
    if (!d.objectStoreNames.contains('items')) {
      const s = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      s.createIndex('idx_code',     'code',    { unique: true  });
      s.createIndex('idx_type',     'type',    { unique: false });
      s.createIndex('idx_fbid',     'fbId',    { unique: false });
      s.createIndex('idx_is_shoe',  'isShoe',  { unique: false });
    }

    // ── shoe_sizes ─────────────────────────────────────────────────
    // One record per item_code + size. FK: itemCode to items.code
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

    // Compressed item/wish photos (JPEG/WebP data URLs). key: "item_12" | "wish_3"
    if (!d.objectStoreNames.contains('photos')) {
      d.createObjectStore('photos', { keyPath: 'key' });
    }

    // NOTE: day_sessions store (legacy) intentionally NOT created in v9.
    //       Existing data migrated to business_days by migrateData().

    // ── v12: customers & customer_txns ────────────────────────────
    if (old < 12) {
      if (!d.objectStoreNames.contains('customers')) {
        const cu = d.createObjectStore('customers', { keyPath: 'id', autoIncrement: true });
        cu.createIndex('idx_customerId', 'customerId', { unique: true  });
        cu.createIndex('idx_name',       'name',       { unique: false });
        cu.createIndex('idx_fbid',       'fbId',       { unique: false });
      }
      if (!d.objectStoreNames.contains('customer_txns')) {
        const ct = d.createObjectStore('customer_txns', { keyPath: 'id', autoIncrement: true });
        ct.createIndex('idx_customer', 'customerId', { unique: false });
        ct.createIndex('idx_date',     'date',       { unique: false });
        ct.createIndex('idx_fbid',     'fbId',       { unique: false });
      }
    }
  };

  req.onerror = e => {
    console.error('[DB] Open error:', e.target.error);
    toast('Database error - try refreshing', 'err');
    setLoginReady(true);
  };

  req.onblocked = () => {
    // Another tab has the DB open at an older version — ask user to close other tabs
    console.warn('[DB] Upgrade blocked — close other tabs');
    toast('Please close other tabs of this app and refresh', 'err');
  };

  req.onsuccess = e => {
    db = e.target.result;
    db.onerror = ev => console.error('[DB] Unhandled error:', ev.target.error);

    loadTypes().then(async () => {
      updateCurrencyUI();
      await migrateData();
      await initPhotoStore();
      _appDbReady = true;
      setLoginReady(true);
      await bootstrapAppData();
      const sessionRestored = checkSession();
      if (sessionRestored && currentUser) {
        _origShowPage(resolveLandingPage(currentUser, localStorage.getItem(KEY_LAST_PAGE)));
      }
    }).catch(err => {
      console.error('[DB] Bootstrap error:', err);
      toast('Database setup failed - refresh the page', 'err');
      setLoginReady(true);
    });
  };
}

// Migrate old field names to normalized v9 names
// ── IndexedDB helpers ─────────────────────────────────────────────
function _dbReady(rej) {
  if (!db) { const e = new Error('Database not ready'); if (rej) rej(e); return false; } return true;
}
function dbAll(store) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    // Guard: return [] for stores that don't exist yet (e.g. new stores not yet migrated)
    if (!db.objectStoreNames.contains(store)) { res([]); return; }
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
    if (!db.objectStoreNames.contains(store)) { res(undefined); return; }
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
// 1. Class: DB           - IndexedDB abstraction (DRY, SRP)
// 2. Class: UI           - DOM access layer (DRY, encapsulation)
// 3. Class: ShoeState    - shoe form state (SRP, encapsulation)
// 4. Class: SavingOverlay- progress UI (SRP, reusability)
// 5. DRY: refreshUI()   - single refresh chain replaces repeated blocks
// 6. CONST: STORES, CSS  - no magic strings
// ===================================================================

// ── Standard 6: Named constants - no magic strings ─────────────────
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

// ── Standard 1: DB class - wraps IndexedDB, single place for DB access
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

// ── Standard 2: UI class - all DOM access in one place ─────────────
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

  // Bulk set text - { elementId: value,... }
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


// ── Core shoe helpers - defined early so all functions can use them ─
function _legacyFootwearName(typeName) {
  if (!typeName) return false;
  const n = typeName.toLowerCase();
  return n.includes('shoe') || n.includes('footwear') || n.includes('boot') ||
         n.includes('sandal') || n.includes('slipper') || n.includes('sneaker');
}

function getTypeRecord(name) {
  if (!name) return null;
  return types.find(t => t.name === name) || null;
}

function _normTypeId(id) {
  if (id == null || id === '') return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : id;
}

function getTypeById(id) {
  const nid = _normTypeId(id);
  if (nid == null) return null;
  return types.find(t => _normTypeId(t.id) === nid) || null;
}

function _typeParentMatches(typeParentId, parentId) {
  if (parentId == null) return typeParentId == null;
  return _normTypeId(typeParentId) === _normTypeId(parentId);
}

function getCategoryAncestors(rec) {
  const chain = [];
  let cur = rec;
  const seen = new Set();
  while (cur && cur.parentId) {
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    const parent = getTypeById(cur.parentId);
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

function isCategoryActive(rec) {
  if (!rec || rec.active === false) return false;
  return getCategoryAncestors(rec).every(a => a.active !== false);
}

function isDescendantOfType(typeRec, ancestorId) {
  if (!typeRec || ancestorId == null) return false;
  const aid = _normTypeId(ancestorId);
  let cur = typeRec;
  const seen = new Set();
  while (cur && cur.parentId) {
    if (_normTypeId(cur.parentId) === aid) return true;
    if (seen.has(cur.parentId)) break;
    seen.add(cur.parentId);
    cur = getTypeById(cur.parentId);
  }
  return false;
}

function walkCategoryTree(visitor) {
  const roots = types.filter(t => t.parentId == null).sort(_sortTypes);
  function walkChildren(parentId, depth) {
    types.filter(t => _typeParentMatches(t.parentId, parentId)).sort(_sortTypes).forEach(child => {
      visitor(child, depth);
      walkChildren(child.id, depth + 1);
    });
  }
  roots.forEach(r => {
    visitor(r, 0);
    walkChildren(r.id, 1);
  });
}

function collectCategoryDescendantIds(parentId) {
  const ids = [];
  function walk(pid) {
    types.filter(t => _typeParentMatches(t.parentId, pid)).forEach(c => {
      ids.push(c.id);
      walk(c.id);
    });
  }
  walk(parentId);
  return ids;
}

function populateCategoryParentSelect(selectEl) {
  if (!selectEl) return;
  const cur = selectEl.value;
  let html = '<option value="">Parent category...</option>';
  walkCategoryTree((rec, depth) => {
    const indent = depth ? '\u2003'.repeat(depth) + '\u21b3 ' : '';
    html += '<option value="' + rec.id + '">' + indent + escapeHtml((rec.emoji || '📦') + ' ' + rec.name) + '</option>';
  });
  selectEl.innerHTML = html;
  if (cur) selectEl.value = cur;
}

function isFootwearType(typeName) {
  if (!typeName || !String(typeName).trim()) return false;
  const rec = getTypeRecord(typeName);
  if (rec) {
    if (rec.isFootwear === true) return true;
    if (rec.isFootwear === false) {
      for (const anc of getCategoryAncestors(rec)) {
        if (anc.isFootwear === true) return true;
      }
      return false;
    }
    for (const anc of getCategoryAncestors(rec)) {
      if (anc.isFootwear === true) return true;
    }
  }
  return _legacyFootwearName(typeName);
}

function getAddCascadePathRecords() {
  return _getCascadePathFromWrap(document.getElementById('f-type-cascade'))
    .map(id => getTypeById(id))
    .filter(Boolean);
}

function _getAddCascadePathIds() {
  return _getCascadePathFromWrap(document.getElementById('f-type-cascade'));
}

/** True when a category row (or its ancestors) is footwear / size-grid mode. */
function categoryRecordIsFootwear(rec) {
  if (!rec) return false;
  if (rec.isFootwear === true) return true;
  if (rec.isFootwear === false) {
    return getCategoryAncestors(rec).some(a => a.isFootwear === true);
  }
  return isFootwearType(rec.name);
}

function _pathIdsIndicateFootwear(pathIds) {
  if (!pathIds || !pathIds.length) return false;
  return pathIds.some(id => {
    const rec = getTypeById(id);
    return rec && categoryRecordIsFootwear(rec);
  });
}

function _addTypeBreadcrumbIndicatesFootwear() {
  const el = document.getElementById('f-type-breadcrumb');
  if (!el || el.hidden) return false;
  const t = (el.textContent || '').toLowerCase();
  return /\bfootwear\b/.test(t) || t.includes('👟');
}

/** Keep cascade wrap in sync so footwear mode survives rerenders. */
function syncAddCascadeFootwearDataset(pathIds) {
  const wrap = document.getElementById('f-type-cascade');
  if (!wrap) return;
  const ids = pathIds || _getAddCascadePathIds();
  const typeVal = (UI.el('f-type')?.value || '').trim();
  const footwear = !!(
    (typeVal && isFootwearType(typeVal)) ||
    _pathIdsIndicateFootwear(ids) ||
    _addTypeBreadcrumbIndicatesFootwear()
  );
  if (footwear) wrap.dataset.footwearMode = '1';
  else delete wrap.dataset.footwearMode;
}

/** Footwear UI on Add: committed leaf OR any category picked in the cascade path (e.g. parent Footwear). */
function isAddFormFootwearContext() {
  const wrap = document.getElementById('f-type-cascade');
  if (wrap?.dataset.footwearMode === '1') return true;

  const type = (UI.el('f-type')?.value || '').trim();
  if (type && isFootwearType(type)) return true;

  const pathIds = _getAddCascadePathIds();
  if (_pathIdsIndicateFootwear(pathIds)) return true;

  if (getAddCascadePathRecords().some(categoryRecordIsFootwear)) return true;
  if (_addTypeBreadcrumbIndicatesFootwear()) return true;

  return false;
}

function _isFootwearAddFormActive() {
  return !!document.getElementById('page-add')?.classList.contains('footwear-add-mode');
}

/** Show shared qty/price row for footwear (visible before sizes are picked). */
function showShoePricingPanel() {
  if (!_isFootwearAddFormActive()) return;
  const rowsWrap = document.getElementById('shoe-rows-wrap');
  const sharedWrap = document.getElementById('shoe-shared-wrap');
  if (rowsWrap) rowsWrap.style.display = 'block';
  if (sharedWrap && !_shoeState.perSizeMode) sharedWrap.style.display = 'block';
}

/** Footwear add: horizontal sizes on S/M/L cards; qty/prices form always visible. */
function prepareShoeSizePickerUI() {
  const grid = document.getElementById('sz-grid');
  if (grid) grid.innerHTML = '';
  _shoeState.shownGroups.clear();
  const szGrid = document.getElementById('shoe-sizes-grid');
  if (szGrid) { szGrid.hidden = true; szGrid.style.display = 'none'; }
  renderAllShoeGroupCards();
  showShoePricingPanel();
}

function revealShoeSizePickerUI() {
  prepareShoeSizePickerUI();
}

function applyAddFormFootwearUI(isShoe) {
  const pageAdd = document.getElementById('page-add');
  if (pageAdd) pageAdd.classList.toggle('footwear-add-mode', !!isShoe);
  const shoePanel  = UI.el('shoe-size-panel');
  const stdPricing = UI.el('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  const modeToggle = document.getElementById('item-mode-toggle');
  const inRestock  = pageAdd?.classList.contains('restock-mode');
  if (inRestock) {
    if (shoePanel)  shoePanel.style.display = 'none';
    if (stdPricing) stdPricing.style.display = 'block';
    if (modeToggle) modeToggle.style.display = 'none';
    return;
  }
  if (modeToggle) modeToggle.style.removeProperty('display');
  // Shoe size panel is never shown in the add form — footwear saved as standard items
  if (shoePanel)  shoePanel.style.display = 'none';
  if (stdPricing) stdPricing.style.removeProperty('display');
  // Hide the text size/variant field for footwear (sizes tracked externally)
  if (sizeField)  sizeField.style.display = isShoe ? 'none' : '';
}

function _sortTypes(a, b) {
  return (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.name || '').localeCompare(String(b.name || ''));
}

function getOrderedTypesForDropdown() {
  const opts = [];
  walkCategoryTree((rec, depth) => {
    if (isCategoryActive(rec)) opts.push({ rec, depth });
  });
  return opts;
}

function itemMatchesTypeFilter(item, filterName) {
  if (filterName === 'all') return true;
  if ((item.type || '') === filterName) return true;
  const itemRec = getTypeRecord(item.type);
  const filterRec = getTypeRecord(filterName);
  if (itemRec && filterRec && isDescendantOfType(itemRec, filterRec.id)) return true;
  return false;
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
    if (el.classList.contains('cat-pick-hidden-select')) {
      const btn = document.getElementById(id + '-parent') ||
        document.querySelector('#' + id + '-cascade .cat-pick-btn:not(.has-value), #' + id + '-cascade .cat-pick-btn');
      if (btn) {
        btn.style.outline = '2px solid var(--red)';
        btn.focus();
        setTimeout(() => { btn.style.outline = ''; }, 2000);
        return;
      }
    }
    el.style.borderColor = 'var(--red)';
    el.focus();
    setTimeout(() => { el.style.borderColor = ''; }, 2000);
  },
  fail(msg, fieldId) {
    toast('Warning: ' + msg, 'err');
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
  // Qty rules for restock (adding to existing - 0 not allowed)
  restockQty(qty, qtyFieldId) {
    if (!qty || isNaN(qty) || qty <= 0) return this.fail('Enter a quantity to add (must be at least 1)', qtyFieldId);
    if (qty > 999999) return this.fail('Quantity exceeds maximum (999,999)', qtyFieldId);
    return true;
  },
  // Stock available check for selling
  stock(wantQty, inStock, itemName) {
    if (inStock <= 0) return this.fail((itemName || 'Item') + ' is out of stock', null);
    if (wantQty > inStock) return this.fail('Only ' + inStock + ' in stock - cannot sell ' + wantQty, null);
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

  /** Required non-empty text */
  text(value, fieldId, label) {
    if (!value || !String(value).trim()) return this.fail((label || 'This field') + ' is required', fieldId);
    return true;
  },

  /** Required money > 0 */
  moneyRequired(value, fieldId, label) {
    if (value === null || value === '') return this.fail('Enter ' + (label || 'amount').toLowerCase(), fieldId);
    if (!Number.isFinite(value)) return this.fail('Enter a valid number', fieldId);
    if (value < 0) return this.fail((label || 'Amount') + ' cannot be negative', fieldId);
    if (value <= 0) return this.fail((label || 'Amount') + ' must be greater than zero', fieldId);
    if (value > 99999999) return this.fail((label || 'Amount') + ' is too large', fieldId);
    return true;
  },

  /** Optional money - empty allowed, must be >= 0 if entered */
  moneyOptional(value, fieldId, label) {
    if (value === null) return true;
    if (!Number.isFinite(value)) return this.fail('Enter a valid number', fieldId);
    if (value < 0) return this.fail((label || 'Amount') + ' cannot be negative', fieldId);
    if (value > 99999999) return this.fail((label || 'Amount') + ' is too large', fieldId);
    return true;
  },

  /** Opening day - at least one pocket entered; empty ≠ zero */
  dayOpening(cash, till, mpesa) {
    const vals = [cash, till, mpesa];
    const ids = ['op-cash', 'op-till', 'op-mpesa'];
    if (vals.every(v => v === null)) {
      return this.fail('Enter opening balances - type 0 if a pocket is empty', 'op-cash');
    }
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === null) continue;
      if (!Number.isFinite(vals[i])) return this.fail('Enter valid numbers only', ids[i]);
      if (vals[i] < 0) return this.fail('Opening balance cannot be negative', ids[i]);
    }
    return true;
  },

  /** Closing physical count - cash/till/mpesa required (not all blank) */
  dayClosingPhysical(cash, till, mpesa) {
    const vals = [cash, till, mpesa];
    const ids = ['cl-cash', 'cl-till', 'cl-mpesa'];
    if (vals.every(v => v === null)) {
      return this.fail('Enter closing cash, till, or M-Pesa - type 0 if empty', 'cl-cash');
    }
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === null) continue;
      if (!Number.isFinite(vals[i])) return this.fail('Enter valid numbers only', ids[i]);
      if (vals[i] < 0) return this.fail('Closing amount cannot be negative', ids[i]);
    }
    return true;
  },

  /** Finance entry date */
  financeDate(dateStr, fieldId) {
    if (!dateStr) return this.fail('Select a date', fieldId);
    const today = todayDateStr();
    if (dateStr > today) return 'future';
    const min = '2020-01-01';
    if (dateStr < min) return this.fail('Date is too far in the past', fieldId);
    return true;
  },

  /** Integer qty optional (empty to null) */
  intOptional(value, fieldId, label) {
    if (value === null) return true;
    if (!Number.isFinite(value)) return this.fail('Enter a valid whole number', fieldId);
    if (value < 0) return this.fail((label || 'Quantity') + ' cannot be negative', fieldId);
    return true;
  },
};

/** Unified input parsing - empty field is null, not zero */
const Input = {
  el(id) { return document.getElementById(id); },
  raw(id) {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    return el ? String(el.value ?? '').trim() : '';
  },
  money(id) {
    const raw = this.raw(id);
    if (raw === '') return null;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : NaN;
  },
  moneyOrZero(id) {
    const v = this.money(id);
    if (v === null) return 0;
    return Number.isFinite(v) ? v : NaN;
  },
  int(id) {
    const raw = this.raw(id);
    if (raw === '') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : NaN;
  },
  text(id) {
    return this.raw(id);
  },
  /** Coalesce null pockets to 0 for storage */
  moneyZero(...values) {
    return values.map(v => (v === null || v === '' ? 0 : (Number.isFinite(v) ? v : 0)));
  }
};

async function _financeTotalsForDay(today) {
  const fins = await dbAll('finances');
  const day = (today || '').slice(0, 10);
  const sumType = type => fins
    .filter(e => e.type === type && (e.date || (e.createdAt || '').split('T')[0]).slice(0, 10) === day)
    .reduce((s, e) => s + (e.amount || 0), 0);
  return { injection: sumType('injection'), expense: sumType('expense'), withdrawal: sumType('withdrawal') };
}

function _warnFinanceClosingMismatch(finTotals, closing, tolerance) {
  const tol = tolerance ?? 1;
  const lines = [];
  if (Math.abs((finTotals.expense || 0) - closing.expenses) > tol && ((finTotals.expense || 0) > 0 || closing.expenses > 0)) {
    lines.push('Business expenses: closing ' + fmt(closing.expenses) + ' vs Finance tab ' + fmt(finTotals.expense || 0));
  }
  if (Math.abs((finTotals.withdrawal || 0) - closing.withdrawn) > tol && ((finTotals.withdrawal || 0) > 0 || closing.withdrawn > 0)) {
    lines.push('Personal withdraws: closing ' + fmt(closing.withdrawn) + ' vs Finance tab ' + fmt(finTotals.withdrawal || 0));
  }
  if (Math.abs((finTotals.injection || 0) - closing.injected) > tol && ((finTotals.injection || 0) > 0 || closing.injected > 0)) {
    lines.push('Cash to business: closing ' + fmt(closing.injected) + ' vs Finance tab ' + fmt(finTotals.injection || 0));
  }
  return lines;
}

// ── Standard 3: ShoeState class - encapsulates all shoe form state ──
class ShoeState {
  constructor() {
    this.reset();
  }

  reset() {
    this.group      = null;       // active group: 'S'|'M'|'L'
    this.sizes      = new Set();  // selected size numbers
    this.shownGroups= new Set();  // groups whose buttons are rendered
    this.perSizeMode= false;      // true = per-size pricing
    this.lockedSizes= new Set();  // sizes already in stock - not selectable (restock-mode)
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

// ── Standard 4: SavingOverlay class - progress UI ──────────────────
class SavingOverlay {
  constructor() {
    this._timer      = null;
    this._progress   = 0;
    this._circumference = 213.6;
    this._targetBtn  = null;
  }

  show(label = 'Saving...', targetBtn = null) {
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
const _overlay       = new SavingOverlay();
const _shoeState     = new ShoeState();

// ── Standard 5: DRY - single UI refresh chain ──────────────────────
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
  // Runs on every startup; idempotent - safe to run multiple times.
  let fixed = 0;

  try {
    // ── 1. items: unify buy/sell fields ────────────────────────────
    // Old: { buy, sell } for standard; { defaultBuy, defaultSell } for shoes
    // New: { buyPrice, sellPrice } for ALL items (unified)
    const items = await dbAll('items');
    for (const item of items) {
      let changed = false;

      // Migrate buy to buyPrice
      if (item.buy != null && item.buyPrice == null) {
        item.buyPrice = item.buy;
        changed = true;
      }
      // Migrate defaultBuy to buyPrice (shoes)
      if (item.defaultBuy != null && item.buyPrice == null) {
        item.buyPrice = item.defaultBuy;
        changed = true;
      }
      // Migrate sell to sellPrice
      if (item.sell != null && item.sellPrice == null) {
        item.sellPrice = item.sell;
        changed = true;
      }
      // Migrate defaultSell to sellPrice (shoes)
      if (item.defaultSell != null && item.sellPrice == null) {
        item.sellPrice = item.defaultSell;
        changed = true;
      }
      // Migrate size to variant (avoid confusion with shoe sizes)
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

    if (db.objectStoreNames.contains('wishlist')) {
      const wishes = await dbAll('wishlist');
      let wFixed = 0;
      for (const w of wishes) {
        if (!Array.isArray(w.vendorQuotes)) {
          w.vendorQuotes = [];
          await dbPut('wishlist', w);
          wFixed++;
        }
      }
      if (wFixed) console.log(`[MIGRATE] wishlist vendorQuotes: ${wFixed} initialized`);
    }

    // ── 3. sales: normalize businessDate field ─────────────────────
    const sales = await dbAll('sales');
    let sFixed = 0;
    for (const s of sales) {
      let changed = false;
      // Normalize business_date to businessDate
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
      // business_date to businessDate
      if (bd.business_date && !bd.businessDate) {
        bd.businessDate = bd.business_date;
        // Keep business_date for backward-compat index - it still has that index
        changed = true;
      }
      // opened_at to openedAt
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
      if (!f.currency)  { f.currency  = 'KES'; changed = true; }
      if (changed) { await dbPut('finances', f); fFixed++; }
    }
    console.log(`[MIGRATE v9] finances: ${fFixed} updated`);

    console.log('[MIGRATE v9] Complete');
  } catch(e) {
    console.warn('[MIGRATE v9] Error:', e.message);
  }
}


// ===== STATE =====
let types = [];
let allItems = [];
let activeTypeFilter = 'all';
let selectedEmoji = '📦';
const currency = 'KES';
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
let _activeSalesTab = 'sell';

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
    page.classList.remove('active');
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
  if (_activeInventoryTab === 'wishlist') {
    renderWishlistPage();
    if (typeof showWishlistSection === 'function') showWishlistSection('list');
  }
  if (_activeInventoryTab === 'monitor') renderStockMonitor();
  if (_activeInventoryTab === 'add') {
    renderTypeSelect();
    updateProfitPreview();
    onTypeChange();
  }
}

function showSalesTab(tab) {
  _activeSalesTab = tab === 'history' ? 'history' : 'sell';
  ['sell', 'history'].forEach(name => {
    const btn = document.getElementById('sales-tab-' + name);
    const slot = document.getElementById('sales-slot-' + name);
    if (btn) btn.classList.toggle('active', name === _activeSalesTab);
    if (slot) slot.classList.toggle('active', name === _activeSalesTab);
  });
  const offBtn = document.getElementById('sales-offstock-btn');
  if (offBtn) offBtn.style.display = _activeSalesTab === 'sell' ? '' : 'none';
  const sub = document.getElementById('sales-sub');
  if (sub) {
    sub.textContent = _activeSalesTab === 'history'
      ? 'Today and past sales records'
      : 'Search stock and record a sale';
  }
  if (_activeSalesTab === 'sell') {
    renderSellPage();
    setTimeout(() => {
      const el = document.getElementById('sell-search');
      if (el) el.focus();
    }, 150);
  } else {
    renderHistoryPage();
  }
}

function mountOperationsPage() {
  if (_operationsMounted) return;
  const daySlot = document.getElementById('ops-day-slot');
  const finSlot = document.getElementById('ops-finance-slot');
  const dayPage = document.getElementById('page-day');
  const finPage = document.getElementById('page-finance');
  if (!daySlot || !finSlot || !dayPage || !finPage) return;

  dayPage.classList.remove('active');
  finPage.classList.remove('active');
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

function resolvePageRoute(id) {
  if (id === 'list' || id === 'wishlist' || id === 'add' || id === 'monitor') {
    _activeInventoryTab = id === 'list' ? 'stock' : id;
    return 'inventory';
  }
  if (id === 'day' || id === 'finance') {
    _activeOperationsTab = id;
    return 'operations';
  }
  if (id === 'history') {
    _activeSalesTab = 'history';
    return 'sell';
  }
  return id;
}

function showPage(id) {
  id = resolvePageRoute(id);
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
  if (id === 'sell') showSalesTab(_activeSalesTab);
  if (id === 'finance')  { renderFinancePage(); }
  if (id === 'settings') { renderCategorySettings(); renderUnitsSettings(); }
  if (id === 'add') setTimeout(() => setItemMode(_addFormIsRecord), 0);
  if (id === 'customers') { renderCustomerList(''); }
  if (id === 'customer-detail') { /* content already populated by openCustomerDetail */ }
}

// Guard: wrap showPage to enforce tab access by role
// Defined immediately after showPage so _origShowPage is available at startup
const _origShowPage = showPage;
showPage = function(id) {
  if (currentUser && !userCanAccessNav(id, currentUser)) {
    toast('Access denied', 'err');
    return;
  }
  if (currentUser) localStorage.setItem(KEY_LAST_PAGE, navAccessKey(id));
  clearDayTabLocks();
  _origShowPage(id);
};

function navigateToStock() {
  goDashNav('stock');
}
window.navigateToStock = navigateToStock;

// ===== TYPES =====
const DEFAULT_TYPES = [
  { name: 'Footwear', emoji: '👟', color: '#1e3a5f', active: true, parentId: null, isFootwear: true, sortOrder: 1 },
  { name: 'Clothes', emoji: '👕', color: '#2d1b4e', active: true, parentId: null, isFootwear: false, sortOrder: 2 },
  { name: 'Plastics', emoji: '🪣', color: '#1a3a2a', active: true, parentId: null, isFootwear: false, sortOrder: 3 },
  { name: 'Gas', emoji: '⛽', color: '#1e7a3e', active: true, parentId: null, isFootwear: false, sortOrder: 4 },
  { name: 'Electronics', emoji: '📱', color: '#1e2a3a', active: true, parentId: null, isFootwear: false, sortOrder: 5 },
  { name: 'Food', emoji: '🍱', color: '#3a2a1a', active: true, parentId: null, isFootwear: false, sortOrder: 6 },
  { name: 'Cosmetics', emoji: '💄', color: '#3a1a2a', active: true, parentId: null, isFootwear: false, sortOrder: 7 },
  { name: 'General', emoji: '📦', color: '#1e293b', active: true, parentId: null, isFootwear: false, sortOrder: 8 },
];

async function normalizeTypeRecords() {
  types = await dbAll('types');
  for (const t of types) {
    let changed = false;
    if (t.active == null) { t.active = true; changed = true; }
    if (t.parentId === undefined || t.parentId === '') {
      if (t.parentId !== null) { t.parentId = null; changed = true; }
    } else {
      const pid = _normTypeId(t.parentId);
      if (pid !== t.parentId) { t.parentId = pid; changed = true; }
    }
    if (t.isFootwear == null) { t.isFootwear = _legacyFootwearName(t.name); changed = true; }
    if (t.sortOrder == null) { t.sortOrder = t.id || 0; changed = true; }
    if (changed) await dbPut('types', t);
  }
  types = await dbAll('types');
}

async function loadTypes() {
  try {
  types = await dbAll('types');
  if (types.length === 0) {
    for (const t of DEFAULT_TYPES) await dbAdd('types', {...t });
    types = await dbAll('types');
  }
  await normalizeTypeRecords();
  if (!types.some(t => isFootwearType(t.name))) {
    await dbAdd('types', {...DEFAULT_TYPES[0] });
    types = await dbAll('types');
    await normalizeTypeRecords();
  }
  renderAllTypeDropdowns();
  } catch(e) { console.error("[loadTypes]", e); toast("Error: " + e.message, "err"); }
}

function _categoryHasActiveChildren(typeId) {
  return _activeChildTypes(typeId).length > 0;
}

function _activeChildTypes(parentId) {
  return types
    .filter(t => _typeParentMatches(t.parentId, parentId) && isCategoryActive(t))
    .sort(_sortTypes);
}

function _typePathToRoot(typeName) {
  const rec = getTypeRecord(typeName);
  if (!rec) return [];
  return [...getCategoryAncestors(rec).reverse(), rec];
}

function _typePathFromId(typeId) {
  const rec = getTypeById(typeId);
  if (!rec) return [];
  return [...getCategoryAncestors(rec).reverse(), rec];
}

function _getCascadePathFromWrap(wrap) {
  if (!wrap) return [];
  try {
    return JSON.parse(wrap.dataset.pathIds || '[]')
      .map(n => _normTypeId(n))
      .filter(id => id != null);
  } catch (_) {
    return [];
  }
}

function _setCascadePathOnWrap(wrap, ids) {
  if (wrap) wrap.dataset.pathIds = JSON.stringify(ids || []);
}

function _syncCascadeValueEl(config, rec) {
  const el = config.valueEl;
  if (!el || !rec) {
    if (el) el.value = '';
    return;
  }
  const val = config.valueMode === 'id' ? String(rec.id) : rec.name;
  if (el.tagName === 'SELECT') {
    let opt = Array.from(el.options).find(o => o.value === val);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      el.appendChild(opt);
    }
    el.value = val;
  } else {
    el.value = val;
  }
}

/** Committed category from cascade (hidden field or completed path). */
function getCascadeCommittedValue(idPrefix, opts) {
  const requireLeaf = opts?.requireLeaf !== false;
  const valueMode = opts?.valueMode || 'name';
  const valueEl = document.getElementById(idPrefix);
  const wrap = document.getElementById(idPrefix + '-cascade');
  const direct = (valueEl?.value || '').trim();
  if (direct) return direct;
  if (!wrap) return '';
  const pathIds = _getCascadePathFromWrap(wrap);
  if (!pathIds.length) return '';
  const deepest = getTypeById(pathIds[pathIds.length - 1]);
  if (!deepest) return '';
  if (requireLeaf && _categoryHasActiveChildren(deepest.id)) return '';
  return valueMode === 'id' ? String(deepest.id) : deepest.name;
}

function _resolveCascadePathIds(config, selectedValue, preservePath) {
  const wrap = config.wrap;
  if (selectedValue) {
    if (config.valueMode === 'id') {
      const path = _typePathFromId(_normTypeId(selectedValue));
      const ids = path.map(x => x.id);
      _setCascadePathOnWrap(wrap, ids);
      return ids;
    }
    const path = _typePathToRoot(selectedValue);
    const ids = path.map(x => x.id);
    _setCascadePathOnWrap(wrap, ids);
    return ids;
  }
  if (preservePath) return _getCascadePathFromWrap(wrap);
  _setCascadePathOnWrap(wrap, []);
  return [];
}

function _updateCascadeBreadcrumb(config, pathIds, committed) {
  const breadcrumb = config.breadcrumbEl;
  if (!breadcrumb) return;
  const pathRecs = pathIds.map(id => getTypeById(id)).filter(Boolean);
  if (committed && pathRecs.length) {
    breadcrumb.hidden = false;
    breadcrumb.textContent = pathRecs.map(t => (t.emoji || '📦') + ' ' + t.name).join(' > ');
  } else if (pathRecs.length) {
    breadcrumb.hidden = false;
    breadcrumb.textContent = pathRecs.map(t => (t.emoji || '📦') + ' ' + t.name).join(' > ') + ' >...';
  } else {
    breadcrumb.hidden = true;
    breadcrumb.textContent = '';
  }
}

function _catPickBtnHtml(placeholder, selected) {
  if (selected && selected.name) {
    return '<span class="cat-pick-val">' + (selected.emoji || '📦') + ' ' + escapeHtml(selected.name) + '</span>' +
      '<span class="cat-pick-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>';
  }
  return '<span class="cat-pick-ph">' + escapeHtml(placeholder) + '</span>' +
    '<span class="cat-pick-chevron" aria-hidden="true"><i class="fa-solid fa-chevron-right"></i></span>';
}

function _appendCascadePickButton(wrap, config, depth, parentId, currentId, currentRec) {
  const ph0 = config.placeholder || 'Choose category...';
  const phN = config.placeholderSub || 'Choose sub-category...';
  const placeholder = depth === 0 ? ph0 : phN;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cat-pick-btn' + (currentRec ? ' has-value' : '');
  btn.id = config.idPrefix + (depth === 0 ? '-parent' : ('-sub-' + depth));
  btn.setAttribute('data-depth', String(depth));
  btn.innerHTML = currentRec
    ? _catPickBtnHtml('', { name: currentRec.name, emoji: currentRec.emoji })
    : _catPickBtnHtml(placeholder, null);

  btn.addEventListener('click', () => {
    const children = _activeChildTypes(parentId);
    if (!children.length) {
      toast(depth === 0 ? 'No categories available' : 'No sub-categories here', 'err');
      return;
    }
    let subtitle = depth === 0 ? 'Pick the main category' : 'Pick the next level';
    if (parentId) {
      const parentRec = getTypeById(parentId);
      if (parentRec) subtitle = 'Under: ' + (parentRec.emoji || '📦') + ' ' + parentRec.name;
    }
    openCategoryPicker({
      title: depth === 0 ? 'Choose category' : 'Choose sub-category',
      subtitle,
      items: children.map(t => ({
        id: String(t.id),
        name: t.name,
        emoji: t.emoji || '📦',
        hint: _categoryHasActiveChildren(t.id) ? 'Has more sub-categories' : 'Use this category',
        hasChildren: _categoryHasActiveChildren(t.id)
      })),
      currentId: currentId ? String(currentId) : '',
      allowClear: true,
      onSelect: (id) => {
        const newPath = _getCascadePathFromWrap(wrap).slice(0, depth);
        if (id) newPath.push(_normTypeId(id));
        _setCascadePathOnWrap(wrap, newPath);
        syncAddCascadeFootwearDataset(newPath);
        const deepest = newPath.length ? getTypeById(newPath[newPath.length - 1]) : null;
        if (deepest && (!config.requireLeaf || !_categoryHasActiveChildren(deepest.id))) {
          _syncCascadeValueEl(config, deepest);
        } else if (config.requireLeaf) {
          if (config.valueEl) config.valueEl.value = '';
        }
        syncAddCascadeFootwearDataset(newPath);
        if (config.idPrefix === 'f-type') applyAddFormFootwearUI(isAddFormFootwearContext());
        let rerenderValue = '';
        if (config.requireLeaf && deepest && !_categoryHasActiveChildren(deepest.id)) {
          rerenderValue = config.valueMode === 'id' ? String(deepest.id) : deepest.name;
        } else if (config.valueEl && config.valueEl.value) {
          rerenderValue = config.valueEl.value;
        }
        config.rerender(rerenderValue, { preservePath: true });
        syncAddCascadeFootwearDataset(newPath);
        if (config.idPrefix === 'f-type') onTypeChange();
      }
    });
  });

  const step = document.createElement('div');
  step.className = 'add-cascade-step';
  if (depth > 0) {
    const lbl = document.createElement('span');
    lbl.className = 'add-cascade-step-lbl';
    lbl.textContent = depth === 1 ? 'Sub-category' : 'Sub-category ' + depth;
    step.appendChild(lbl);
  }
  step.appendChild(btn);
  wrap.appendChild(step);
}

function renderCategoryCascade(config, selectedValue, opts) {
  const wrap = config.wrap;
  if (!wrap) return;
  const preservePath = !!(opts && opts.preservePath);
  const pathIds = _resolveCascadePathIds(config, selectedValue, preservePath);

  wrap.innerHTML = '';
  let parentId = null;
  let depth = 0;

  while (depth < pathIds.length) {
    const rec = getTypeById(pathIds[depth]);
    if (!rec) break;
    _appendCascadePickButton(wrap, config, depth, parentId, rec.id, rec);
    parentId = rec.id;
    depth += 1;
  }

  if (_activeChildTypes(parentId).length) {
    _appendCascadePickButton(wrap, config, depth, parentId, null, null);
  }

  const deepestId = pathIds.length ? pathIds[pathIds.length - 1] : null;
  const deepestRec = deepestId ? getTypeById(deepestId) : null;
  const isComplete = deepestRec && (!config.requireLeaf || !_categoryHasActiveChildren(deepestId));

  if (isComplete) {
    _syncCascadeValueEl(config, deepestRec);
  } else if (config.requireLeaf && config.valueEl) {
    config.valueEl.value = '';
  }

  _updateCascadeBreadcrumb(config, pathIds, !!(isComplete && config.valueEl && config.valueEl.value));
  wrap.classList.toggle('is-locked', !!config.locked);

  if (config.idPrefix === 'f-type') syncAddCascadeFootwearDataset(pathIds);

  if (!(opts && opts.skipChange) && config.onChange) config.onChange();
}

function _makeCascadeConfig(base) {
  const idPrefix = base.idPrefix || 'cat';
  const wrap = base.wrap || document.getElementById(idPrefix + '-cascade');
  return {
    wrap,
    valueEl: base.valueEl,
    valueMode: base.valueMode || 'name',
    requireLeaf: base.requireLeaf !== false,
    breadcrumbEl: base.breadcrumbEl || document.getElementById(idPrefix + '-breadcrumb'),
    idPrefix,
    placeholder: base.placeholder || 'Choose category...',
    placeholderSub: base.placeholderSub || 'Choose sub-category...',
    locked: !!base.locked,
    onChange: base.onChange || null,
    rerender(selectedValue, opts) {
      renderCategoryCascade(this, selectedValue, opts);
    }
  };
}

function mountCategoryCascadeField(opts) {
  if (!opts || !opts.valueEl) return;
  const idPrefix = opts.idPrefix || opts.valueEl.id;
  let wrap = opts.wrap || document.getElementById(idPrefix + '-cascade');
  if (!wrap && opts.valueEl.parentNode) {
    wrap = document.createElement('div');
    wrap.id = idPrefix + '-cascade';
    wrap.className = 'add-cascade';
    opts.valueEl.classList.add('cat-pick-hidden-select');
    opts.valueEl.parentNode.insertBefore(wrap, opts.valueEl);
  }
  opts.valueEl.classList.add('cat-pick-hidden-select');
  opts.valueEl.setAttribute('tabindex', '-1');
  opts.valueEl.setAttribute('aria-hidden', 'true');
  const config = _makeCascadeConfig({...opts, wrap, idPrefix });
  renderCategoryCascade(config, opts.valueEl.value || '', { skipChange: true });
  return config;
}

function mountWishTypeCascade() {
  mountCategoryCascadeField({
    wrap: document.getElementById('wish-type-cascade'),
    valueEl: document.getElementById('wish-type'),
    breadcrumbEl: document.getElementById('wish-type-breadcrumb'),
    idPrefix: 'wish-type',
    valueMode: 'name',
    requireLeaf: true,
    placeholder: 'Category...'
  });
}

function mountOffTypeCascade() {
  mountCategoryCascadeField({
    wrap: document.getElementById('off-type-cascade'),
    valueEl: document.getElementById('off-type'),
    breadcrumbEl: document.getElementById('off-type-breadcrumb'),
    idPrefix: 'off-type',
    valueMode: 'name',
    requireLeaf: true,
    placeholder: 'Category...'
  });
}

function mountNewSubParentCascade() {
  mountCategoryCascadeField({
    wrap: document.getElementById('new-sub-parent-cascade'),
    valueEl: document.getElementById('new-sub-parent'),
    breadcrumbEl: document.getElementById('new-sub-parent-breadcrumb'),
    idPrefix: 'new-sub-parent',
    valueMode: 'id',
    requireLeaf: false,
    placeholder: 'Parent category (optional - leave blank for top-level)'
  });
}

function renderAddTypeCascade(selectedTypeName, opts) {
  const hidden = UI.el('f-type');
  if (!hidden) return;
  const config = _makeCascadeConfig({
    wrap: document.getElementById('f-type-cascade'),
    valueEl: hidden,
    valueMode: 'name',
    requireLeaf: true,
    breadcrumbEl: document.getElementById('f-type-breadcrumb'),
    idPrefix: 'f-type',
    locked: hidden.disabled,
    // Do not close over opts.skipTypeChange - config.rerender() reuses this callback after
    // renderTypeSelect({ skipTypeChange: true }), which would block onTypeChange forever.
    onChange: () => onTypeChange()
  });
  const selectedName = selectedTypeName != null ? selectedTypeName : (hidden.value || '');
  const cascadeOpts = Object.assign({}, opts || {}, {
    skipChange: !!(opts && opts.skipTypeChange)
  });
  renderCategoryCascade(config, selectedName, cascadeOpts);
}

function closeCategoryPicker() {
  const el = document.getElementById('category-picker-sheet');
  if (el) el.remove();
}
window.closeCategoryPicker = closeCategoryPicker;

function openCategoryPicker(opts) {
  closeCategoryPicker();
  const items = (opts && opts.items) || [];
  const sheet = document.createElement('div');
  sheet.id = 'category-picker-sheet';
  sheet.className = 'cat-picker-overlay';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');

  const renderList = (filter) => {
    const q = (filter || '').trim().toLowerCase();
    const filtered = q
      ? items.filter(it => (it.name || '').toLowerCase().includes(q))
      : items;
    if (!filtered.length) {
      return '<div class="cat-picker-empty">No categories match your search.</div>';
    }
    return filtered.map(it => {
      const depth = it.depth || 0;
      const pad = depth ? ' style="padding-left:' + (12 + depth * 14) + 'px;"' : '';
      const sel = String(opts.currentId || '') === String(it.id) ? ' selected' : '';
      return '<button type="button" class="cat-picker-item' + sel + '" data-id="' + escapeHtml(String(it.id)) + '"' + pad + '>' +
        '<span class="cat-picker-emoji">' + (it.emoji || '📦') + '</span>' +
        '<span class="cat-picker-body">' +
          '<span class="cat-picker-name">' + escapeHtml(it.name || '') + '</span>' +
          (it.hint ? '<span class="cat-picker-hint">' + escapeHtml(it.hint) + '</span>' : '') +
        '</span>' +
        (it.hasChildren ? '<span class="cat-picker-tag">Sub</span>' : '') +
      '</button>';
    }).join('');
  };

  sheet.innerHTML =
    '<div class="cat-picker-panel">' +
      '<div class="cat-picker-handle"></div>' +
      '<div class="cat-picker-header">' +
        '<div class="cat-picker-title">' + escapeHtml(opts.title || 'Choose category') + '</div>' +
        (opts.subtitle ? '<div class="cat-picker-sub">' + escapeHtml(opts.subtitle) + '</div>' : '') +
      '</div>' +
      '<div class="cat-picker-search-wrap">' +
        '<i class="fa-solid fa-magnifying-glass cat-picker-search-icon"></i>' +
        '<input type="search" class="cat-picker-search" placeholder="Search categories..." autocomplete="off" spellcheck="false">' +
      '</div>' +
      '<div class="cat-picker-list">' + renderList('') + '</div>' +
      (opts.allowClear ? '<button type="button" class="cat-picker-clear">Clear selection</button>' : '') +
      '<button type="button" class="cat-picker-cancel">Cancel</button>' +
    '</div>';

  sheet.addEventListener('click', e => {
    if (e.target === sheet) closeCategoryPicker();
  });
  sheet.querySelector('.cat-picker-panel').addEventListener('click', e => e.stopPropagation());

  const listEl = sheet.querySelector('.cat-picker-list');
  const searchEl = sheet.querySelector('.cat-picker-search');

  listEl.addEventListener('click', e => {
    const btn = e.target.closest('.cat-picker-item');
    if (!btn) return;
    const id = btn.getAttribute('data-id');
    closeCategoryPicker();
    if (opts.onSelect) opts.onSelect(id || '');
  });

  searchEl.addEventListener('input', () => {
    listEl.innerHTML = renderList(searchEl.value);
  });

  const clearBtn = sheet.querySelector('.cat-picker-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      closeCategoryPicker();
      if (opts.onSelect) opts.onSelect('');
    });
  }
  sheet.querySelector('.cat-picker-cancel').addEventListener('click', closeCategoryPicker);

  document.body.appendChild(sheet);
  requestAnimationFrame(() => {
    sheet.classList.add('open');
    if (opts.focusSearch) searchEl.focus();
  });
}
window.openCategoryPicker = openCategoryPicker;

function setAddFormSubtitle(text) {
  const el = document.getElementById('add-form-sub');
  if (!el) return;
  const t = (text || '').trim();
  el.textContent = t;
  el.hidden = !t;
}

function setSaveBtnLabel(label, icon) {
  const sb = UI.el('save-btn');
  if (!sb) return;
  const ic = icon || 'fa-check';
  sb.innerHTML = '<i class="fa-solid ' + ic + '"></i> ' + escapeHtml(label);
}

function setRestockBanner(show, message) {
  const banner = document.getElementById('restock-mode-banner');
  if (!banner) return;
  banner.style.display = 'none';
}

const _RESTOCK_PRICING_TITLE = '<span class="add-step-badge">3</span> Stock &amp; pricing';
const _RESTOCK_QTY_TITLE = 'Add to stock';

function _mountRestockPricingSection() {
  const view = document.getElementById('restock-view');
  const stdPricing = document.getElementById('std-pricing-section');
  if (!view || !stdPricing) return;
  if (!view.contains(stdPricing)) view.appendChild(stdPricing);
  stdPricing.style.display = 'block';
  const shoePanel = document.getElementById('shoe-size-panel');
  if (shoePanel) shoePanel.style.display = 'none';
}

function _unmountRestockPricingSection() {
  const flow = document.querySelector('#page-add .add-flow');
  const stdPricing = document.getElementById('std-pricing-section');
  if (!flow || !stdPricing || flow.contains(stdPricing)) return;
  const photoSection = flow.querySelector('.add-card-photo');
  if (photoSection) flow.insertBefore(stdPricing, photoSection);
  else flow.appendChild(stdPricing);
}

function showRestockView(meta) {
  const page = document.getElementById('page-add');
  const view = document.getElementById('restock-view');
  const flow = document.querySelector('#page-add .add-flow');
  if (page) page.classList.add('restock-mode');
  if (view) view.hidden = false;
  if (flow) {
    flow.querySelectorAll('.add-card').forEach(card => {
      if (card.id !== 'std-pricing-section') card.style.display = 'none';
    });
    const shoePanel = document.getElementById('shoe-size-panel');
    if (shoePanel) shoePanel.style.display = 'none';
  }
  _mountRestockPricingSection();

  const setCell = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = (val != null && val !== '') ? val : '-';
  };
  setCell('rs-code', meta.code);
  setCell('rs-name', meta.name);
  const typeObj = meta.type ? getTypeObj(meta.type) : null;
  setCell('rs-category', typeObj ? ((typeObj.emoji || '📦') + ' ' + meta.type) : meta.type);
  const sizeRow = document.getElementById('rs-size-row');
  if (sizeRow) sizeRow.hidden = meta.size == null;
  setCell('rs-size', meta.size != null ? String(meta.size) : '');
  const stockEl = document.getElementById('rs-stock');
  if (stockEl) {
    const stock = meta.stock != null ? meta.stock : null;
    stockEl.textContent = stock != null ? (stock + (meta.stockUnit || '')) : '-';
    stockEl.classList.toggle('rs-stock-out', stock === 0);
    stockEl.classList.toggle('rs-stock-ok', stock != null && stock > 0);
  }
  setCell('rs-buy', meta.buy != null ? fmt(meta.buy) : '-');
  setCell('rs-sell', meta.sell != null ? fmt(meta.sell) : '-');

  setRestockBanner(false);
  const ml = UI.el('form-mode-label');
  if (ml) {
    ml.hidden = false;
    ml.textContent = meta.size != null ? 'Restock - Size ' + meta.size : 'Restock';
  }
  setAddFormSubtitle(meta.code ? meta.code + (meta.name ? ' - ' + meta.name : '') : '');

  const sizeLabel = meta.size != null ? String(meta.size) : '';
  setSaveBtnLabel(sizeLabel ? 'RESTOCK (' + sizeLabel + ')' : 'RESTOCK', 'fa-boxes-stacked');
  const footer = document.getElementById('add-footer');
  const cancelBtn = document.getElementById('restock-cancel-btn');
  if (footer) footer.classList.add('has-cancel');
  if (cancelBtn) cancelBtn.hidden = false;
  const headerCancel = UI.el('cancel-edit-btn');
  if (headerCancel) headerCancel.style.display = 'none';

  const pricingTitle = document.querySelector('#std-pricing-section .add-card-title');
  if (pricingTitle) pricingTitle.innerHTML = _RESTOCK_QTY_TITLE;

  const qtyEl = UI.el('f-qty');
  if (qtyEl) {
    qtyEl.placeholder = 'Qty to add *';
    qtyEl.disabled = false;
    qtyEl.style.opacity = '1';
    qtyEl.style.cursor = '';
  }
  ['f-buy', 'f-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = '1'; el.style.cursor = ''; }
  });
  setTimeout(() => qtyEl?.focus(), 120);
}

function hideRestockView() {
  const page = document.getElementById('page-add');
  if (page) page.classList.remove('restock-mode');
  const view = document.getElementById('restock-view');
  if (view) view.hidden = true;
  _unmountRestockPricingSection();
  const flow = document.querySelector('#page-add .add-flow');
  if (flow) {
    flow.querySelectorAll('.add-card').forEach(card => {
      if (card.id === 'shoe-size-panel') return;
      card.style.display = '';
    });
  }
  const footer = document.getElementById('add-footer');
  const cancelBtn = document.getElementById('restock-cancel-btn');
  if (footer) footer.classList.remove('has-cancel');
  if (cancelBtn) cancelBtn.hidden = true;
  const pricingTitle = document.querySelector('#std-pricing-section .add-card-title');
  if (pricingTitle) pricingTitle.innerHTML = _RESTOCK_PRICING_TITLE;
  const qtyEl = UI.el('f-qty');
  if (qtyEl) qtyEl.placeholder = 'Qty *';
  if (typeof onTypeChange === 'function') onTypeChange();
}

function resetShoeUiPanels() {
  _shoeState.perSizeMode = false;
  if (typeof setShoeMode === 'function') setShoeMode('shared');
  const modeShared = document.getElementById('mode-tab-shared');
  const modePerSize = document.getElementById('mode-tab-persize');
  if (modeShared) modeShared.classList.add('active');
  if (modePerSize) modePerSize.classList.remove('active');
  const sharedWrap = document.getElementById('shoe-shared-wrap');
  const perSizeWrap = document.getElementById('shoe-per-size-wrap');
  if (sharedWrap) sharedWrap.style.display = 'block';
  if (perSizeWrap) perSizeWrap.style.display = 'none';
  const szGrid = UI.el('shoe-sizes-grid');
  const szWrap = UI.el('shoe-rows-wrap');
  const szInner = UI.el('sz-grid');
  if (szGrid) szGrid.style.display = 'none';
  if (!_isFootwearAddFormActive() && szWrap) szWrap.style.display = 'none';
  if (szInner) szInner.innerHTML = '';
  _shoeState.shownGroups.clear();
  const sum = UI.el('shoe-selected-summary');
  if (sum) sum.innerHTML = '';
  renderShoeGroupButtons();
}

function setAddFormType(typeName, opts) {
  const hidden = UI.el('f-type');
  if (!hidden) return;
  hidden.value = typeName || '';
  renderAddTypeCascade(typeName || '', { skipTypeChange: opts && opts.skipTypeChange });
}

function setAddTypeLocked(locked) {
  const hidden = UI.el('f-type');
  if (hidden) hidden.disabled = !!locked;
  const wrap = document.getElementById('f-type-cascade');
  if (wrap) wrap.classList.toggle('is-locked', !!locked);
}

function renderAllTypeDropdowns() {
  renderAddTypeCascade(UI.el('f-type')?.value || '', { skipTypeChange: true });
  mountWishTypeCascade();
  mountOffTypeCascade();
  mountNewSubParentCascade();
  renderTypeChips();
}

function renderTypeSelect() {
  renderAddTypeCascade(UI.el('f-type')?.value || '', { skipTypeChange: true });
}

function renderTypeChips() {
  const chips = document.getElementById('type-chips');
  if (!chips) return;
  const topActive = types.filter(t => t.parentId == null && isCategoryActive(t)).sort(_sortTypes);
  chips.innerHTML = '<span class="chip ' + (activeTypeFilter === 'all' ? 'active' : '') + '" onclick="setTypeFilter(\'all\', this)">All</span>' +
    topActive.map(t =>
      '<span class="chip ' + (activeTypeFilter === t.name ? 'active' : '') + '" onclick="setTypeFilter(\'' + escapeHtml(t.name).replace(/'/g, "\\'") + '\', this)">' +
      (t.emoji || '📦') + ' ' + escapeHtml(t.name) + '</span>'
    ).join('');
}

function setTypeFilter(name, el) {
  activeTypeFilter = name;
  if (name === 'all' || !isFootwearType(name)) {
    window._activeSizeGroupFilter = 'all';
    document.querySelectorAll('[id^="sgf-"]').forEach(b => b.classList.remove('active'));
  }
  document.querySelectorAll('#type-chips .chip').forEach(c => c.classList.remove('active'));
  if (el) el.classList.add('active');
  _renderSizeGroupFilter();
  renderList();
}

async function renderCategorySettings() {
  try {
    types = await dbAll('types');
    await normalizeTypeRecords();
    renderAllTypeDropdowns();
    renderShoeGroupSettings();
    // Populate saved Gemini key status
    const saved = getGeminiKey();
    const keyInp = document.getElementById('gemini-api-key-input');
    if (keyInp) keyInp.value = saved ? saved.slice(0,8) + '••••••••••••' : '';
    _aiUpdateKeyUI(!!saved);
    const list = document.getElementById('categories-list');
    if (!list) return;
    if (!types.length) {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px;">No categories yet</div>';
      return;
    }
    mountNewSubParentCascade();

    const countDescendants = (id) => collectCategoryDescendantIds(id).length;

    const rowHtml = (t, depth) => {
      const active = t.active !== false;
      const footwear = isFootwearType(t.name);
      const subCount = countDescendants(t.id);
      const pad = 12 + Math.min(depth, 12) * 14;
      return '<div class="cat-row' + (depth ? ' cat-sub' : '') + '" data-id="' + t.id + '" style="padding-left:' + pad + 'px;">' +
        '<div class="cat-row-main">' +
          '<span class="cat-emoji">' + (t.emoji || '📦') + '</span>' +
          '<div class="cat-info">' +
            '<div class="cat-name">' + escapeHtml(t.name) +
              (depth ? ' <span class="cat-subcount">L' + (depth + 1) + '</span>' : '') +
              (subCount ? ' <span class="cat-subcount">' + subCount + ' nested</span>' : '') +
            '</div>' +
            '<div class="cat-meta">' + (active ? 'Active in dropdowns' : 'Hidden from dropdowns') +
              (footwear ? ' - Size-grid mode' : '') + '</div>' +
          '</div>' +
          '<div class="cat-toggles">' +
            '<button type="button" class="cat-toggle' + (active ? ' on' : '') + '" onclick="toggleCategoryActive(' + t.id + ')" title="Show in dropdowns">' +
              (active ? 'ON' : 'OFF') + '</button>' +
            '<button type="button" class="cat-toggle foot' + (footwear ? ' on' : '') + '" onclick="toggleCategoryFootwear(' + t.id + ')" title="Use shoe size grid">' +
              'Sizes</button>' +
            '<button type="button" class="type-del" onclick="deleteType(' + t.id + ')">X</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    };

    let html = '';
    walkCategoryTree((rec, depth) => { html += rowHtml(rec, depth); });
    list.innerHTML = html;
  } catch (e) {
    console.error('[renderCategorySettings]', e);
    toast('Error loading categories: ' + e.message, 'err');
  }
}

window.renderCategorySettings = renderCategorySettings;
window.renderTypes = renderCategorySettings;

function renderShoeGroupSettings() {
  const wrap = document.getElementById('shoe-groups-settings');
  if (!wrap) return;
  const groups = getShoeGroups();
  const labels = { S: 'Children (S)', M: 'Teens (M)', L: 'Adults (L)' };
  wrap.innerHTML = ['S', 'M', 'L'].map(g => {
    const cfg = groups[g] || SHOE_GROUP_DEFAULTS[g];
    const lbl = (cfg && cfg.label) || labels[g];
    return '<div class="sg-setting-row">' +
      '<div class="sg-setting-fields">' +
        '<input id="sg-label-' + g + '" type="text" class="type-input" placeholder="' + g + ' - display name" value="' + escapeHtml(lbl) + '" style="flex:1;min-width:0;" aria-label="' + g + ' display name">' +
        '<input id="sg-min-' + g + '" type="number" min="1" max="60" class="type-input sg-num" placeholder="Min size" value="' + (cfg?.min ?? '') + '" aria-label="' + g + ' minimum size">' +
        '<span style="color:var(--muted);">–</span>' +
        '<input id="sg-max-' + g + '" type="number" min="1" max="60" class="type-input sg-num" placeholder="Max size" value="' + (cfg?.max ?? '') + '" aria-label="' + g + ' maximum size">' +
      '</div>' +
    '</div>';
  }).join('');
}

async function saveShoeGroupSettings() {
  const groups = {};
  for (const g of ['S', 'M', 'L']) {
    const min = parseInt(document.getElementById('sg-min-' + g)?.value, 10);
    const max = parseInt(document.getElementById('sg-max-' + g)?.value, 10);
    const label = (document.getElementById('sg-label-' + g)?.value || '').trim();
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || min < 1 || max > 60) {
      toast('Invalid size range for group ' + g + ' (use sizes 1–60)', 'err');
      return;
    }
    groups[g] = { min, max };
    if (label) groups[g].label = label;
  }
  localStorage.setItem(KEY_SHOE_GROUPS, JSON.stringify(groups));
  renderShoeGroupButtons();
  toast('Shoe size groups saved', 'ok');
}
window.saveShoeGroupSettings = saveShoeGroupSettings;

async function toggleCategoryActive(id) {
  const t = types.find(x => x.id === id);
  if (!t) return;
  t.active = t.active === false;
  await dbPut('types', t);
  await loadTypes();
  renderCategorySettings();
}

async function toggleCategoryFootwear(id) {
  const t = types.find(x => x.id === id);
  if (!t) return;
  t.isFootwear = !t.isFootwear;
  await dbPut('types', t);
  await loadTypes();
  renderCategorySettings();
  toast(t.isFootwear ? 'Size-grid mode ON for ' + t.name : 'Size-grid mode OFF for ' + t.name, 'ok');
}
window.toggleCategoryActive = toggleCategoryActive;
window.toggleCategoryFootwear = toggleCategoryFootwear;

function pickEmoji(el) {
  document.querySelectorAll('.ep').forEach(e => e.classList.remove('sel'));
  el.classList.add('sel');
  selectedEmoji = el.dataset.e;
}

// Single "Add category" form covers both cases: no parent selected in the
// cascade -> top-level category; parent selected -> sub-category under it
// (replaces the old separate addType()/addSubCategory() + their two forms).
async function addCategoryOrSub() {
  try {
    const name = (document.getElementById('new-type-name')?.value || '').trim();
    if (!name) { toast('Enter a category name', 'err'); return; }
    if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Category already exists', 'err'); return; }

    const parentRaw = document.getElementById('new-sub-parent')?.value;
    const parentId  = parentRaw ? parseInt(parentRaw, 10) : null;
    const parent    = parentId ? getTypeById(parentId) : null;

    const isFootwear = parent
      ? isFootwearType(parent.name)
      : (document.getElementById('new-type-footwear')?.checked || false);
    const sortOrder = parentId
      ? types.filter(t => _typeParentMatches(t.parentId, parentId)).length + 1
      : types.length + 1;

    await dbAdd('types', {
      name,
      emoji: parent?.emoji || selectedEmoji,
      color: parent?.color || '#1e293b',
      active: true,
      parentId,
      isFootwear,
      sortOrder,
    });

    document.getElementById('new-type-name').value = '';
    const ft = document.getElementById('new-type-footwear');
    if (ft) ft.checked = false;

    await loadTypes();
    renderCategorySettings();
    toast(parentId ? 'Sub-category added' : 'Category added', 'ok');
  } catch (e) {
    console.error('[addCategoryOrSub]', e);
    toast('Error: ' + e.message, 'err');
  }
}
window.addCategoryOrSub = addCategoryOrSub;

async function deleteType(id) {
  try {
  const allItems = await dbAll('items');
  const typeObj = getTypeById(id);
  const descIds = collectCategoryDescendantIds(id);
  const descRecords = descIds.map(did => getTypeById(did)).filter(Boolean);
  const namesToCheck = [typeObj?.name,...descRecords.map(t => t.name)].filter(Boolean);
  const inUse = allItems.filter(i => namesToCheck.includes(i.type)).length;
  let msg = 'Delete "' + (typeObj ? typeObj.name : 'this category') + '"?';
  if (descIds.length) msg += '\n\nAlso deletes ' + descIds.length + ' nested sub-categor' + (descIds.length === 1 ? 'y' : 'ies') + '.';
  if (inUse > 0) msg += '\n\n' + inUse + ' item(s) still use these names - they will keep the label.';
  if (!confirm(msg)) return;
  for (const did of descIds) await dbDelete('types', did);
  await dbDelete('types', id);
  await loadTypes();
  renderCategorySettings();
  } catch(e) { console.error("[deleteType]", e); toast("Error: " + e.message, "err"); }
}

// ===== PROFIT PREVIEW =====
function updateProfitPreview() {
  const buy     = parseFloat(UI.el('f-buy')?.value)     || 0;
  const sell    = parseFloat(UI.el('f-sell')?.value)    || 0;
  const sellMin = parseFloat(UI.el('f-sell-min')?.value) || 0;
  const qty     = parseInt(UI.el('f-qty')?.value)       || 0;
  const preview = UI.el('profit-preview');
  if (!preview) return;

  if (buy > 0 && sell > 0) {
    const profitMax = sell - buy;
    const profitMin = sellMin > 0 ? sellMin - buy : profitMax;
    const hasRange  = sellMin > 0 && sellMin < sell;
    const marginMax = ((profitMax / sell) * 100).toFixed(1);
    const colorMax  = profitMax >= 0 ? 'var(--green)' : 'var(--red)';
    const colorMin  = profitMin >= 0 ? 'var(--green)' : 'var(--red)';

    const ppProfit   = document.getElementById('pp-profit');
    const ppMargin   = document.getElementById('pp-margin');
    const ppTotal    = document.getElementById('pp-total');
    const ppTotalRow = document.getElementById('pp-total-row');

    if (ppProfit) {
      ppProfit.textContent = hasRange
        ? (profitMin >= 0 ? '+' : '') + fmt(profitMin) + ' – ' + (profitMax >= 0 ? '+' : '') + fmt(profitMax)
        : (profitMax >= 0 ? '+' : '') + fmt(profitMax);
      ppProfit.style.color = colorMin;
    }
    if (ppMargin) { ppMargin.textContent = marginMax + '%'; ppMargin.style.color = profitMax >= 0 ? 'var(--accent)' : 'var(--red)'; }

    if (qty > 0) {
      if (ppTotal) {
        ppTotal.textContent = hasRange
          ? (profitMin >= 0 ? '+' : '') + fmt(profitMin * qty) + ' – ' + (profitMax >= 0 ? '+' : '') + fmt(profitMax * qty)
          : (profitMax >= 0 ? '+' : '') + fmt(profitMax * qty);
        ppTotal.style.color = colorMin;
      }
      if (ppTotalRow) ppTotalRow.style.display = '';
    } else {
      if (ppTotalRow) ppTotalRow.style.display = 'none';
    }

    const ppBuy  = document.getElementById('pp-buy');
    const ppSell = document.getElementById('pp-sell');
    if (ppBuy)  ppBuy.textContent  = fmt(buy);
    if (ppSell) ppSell.textContent = hasRange ? fmt(sellMin) + ' – ' + fmt(sell) : fmt(sell);

    preview.style.display = 'block';
  } else {
    preview.style.display = 'none';
  }
}


// ===== PHOTO STORAGE & COMPRESSION =====
// Photos live in IndexedDB ("photos" store) as compressed data URLs (WebP or JPEG).
// An in-memory cache keeps getItemPhoto/getWishPhoto synchronous for list rendering.
const PHOTO_PRESETS = Object.freeze({
  item: Object.freeze({ maxW: 512, maxH: 512, maxBytes: 80000, minQuality: 0.4 }),
  wish: Object.freeze({ maxW: 480, maxH: 480, maxBytes: 65000, minQuality: 0.4 }),
});
const _photoCache = new Map();
let _photoMimeWebp = null;

function _photoKey(kind, id) { return kind + '_' + id; }

function dataUrlByteLength(dataUrl) {
  const base64 = (dataUrl || '').split(',')[1] || '';
  return Math.ceil(base64.length * 3 / 4);
}

function _canvasSupportsMime(mime) {
  if (mime !== 'image/webp') return true;
  if (_photoMimeWebp === null) {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    _photoMimeWebp = c.toDataURL('image/webp', 0.5).startsWith('data:image/webp');
  }
  return _photoMimeWebp;
}

function compressImageDataUrl(dataUrl, maxW, maxH, quality, mime) {
  const maxHeight = maxH || maxW;
  const outMime = mime || 'image/jpeg';
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, maxW / img.width, maxHeight / img.height);
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const useMime = _canvasSupportsMime(outMime) ? outMime : 'image/jpeg';
      resolve(canvas.toDataURL(useMime, quality));
    };
    img.onerror = () => reject(new Error('Invalid image'));
    img.src = dataUrl;
  });
}

async function compressImageForStorage(source, presetName) {
  const preset = PHOTO_PRESETS[presetName] || PHOTO_PRESETS.item;
  let dataUrl = typeof source === 'string'
    ? source
    : await compressImageFile(source, Math.max(preset.maxW, 640), 0.82);
  const mimes = _canvasSupportsMime('image/webp')
    ? ['image/webp', 'image/jpeg']
    : ['image/jpeg'];
  let best = dataUrl;
  for (const mime of mimes) {
    let quality = 0.78;
    while (quality >= preset.minQuality) {
      const candidate = await compressImageDataUrl(dataUrl, preset.maxW, preset.maxH, quality, mime);
      best = candidate;
      if (dataUrlByteLength(candidate) <= preset.maxBytes) return candidate;
      quality -= 0.07;
    }
  }
  return best;
}

function compressImageFile(file, maxW, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = ev => compressImageDataUrl(ev.target.result, maxW, maxW, quality).then(resolve).catch(reject);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function initPhotoStore() {
  if (!db || !db.objectStoreNames.contains('photos')) return;
  try {
    const rows = await dbAll('photos');
    rows.forEach(r => { if (r && r.key && r.dataUrl) _photoCache.set(r.key, r.dataUrl); });
    await _migrateLegacyLocalStoragePhotos();
  } catch (e) {
    console.warn('[initPhotoStore]', e);
  }
}

async function _migrateLegacyLocalStoragePhotos() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.startsWith('item_photo_') || k.startsWith('wish_photo_'))) keys.push(k);
  }
  if (!keys.length) return;
  for (const k of keys) {
    const raw = localStorage.getItem(k);
    if (!raw) { localStorage.removeItem(k); continue; }
    let storeKey = null;
    let preset = 'item';
    if (k.startsWith('item_photo_')) {
      storeKey = _photoKey('item', k.slice('item_photo_'.length));
    } else {
      storeKey = _photoKey('wish', k.slice('wish_photo_'.length));
      preset = 'wish';
    }
    if (_photoCache.has(storeKey)) {
      localStorage.removeItem(k);
      continue;
    }
    try {
      await _persistPhoto(storeKey, raw, preset);
    } catch (_) { /* keep in localStorage if migrate fails */ }
    localStorage.removeItem(k);
  }
}

async function _persistPhoto(key, dataUrl, presetName) {
  const compressed = await compressImageForStorage(dataUrl, presetName);
  const mime = (compressed.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
  const record = {
    key,
    dataUrl: compressed,
    mime,
    bytes: dataUrlByteLength(compressed),
    updatedAt: new Date().toISOString(),
  };
  await dbPut('photos', record);
  _photoCache.set(key, compressed);
  return compressed;
}

function getItemPhoto(itemId) {
  const key = _photoKey('item', itemId);
  if (_photoCache.has(key)) return _photoCache.get(key);
  return localStorage.getItem('item_photo_' + itemId) || null;
}

async function setItemPhoto(itemId, dataUrl) {
  if (!dataUrl) return;
  try {
    await _persistPhoto(_photoKey('item', itemId), dataUrl, 'item');
    localStorage.removeItem('item_photo_' + itemId);
  } catch (e) {
    console.warn('[setItemPhoto]', e);
    try {
      const compressed = await compressImageForStorage(dataUrl, 'item');
      localStorage.setItem('item_photo_' + itemId, compressed);
      _photoCache.set(_photoKey('item', itemId), compressed);
    } catch (_) {
      toast('Storage full - photo not saved', 'err');
    }
  }
}

async function removeItemPhoto(itemId) {
  const key = _photoKey('item', itemId);
  _photoCache.delete(key);
  localStorage.removeItem('item_photo_' + itemId);
  if (db && db.objectStoreNames.contains('photos')) {
    try { await dbDelete('photos', key); } catch (_) { /* intentionally ignored */ }
  }
}

function getWishPhoto(wishId) {
  const key = _photoKey('wish', wishId);
  if (_photoCache.has(key)) return _photoCache.get(key);
  return localStorage.getItem('wish_photo_' + wishId) || null;
}

async function setWishPhoto(wishId, dataUrl) {
  if (!dataUrl) return;
  try {
    await _persistPhoto(_photoKey('wish', wishId), dataUrl, 'wish');
    localStorage.removeItem('wish_photo_' + wishId);
  } catch (e) {
    console.warn('[setWishPhoto]', e);
    try {
      const compressed = await compressImageForStorage(dataUrl, 'wish');
      localStorage.setItem('wish_photo_' + wishId, compressed);
      _photoCache.set(_photoKey('wish', wishId), compressed);
    } catch (_) {
      toast('Storage full - photo not saved', 'err');
    }
  }
}

async function removeWishPhoto(wishId) {
  const key = _photoKey('wish', wishId);
  _photoCache.delete(key);
  localStorage.removeItem('wish_photo_' + wishId);
  if (db && db.objectStoreNames.contains('photos')) {
    try { await dbDelete('photos', key); } catch (_) { /* intentionally ignored */ }
  }
}

function clearAllPhotoCache() {
  _photoCache.clear();
}

function _closeImagePickerSheet() {
  const el = document.getElementById('image-picker-sheet');
  if (el) el.remove();
}

let _clipboardPastePending = null;
let _wishlistScreenshotWatchOn = false;

async function _imageBlobToStorage(blob, preset) {
  if (!blob || !blob.size) return null;
  const type = blob.type || 'image/png';
  const rough = await compressImageFile(new File([blob], 'screenshot.jpg', { type }), 960, 0.82);
  return compressImageForStorage(rough, preset);
}

async function _readImageFromClipboardItems(items, preset) {
  for (const item of items) {
    const types = (item.types && item.types.length)
      ? [...item.types]
      : ['image/png', 'image/jpeg', 'image/webp'];
    for (const type of types) {
      if (!type.startsWith('image/')) continue;
      try {
        const blob = await item.getType(type);
        const dataUrl = await _imageBlobToStorage(blob, preset);
        if (dataUrl) return dataUrl;
      } catch (_) { /* try next type */ }
    }
  }
  return null;
}

function _isWishlistVisible() {
  const inv = document.getElementById('page-inventory');
  if (inv && inv.classList.contains('active') && _activeInventoryTab === 'wishlist') return true;
  const wp = document.getElementById('page-wishlist');
  return !!(wp && wp.classList.contains('active'));
}

function cancelClipboardScreenshotWait() {
  if (!_clipboardPastePending) return;
  document.removeEventListener('visibilitychange', _clipboardPastePending.onVis);
  window.removeEventListener('focus', _clipboardPastePending.onFocus);
  window.removeEventListener('pageshow', _clipboardPastePending.onPageShow);
  document.removeEventListener('paste', _clipboardPastePending.onPaste, true);
  if (_clipboardPastePending.retryTimers) {
    _clipboardPastePending.retryTimers.forEach(id => clearTimeout(id));
  }
  if (_clipboardPastePending.timeoutId) clearTimeout(_clipboardPastePending.timeoutId);
  const el = document.getElementById('clipboard-wait-overlay');
  if (el) el.remove();
  _clipboardPastePending = null;
}
window.cancelClipboardScreenshotWait = cancelClipboardScreenshotWait;

function _updateClipboardWaitOverlay(state) {
  const el = document.getElementById('clipboard-wait-overlay');
  if (!el) return;
  const importBtn = el.querySelector('#clipboard-wait-import-btn');
  const text = el.querySelector('.clipboard-wait-text');
  if (state === 'ready') {
    if (importBtn) importBtn.classList.add('pulse');
    if (text) text.textContent = 'You\'re back - tap Import now to attach the screenshot.';
  } else if (state === 'waiting') {
    if (importBtn) importBtn.classList.remove('pulse');
    if (text) text.innerHTML = 'Open another app, take your screenshot, tap <strong>Done</strong> or <strong>Complete</strong>, then switch back here.';
  }
}

function _showClipboardWaitOverlay() {
  let el = document.getElementById('clipboard-wait-overlay');
  if (el) {
    _updateClipboardWaitOverlay('waiting');
    return el;
  }
  el = document.createElement('div');
  el.id = 'clipboard-wait-overlay';
  el.className = 'clipboard-wait-overlay';
  el.innerHTML =
    '<div class="clipboard-wait-card">' +
      '<div class="clipboard-wait-icon"><i class="fa-solid fa-paste"></i></div>' +
      '<div class="clipboard-wait-title">Waiting for screenshot</div>' +
      '<p class="clipboard-wait-text">Open another app, take your screenshot, tap <strong>Done</strong> or <strong>Complete</strong>, then switch back here.</p>' +
      '<button type="button" class="clipboard-wait-import" id="clipboard-wait-import-btn">Import now</button>' +
      '<button type="button" class="clipboard-wait-gallery" id="clipboard-wait-gallery-btn">Pick from gallery instead</button>' +
      '<button type="button" class="clipboard-wait-cancel" id="clipboard-wait-cancel-btn">Cancel</button>' +
    '</div>';
  el.querySelector('#clipboard-wait-cancel-btn').addEventListener('click', () => {
    cancelClipboardScreenshotWait();
    toast('Screenshot import cancelled', 'ok');
  });
  el.querySelector('#clipboard-wait-import-btn').addEventListener('click', () => {
    if (_clipboardPastePending && _clipboardPastePending.tryImport) {
      _clipboardPastePending.tryImport(true);
    }
  });
  el.querySelector('#clipboard-wait-gallery-btn').addEventListener('click', () => {
    const pending = _clipboardPastePending;
    if (!pending) return;
    const preset = pending.opts.photoPreset || 'item';
    const onPick = pending.opts.onPick;
    cancelClipboardScreenshotWait();
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async e => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const rough = await compressImageFile(file, 960, 0.82);
        const dataUrl = await compressImageForStorage(rough, preset);
        if (onPick) await onPick(dataUrl);
        toast('Photo attached', 'ok');
      } catch (_) {
        toast('Could not load image', 'err');
      }
    };
    input.click();
  });
  document.body.appendChild(el);
  return el;
}

async function pasteImageFromClipboard(options) {
  const silent = options && options.silent;
  const preset = (options && options.photoPreset) || 'item';

  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      const dataUrl = await _readImageFromClipboardItems(items, preset);
      if (dataUrl) return dataUrl;
    } catch (e) {
      console.warn('[clipboard]', e);
      if (!silent) {
        if (e.name === 'NotAllowedError') {
          toast('Tap Import now to allow clipboard access', 'err');
        } else {
          toast('Could not read clipboard - tap Import now or use Gallery', 'err');
        }
      }
      return null;
    }
  } else if (!silent) {
    toast('Clipboard not supported - use Gallery and pick your screenshot', 'err');
  }

  if (!silent) toast('No image in clipboard yet', 'err');
  return null;
}
window.pasteImageFromClipboard = pasteImageFromClipboard;

async function _completeScreenshotImport(dataUrl) {
  if (!dataUrl || !_clipboardPastePending) return false;
  const onPick = _clipboardPastePending.opts.onPick;
  cancelClipboardScreenshotWait();
  if (onPick) await onPick(dataUrl);
  toast('Screenshot imported', 'ok');
  return true;
}

function startClipboardScreenshotImport(opts) {
  cancelClipboardScreenshotWait();
  const pickOpts = {
    photoPreset: opts.photoPreset || 'item',
    onPick: opts.onPick
  };

  _showClipboardWaitOverlay();

  let importing = false;
  async function tryImport(fromUserTap) {
    if (!_clipboardPastePending || importing) return false;
    importing = true;
    try {
      const dataUrl = await pasteImageFromClipboard({
        silent: !fromUserTap,
        photoPreset: pickOpts.photoPreset
      });
      if (dataUrl) {
        await _completeScreenshotImport(dataUrl);
        return true;
      }
      if (fromUserTap) {
        toast('No screenshot in clipboard - try Gallery or take the screenshot again', 'err');
      }
      return false;
    } finally {
      importing = false;
    }
  }

  async function tryImportFromPasteEvent(e) {
    if (!_clipboardPastePending || importing) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items || !items.length) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.type || item.type.indexOf('image') === -1) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      importing = true;
      try {
        const dataUrl = await _imageBlobToStorage(file, pickOpts.photoPreset);
        if (dataUrl) await _completeScreenshotImport(dataUrl);
      } finally {
        importing = false;
      }
      return;
    }
  }

  const retryDelays = [200, 600, 1200, 2200];
  const retryTimers = [];

  const onReturn = () => {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    _updateClipboardWaitOverlay('ready');
    retryTimers.forEach(id => clearTimeout(id));
    retryDelays.forEach(ms => {
      retryTimers.push(setTimeout(() => {
        if (_clipboardPastePending) tryImport(false);
      }, ms));
    });
  };

  const onPaste = e => { tryImportFromPasteEvent(e); };

  _clipboardPastePending = {
    opts: pickOpts,
    tryImport,
    onVis: onReturn,
    onFocus: onReturn,
    onPageShow: onReturn,
    onPaste,
    retryTimers,
    timeoutId: setTimeout(() => {
      if (_clipboardPastePending) {
        cancelClipboardScreenshotWait();
        toast('Screenshot import timed out', 'err');
      }
    }, 10 * 60 * 1000)
  };

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  window.addEventListener('pageshow', onReturn);
  document.addEventListener('paste', onPaste, true);

  tryImport(false).then(imported => {
    if (imported || !_clipboardPastePending) return;
    toast('Take screenshot in another app, then return here', 'ok');
  });
}
window.startClipboardScreenshotImport = startClipboardScreenshotImport;

function startWishlistScreenshotImport() {
  startClipboardScreenshotImport({
    photoPreset: 'wish',
    onPick: async dataUrl => {
      _wishFormPhotoData = dataUrl;
      updateWishPhotoPreview();
    }
  });
}
window.startWishlistScreenshotImport = startWishlistScreenshotImport;

function initWishlistScreenshotWatch() {
  if (_wishlistScreenshotWatchOn) return;
  _wishlistScreenshotWatchOn = true;
  const delays = [300, 900, 1800];
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!_isWishlistVisible() || _clipboardPastePending || _wishFormPhotoData) return;
    delays.forEach(ms => {
      setTimeout(async () => {
        if (!_isWishlistVisible() || _clipboardPastePending || _wishFormPhotoData) return;
        const dataUrl = await pasteImageFromClipboard({ silent: true, photoPreset: 'wish' });
        if (!dataUrl) return;
        _wishFormPhotoData = dataUrl;
        updateWishPhotoPreview();
        toast('Screenshot imported to wishlist', 'ok');
      }, ms);
    });
  });
}

function showImagePickerSheet(opts) {
  _closeImagePickerSheet();
  const title = opts.title || 'Add photo';
  const sheet = document.createElement('div');
  sheet.id = 'image-picker-sheet';
  sheet.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:flex-end;justify-content:center;';
  sheet.onclick = e => { if (e.target === sheet) _closeImagePickerSheet(); };
  const btnStyle = 'width:100%;padding:14px;border-radius:var(--r);font-size:15px;font-weight:700;cursor:pointer;font-family:var(--sans);margin-bottom:8px;border:none;';
  sheet.innerHTML =
    '<div style="background:var(--surface);border-radius:20px 20px 0 0;width:100%;max-width:520px;padding:20px 18px 32px;" onclick="event.stopPropagation()">' +
      '<div style="font-size:15px;font-weight:800;color:var(--text);margin-bottom:6px;text-align:center;">' + escapeHtml(title) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);text-align:center;margin-bottom:14px;line-height:1.4;">Take a photo, pick from gallery, or screenshot in another app and return here to import.</div>' +
      '<button type="button" data-src="camera" style="' + btnStyle + 'background:var(--accent);color:white;">Take photo</button>' +
      '<button type="button" data-src="gallery" style="' + btnStyle + 'background:var(--surface2);color:var(--text);border:1.5px solid var(--border);">Choose from gallery</button>' +
      '<button type="button" data-src="clipboard" style="' + btnStyle + 'background:var(--surface2);color:var(--text);border:1.5px solid var(--border);">Screenshot from another app</button>' +
      '<button type="button" data-src="cancel" style="width:100%;padding:12px;background:transparent;color:var(--muted);border:none;font-size:14px;cursor:pointer;font-family:var(--sans);">Cancel</button>' +
    '</div>';
  sheet.querySelectorAll('button[data-src]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const src = btn.getAttribute('data-src');
      if (src === 'cancel') { _closeImagePickerSheet(); return; }
      if (src === 'clipboard') {
        startClipboardScreenshotImport(opts);
        _closeImagePickerSheet();
        return;
      }
      _closeImagePickerSheet();
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      if (src === 'camera') input.capture = 'environment';
      input.onchange = async e => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        try {
          const rough = await compressImageFile(file, 960, 0.82);
          const dataUrl = await compressImageForStorage(rough, opts.photoPreset || 'item');
          if (opts.onPick) opts.onPick(dataUrl, { fileName: file.name || '' });
        } catch (err) {
          toast('Could not load image', 'err');
        }
      };
      input.click();
    });
  });
  document.body.appendChild(sheet);
}
window.showImagePickerSheet = showImagePickerSheet;

function triggerPhotoUpload(itemId, event) {
  event.stopPropagation();
  showImagePickerSheet({
    title: 'Item photo',
    photoPreset: 'item',
    onPick: async dataUrl => {
      await setItemPhoto(itemId, dataUrl);
      renderList();
      toast('Photo saved', 'ok');
    }
  });
}

// ===== ADD FORM PHOTO =====
let _addFormPhotoData = null;

function triggerAddPhotoUpload() {
  showImagePickerSheet({
    title: 'Item photo',
    photoPreset: 'item',
    onPick: async dataUrl => {
      _addFormPhotoData = dataUrl;
      const photoImg = document.getElementById('add-photo-img');
      const placeholder = document.getElementById('add-photo-placeholder');
      const removeBtn = document.getElementById('add-photo-remove');
      if (photoImg) { photoImg.src = _addFormPhotoData; photoImg.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      if (removeBtn) removeBtn.style.display = 'block';
      const pv = _photoViewerRegistry.get('add');
      if (pv) requestAnimationFrame(() => pv.reset());
      toast('Photo ready', 'ok');
    }
  });
}

// ===== WISHLIST PHOTO =====
let _wishFormPhotoData = null;

/** e.g. "YS5981-1 36-42.jpg" to { shoeCode: "YS5981-1", itemName: "YS5981-1 36-42" } */
function parseWishPhotoFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const base = fileName.trim().replace(/\.(jpe?g|png|gif|webp|heic|heif|bmp|avif)$/i, '').trim();
  if (!base) return null;

  const itemName = base;
  const sizeRangeRe = /\d+\s*[-–-]\s*\d+/;
  const normCode = s => String(s || '').trim().toUpperCase();

  // "CODE-1 36-42" or "YS5981 36-42" (space before size range)
  const spaced = base.match(/^(.+?)\s+(\d+\s*[-–-]\s*\d+)\s*$/);
  if (spaced && sizeRangeRe.test(spaced[2])) {
    const shoeCode = normCode(spaced[1]);
    if (shoeCode) return { itemName, shoeCode };
  }

  // "YS5981-1-36-42" or "YS5981-36-42" (hyphen before size range at end)
  const hyphenated = base.match(/^(.+?)[\s\-]+(\d+\s*[-–-]\s*\d+)\s*$/);
  if (hyphenated) {
    const shoeCode = normCode(hyphenated[1].replace(/[\s\-]+$/, ''));
    if (shoeCode) return { itemName, shoeCode };
  }

  // Code-only filename (allows CODE-1 suffix)
  const codeOnly = base.match(/^([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/);
  return {
    itemName,
    shoeCode: codeOnly ? normCode(codeOnly[1]) : ''
  };
}

function applyWishPhotoFileName(fileName) {
  const parsed = parseWishPhotoFileName(fileName);
  if (!parsed) return false;
  const nameEl = document.getElementById('wish-name');
  const codeEl = document.getElementById('wish-code');
  if (nameEl) nameEl.value = parsed.itemName;
  if (codeEl && parsed.shoeCode) {
    codeEl.value = parsed.shoeCode;
    toggleWishAddMore(true);
  }
  return true;
}

function handleWishPhotoPicked(dataUrl, meta) {
  _wishFormPhotoData = dataUrl;
  updateWishPhotoPreview();
  const fromFile = meta?.fileName && applyWishPhotoFileName(meta.fileName);
  toast(fromFile ? 'Photo - name from filename' : 'Photo attached', 'ok');
}

function updateWishPhotoPreview() {
  const photoImg = document.getElementById('wish-photo-img');
  const placeholder = document.getElementById('wish-photo-placeholder');
  const removeBtn = document.getElementById('wish-photo-remove');
  if (_wishFormPhotoData) {
    if (photoImg) { photoImg.src = _wishFormPhotoData; photoImg.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'block';
    const pv = _photoViewerRegistry.get('wish');
    if (pv) requestAnimationFrame(() => pv.reset());
  } else {
    if (photoImg) { photoImg.src = ''; photoImg.style.display = 'none'; }
    if (placeholder) placeholder.style.display = 'flex';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function triggerWishPhotoUpload() {
  showImagePickerSheet({
    title: 'Wishlist photo',
    photoPreset: 'wish',
    onPick: async (dataUrl, meta) => handleWishPhotoPicked(dataUrl, meta)
  });
}
window.triggerWishPhotoUpload = triggerWishPhotoUpload;

function removeWishFormPhoto(event) {
  if (event) event.stopPropagation();
  _wishFormPhotoData = null;
  updateWishPhotoPreview();
}

function clearWishPhotoForm() {
  _wishFormPhotoData = null;
  updateWishPhotoPreview();
}
window.removeWishFormPhoto = removeWishFormPhoto;

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

function applyAddFormPhotoPreview(dataUrl) {
  if (!dataUrl) {
    clearAddFormPhoto();
    return;
  }
  _addFormPhotoData = dataUrl;
  const photoImg = document.getElementById('add-photo-img');
  const placeholder = document.getElementById('add-photo-placeholder');
  const removeBtn = document.getElementById('add-photo-remove');
  if (photoImg) { photoImg.src = dataUrl; photoImg.style.display = 'block'; }
  if (placeholder) placeholder.style.display = 'none';
  if (removeBtn) removeBtn.style.display = 'block';
  const pv = _photoViewerRegistry.get('add');
  if (pv) requestAnimationFrame(() => pv.reset());
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

let _currentWishDetailId = null;
let _wishStockingFromId = null;

async function markWishlistStockedById(wishId, itemId) {
  if (!wishId || !db.objectStoreNames.contains('wishlist')) return;
  const wish = await dbGet('wishlist', wishId);
  if (!wish) return;
  wish.status = 'stocked';
  wish.stockedAt = new Date().toISOString();
  wish.stockedItemId = itemId || null;
  await dbPut('wishlist', wish);
}

function normalizeWishVendorQuotes(wish) {
  if (!wish || !Array.isArray(wish.vendorQuotes)) return [];
  return wish.vendorQuotes
    .map(q => ({
      id: q.id || ('vq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
      vendor: String(q.vendor || '').trim(),
      price: parseFloat(q.price),
      updatedAt: q.updatedAt || q.createdAt || new Date().toISOString()
    }))
    .filter(q => q.vendor && Number.isFinite(q.price) && q.price >= 0);
}

function sortWishVendorQuotes(quotes) {
  return [...quotes].sort((a, b) => a.price - b.price || a.vendor.localeCompare(b.vendor));
}

function getCheapestWishVendorQuote(quotes) {
  const sorted = sortWishVendorQuotes(quotes);
  return sorted.length ? sorted[0] : null;
}

/** Parse "... 36-42" from wish name to size numbers for grid. */
function parseWishShoeSizeRange(text) {
  const s = String(text || '');
  const m = s.match(/(\d+)\s*[-–-]\s*(\d+)\s*$/);
  if (!m) return null;
  const min = parseInt(m[1], 10);
  const max = parseInt(m[2], 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max || max - min > 40) return null;
  const sizes = [];
  for (let i = min; i <= max; i++) sizes.push(i);
  return { min, max, label: min + '–' + max, sizes };
}

function buildWishShoeOverlayHtml(wish) {
  const range = parseWishShoeSizeRange(wish?.name || '') || parseWishShoeSizeRange(wish?.code || '');
  if (!range) return '';
  return '<span class="wd-shoe-badge">' + escapeHtml(range.label) + '</span>';
}

function renderWishShoeOverlay(wish) {
  const el = document.getElementById('wd-shoe-overlay');
  if (!el) return;
  const html = buildWishShoeOverlayHtml(wish);
  if (html) {
    el.innerHTML = html;
    el.hidden = false;
  } else {
    el.innerHTML = '';
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
      '<div class="wd-vendor-row' + (best ? ' wd-vendor-row-best' : '') + '">' +
        '<span class="wd-vendor-name">' + escapeHtml(q.vendor) + '</span>' +
        '<span class="wd-vendor-amt">' + fmt(q.price) +
          (best ? '<span class="wd-best-tag">Best</span>' : '') +
        '</span>' +
      '</div>';
  });
  return html + '</div>';
}

function renderWishDetailItemInfo(wish) {
  const el = document.getElementById('wd-item-details');
  if (!el) return;
  const range = parseWishShoeSizeRange(wish.name || '') || parseWishShoeSizeRange(wish.code || '');
  const rows = [
    { label: 'Name', value: wish.name },
    { label: 'Code', value: wish.code },
    { label: 'Category', value: wish.type },
    { label: 'Qty', value: wish.qty > 0 ? wish.qty + ' pcs' : '' },
    { label: 'BP est.', value: wish.estimatedCost > 0 ? fmt(wish.estimatedCost) : '' },
    { label: 'Sizes', value: range ? range.label : '' }
  ];
  const html = rows
    .filter(r => r.value)
    .map(r =>
      '<div class="wish-detail-dl-row">' +
        '<dt>' + escapeHtml(r.label) + '</dt>' +
        '<dd>' + escapeHtml(String(r.value)) + '</dd>' +
      '</div>'
    )
    .join('');
  el.innerHTML = html || '<p class="wish-vendor-empty">No details</p>';
}

function buildWishListCardHtml(row, wishRec) {
  const photo = getWishPhoto(row.wishId);
  const thumb = photo
    ? '<img src="' + photo + '" alt="" class="wish-card-thumb">'
    : '<div class="wish-card-thumb wish-card-thumb-empty"><i class="fa-solid fa-camera"></i></div>';

  const quotes = normalizeWishVendorQuotes(wishRec || { vendorQuotes: [] });
  const cheapest = getCheapestWishVendorQuote(quotes);
  const moreCount = quotes.length > 1 ? quotes.length - 1 : 0;

  let priceHtml;
  if (cheapest) {
    priceHtml =
      '<div class="wish-card-price">' +
        '<div class="wish-card-price-amt">' + fmt(cheapest.price) + '</div>' +
        '<div class="wish-card-price-vendor">' + escapeHtml(cheapest.vendor) + '</div>' +
        (moreCount > 0 ? '<div class="wish-card-price-more">+' + moreCount + ' more</div>' : '') +
      '</div>';
  } else {
    priceHtml = '<div class="wish-card-price wish-card-price-empty"><span>-</span></div>';
  }

  const chips = [];
  if (row.code) chips.push('<span class="wish-chip wish-chip-code">' + escapeHtml(row.code) + '</span>');
  if (row.type) chips.push('<span class="wish-chip">' + escapeHtml(row.type) + '</span>');
  if (row.qty) chips.push('<span class="wish-chip">' + row.qty + ' pcs</span>');
  if (wishRec && wishRec.estimatedCost) chips.push('<span class="wish-chip">BP ' + fmt(wishRec.estimatedCost) + '</span>');

  return '<article class="wish-card" onclick="openWishlistDetail(' + row.wishId + ')" role="button" tabindex="0">' +
    thumb +
    '<div class="wish-card-body">' +
      '<div class="wish-card-name">' + escapeHtml(row.name || row.code || 'Item') + '</div>' +
      (chips.length ? '<div class="wish-card-chips">' + chips.join('') + '</div>' : '') +
    '</div>' +
    priceHtml +
  '</article>';
}

function clearWishDetailVendorForm() {
  ['wd-vendor-name', 'wd-vendor-price'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
}

function renderWishVendorSection(wish) {
  const quotes = normalizeWishVendorQuotes(wish);
  const listEl = document.getElementById('wd-vendor-list');
  if (listEl) listEl.innerHTML = buildWishVendorDetailHtml(quotes);
}

async function openWishlistDetail(wishId) {
  const wish = await dbGet('wishlist', wishId);
  if (!wish) {
    toast('Wishlist item not found', 'err');
    return;
  }
  if (!Array.isArray(wish.vendorQuotes)) wish.vendorQuotes = [];
  _currentWishDetailId = wishId;
  const sheet = document.getElementById('wishlist-detail-sheet');
  const photo = getWishPhoto(wishId);
  const photoImg = document.getElementById('wd-photo-img');
  const photoEmpty = document.getElementById('wd-photo-empty');
  if (photo && photoImg) {
    photoImg.src = photo;
    photoImg.style.display = 'block';
    if (photoEmpty) photoEmpty.style.display = 'none';
    const pv = _photoViewerRegistry.get('wishDetail');
    if (pv) requestAnimationFrame(() => pv.reset());
  } else {
    if (photoImg) { photoImg.src = ''; photoImg.style.display = 'none'; }
    if (photoEmpty) photoEmpty.style.display = 'flex';
  }
  const nameEl = document.getElementById('wd-name');
  const noteInput = document.getElementById('wd-note-input');
  if (nameEl) nameEl.textContent = wish.name || wish.code || 'Item';
  renderWishDetailItemInfo(wish);
  renderWishShoeOverlay(wish);
  if (noteInput) noteInput.value = wish.note || '';
  clearWishDetailVendorForm();
  renderWishVendorSection(wish);
  if (sheet) sheet.classList.add('open');
}
window.openWishlistDetail = openWishlistDetail;

async function saveWishlistDetail() {
  const id = _currentWishDetailId;
  if (!id) return;
  const wish = await dbGet('wishlist', id);
  if (!wish) {
    toast('Wishlist item not found', 'err');
    return;
  }
  if (!Array.isArray(wish.vendorQuotes)) wish.vendorQuotes = [];

  const noteInput = document.getElementById('wd-note-input');
  wish.note = noteInput ? String(noteInput.value || '').trim() : '';

  const vendorName = Input.text('wd-vendor-name').trim();
  const vendorPriceRaw = Input.money('wd-vendor-price');
  if (vendorName || vendorPriceRaw > 0) {
    if (!vendorName) return Validate.fail('Enter vendor name', 'wd-vendor-name');
    if (!Validate.moneyRequired(vendorPriceRaw, 'wd-vendor-price', 'Amount')) return;
    const key = vendorName.toLowerCase();
    const existing = wish.vendorQuotes.find(q => String(q.vendor || '').trim().toLowerCase() === key);
    const now = new Date().toISOString();
    if (existing) {
      existing.vendor = vendorName;
      existing.price = vendorPriceRaw;
      existing.updatedAt = now;
    } else {
      wish.vendorQuotes.push({
        id: 'vq_' + Date.now(),
        vendor: vendorName,
        price: vendorPriceRaw,
        updatedAt: now
      });
    }
    clearWishDetailVendorForm();
  }

  await dbPut('wishlist', wish);
  scheduleSync();
  renderWishDetailItemInfo(wish);
  renderWishVendorSection(wish);
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast('Saved', 'ok');
}
window.saveWishlistDetail = saveWishlistDetail;

function closeWishlistDetail() {
  const sheet = document.getElementById('wishlist-detail-sheet');
  if (sheet) sheet.classList.remove('open');
  _currentWishDetailId = null;
}
window.closeWishlistDetail = closeWishlistDetail;

function wishlistDetailStock() {
  const id = _currentWishDetailId;
  closeWishlistDetail();
  if (id) startWishlistRestock(id);
}
window.wishlistDetailStock = wishlistDetailStock;

async function wishlistDetailDelete() {
  const id = _currentWishDetailId;
  if (!id) return;
  const wish = await dbGet('wishlist', id);
  const label = wish ? (wish.name || wish.code || 'this item') : 'this item';
  if (!confirm('Remove "' + label + '" from wishlist?')) return;
  closeWishlistDetail();
  await deleteWishlistItem(id);
}
window.wishlistDetailDelete = wishlistDetailDelete;

// ===== SAVE ITEM =====
async function saveItem() {
  _overlay.show('Saving...');
  try {
    // Use hidden input; fall back to JS variable if input got cleared unexpectedly
    const editIdRaw = UI.el('edit-id')?.value || (_editingItemId ? String(_editingItemId) : '');

    // SHOE SIZE EDIT
    // SHOE SIZE RESTOCK - adds qty to existing, never replaces
    if (editIdRaw && editIdRaw.startsWith('shoe_restock_')) {
      const parts = editIdRaw.replace('shoe_restock_','').split('_');
      const itemId = parseInt(parts[0]); const size = parseInt(parts[1]);
      const item = await dbGet('items', itemId);
      const allSz = await getShoeSizes(item ? item.code : '');
      const sizeRec = allSz.find(s => s.size === size);
      if (!sizeRec) { toast('Size record not found', 'err'); return; }
      const addQty = parseInt(UI.el('f-qty')?.value);
      if (isNaN(addQty) || addQty <= 0) { toast('Warning: Enter quantity to add', 'err'); return; }
      const buy = parseFloat(UI.el('f-buy')?.value);
      const sell = parseFloat(UI.el('f-sell')?.value);
      const nextBuy = !isNaN(buy) ? buy : (sizeRec.buyPrice || item?.buyPrice || item?.buy || 0);
      const nextSell = !isNaN(sell) ? sell : (sizeRec.sellPrice || item?.sellPrice || item?.sell || 0);
      if (!Validate.price(nextBuy, nextSell, 'f-buy', 'f-sell')) return;
      const newQty = (sizeRec.qty || 0) + addQty;
      if (newQty > 999999) { toast('Warning: Exceeds max 999,999', 'err'); return; }
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
          await setDoc(fbDoc('shoe_sizes', sizeRec.fbId), sanitiseForFirestore({...sizeRec}));
        } catch(e) { console.warn('[SYNC] shoe restock:', e.message); }
      }
      clearForm();
      allItems = await dbAll('items'); await enrichShoeItems(allItems);
      renderList(); renderDashboard(); updateHeader(); scheduleSync();
      toast('\U0001f4e6 Size ' + size + ': +' + addQty + ' to ' + newQty, 'ok');
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
      ['f-code','f-name','f-size'].forEach(id=>{const el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='';el.style.cursor='';}});
      setAddTypeLocked(false);
      setRestockBanner(false);
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('Size '+size+' updated - '+qty+' pcs - '+fmt(sell),'ok');
      showPage('list');return;
    }

    // RESTOCK MODE
    if(editIdRaw&&editIdRaw.startsWith('restock_')){
      const existing=await dbGet('items',parseInt(editIdRaw.replace('restock_','')));
      if(!existing){toast('Warning: Item not found','err');exitRestockMode();return;}
      const qtyEl=UI.el('f-qty');
      const addQty=parseInt(qtyEl?qtyEl.value.trim():'0');
      if(!addQty||addQty<=0){toast('Warning: Enter quantity to add','err');if(qtyEl)qtyEl.focus();return;}
      if(addQty>CODE_MAX_QTY&&!confirm('Adding '+addQty+' units - confirm?'))return;
      const newQty=existing.qty+addQty;
      if(newQty>999999){toast('Warning: Exceeds max 999,999','err');return;}
      existing.qty=newQty;existing.updatedAt=new Date().toISOString();
      await dbPut('items',existing);fbSyncItem(existing);
      await recordStockInvestment(existing, addQty * (existing.buyPrice || existing.buy || 0), addQty, 'Restock');
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      exitRestockMode();
      toast('\U0001f4e6 '+existing.code+': +'+addQty+' to '+newQty,'ok');return;
    }

    // COMMON FIELDS
    const type=UI.el('f-type')?.value||'';
    const code=sanitiseCode(UI.el('f-code')?.value||'');
    const name=(UI.el('f-name')?.value||'').trim().replace(/[ \t]+/g,' ');
    if(!code){toast('Warning: Enter item code','err');return;}
    if(!name){return Validate.fail('Enter item name', 'f-name');}
    if (!editIdRaw) {
      const codeMatches = await findCodeMatchesForSave(code);
      const existingCode = codeMatches.find(i => i.code === code);
      // Footwear: same code is OK when adding/updating sizes on an existing shoe SKU
      const addingShoeSizes = existingCode && isFootwearType(type) && existingCode.isShoe;
      if (existingCode && !addingShoeSizes) {
        showCodeDropdown(codeMatches, code);
        toast('Warning: Item code already exists - select it from the dropdown', 'err');
        UI.el('f-code')?.focus();
        return;
      }
    }

    // Determine Record Only mode early — affects both shoe and standard paths
    const isRecord = !!_addFormIsRecord;

    // SHOE MODE — disabled; footwear now saved as standard items
    if (false && isFootwearType(type) && !editIdRaw && !isRecord) {
      const savedCount = await saveShoeItems(code, name, type);
      if (!savedCount) return;
      if (_wishStockingFromId) {
        const stocked = (await dbAll('items')).find(i => i.code === code);
        if (stocked) await markWishlistStockedById(_wishStockingFromId, stocked.id);
        _wishStockingFromId = null;
      }
      clearForm();
      clearAddFormPhoto();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      await renderWishlistPage();
      await renderStockMonitorSummary();
      toast(''+savedCount+' shoe size(s) saved!','ok');return;
    }

    // STANDARD ADD / EDIT
    const size=UI.el('f-size')?.value.trim()||'';
    const qtyRaw=isRecord ? '0' : (UI.el('f-qty')?.value||'');
    const qty=qtyRaw === '' ? 0 : parseInt(qtyRaw);
    const buyRaw=UI.el('f-buy')?.value||'';
    const sellRaw=UI.el('f-sell')?.value||'';
    const sellMinRaw=UI.el('f-sell-min')?.value||'';
    const buy=parseFloat(buyRaw)||0;
    const sell=parseFloat(sellRaw)||0;
    const sellPriceMin=parseFloat(sellMinRaw)||0;
    if (!isRecord && qtyRaw !== '' && isNaN(qty)) return Validate.fail('Enter a valid quantity', 'f-qty');
    if (!isRecord && qty < 0) return Validate.fail('Quantity cannot be negative', 'f-qty');
    if (!isRecord && qty > 999999) return Validate.fail('Quantity exceeds maximum (999,999)', 'f-qty');
    if (!isRecord && qty > CODE_MAX_QTY && !confirm('Adding ' + qty + ' units - confirm?')) return;
    // Record Only: buy price is the one mandatory pricing field
    if (isRecord && (!buy || buy <= 0)) return Validate.fail('Buy price is required for Record items', 'f-buy');
    if (!Validate.moneyOptional(buyRaw === '' ? null : buy, 'f-buy', 'Buy price')) return;
    if (!Validate.moneyOptional(sellRaw === '' ? null : sell, 'f-sell', 'Sell price')) return;
    if (buy > 0 && sell > 0 && sell < buy) {
      return Validate.fail('Selling price (' + fmt(sell) + ') cannot be less than buying price (' + fmt(buy) + ')', 'f-sell');
    }
    if (sellPriceMin > 0 && sell > 0 && sellPriceMin >= sell) {
      return Validate.fail('Min sell price must be lower than sell price (' + fmt(sell) + ')', 'f-sell-min');
    }
    if (sellPriceMin > 0 && buy > 0 && sellPriceMin < buy) {
      if (!confirm('Min sell price (' + fmt(sellPriceMin) + ') is below buy price (' + fmt(buy) + '). Confirm?')) return;
    }
    const profit=sell-buy;
    const item={type,code,name,variant:size,buyPrice:buy,sellPrice:sell,sellPriceMin:sellPriceMin||undefined,profit,qty,isRecord,createdAt:new Date().toISOString()};

    if(editIdRaw){
      const resolvedId = parseInt(editIdRaw);
      if (!resolvedId || isNaN(resolvedId)) { toast('Warning: Cannot save: item ID missing', 'err'); return; }
      const original=await dbGet('items', resolvedId);
      // Merge: start from original to preserve all fields (isShoe, photo refs, etc)
      // then overwrite only what the form controls
      const saved = Object.assign({}, original || {}, {
        id:        resolvedId,
        type, code, name,
        variant:   size,
        buyPrice:     buy,
        sellPrice:    sell,
        sellPriceMin: sellPriceMin || undefined,
        profit,
        qty,
        isRecord,
        createdAt: original ? (original.createdAt || item.createdAt) : item.createdAt,
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser ? currentUser.username : 'system',
        fbId:      original ? original.fbId : undefined,
      });
      await dbPut('items', saved);
      if (_addFormPhotoData) await setItemPhoto(saved.id, _addFormPhotoData);
      fbSyncItem(saved);
      await _backfillSalesForItem(saved);  // keep itemId in sync with any code changes
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      try { await renderHistoryPage(); } catch(_) {}
      toast('Item updated!','ok');showPage('list');
    }else{
      // Pre-assign fbId so it's stored in IndexedDB immediately — prevents stale allItems
      item.fbId = stableItemFbId(item);
      const newId=await dbAdd('items',item);item.id=newId;
      if (_addFormPhotoData) await setItemPhoto(newId, _addFormPhotoData);
      if (_wishStockingFromId) {
        await markWishlistStockedById(_wishStockingFromId, newId);
        _wishStockingFromId = null;
      } else {
        await markWishlistStockedForItem(item);
      }
      await recordStockInvestment(item, qty * buy, qty, 'New stock');
      fbSyncItem(item);
      // Link any existing sales with this code to the new item ID
      const _backfilled = await _backfillSalesForItem(item);
      clearForm();clearAddFormPhoto();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      if (_backfilled > 0) { try { await renderHistoryPage(); } catch(_) {} }
      showPage('list');
      showSplash(name,sell,profit);
    }

  }catch(err){
    if(err.name==='ConstraintError'){
      toast('Warning: Code already exists - select from dropdown to restock','err');
    }else{
      toast('Warning: Save failed: '+(err.message||'Unknown error'),'err');
      console.error('[SAVE]',err);
    }
  }finally{
    _overlay.hide();
  }
}

function clearForm() {
  UI.el('edit-id').value   = '';
  _editingItemId = null;  // clear JS-side edit tracker
  _lastAddFormType = '';
  // Default to General category; fall back to empty if it doesn't exist
  const _defaultType = types.find(t => t.name === 'General' && isCategoryActive(t)) ? 'General' : '';
  setAddFormType(_defaultType, { skipTypeChange: true });
  UI.el('f-code').value    = '';
  UI.el('f-name').value    = '';
  UI.el('f-size').value    = '';
  UI.el('f-qty').value      = '';
  UI.el('f-buy').value      = '';
  UI.el('f-sell').value     = '';
  const _fSellMin = UI.el('f-sell-min');
  if (_fSellMin) _fSellMin.value = '';
  const pp = UI.el('profit-preview');
  if (pp) pp.style.display = 'none';
  setSaveBtnLabel('Save');
  const ml = UI.el('form-mode-label');
  if (ml) { ml.textContent = ''; ml.hidden = true; }
  setAddFormSubtitle();
  const ce = UI.el('cancel-edit-btn');
  if (ce) ce.style.display = 'none';

  // Re-enable any locked fields
  ['f-code','f-name','f-size','f-qty','f-buy','f-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; }
  });
  setAddTypeLocked(false);

  _shoeState.reset();
  resetShoeUiPanels();
  _addFormWasFootwear = false;
  _addFormIsRecord    = true;
  _preloadShoeCode = '';
  const pageAdd = document.getElementById('page-add');
  if (pageAdd) pageAdd.classList.remove('footwear-add-mode');
  const cascadeWrap = document.getElementById('f-type-cascade');
  if (cascadeWrap) delete cascadeWrap.dataset.footwearMode;
  ['shoe-shared-qty','shoe-shared-buy','shoe-shared-sell'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });

  setRestockBanner(false);
  hideRestockView();
  _wishStockingFromId = null;
  onTypeChange();

  // Apply Record Only AFTER onTypeChange so nothing overwrites it
  setItemMode(true);

  clearCodeMatchSelect();
  hideCodeDropdown();
}

// Code autocomplete helpers
let _codeDropdownActive = false;
let _editOriginItemId   = null;
let _editingItemId      = null;  // tracks current edit ID reliably (backup to hidden input)
let _lastAddFormType    = '';    // last f-type value - avoid wiping shoe sizes on tab switch
let _addFormWasFootwear = false;
let _addFormIsRecord    = true;    // true = Record Only mode (default)
let _preloadShoeCode    = '';
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
  return [...exact,...startsWith,...contains,...nameMatch].slice(0, 10);
}

async function onCodeInput() {
  const raw   = UI.el('f-code').value;
  const clean = sanitiseCode(raw);
  UI.el('f-code').value = clean;
  if (!clean) { clearCodeMatchSelect(); hideCodeDropdown(); return; }
  const source = (allItems && allItems.length) ? allItems : await dbAll('items');

  // De-duplicate by code then search: exact to startsWith to contains
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
  const matches    = [...exact,...startsWith,...contains,...nameMatch].slice(0, 10);

  if (!matches.length) { clearCodeMatchSelect('No match'); hideCodeDropdown(); return; }
  showCodeDropdown(matches, clean);

  const exactMatches = matches.filter(i => i.code === clean);
  if (exactMatches.length === 1 && exactMatches[0].isShoe && isAddFormFootwearContext() && !UI.el('edit-id')?.value) {
    await preloadShoeSizesForAdd(exactMatches[0].code);
  }
}

async function preloadShoeSizesForAdd(code) {
  if (!code || !isAddFormFootwearContext()) return;
  const items = (allItems && allItems.length) ? allItems : await dbAll('items');
  const product = items.find(i => i.code === code && i.isShoe);
  if (!product) return;
  if (_preloadShoeCode === code) return;
  _preloadShoeCode = code;
  _shoeState.sizes.clear();
  _shoeState.shownGroups.clear();
  const grid = UI.el('sz-grid');
  if (grid) grid.innerHTML = '';
  const records = await getShoeSizes(code);
  if (!records.length) return;

  const groupsNeeded = new Set();
  records.forEach(sz => groupsNeeded.add(sz.sizeGroup || _shoeState.groupFor(sz.size)));
  records.forEach(sz => _shoeState.sizes.add(sz.size));
  renderAllShoeGroupCards();

  const szWrap = UI.el('shoe-rows-wrap');
  if (szWrap) szWrap.style.display = _shoeState.sizes.size > 0 ? 'block' : 'none';
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
  records.filter(r => (r.qty || 0) > 0).forEach(r => _shoeState.lockedSizes.add(Number(r.size)));
  const grid = UI.el('sz-grid');
  if (grid) grid.innerHTML = '';
  renderAllShoeGroupCards();
  showShoePricingPanel();
  renderShoeSummary();
  updateShoeCollectiveSummary();
}
window.preloadShoeSizesForRestock = preloadShoeSizesForRestock;

// Entry point: "Restock" button on a footwear collection's stock-list header.
async function openShoeCollectionRestock(code) {
  const items = (allItems && allItems.length) ? allItems : await dbAll('items');
  const item = items.find(i => i.code === code && i.isShoe);
  if (!item) { toast('Item not found', 'err'); return; }

  showPage('add');
  setTimeout(async () => {
    setAddFormType(item.type || '', { skipTypeChange: true });
    UI.el('f-code').value  = item.code || '';
    UI.el('f-name').value  = item.name || '';
    UI.el('edit-id').value = '';
    onTypeChange();

    ['f-code', 'f-name'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = true; el.style.opacity = '0.45'; el.style.cursor = 'not-allowed'; }
    });
    setAddTypeLocked(true);
    setSaveBtnLabel('Save new sizes');
    const ml = UI.el('form-mode-label');
    if (ml) { ml.hidden = false; ml.textContent = 'Restock ' + item.code + ' - missing & out-of-stock sizes only'; }
    UI.el('cancel-edit-btn').style.display = 'block';

    await preloadShoeSizesForRestock(item.code);
  }, 100);
}
window.openShoeCollectionRestock = openShoeCollectionRestock;

function showCodeDropdown(items, typedCode) {
  const select = document.getElementById('code-match-select');
  if (select) {
    select.onchange = () => selectExistingItemFromDropdown(select.value);
    select.disabled = !items.length;
    select.style.opacity = items.length ? '1' : '0.55';
    select.style.cursor = items.length ? 'pointer' : 'not-allowed';
    select.innerHTML = '<option value="">Match existing code...</option>' +
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

function clearCodeMatchSelect(label = 'Match existing code...') {
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
    if (!item) { toast('Warning: Item not found', 'err'); hideCodeDropdown(); return; }
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

  // Filter — if there's a query, rank by match score; otherwise sort by recency
  let filtered = allItems.filter(item => {
    const matchSearch = !search || _gscScore(item, search) > 0;
    const matchType   = itemMatchesTypeFilter(item, activeTypeFilter);
    return matchSearch && matchType;
  }).sort((a, b) => {
    if (search) return _gscScore(b, search) - _gscScore(a, search);
    return new Date(b.createdAt||0) - new Date(a.createdAt||0);
  });

  updateHeader();

  const list = UI.el('item-list');
  if (!list) return;

  if (!filtered.length) {
    list.style.border = 'none';
    list.innerHTML = `<div class="empty">
      <div class="e-icon"><i class="fa-solid fa-${allItems.length ? 'magnifying-glass' : 'box'}"></i></div>
      <p>${allItems.length ? 'No items match your search.' : 'No items yet.\nTap Add Item to get started.'}</p>
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

  // Pre-build sub-category type groups (non-shoe items whose type has a parentId)
  const _typeGroupMap = {};
  const _seenTypeGroups = new Set();
  const _groupedItemIds = new Set();
  for (const _gi of filtered) {
    if (_gi.isShoe) continue;
    const _gtObj = getTypeObj(_gi.type);
    if (_gtObj && _gtObj.parentId) {
      const _gpt = types.find(t => t.id === _gtObj.parentId);
      if (_gpt) {
        if (!_typeGroupMap[_gpt.id]) _typeGroupMap[_gpt.id] = { parentType: _gpt, items: [] };
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
        .filter(s => s.itemCode === item.code)
        .sort((a, b) => a.size - b.size);

      if (!sizes.length) {
        // Shoe parent with no sizes yet - show placeholder
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
          const stockLabel = isOut?'Out':sz.qty+' pcs';
          const soldQty    = salesBySize[item.code+'_'+sz.size]||0;
          cards.push(`
            <div class="item-card shoe-size-row${isOut?' shoe-out-card':''}" onclick="openShoeSizeCard('${escapeHtml(item.code)}',${sz.size})">
              ${isOut?'<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>':''}
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

    } else if (item.hasVariants) {
      // ── GENERAL VARIANT ITEM - expandable like footwear ───────────
      const variants = allSizes
        .filter(s => s.itemCode === item.code)
        .sort((a, b) => String(a.sizeGroup||'').localeCompare(String(b.sizeGroup||'')));

      if (!variants.length) {
        cards.push(`
          <div class="item-card" onclick="openSheet(${item.id})">
            <div class="item-top">
              <div class="item-icon" style="background:${t.color||'var(--surface2)'};">${t.emoji}</div>
              <div class="item-body">
                <div class="item-code">${escapeHtml(item.code)}</div>
                <div class="item-name">${escapeHtml(item.name||'')}</div>
                <div class="item-tags">
                  <span class="tag tag-cyan">${escapeHtml(item.type)}</span>
                  <span class="tag tag-gray">No variants</span>
                </div>
              </div>
            </div>
          </div>`);
        continue;
      }

      const groupTotalPcs = variants.reduce((s,v) => s+(v.qty||0), 0);
      const groupSoldPcs  = variants.reduce((s,v) => s+(salesBySize[item.code+'_'+v.sizeGroup]||0), 0);
      const groupRevenue  = allSales.filter(s=>s.itemCode===item.code).reduce((s,x)=>s+(x.revenue||0),0);
      const allOut  = variants.every(v => v.qty <= 0);
      const hasOut  = variants.some(v => v.qty <= 0);
      const isExpanded = (UI.el('search')?.value||'').length > 0 || (_expandedShoeGroups&&_expandedShoeGroups.has(item.code));

      cards.push(`
        <div class="shoe-group-header" onclick="toggleShoeGroup('${escapeHtml(item.code)}')" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${t.color||'#334155'};">${t.emoji}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(item.code)}</span>
              ${allOut?'<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>':hasOut?'<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>':''}
            </div>
            <span class="shoe-group-name">${escapeHtml(item.name||'')}</span>
            <div style="font-size:10px;color:var(--muted);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>${variants.length} ${escapeHtml(item.variantType||'variant')}${variants.length!==1?'s':''}</span>
              <span>${groupTotalPcs} pcs</span>
              <span>Sold ${groupSoldPcs}</span>
              <span style="color:var(--accent2);">${fmt(groupRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <span class="tag tag-cyan" style="font-size:10px;">${escapeHtml(item.variantType||'Variants')}</span>
            <span style="font-size:16px;color:var(--muted);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded?180:0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) { cards.push('<div style="height:4px;"></div>'); }
      else {
        variants.forEach(v => {
          const isOut = v.qty <= 0;
          const isLow = !isOut && v.qty <= LOW_STOCK_LEVEL;
          const sc    = isOut ? 'tag-red' : isLow ? 'tag-amber' : 'tag-green';
          const sl    = isOut ? 'Out' : v.qty + ' pcs';
          const sq    = salesBySize[item.code+'_'+v.sizeGroup] || 0;
          const sp    = v.sellPrice || item.sellPrice || 0;
          const bp    = v.buyPrice  || item.buyPrice  || 0;
          cards.push(`
            <div class="item-card shoe-size-row${isOut?' shoe-out-card':''}" onclick="openSheet(${item.id})">
              ${isOut?'<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>':''}
              <div class="item-top">
                <div class="variant-badge ${isOut?'out':isLow?'low':''}">${escapeHtml(v.sizeGroup||'?')}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(item.name||item.code)}</div>
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
      const isExpanded = (UI.el('search')?.value||'').length > 0 || _expandedTypeGroups.has(ptId);
      const groupTotalQty = groupItems.reduce((s,i) => s+(i.qty||0), 0);
      const groupRevenue  = allSales.filter(s => groupItems.some(i => i.id === s.itemId)).reduce((s,x) => s+(x.revenue||0), 0);
      const allOut = groupItems.every(i => i.qty <= 0);
      const hasOut = groupItems.some(i => i.qty <= 0);

      cards.push(`
        <div class="type-group-header" onclick="toggleTypeGroup(${ptId})" style="cursor:pointer;">
          <div class="shoe-group-icon" style="background:${parentType.color||'#334155'};">${parentType.emoji||'📦'}</div>
          <div class="shoe-group-info" style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span class="shoe-group-code">${escapeHtml(parentType.name)}</span>
              ${allOut?'<span style="font-size:9px;background:var(--red);color:white;padding:1px 6px;border-radius:10px;font-weight:700;">OUT</span>':hasOut?'<span style="font-size:9px;background:#d97706;color:white;padding:1px 6px;border-radius:10px;font-weight:700;">PARTIAL</span>':''}
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,.6);font-family:var(--mono);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;">
              <span>${groupItems.length} item${groupItems.length!==1?'s':''}</span>
              <span>${groupTotalQty} pcs</span>
              <span style="color:var(--accent2);">${fmt(groupRevenue)}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
            <span style="font-size:16px;color:rgba(255,255,255,.6);transition:transform .2s;display:inline-block;transform:rotate(${isExpanded?180:0}deg);">▼</span>
          </div>
        </div>`);

      if (!isExpanded) {
        cards.push('<div style="height:4px;"></div>');
      } else {
        for (const ci of groupItems) {
          const ct = getTypeObj(ci.type);
          const sc = ci.qty === 0 ? 'tag-red' : ci.qty <= LOW_STOCK_LEVEL ? 'tag-amber' : 'tag-green';
          const sl = ci.qty === 0 ? 'Out' : ci.qty + ' pcs';
          const sq = (salesByItem[ci.id] || {}).qty || 0;
          const sp = ci.sellPrice || ci.sell || 0;
          const bp = ci.buyPrice  || ci.buy  || 0;
          cards.push(`
            <div class="item-card type-group-child-row${ci.qty<=0?' shoe-out-card':''}" onclick="openSheet(${ci.id})">
              ${ci.qty<=0?'<div class="out-of-stock-overlay"><span>OUT OF STOCK - RESTOCK</span></div>':''}
              <div class="item-top">
                <div class="item-icon" style="background:${ct.color||'var(--surface2)'};">${ct.emoji||'📦'}</div>
                <div class="item-body">
                  <div class="item-code">${escapeHtml(ci.code)}${(ci.variant||ci.size)?' - '+escapeHtml(ci.variant||ci.size):''}</div>
                  <div class="item-name">${escapeHtml(ci.name||'')}</div>
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
      const isRec      = !!item.isRecord;
      const stockColor = isRec ? 'tag-amber' : item.qty === 0 ? 'tag-red' : item.qty <= LOW_STOCK_LEVEL ? 'tag-amber' : 'tag-green';
      const stockLabel = isRec ? 'Record' : item.qty === 0 ? 'Out' : item.qty + ' pcs';
      const soldQty    = (salesByItem[item.id] || {}).qty || 0;
      const sellPrice  = item.sellPrice || item.sell || 0;
      const buyPrice   = item.buyPrice  || item.buy  || 0;

      const stockDot = isRec ? '#f59e0b' : item.qty === 0 ? 'var(--red)' : item.qty <= LOW_STOCK_LEVEL ? '#f59e0b' : 'var(--green)';
      cards.push(`
        <div class="item-card item-card-compact${isRec ? ' item-card-record' : (item.qty<=0?' shoe-out-card':'')}" onclick="openSheet(${item.id})">
          <div class="item-top">
            <div class="item-icon" style="background:${t.color||'var(--surface2)'};">${t.emoji}</div>
            <div class="item-body">
              <div class="ic-row1">
                <span class="ic-code">${escapeHtml(item.code)}${(item.variant||item.size)?' · '+escapeHtml(item.variant||item.size):''}</span>
                <span class="ic-name">${escapeHtml(item.name||'')}</span>
              </div>
              <div class="ic-row2">
                <span class="ic-type">${escapeHtml(item.type)}</span>
                ${isRec ? '<span class="ic-badge ic-badge-rec">RECORD</span>' : ''}
                <span class="ic-dot" style="background:${stockDot};"></span>
                <span class="ic-stock">${stockLabel}</span>
                ${soldQty > 0 ? '<span class="ic-sold">· ' + soldQty + ' sold</span>' : ''}
              </div>
            </div>
            <div class="item-right">
              <div class="ic-price">${fmt(sellPrice)}</div>
              ${buyPrice > 0 ? '<div class="ic-buy">Buy ' + fmt(buyPrice) + '</div>' : ''}
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
    } else if (!item.isRecord && (item.qty || 0) <= 0) {
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
  const sub = document.getElementById('stock-monitor-sub');
  if (!sub) return;
  const rows = await getStockMonitorRows();
  const outCount = rows.filter(r => r.kind === 'out').length;
  const wishCount = rows.filter(r => r.kind === 'prospective').length;
  sub.textContent = outCount + ' out of stock';
  const wishSub = document.getElementById('wishlist-sub');
  if (wishSub) wishSub.textContent = wishCount + ' prospective items';
}

function renderWishlistTypeOptions() {
  mountWishTypeCascade();
}

function renderOffstockTypeOptions() {
  mountOffTypeCascade();
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
      : 'openWishlistDetail(' + row.wishId + ')';
    const deleteBtn = row.kind !== 'out'
      ? '<button class="stock-monitor-action delete" onclick="event.stopPropagation();deleteWishlistItem(' + row.wishId + ')" title="Remove"><i class="fa-solid fa-trash"></i></button>'
      : '';
    return '<div class="stock-monitor-row ' + cls + '" onclick="' + restockAction + '" role="button" tabindex="0">' +
      '<div class="stock-monitor-body">' +
        '<div class="stock-monitor-name">' + escapeHtml(row.name) + '</div>' +
        '<div class="stock-monitor-meta">' +
          escapeHtml(row.code || 'No code') + (row.type ? ' - ' + escapeHtml(row.type) : '') +
          (row.qty ? ' - target ' + row.qty : '') +
          (row.buyPrice ? ' - ' + fmt(row.buyPrice) : '') +
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

function showWishlistSection(section) {
  const listPanel = document.getElementById('wishlist-list');
  const addPanel = document.getElementById('wishlist-add-panel');
  const tabList = document.getElementById('wish-tab-list');
  const tabAdd = document.getElementById('wish-tab-add');
  const isAdd = section === 'add';
  if (listPanel) listPanel.style.display = isAdd ? 'none' : 'block';
  if (addPanel) addPanel.style.display = isAdd ? 'block' : 'none';
  if (tabList) tabList.classList.toggle('active', !isAdd);
  if (tabAdd) tabAdd.classList.toggle('active', isAdd);
  if (isAdd) {
    toggleWishAddMore(false);
    setTimeout(() => document.getElementById('wish-name')?.focus(), 80);
  } else if (listPanel) {
    listPanel.scrollTop = 0;
  }
}
function toggleWishAddMore(forceOpen) {
  const panel = document.getElementById('wish-add-more');
  const btn = document.getElementById('wish-add-more-toggle');
  if (!panel || !btn) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : panel.hidden;
  panel.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.classList.toggle('is-open', open);
  const label = btn.querySelector('.wish-add-more-toggle-text');
  if (label) label.textContent = open ? 'Hide options' : 'More options';
}
window.toggleWishAddMore = toggleWishAddMore;

window.showWishlistSection = showWishlistSection;

async function renderWishlistPage() {
  renderWishlistTypeOptions();
  await renderStockMonitorSummary();
  const list = document.getElementById('wishlist-list');
  if (!list) return;
  const rows = filterStockRows(await getStockMonitorRows(), 'prospective');
  const wishSub = document.getElementById('wishlist-sub');
  if (wishSub) wishSub.textContent = rows.length ? rows.length + ' item' + (rows.length === 1 ? '' : 's') : 'Nothing yet';

  const toolbar = '<div class="wish-list-toolbar">' +
    '<button type="button" class="wish-fab-add" onclick="showWishlistSection(\'add\')"><i class="fa-solid fa-plus"></i> Add item</button>' +
    '</div>';

  if (!rows.length) {
    list.innerHTML = toolbar +
      '<div class="wish-empty">' +
        '<div class="wish-empty-icon">+</div>' +
        '<p class="wish-empty-title">No wishlist items</p>' +
        '<button type="button" class="wish-empty-btn" onclick="showWishlistSection(\'add\')">Add first item</button>' +
      '</div>';
    return;
  }

  const wishById = new Map();
  if (db.objectStoreNames.contains('wishlist')) {
    (await dbAll('wishlist')).forEach(w => wishById.set(w.id, w));
  }
  list.innerHTML = toolbar + '<div class="wish-card-list">' +
    rows.map(row => buildWishListCardHtml(row, wishById.get(row.wishId))).join('') +
    '</div>';
}

async function saveWishlistItem() {
  const name = Input.text('wish-name');
  const code = Input.text('wish-code').toUpperCase();
  const type = getCascadeCommittedValue('wish-type', { valueMode: 'name', requireLeaf: true });
  const qtyRaw = Input.int('wish-qty');
  const costRaw = Input.money('wish-cost');
  const note = Input.text('wish-note');
  const vendorName = Input.text('wish-vendor-name').trim();
  const vendorPriceRaw = Input.money('wish-vendor-price');
  if (!name) return Validate.fail('Enter item name', 'wish-name');
  if (!Validate.intOptional(qtyRaw, 'wish-qty', 'Quantity')) return;
  if (!Validate.moneyOptional(costRaw, 'wish-cost', 'Estimated cost')) return;
  if (vendorName && !Validate.moneyRequired(vendorPriceRaw, 'wish-vendor-price', 'Vendor price')) return;
  if (!vendorName && vendorPriceRaw > 0) return Validate.fail('Enter vendor name', 'wish-vendor-name');
  const qty = (qtyRaw === null || qtyRaw <= 0) ? 1 : qtyRaw;
  const estimatedCost = costRaw === null ? 0 : costRaw;
  const vendorQuotes = vendorName
    ? [{ id: 'vq_' + Date.now(), vendor: vendorName, price: vendorPriceRaw, updatedAt: new Date().toISOString() }]
    : [];
  const entry = {
    name,
    code,
    type,
    qty,
    estimatedCost,
    note,
    vendorQuotes,
    status: 'prospective',
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : 'system'
  };
  entry.id = await dbAdd('wishlist', entry);
  if (_wishFormPhotoData) await setWishPhoto(entry.id, _wishFormPhotoData);
  ['wish-name','wish-code','wish-qty','wish-cost','wish-note','wish-vendor-name','wish-vendor-price'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  clearWishPhotoForm();
  toggleWishAddMore(false);
  scheduleSync();
  showWishlistSection('list');
  await renderWishlistPage();
  await renderStockMonitorSummary();
  toast('Added to wishlist', 'ok');
}

async function deleteWishlistItem(id) {
  await removeWishPhoto(id);
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
  _wishStockingFromId = wishId;
  closeWishlistDetail();
  closeStockMonitor();
  clearForm();
  _wishStockingFromId = wishId;
  showPage('add');
  const photo = getWishPhoto(wishId);
  setTimeout(() => {
    if (wish.type) setAddFormType(wish.type);
    if (UI.el('f-code')) UI.el('f-code').value = wish.code || '';
    if (UI.el('f-name')) UI.el('f-name').value = wish.name || '';
    if (UI.el('f-qty')) UI.el('f-qty').value = wish.qty || 1;
    if (UI.el('f-buy')) UI.el('f-buy').value = wish.estimatedCost || '';
    if (photo) applyAddFormPhotoPreview(photo);
    else clearAddFormPhoto();
    setAddFormSubtitle('');
    setSaveBtnLabel('Save');
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
  const stockLbl = isOut ? 'Out of stock' : sizeRec.qty + ' pcs in stock';
  const groupLbl = sizeRec.sizeGroup === 'S' ? 'Children' : sizeRec.sizeGroup === 'M' ? 'Teens' : 'Adults';

  let sheet = document.getElementById('shoe-size-action-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'shoe-size-action-sheet';
    sheet.className = 'sheet-overlay';
    sheet.innerHTML = '<div class="sheet detail-sheet-unified" id="shoe-size-action-inner"></div>';
    sheet.addEventListener('click', e => { if (e.target === sheet) closeShoeSizeActions(); });
    document.body.appendChild(sheet);
  }

  const inner = document.getElementById('shoe-size-action-inner');
  inner.innerHTML = `
    <div class="sheet-handle"></div>
    <button type="button" class="detail-sheet-close" onclick="closeShoeSizeActions()" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>
    <div class="detail-sheet-hero">
      <div class="shoe-size-badge ${isOut ? 'out' : isLow ? 'low' : ''}" style="width:56px;height:56px;font-size:24px;">${size}</div>
      <div class="detail-sheet-hero-text">
        <div class="detail-sheet-title">${escapeHtml(item.name || item.code)}</div>
        <div class="detail-sheet-sub">${escapeHtml(item.code)} - Size ${size} - ${groupLbl}</div>
        <div class="detail-sheet-stock" style="color:${stockCol};">${stockLbl}</div>
      </div>
    </div>
    <div id="sh-price-cols" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin:0 12px 10px;">
      <div class="sh-stat-box"><div class="sh-stat-lbl">Buying</div><div class="sh-stat-val muted">${fmt(buy)}</div></div>
      <div class="sh-stat-box"><div class="sh-stat-lbl">Selling</div><div class="sh-stat-val accent2">${fmt(price)}</div></div>
      <div class="sh-stat-box accent-bg"><div class="sh-stat-lbl">Profit</div><div class="sh-stat-val ${profit > 0 ? 'green' : 'muted'}">${fmt(profit)}</div></div>
      <div class="sh-stat-box"><div class="sh-stat-lbl">Stock</div><div class="sh-stat-val accent">${sizeRec.qty} pcs</div></div>
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
      ${!isOut ? `<button type="button" class="detail-sell-btn" onclick="closeShoeSizeActions();closeSheet();openSellShoeModal(${item.id},${size})">SELL - Size ${size}</button>` :
        `<div class="detail-sell-muted">Out of stock - restock first</div>`}
    </div>
    <div style="padding:0 12px 16px;text-align:center;">
      <button type="button" class="detail-link-btn" onclick="closeShoeSizeActions();openShoeSizeEdit(${item.id},${size})">Edit prices</button>
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
    '<div class="sheet-title">Restock sizes</div>' +
    '<div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent);margin-bottom:12px;">' + sizes.join(', ') + '</div>' +
    '<input id="bulk-shoe-restock-qty" type="number" min="1" inputmode="numeric" placeholder="Qty to add to each size" ' +
      'style="width:100%;padding:13px 14px;border:1.5px solid var(--border);border-radius:var(--r);font-size:16px;font-weight:800;font-family:var(--mono);background:var(--bg);outline:none;margin-bottom:12px;">' +
    '<div class="detail-restock-actions">' +
      '<button onclick="confirmBulkShoeRestock()" class="detail-restock-confirm">RESTOCK</button>' +
      '<button onclick="closeBulkShoeRestock()" class="detail-restock-cancel">Cancel</button>' +
    '</div>';

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
        await setDoc(fbDoc('shoe_sizes', rec.fbId), sanitiseForFirestore({...rec }));
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
        toast('Warning: Select a size first from the detail sheet', 'err');
        setTimeout(() => openSheet(id), 150);
        return;
      }
      openSellShoeModal(id, _selectedShoeSize);
    } else {
      if (item.qty <= 0 && !item.isRecord) { toast('Warning: Out of stock', 'err'); return; }
      openSellModal(id);
    }
  }, 120);
}

function triggerSheetPhotoUpload(event) {
  event.stopPropagation();
  const itemId = currentDetailId;
  showImagePickerSheet({
    title: 'Item photo',
    photoPreset: 'item',
    onPick: async dataUrl => {
      await setItemPhoto(itemId, dataUrl);
      const photoImg = document.getElementById('sh-photo-img');
      const fallback = document.getElementById('sh-photo-fallback');
      const panWrap = document.getElementById('sh-photo-pan');
      const saved = getItemPhoto(itemId);
      if (photoImg && saved) { photoImg.src = saved; }
      if (panWrap) panWrap.style.display = 'block';
      if (fallback) fallback.style.display = 'none';
      if (typeof window._resetPhotoPan === 'function') {
        requestAnimationFrame(() => window._resetPhotoPan());
      }
      const btn = document.getElementById('sh-photo-btn');
      if (btn) btn.textContent = 'Photo';
      renderList();
      toast('Photo saved', 'ok');
    }
  });
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
  const panHint = document.getElementById('sh-photo-pan-hint');
  if (photo) {
    photoImg.src = photo;
    if (photoPan) { const panEl=document.getElementById('sh-photo-pan'); if(panEl) panEl.style.display='block'; }
    if (panHint) panHint.style.display = 'block';
    photoFallback.style.display = 'none';
  } else {
    if (photoPan) photoPan.style.display = 'none';
    if (panHint) panHint.style.display = 'none';
    photoFallback.style.display = 'flex';
    photoFallback.style.background = t.color || 'var(--surface2)';
  }
  if (typeof window._resetPhotoPan === 'function') {
    requestAnimationFrame(() => window._resetPhotoPan());
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('sh-photo-btn', photo ? 'Change photo' : 'Add photo');
  set('sh-icon', t.emoji);
  set('sh-name', item.name);
  set('sh-code', item.code + (item.size ? ' - ' + item.size : ''));
  set('sh-type', item.type);
  const tbadge = document.getElementById('sh-type-badge'); if (tbadge) tbadge.textContent = t.emoji + ' ' + item.type;
  set('sh-size', item.size || '-');
  set('sh-buy', fmt(item.buyPrice || item.buy || 0));
  set('sh-sell', fmt(item.sellPrice || item.sell || 0));
  set('sh-profit', fmt(item.profit));
  set('sh-qty', item.qty + ' pcs');
  set('sh-code-large', item.code + (item.size ? ' - ' + item.size : ''));

  // ── SHOE ITEMS - load fresh sizes, show size grid ─────────────
  const priceCols = document.getElementById('sh-price-cols');
  if (priceCols) priceCols.style.display = 'grid';
  const sizeSec   = document.getElementById('sh-shoe-sizes');
  const sizebar   = document.getElementById('sh-selected-size-bar');
  _selectedShoeSize = null; // reset selection
  _selectedShoeSizes = new Set();

  if (item.isShoe) {
    const freshSizes = await getShoeSizes(item.code);
    const totalQty   = freshSizes.reduce((t,s) => t+s.qty, 0);
    item.qty         = totalQty;
    // Show shoe buy/sell from defaults
    set('sh-buy',  fmt(item.buyPrice  || item.defaultBuy  || 0));
    set('sh-sell', fmt(item.sellPrice || item.defaultSell || 0));
    set('sh-qty',  totalQty + ' pcs');
    if (sizeSec) sizeSec.style.display = 'block';
    if (sizebar) { sizebar.style.display = 'none'; sizebar.textContent = ''; }
    await renderShoeDetailGrid(item);
  } else {
    set('sh-buy',  fmt(item.buyPrice  || item.buy  || 0));
    set('sh-sell', fmt(item.sellPrice || item.sell || 0));
    set('sh-qty',  item.qty + ' pcs');
    if (sizeSec) sizeSec.style.display = 'none';
    if (sizebar) sizebar.style.display = 'none';
  }

  // Out of stock
  const outBadge = document.getElementById('sh-out-badge');
  const sellBtn = document.getElementById('sh-sell-btn');
  if (item.qty <= 0 && !item.isShoe && !item.isRecord) {
    if (outBadge) outBadge.style.display = 'block';
    if (sellBtn) { sellBtn.disabled = true; sellBtn.style.opacity = '0.4'; sellBtn.style.cursor = 'not-allowed'; sellBtn.textContent = 'OUT OF STOCK'; }
  } else {
    if (outBadge) outBadge.style.display = 'none';
    if (sellBtn) { sellBtn.disabled = false; sellBtn.style.opacity = '1'; sellBtn.style.cursor = 'pointer'; sellBtn.textContent = item.isShoe ? 'SELECT SIZE & SELL' : 'SELL'; }
  }
  set('sh-total', fmt((item.buyPrice || item.buy || 0) * (item.qty || 0)));
  set('sh-sold', soldQty);
  set('sh-revenue', fmt(revenue));
  set('sh-profit-made', fmt(profitMade));

  document.getElementById('detail-sheet').classList.add('open');

  const restockPanel = document.getElementById('restock-panel');
  if (restockPanel) restockPanel.style.display = 'none';
  updateDetailRestockBtnLabel();

  const shSellBtn  = document.getElementById('sh-sell-btn');
  const delBtn     = document.querySelector('#detail-sheet .btn-del');
  const editBtn    = document.querySelector('#detail-sheet .btn-edit');
  const restockBtn = document.querySelector('#detail-sheet .detail-action-restock');
  const actionRow  = document.getElementById('sh-action-row');
  [shSellBtn, delBtn, editBtn].forEach(b => {
    if (b) { b.style.display = ''; b.style.opacity = '1'; b.style.pointerEvents = 'auto'; }
  });
  if (restockBtn) {
    const showRestock = !item.isShoe;
    restockBtn.style.display = showRestock ? '' : 'none';
    restockBtn.style.opacity = showRestock ? '1' : '0';
    restockBtn.style.pointerEvents = showRestock ? 'auto' : 'none';
  }
  if (actionRow) {
    actionRow.style.display = '';
    actionRow.style.justifyContent = item.isShoe ? 'flex-start' : 'space-between';
  }
  if (item.isShoe && restockPanel) restockPanel.style.display = 'none';
  const notice = document.getElementById('sh-day-notice');
  if (notice) notice.style.display = 'none';
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
  if (itemSales.length > 0) msg += '\n\nWarning: This item has ' + itemSales.length + ' sale record(s). The sales history will remain but the item cannot be restocked.';
  if (!confirm(msg)) return;
  if (toDelete.isShoe) {
    const sizes = await getShoeSizes(toDelete.code);
    for (const sz of sizes) {
      await dbDelete('shoe_sizes', sz.id);
      if (sz.fbId && fbReady && fbDb) {
        try {
          const { doc, deleteDoc } = await waitForFbImports();
          await deleteDoc(fbDoc('shoe_sizes', sz.fbId));
        } catch (_) { /* intentionally ignored */ }
      }
    }
  }
  await dbDelete('items', currentDetailId);
  await removeItemPhoto(currentDetailId);
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
    if (!size) { toast('Warning: Select a size first before editing', 'err'); setTimeout(()=>openSheet(item.id),100); return; }
    const sizes = await getShoeSizes(item.code);
    const sizeRec = sizes.find(s => s.size === size);
    if (!sizeRec) { toast('Size record not found', 'err'); return; }
    _editingItemId = null;  // shoe edits use shoe_edit_ prefix, not _editingItemId
    UI.el('edit-id').value = 'shoe_edit_' + item.id + '_' + size;
    setAddFormType(item.type || '', { skipTypeChange: true });
    UI.el('f-code').value  = item.code || '';
    UI.el('f-name').value  = item.name || '';
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = sizeRec.qty ?? '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || item.defaultBuy  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || item.defaultSell || '';
    showPage('add');
    ['f-code','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled=true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; }
    });
    setAddTypeLocked(true);
    const shoePanel  = UI.el('shoe-size-panel');
    const stdPricing = UI.el('std-pricing-section');
    const sizeField  = document.getElementById('f-size-field');
    if (shoePanel)  shoePanel.style.display  = 'none';
    if (stdPricing) stdPricing.style.display = 'block';
    if (sizeField)  sizeField.style.display  = 'block';
    setSaveBtnLabel('Save size ' + size);
    const _ml1 = UI.el('form-mode-label');
    if (_ml1) { _ml1.hidden = false; _ml1.textContent = 'Edit - ' + item.code + ' Size ' + size; }
    UI.el('cancel-edit-btn').style.display = 'block';
    _editOriginItemId = item.id;
    updateProfitPreview();
    return;
  }

  // ── STANDARD ITEM EDIT ────────────────────────────────────────
  _editingItemId = item.id;   // store reliably in JS variable
  showPage('add');
  UI.el('edit-id').value = item.id;
  setAddFormType(item.type || '', { skipTypeChange: true });
  UI.el('f-code').value  = item.code  || '';
  UI.el('f-name').value  = item.name  || '';
  UI.el('f-size').value  = item.variant || item.size || '';   // normalized field name
  UI.el('f-qty').value   = item.qty   ?? '';
  UI.el('f-buy').value   = item.buyPrice  || item.buy  || '';
  UI.el('f-sell').value  = item.sellPrice || item.sell || '';
  const _editSellMin = UI.el('f-sell-min');
  if (_editSellMin) _editSellMin.value = item.sellPriceMin || '';
  if (item.isRecord) setItemMode(true);
  // Lock code and type - identifying fields
  ['f-code'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled=true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; }
  });
  setAddTypeLocked(true);
  setSaveBtnLabel('Save changes');
  const _ml2 = UI.el('form-mode-label');
  if (_ml2) { _ml2.hidden = false; _ml2.textContent = 'Edit - ' + (item.name || item.code); }
  UI.el('cancel-edit-btn').style.display = 'block';
  _editOriginItemId = item.id;
  onTypeChange();
  updateProfitPreview();
  const existingPhoto = getItemPhoto(item.id);
  if (existingPhoto) applyAddFormPhotoPreview(existingPhoto);
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

function _dashPeriodLabel() {
  return { today: 'Today', week: 'This Week', month: 'This Month', all: 'All Time' }[_dashPeriod] || 'Period';
}

function _dashPrevDateRange() {
  const today = todayDateStr();
  if (_dashPeriod === 'today') {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const y = d.toISOString().split('T')[0];
    return { from: y, to: y };
  }
  if (_dashPeriod === 'week') {
    const end = new Date(); end.setDate(end.getDate() - 7);
    const start = new Date(end); start.setDate(start.getDate() - 6);
    return { from: start.toISOString().split('T')[0], to: end.toISOString().split('T')[0] };
  }
  if (_dashPeriod === 'month') {
    const d = new Date(); d.setDate(0);
    const lastDay = d.getDate();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(lastDay).padStart(2, '0')}` };
  }
  return { from: null, to: null };
}

function _filterSalesByRange(allSales, range) {
  if (!range || !range.from) return allSales;
  return allSales.filter(s => {
    const d = s.businessDate || s.business_date || (s.date || '').split('T')[0];
    return d >= range.from && d <= range.to;
  });
}

function _dashSumCard(icon, val, lbl, note, tone, navTarget) {
  const toneStyle = tone ? ` style="color:${tone};"` : '';
  const navAttr = navTarget
    ? ' class="dash-sum-card dash-sum-card-link" role="button" tabindex="0" onclick="goDashNav(\'' + navTarget + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();goDashNav(\'' + navTarget + '\');}"'
    : ' class="dash-sum-card"';
  return '<div' + navAttr + '>' +
    '<div class="dash-sum-card-icon">' + icon + '</div>' +
    '<div class="dash-sum-card-val"' + toneStyle + '>' + val + '</div>' +
    '<div class="dash-sum-card-lbl">' + lbl + '</div>' +
    (note ? '<div class="dash-sum-card-note">' + note + '</div>' : '') +
  '</div>';
}

function goDashNav(target) {
  if (target === 'stock') {
    showPage('inventory');
    showInventoryTab('stock');
    return;
  }
  if (target === 'wishlist') {
    showPage('inventory');
    showInventoryTab('wishlist');
    if (typeof showWishlistSection === 'function') showWishlistSection('list');
    return;
  }
  if (target === 'itemsSold') {
    const filterEl = document.getElementById('hist-period-filter');
    if (filterEl) filterEl.value = _dashPeriod;
    showPage('sell');
    showSalesTab('history');
  }
}
window.goDashNav = goDashNav;

async function _renderDashSummary(ctx) {
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const wrap = document.getElementById('d-summary-wrap');
  if (!wrap) return;

  const {
    allSales, totalItems,
    totalRevenue, totalProfitEarned, totalSalesCount, totalPiecesSold,
    outStk, lowStk, margin, today, todayDashSales, todayDashProf
  } = ctx;

  const periodLbl = _dashPeriodLabel();
  setEl('d-summary-period', periodLbl);
  setEl('d-summary-sub', new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }));

  let wishCount = 0;
  try {
    if (db.objectStoreNames.contains('wishlist')) {
      wishCount = (await dbAll('wishlist')).filter(w => w.status !== 'stocked').length;
    }
  } catch (_) { /* intentionally ignored */ }

  let money = null;
  try { money = await _computeFinanceMovement(); } catch (_) { /* intentionally ignored */ }

  const dayStatus = activeDay ? (activeDay.status || 'OPEN') : 'NONE';
  const dayOpen = dayStatus === 'OPEN';
  const dayLabel = !activeDay ? 'No day opened' : dayOpen ? 'Day open' : 'Day ' + dayStatus.toLowerCase();

  const prevRange = _dashPrevDateRange();
  const prevSales = _filterSalesByRange(allSales, prevRange);
  const prevRev = prevSales.reduce((s, x) => s + (x.revenue || 0), 0);
  let trendNote = '';
  if (_dashPeriod !== 'all' && prevRev > 0) {
    const chg = ((totalRevenue - prevRev) / prevRev * 100);
    trendNote = chg >= 0 ? '↑ ' + chg.toFixed(0) + '% vs prior period' : '↓ ' + Math.abs(chg).toFixed(0) + '% vs prior period';
  } else if (_dashPeriod !== 'all' && totalRevenue > 0 && prevRev === 0) {
    trendNote = 'Up from prior period';
  }

  const alertCount = outStk.length + lowStk.length;
  const headlineChips = [];
  if (totalItems === 0) {
    headlineChips.push({ icon: 'box-open', text: 'Add items to start tracking', tone: 'muted' });
  } else {
    if (dayOpen && _dashPeriod === 'today') {
      headlineChips.push({ icon: 'circle-dot', text: 'Day open', tone: 'open' });
    } else if (activeDay) {
      headlineChips.push({ icon: 'circle-pause', text: dayLabel, tone: 'muted' });
    }
    if (totalSalesCount > 0) {
      headlineChips.push({ icon: 'chart-line', text: fmtN(totalSalesCount) + ' sales · ' + fmt(totalRevenue), tone: 'sales' });
    }
    if (alertCount > 0) {
      headlineChips.push({ icon: 'triangle-exclamation', text: alertCount + ' stock alert' + (alertCount !== 1 ? 's' : ''), tone: 'warn' });
    } else if (totalItems > 0) {
      headlineChips.push({ icon: 'circle-check', text: 'Stock healthy', tone: 'ok' });
    }
  }
  const _headlineEl = document.getElementById('d-summary-headline');
  if (_headlineEl) {
    _headlineEl.innerHTML = headlineChips.map(c =>
      '<span class="dash-hchip dash-hchip-' + c.tone + '"><i class="fa-solid fa-' + c.icon + '"></i>' + c.text + '</span>'
    ).join('');
  }

  const cards = [];
  cards.push(_dashSumCard('', fmtN(totalPiecesSold), 'Items sold for this period', null, null, 'itemsSold'));
  cards.push(_dashSumCard('', fmt(totalRevenue), periodLbl + ' revenue', trendNote || (fmt(totalProfitEarned) + ' profit - ' + margin.toFixed(1) + '% margin'), totalProfitEarned >= 0 ? 'var(--green)' : 'var(--red)'));
  cards.push(_dashSumCard('', fmtN(totalSalesCount), 'Sales', totalSalesCount ? 'Avg ' + fmt(totalRevenue / totalSalesCount) + ' per sale' : 'No sales in period'));
  cards.push(_dashSumCard(
    dayOpen ? 'Open' : (activeDay ? 'Locked' : 'Paused'),
    dayOpen ? 'Open' : (activeDay ? activeDay.status : '-'),
    'Business day',
    _dashPeriod === 'today' && todayDashSales.length
      ? fmtN(todayDashSales.length) + ' sales - ' + fmt(todayDashProf) + ' profit today'
      : (money ? 'Pool ' + fmt(money.businessPool) : dayLabel)
  ));
  if (wishCount > 0) {
    cards.push(_dashSumCard(
      '',
      fmtN(wishCount),
      'Wishlist',
      wishCount + ' item' + (wishCount !== 1 ? 's' : '') + ' to stock - tap to open',
      'var(--accent)',
      'wishlist'
    ));
  }
  if (alertCount > 0) {
    cards.push(_dashSumCard(
      '',
      fmtN(alertCount) + ' alerts',
      'Needs attention',
      (outStk.length ? outStk.length + ' out - ' : '') + (lowStk.length ? lowStk.length + ' low' : ''),
      'var(--amber)',
      'stock'
    ));
  }
  if (money && (money.businessPool || money.salesProfit)) {
    cards.push(_dashSumCard('', fmt(money.businessPool), 'Business pool', 'Profit ' + fmt(money.salesProfit) + ' - cost out ' + fmt(money.salesCostOut), money.businessPool >= 0 ? 'var(--accent2)' : 'var(--red)'));
  }

  const cardsEl = document.getElementById('d-summary-cards');
  if (cardsEl) cardsEl.innerHTML = cards.slice(0, 6).join('');
}

async function renderDashboard() {
  const setEl = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
  const allItems = await dbAll('items');
  const allSales = await dbAll('sales');
  const range    = _dashDateRange();
  const today    = todayDateStr();

  const sales = _filterSalesByRange(allSales, range);

  const totalItems  = allItems.length;

  const totalRevenue      = sales.reduce((s,x) => s+(x.revenue||0), 0);
  const totalProfitEarned = sales.reduce((s,x) => s+(x.profit||0), 0);
  const totalPiecesSold   = sales.reduce((s,x) => s+(x.qty||0), 0);
  const totalSalesCount   = sales.length;
  const margin = totalRevenue > 0 ? (totalProfitEarned/totalRevenue*100) : 0;
  const avgSale = totalSalesCount > 0 ? totalRevenue/totalSalesCount : 0;

  const outStk = allItems.filter(i => i.qty === 0);
  const lowStk = allItems.filter(i => i.qty > 0 && i.qty <= LOW_STOCK_LEVEL);
  const todayDashSales = allSales.filter(s => (s.businessDate||(s.date||'').split('T')[0]) === today);
  const todayDashProf  = todayDashSales.reduce((s,x)=>s+(x.profit||0),0);

  await _renderDashSummary({
    allSales, totalItems,
    totalRevenue, totalProfitEarned, totalSalesCount, totalPiecesSold,
    outStk, lowStk, margin, today, todayDashSales, todayDashProf
  });

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
}

// renderSummary removed - content merged into renderDashboard
function renderSummary() { renderDashboard(); }

// ===== HEADER =====
function updateHeader() {
  // header simplified - no counts displayed
}

// ===== CURRENCY (fixed KES) =====
function updateCurrencyUI() {
  const bp = document.getElementById('bp-cur');
  if (bp) bp.textContent = currency;
  const sp = document.getElementById('sp-cur');
  if (sp) sp.textContent = currency;
  const buyEl = document.getElementById('f-buy');
  const sellEl = document.getElementById('f-sell');
  if (buyEl) buyEl.placeholder = 'Buy (' + currency + ') *';
  if (sellEl) sellEl.placeholder = 'Sell (' + currency + ') *';
  const shBuy = document.getElementById('shoe-shared-buy');
  const shSell = document.getElementById('shoe-shared-sell');
  if (shBuy) shBuy.placeholder = 'Buy (' + currency + ') *';
  if (shSell) shSell.placeholder = 'Sell (' + currency + ') *';
  const finAmt = document.getElementById('fin-amount');
  if (finAmt) finAmt.placeholder = 'Amount (' + currency + ') *';
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

async function _legacySearchSell() {
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
    results.innerHTML = '<div class="empty" style="padding:24px 0;"><div class="e-icon" style="font-size:36px;"><i class="fa-solid fa-magnifying-glass"></i></div><p>No items found</p></div>';
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
          <div class="item-code">${item.code}${item.size ? ' - ' + item.size : ''}</div>
          <div class="item-name">${item.name || ''}</div>
          <div class="item-tags">
            <span class="tag tag-cyan">${item.type}</span>
            <span class="tag" style="background:${outOfStock?'var(--red-light)':item.qty<=3?'var(--amber-light)':'var(--green-light)'};color:${stockColor};">
              ${outOfStock ? 'Out of stock' : item.qty + ' pcs'}
            </span>
          </div>
        </div>
        <div class="item-right">
          <div style="font-size:18px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(item.sell)}</div>
          <div style="font-size:11px;color:var(--green);font-family:var(--mono);margin-top:3px;">+${fmt(item.profit)} profit</div>
          ${!outOfStock ? '<div style="margin-top:8px;background:var(--accent);color:white;border-radius:8px;padding:5px 12px;font-size:12px;font-weight:700;text-align:center;">Sell</div>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  } catch(e) { console.error("[searchSell]", e); toast("Error: " + e.message, "err"); }
}

let _sellSearchTimer = null;

function onSellSearch(val) {
  const clearBtn = document.getElementById('sell-search-clear');
  if (clearBtn) clearBtn.style.display = val ? 'flex' : 'none';
  clearTimeout(_sellSearchTimer);
  _sellSearchTimer = setTimeout(() => searchSell(), 120);
}
window.onSellSearch = onSellSearch;

function clearSellSearch() {
  const inp = document.getElementById('sell-search');
  const btn = document.getElementById('sell-search-clear');
  if (inp) inp.value = '';
  if (btn) btn.style.display = 'none';
  searchSell();
}
window.clearSellSearch = clearSellSearch;

async function searchSell() {
  try {
    const raw = (document.getElementById('sell-search')?.value || '').trim();
    const q   = raw.toLowerCase();
    const results = document.getElementById('sell-results');
    if (!results) return;

    // Use global allItems (same source as dashboard + inventory)
    const items = allItems.length ? allItems : await dbAll('items');
    await enrichShoeItems(items);
    const sizes = await dbAll('shoe_sizes');

    const rows = [];

    items.forEach(item => {
      const score = q ? _gscScore(item, q) : 1;
      if (q && score === 0) return;

      const t = getTypeObj(item.type);

      if (item.isShoe) {
        sizes.filter(sz => sz.itemCode === item.code && (sz.qty || 0) > 0).forEach(sz => {
          // Also score against size number
          const szScore = q
            ? Math.max(score, String(sz.size).includes(q) ? 20 : 0)
            : 1;
          if (q && szScore === 0) return;
          const price  = sz.sellPrice || item.sellPrice || item.sell || 0;
          const buy    = sz.buyPrice  || item.buyPrice  || item.buy  || 0;
          rows.push({ item, t, score: szScore,
            label: item.name || item.code,
            meta:  item.code + ' · Size ' + sz.size,
            qty:   sz.qty || 0, price, profit: price - buy,
            isRec: false,
            action: `openSellShoeModal(${item.id},${sz.size})`,
            extraTag: `<span class="tag tag-gray">Sz ${escapeHtml(String(sz.size))}</span>` });
        });
        return;
      }

      // Standard + Record Only items
      const sellable = item.isRecord || (item.qty || 0) > 0;
      if (!sellable) return;

      const price  = item.sellPrice || item.sell || 0;
      const buy    = item.buyPrice  || item.buy  || 0;
      const meta   = item.code + ((item.variant || item.size) ? ' · ' + (item.variant || item.size) : '');
      rows.push({ item, t, score,
        label: item.name || item.code,
        meta,
        qty:   item.qty || 0, price, profit: price - buy,
        isRec: !!item.isRecord,
        action: `openSellModal(${item.id})`,
        extraTag: item.isRecord ? '<span class="tag tag-record">RECORD</span>' : '' });
    });

    // Sort: by score desc (with query) or alphabetically (no query)
    rows.sort((a, b) => q ? (b.score - a.score) : (a.label || '').localeCompare(b.label || ''));

    const offStockBtn = '<button onclick="openOffStockSale()" class="stock-add-wish-btn" ' +
      'style="margin-bottom:12px;background:#1d4ed8;">' +
      '<i class="fa-solid fa-plus"></i> Sell item not in stock</button>';

    if (!rows.length) {
      results.innerHTML = `<div class="empty" style="padding:24px 0;">
        <div class="e-icon"><i class="fa-solid fa-magnifying-glass"></i></div>
        <p>${q ? 'No items match "' + escapeHtml(raw) + '"' : 'No sellable items in stock.'}</p>
      </div>` + offStockBtn;
      return;
    }

    results.innerHTML = offStockBtn + rows.slice(0, 120).map(row => {
      const qty       = row.qty;
      const isRec     = row.isRec;
      const stockLbl  = isRec ? '∞' : qty + ' pcs';
      const stockCls  = isRec ? 'var(--amber)' : qty <= LOW_STOCK_LEVEL ? 'var(--amber)' : 'var(--green)';
      const bgCls     = isRec ? 'var(--amber-light,#fffbeb)' : qty <= LOW_STOCK_LEVEL ? 'var(--amber-light)' : 'var(--green-light)';
      const sellMin   = row.item.sellPriceMin || 0;
      const priceStr  = sellMin > 0 && sellMin < row.price
        ? fmt(sellMin) + ' – ' + fmt(row.price)
        : fmt(row.price);

      return `<div class="item-card${isRec ? ' item-card-record' : ''}" onclick="${row.action}"
          style="margin-bottom:8px;cursor:pointer;">
        <div class="item-top">
          <div class="item-icon" style="background:${row.t.color||'var(--surface2)'};">${row.t.emoji}</div>
          <div class="item-body">
            <div class="item-code">${escapeHtml(row.meta)}</div>
            <div class="item-name">${escapeHtml(row.label||'')}</div>
            <div class="item-tags">
              <span class="tag tag-cyan">${escapeHtml(row.item.type||'')}</span>
              ${row.extraTag}
              <span class="tag" style="background:${bgCls};color:${stockCls};">${stockLbl}</span>
            </div>
          </div>
          <div class="item-right">
            <div style="font-size:16px;font-weight:900;font-family:var(--mono);color:var(--accent2);">${priceStr}</div>
            <div style="font-size:11px;color:${row.profit>=0?'var(--green)':'var(--red)'};font-family:var(--mono);margin-top:3px;">
              ${row.profit>=0?'+':''}${fmt(row.profit)} profit
            </div>
            <div style="margin-top:8px;background:var(--accent);color:white;border-radius:8px;
              padding:5px 12px;font-size:12px;font-weight:700;text-align:center;">Sell</div>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch(e) { console.error('[searchSell]', e); toast('Error: ' + e.message, 'err'); }
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
  const name = Input.text('off-name');
  const code = sanitiseCode(Input.text('off-code'));
  const type = getCascadeCommittedValue('off-type', { valueMode: 'name', requireLeaf: true });
  const size = Input.text('off-size');
  const qty = Input.int('off-qty');
  const buyPrice = Input.money('off-buy');
  const sellPrice = Input.money('off-sell');
  const paymentMethod = 'cash';
  if (!name && !code) return Validate.fail('Enter item name or code', 'off-name');
  if (!type) {
    const wrap = document.getElementById('off-type-cascade');
    const pathIds = wrap ? _getCascadePathFromWrap(wrap) : [];
    const deepest = pathIds.length ? getTypeById(pathIds[pathIds.length - 1]) : null;
    if (deepest && _categoryHasActiveChildren(deepest.id)) {
      return Validate.fail('Pick a sub-category', 'off-type');
    }
    return Validate.fail('Select a category', 'off-type');
  }
  if (!Validate.restockQty(qty, 'off-qty')) return;
  if (!Validate.moneyOptional(buyPrice, 'off-buy', 'Buy price')) return;
  if (!Validate.moneyRequired(sellPrice, 'off-sell', 'Sale price')) return;
  const buy = buyPrice === null ? 0 : buyPrice;
  if (buy > 0 && sellPrice < buy && !confirm('Sale price is below buy price. Record anyway?')) return;

  const revenue = qty * sellPrice;
  const profit = qty * (sellPrice - buy);
  const sale = {
    itemId: null,
    itemCode: code,
    itemName: name || code,
    itemType: type,
    itemSize: size,
    qty,
    buyPrice: buy,
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

  ['off-name','off-code','off-size','off-qty','off-buy','off-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const offType = document.getElementById('off-type');
  if (offType) offType.value = '';
  renderOffstockTypeOptions();
  closeOffStockSale();
  await renderStockMonitor();
  await refreshSalesViews();
  try { renderDashboard(); } catch(_) { /* intentionally ignored */ }
  try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
  scheduleSync();
  toast('Sale recorded - monitor marked NOT ACCOUNTED', 'ok');
}

// Shows the "enter buy price" field only when the item/size has no cost on record yet.
function _toggleSmBuyField(currentBuy) {
  const field = document.getElementById('sm-buy-field');
  const input = document.getElementById('sm-buy');
  if (input) input.value = '';
  if (field) field.style.display = (currentBuy > 0) ? 'none' : '';
}

async function openSellModal(itemId) {
  try {
  const item = await dbGet('items', itemId);
  if (!item) { toast('Warning: Item not found', 'err'); return; }
  if (item.qty <= 0 && !item.isRecord) {
    toast('Warning: ' + (item.name || item.code) + ' is out of stock - restock first', 'err');
    return;
  }
  currentSellItemId = itemId;
  const t = getTypeObj(item.type);
  document.getElementById('sm-icon').textContent = t.emoji;
  document.getElementById('sm-icon').style.background = t.color || 'var(--surface2)';
  document.getElementById('sm-name').textContent = item.name;
  document.getElementById('sm-meta').textContent = item.code + (item.size ? ' - ' + item.size : '') + (item.isRecord ? ' · Record' : '');
  document.getElementById('sm-stock').textContent = item.isRecord ? '∞' : item.qty;
  const _itemSell = item.sellPrice || item.sell || 0;
  const _itemBuy  = item.buyPrice  || item.buy  || 0;
  const _itemSellMin = item.sellPriceMin || 0;
  document.getElementById('sm-sell').textContent = fmt(_itemSell);
  const _smPriceRange = document.getElementById('sm-price-range');
  const _smMinVal     = document.getElementById('sm-price-min-val');
  if (_smPriceRange) {
    if (_itemSellMin > 0 && _itemSellMin < _itemSell) {
      if (_smMinVal) _smMinVal.textContent = fmt(_itemSellMin);
      _smPriceRange.style.display = 'block';
    } else {
      _smPriceRange.style.display = 'none';
    }
  }
  const _maxProfit = _itemSell - _itemBuy;
  const _minProfit = _itemSellMin > 0 ? _itemSellMin - _itemBuy : _maxProfit;
  const _smProfit = document.getElementById('sm-profit');
  if (_smProfit) {
    _smProfit.textContent = _itemSellMin > 0 && _itemSellMin < _itemSell
      ? ('+' + fmt(_minProfit) + ' – +' + fmt(_maxProfit))
      : ((_maxProfit >= 0 ? '+' : '') + fmt(_maxProfit));
  }
  const _smProfitRange = document.getElementById('sm-profit-range');
  if (_smProfitRange) _smProfitRange.style.display = 'none';
  const _tpel=document.getElementById('sm-total-profit'); if(_tpel) _tpel.textContent = (_maxProfit >= 0 ? '+' : '') + fmt(_maxProfit);
  document.getElementById('sm-cur').textContent = currency;
  document.getElementById('sm-qty').value = 0;
  document.getElementById('sm-qty').min = 0;
  document.getElementById('sm-qty').max = item.isRecord ? 999999 : item.qty;
  document.getElementById('sm-actual').value = '';
  _toggleSmBuyField(_itemBuy);
  updateSellModal();
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
  const buyOnRecord = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.buyPrice  || item.buyPrice  || item.buy  || 0) : (item.buy  || item.buyPrice  || 0);
  const buyRaw    = parseFloat(document.getElementById('sm-buy')?.value);
  const baseBuy   = (!isNaN(buyRaw) && buyRaw >= 0) ? buyRaw : buyOnRecord;
  const maxStock  = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.qty || 0)
               : item.isRecord ? 999999
               : (item.qty || 0);
  const qtyEl = document.getElementById('sm-qty');
  let qty = parseInt(qtyEl?.value || '0');
  if (!Number.isFinite(qty) || qty < 0) qty = 0;
  if (qty > maxStock) {
    qty = maxStock;
    toast('Only ' + maxStock + ' in stock', 'err');
  }
  if (qtyEl) {
    qtyEl.min = 0;
    qtyEl.max = maxStock;
    if (String(qtyEl.value) !== String(qty)) qtyEl.value = qty;
  }
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
  // ── Min-price floor warning ────────────────────────────────────
  const sellMin = (_isShoeSale && _sellShoeSize ? (_sellShoeSize.sellPriceMin||0) : (item.sellPriceMin||0));
  const minWarn = document.getElementById('sm-min-warn');
  const belowMin = sellMin > 0 && priceUsed > 0 && priceUsed < sellMin;
  if (minWarn) minWarn.style.display = belowMin ? 'block' : 'none';

  const confirmBtn = document.getElementById('confirm-sale-btn');
  if (confirmBtn) {
    confirmBtn.textContent = belowMin ? '⚠ CONFIRM BELOW MIN' : 'CONFIRM SALE';
    confirmBtn.style.background = belowMin ? '#d97706' : '#1e7a3e';
    confirmBtn.title = priceUsed < baseBuy && priceUsed > 0 ? 'Warning: selling below cost price' : '';
  }
  } catch(e) { console.error("[updateSellModal]", e); toast("Error: " + e.message, "err"); }
}

function adjSellQty(d) {
  const inp = document.getElementById('sm-qty');
  let v = (parseInt(inp.value) || 0) + d;
  const max = parseInt(inp.max) || 9999;
  if (v > max) { toast('Warning: Only ' + max + ' in stock', 'err'); v = max; }
  inp.value = Math.max(0, v);
  updateSellModal();
}

async function confirmSale() {
  if (!currentSellItemId) return;

  // Gray out confirm button + show progress overlay
  const _confirmBtn = document.getElementById('confirm-sale-btn');
  _overlay.show('Processing Sale...', _confirmBtn);

  try {

  const item = await dbGet('items', currentSellItemId);
  if (!item) { toast('Item not found', 'err'); closeSellModal(); _overlay.hide(); return; }

  // ── Read form values ───────────────────────────────────────────
  const qtyEl     = document.getElementById('sm-qty');
  const actualEl  = document.getElementById('sm-actual');
  const buyEl     = document.getElementById('sm-buy');
  const qty       = parseInt(qtyEl?.value || '0');
  const actualRaw = parseFloat(actualEl?.value || '');
  const buyEntered = parseFloat(buyEl?.value || '');

  // ── Prices - use normalized sellPrice/buyPrice ─────────────────
  const sellPrice = _isShoeSale && _sellShoeSize
    ? (_sellShoeSize.sellPrice || item.sellPrice || item.sell || 0)
    : (item.sellPrice || item.sell || 0);
  const buyOnRecord = _isShoeSale && _sellShoeSize
    ? (_sellShoeSize.buyPrice  || item.buyPrice  || item.buy  || 0)
    : (item.buyPrice  || item.buy  || 0);
  // If there was no buy price on record, use whatever the user entered at sell time and save it.
  const buyPriceEntered = buyOnRecord <= 0 && !isNaN(buyEntered) && buyEntered >= 0;
  const buyPrice = buyPriceEntered ? buyEntered : buyOnRecord;

  const priceUsed = (!isNaN(actualRaw) && actualRaw > 0) ? actualRaw : sellPrice;

  // ── Validate stock ─────────────────────────────────────────────
  const maxQty = _isShoeSale && _sellShoeSize ? _sellShoeSize.qty : item.qty;
  const itemLabel = item.name || item.code;
  if (!Number.isFinite(qty) || qty <= 0) {
    Validate.fail('Enter quantity to sell', 'sm-qty');
    _overlay.hide();
    return;
  }
  if (!item.isRecord) {
    if (qty > maxQty) {
      Validate.fail('Only ' + maxQty + ' in stock - cannot sell ' + qty, 'sm-qty');
      _overlay.hide();
      return;
    }
    if (!Validate.stock(qty, maxQty, itemLabel)) { _overlay.hide(); return; }
  }

  // ── Validate sale price ────────────────────────────────────────
  if (!Validate.salePrice(priceUsed, buyPrice, sellPrice)) { _overlay.hide(); return; }
  const _sellMin = (_isShoeSale && _sellShoeSize ? (_sellShoeSize.sellPriceMin || 0) : (item.sellPriceMin || 0));
  if (_sellMin > 0 && priceUsed < _sellMin) {
    const go = confirm(
      'Price ' + fmt(priceUsed) + ' is below minimum ' + fmt(_sellMin) + '.\nSell anyway?'
    );
    if (!go) { _overlay.hide(); return; }
  }

  const revenue = qty * priceUsed;
  const profit  = qty * (priceUsed - buyPrice);

  const paymentMethod = 'cash';

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

  // ── Persist a newly-entered buy price so future sales use it ────
  if (buyPriceEntered) {
    if (_isShoeSale && _sellShoeSize) {
      _sellShoeSize.buyPrice = buyPrice;
      _sellShoeSize.profit   = sellPrice - buyPrice;
    } else {
      item.buyPrice = buyPrice;
      item.profit   = sellPrice - buyPrice;
    }
  }

  // ── Deduct stock (skip for record-only items) ─────────────────
  if (!item.isRecord) {
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
          await setDoc(fbDoc('shoe_sizes', _sellShoeSize.fbId), sanitiseForFirestore({..._sellShoeSize}));
        } catch(e) { console.warn('[SYNC] shoe size:', e.message); }
      }
    } else {
      item.qty = Math.max(0, item.qty - qty);
    }
  }
  await dbPut('items', item);

  // ── Record sale ────────────────────────────────────────────────
  // Pre-assign fbId so IndexedDB stores it immediately
  sale.fbId = stableSaleFbId(sale);
  const newSaleId = await dbAdd('sales', sale);
  sale.id = newSaleId;
  fbSyncItem(item);
  fbSyncSale(sale);

  // Sales are the source of truth for revenue - no duplicate finance row.

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
  try { await refreshSalesViews(); } catch(_) { /* intentionally ignored */ }
  try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
  // Refresh finance page if it's currently visible
  try {
    const financeVisible = document.getElementById('page-finance')?.classList.contains('active') ||
      (document.getElementById('page-operations')?.classList.contains('active') && _activeOperationsTab === 'finance');
    if (financeVisible) {
      renderFinancePage();
    }
  } catch(_) { /* intentionally ignored */ }

  toast('' + fmt(revenue) + ' - Profit: ' + fmt(profit), 'ok');

  } catch(err) {
    console.error('[confirmSale]', err);
    toast('Warning: Sale failed: ' + (err.message || 'Unknown error'), 'err');
  } finally {
    _overlay.hide();
  }
}

async function renderSellPage() {
  try {
    await searchSell();
  } catch(e) { console.error("[renderSellPage]", e); toast("Error: " + e.message, "err"); }
}

async function refreshSalesViews() {
  try { await renderSellPage(); } catch(_) { /* intentionally ignored */ }
  try { await renderHistoryPage(); } catch(_) { /* intentionally ignored */ }
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
// FULL SCHEMA REBUILD - clears the LOCAL database only and recreates
// it clean. Cloud data (Firebase) is left untouched on purpose, so a
// corrupted local database can always be recovered afterward with
// "Pull cloud to local" in Settings. Only accessible to Super User.
// ═══════════════════════════════════════════════════════════════
async function resetAndRebuildDB() {
  const msg =
    'FULL SCHEMA REBUILD\n\n' +
    'This will:\n' +
    '• Delete ALL local items, sales, finances, shoe sizes\n' +
    '• Delete ALL local business day records\n' +
    '• Recreate the local database schema clean (v' + DB_VER + ')\n\n' +
    'Cloud data is NOT touched - if this environment syncs to Firebase, ' +
    'use "Pull cloud to local" afterward to restore your data.\n\n' +
    'Your login and preferences are kept.\n' +
    'This CANNOT be undone. Type RESET to confirm:';

  const input = prompt(msg);
  if (input !== 'RESET') { toast('Reset cancelled', ''); return; }

  try {
    toast('Rebuilding database...', '');

    // 1. Clear all local IndexedDB data stores (cloud data is untouched)
    await DB.clearAll([
      STORES.ITEMS, STORES.SALES, STORES.SIZES,
      STORES.FINANCES, STORES.BDAYS, STORES.TYPES, STORES.WISHLIST,
    ]);
    console.log('[DB] All local stores cleared');

    // 2. Reset in-memory state
    allItems  = [];
    activeDay = null;
    types     = [];

    // 3. Clear relevant localStorage keys (keep session + prefs)
    const keep = {
      [KEY_SESSION]:      localStorage.getItem(KEY_SESSION),
      [KEY_FIREBASE_ENV]: localStorage.getItem(KEY_FIREBASE_ENV),
      [KEY_SHOE_GROUPS]:  localStorage.getItem(KEY_SHOE_GROUPS),
    };
    localStorage.clear();
    Object.entries(keep).forEach(([k, v]) => v && localStorage.setItem(k, v));
    _clearAllDayReconKeys();

    // 4. Reload default types and re-render
    await loadTypes();
    renderList();
    renderDashboard();
    updateHeader();
    try { updateLowStockBadge(); } catch(_) { /* intentionally ignored */ }

    toast('Database rebuilt clean - fresh start!', 'ok');
    console.log('[DB] Rebuild complete v' + DB_VER);

  } catch(e) {
    toast('Error: Rebuild failed: ' + e.message, 'err');
    console.error('[DB]', e);
  }
}
window.resetAndRebuildDB = resetAndRebuildDB;

// ═══════════════════════════════════════════════════════════════════
// DEVELOPMENT SEED DATA
// Realistic dummy items/sales/wishlist/finance records used ONLY to
// populate the Development environment's own database. Never runs
// against production - see the guards in rebuildDevDatabaseWithSeed().
// ═══════════════════════════════════════════════════════════════════
const DEV_SEED_STANDARD_ITEMS = [
  // Clothes
  { type: 'Clothes',     code: 'CL-001', name: "Men's Polo Shirt - Blue",         buy: 450,  sell: 800,  qty: 22 },
  { type: 'Clothes',     code: 'CL-002', name: 'Ladies Maxi Dress - Floral',      buy: 700,  sell: 1300, qty: 8  },
  { type: 'Clothes',     code: 'CL-003', name: 'Kids Hoodie - Grey',              buy: 500,  sell: 950,  qty: 0  },
  { type: 'Clothes',     code: 'CL-004', name: 'Denim Jeans - Slim Fit',          buy: 900,  sell: 1600, qty: 15 },
  // Plastics
  { type: 'Plastics',    code: 'PL-001', name: '20L Water Bucket',                buy: 250,  sell: 400,  qty: 40 },
  { type: 'Plastics',    code: 'PL-002', name: 'Plastic Chair - White',           buy: 550,  sell: 900,  qty: 12 },
  { type: 'Plastics',    code: 'PL-003', name: 'Storage Basin - Large',           buy: 300,  sell: 550,  qty: 1  },
  { type: 'Plastics',    code: 'PL-004', name: 'Laundry Basket',                  buy: 200,  sell: 380,  qty: 18 },
  // Gas
  { type: 'Gas',         code: 'GA-001', name: '13kg Gas Cylinder Refill',        buy: 2200, sell: 2850, qty: 6  },
  { type: 'Gas',         code: 'GA-002', name: '6kg Gas Cylinder Refill',         buy: 1100, sell: 1500, qty: 9  },
  { type: 'Gas',         code: 'GA-003', name: 'Gas Regulator - Standard',        buy: 600,  sell: 1000, qty: 0  },
  { type: 'Gas',         code: 'GA-004', name: 'Gas Hose Pipe 2m',                buy: 250,  sell: 450,  qty: 14 },
  // Electronics
  { type: 'Electronics', code: 'EL-001', name: 'LED Bulb 9W',                     buy: 90,   sell: 180,  qty: 60 },
  { type: 'Electronics', code: 'EL-002', name: 'Extension Cable 4-Way',           buy: 350,  sell: 650,  qty: 10 },
  { type: 'Electronics', code: 'EL-003', name: 'Phone Charger - Type C',          buy: 300,  sell: 600,  qty: 1  },
  { type: 'Electronics', code: 'EL-004', name: 'Bluetooth Speaker - Mini',        buy: 900,  sell: 1600, qty: 5  },
  // Food
  { type: 'Food',        code: 'FD-001', name: 'Maize Flour 2kg',                 buy: 140,  sell: 175,  qty: 50 },
  { type: 'Food',        code: 'FD-002', name: 'Cooking Oil 1L',                  buy: 260,  sell: 320,  qty: 30 },
  { type: 'Food',        code: 'FD-003', name: 'Sugar 1kg',                       buy: 130,  sell: 160,  qty: 0  },
  { type: 'Food',        code: 'FD-004', name: 'Rice 2kg - Pishori',              buy: 280,  sell: 350,  qty: 25 },
  // Cosmetics
  { type: 'Cosmetics',   code: 'CO-001', name: 'Vaseline Petroleum Jelly 100ml',  buy: 120,  sell: 220,  qty: 20 },
  { type: 'Cosmetics',   code: 'CO-002', name: 'Body Lotion 400ml',               buy: 180,  sell: 320,  qty: 16 },
  { type: 'Cosmetics',   code: 'CO-003', name: 'Bar Soap - 800g',                 buy: 80,   sell: 150,  qty: 1  },
  { type: 'Cosmetics',   code: 'CO-004', name: 'Hair Relaxer Kit',                buy: 250,  sell: 450,  qty: 9  },
  // General
  { type: 'General',     code: 'GE-001', name: 'Padlock - Medium',                buy: 150,  sell: 280,  qty: 24 },
  { type: 'General',     code: 'GE-002', name: 'Umbrella - Black',                buy: 300,  sell: 550,  qty: 11 },
  { type: 'General',     code: 'GE-003', name: 'Torch - Rechargeable',            buy: 400,  sell: 750,  qty: 0  },
  { type: 'General',     code: 'GE-004', name: 'Broom - Nylon',                   buy: 100,  sell: 200,  qty: 33 },
];

const DEV_SEED_SHOE_ITEMS = [
  { code: 'SH-001', name: 'School Shoes - Black',  buy: 800,  sell: 1400, sizes: [{ size:'32', group:'M', qty:6 }, { size:'34', group:'M', qty:4 }, { size:'36', group:'M', qty:0 }] },
  { code: 'SH-002', name: 'Nike Air Max Sneaker',   buy: 2500, sell: 4200, sizes: [{ size:'40', group:'L', qty:3 }, { size:'42', group:'L', qty:5 }, { size:'44', group:'L', qty:2 }] },
  { code: 'SH-003', name: 'Ladies Sandals - Tan',   buy: 600,  sell: 1100, sizes: [{ size:'37', group:'L', qty:7 }, { size:'38', group:'L', qty:1 }, { size:'39', group:'L', qty:0 }] },
  { code: 'SH-004', name: "Men's Official Shoes",   buy: 1800, sell: 3200, sizes: [{ size:'41', group:'L', qty:4 }, { size:'42', group:'L', qty:6 }, { size:'43', group:'L', qty:3 }] },
];

// Local (not UTC) YYYY-MM-DD, matching todayDateStr()'s convention - avoids
// the day drifting by the local UTC offset when building past seed dates.
function _seedLocalDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

async function seedDevDatabase() {
  const now = new Date();
  const soldItems = []; // flattened sellable lines: standard items + each shoe size

  // ── Standard items ──────────────────────────────────────────────
  for (const s of DEV_SEED_STANDARD_ITEMS) {
    const profit = s.sell - s.buy;
    const id = await dbAdd('items', {
      type: s.type, code: s.code, name: s.name, variant: '',
      buyPrice: s.buy, sellPrice: s.sell, profit,
      qty: s.qty, createdAt: now.toISOString(),
    });
    soldItems.push({ id, code: s.code, name: s.name, type: s.type, buyPrice: s.buy, sellPrice: s.sell, size: '' });
  }

  // ── Footwear items + per-size stock ─────────────────────────────
  for (const s of DEV_SEED_SHOE_ITEMS) {
    const totalQty = s.sizes.reduce((t, sz) => t + sz.qty, 0);
    const pid = await dbAdd('items', {
      code: s.code, name: s.name, type: 'Footwear', category: 'Footwear', isShoe: true,
      buyPrice: s.buy, sellPrice: s.sell, profit: s.sell - s.buy,
      qty: totalQty, createdAt: now.toISOString(),
    });
    for (const sz of s.sizes) {
      await dbAdd('shoe_sizes', {
        itemCode: s.code, itemId: pid, size: sz.size, sizeGroup: sz.group,
        qty: sz.qty, buyPrice: s.buy, sellPrice: s.sell, profit: s.sell - s.buy,
        codeSize: s.code + '_' + sz.size,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
      });
      soldItems.push({ id: pid, code: s.code, name: s.name + ' (Size ' + sz.size + ')', type: 'Footwear', buyPrice: s.buy, sellPrice: s.sell, size: sz.size });
    }
  }

  // ── Sales history - last 21 days, varied volume, occasional price overrides ──
  const paymentCycle = ['cash', 'cash', 'cash', 'mpesa'];
  let saleSeq = 0;
  for (let dayOffset = 20; dayOffset >= 0; dayOffset--) {
    const d = new Date(now); d.setDate(d.getDate() - dayOffset);
    const businessDate = _seedLocalDateStr(d);
    const dow = d.getDay();
    let salesToday = (dow === 0 || dow === 6) ? 6 : 3; // busier on weekends
    if (dayOffset === 10) salesToday = 0;              // one quiet/no-sale day for realism

    for (let i = 0; i < salesToday; i++) {
      const pick = soldItems[(saleSeq * 7 + i * 3) % soldItems.length];
      const qty = 1 + (saleSeq % 3);
      const overridden = saleSeq % 5 === 0;
      const actualPrice = overridden
        ? Math.max(pick.buyPrice, pick.sellPrice - Math.round(pick.sellPrice * 0.1))
        : pick.sellPrice;
      const revenue = qty * actualPrice;
      const profit  = qty * (actualPrice - pick.buyPrice);
      const saleTime = new Date(d);
      saleTime.setHours(9 + (i % 9), (i * 17) % 60, 0, 0);

      await dbAdd('sales', {
        itemId: pick.id, itemCode: pick.code, itemName: pick.name, itemType: pick.type,
        itemSize: pick.size || '', qty, buyPrice: pick.buyPrice, sellPrice: pick.sellPrice,
        actualPrice, revenue, profit, overridden,
        paymentMethod: paymentCycle[saleSeq % paymentCycle.length],
        soldBy: 'system', businessDate, date: saleTime.toISOString(),
      });
      saleSeq++;
    }
  }

  // ── Wishlist entries ─────────────────────────────────────────────
  const wishSeed = [
    { name: 'Solar Lamp - Rechargeable', type: 'Electronics', qty: 10, cost: 900,  note: 'Customers keep asking for these' },
    { name: 'School Bag - Junior',       type: 'General',     qty: 15, cost: 600,  note: '' },
    { name: 'Motorcycle Helmet',         type: 'General',     qty: 5,  cost: 2200, note: 'Check with boda riders on preferred brand' },
  ];
  for (const w of wishSeed) {
    await dbAdd('wishlist', {
      name: w.name, code: '', type: w.type, qty: w.qty, estimatedCost: w.cost,
      note: w.note, vendorQuotes: [], status: 'prospective',
      createdAt: now.toISOString(), createdBy: 'system',
    });
  }

  // ── Finance entries ──────────────────────────────────────────────
  const financeSeed = [
    { type: 'injection',  amount: 50000, description: 'Owner capital injection', daysAgo: 20 },
    { type: 'expense',    amount: 3500,  description: 'Shop rent contribution',  daysAgo: 15 },
    { type: 'expense',    amount: 1200,  description: 'Transport for restock',   daysAgo: 9  },
    { type: 'withdrawal', amount: 5000,  description: 'Owner withdrawal',        daysAgo: 4  },
  ];
  for (const f of financeSeed) {
    const d = new Date(now); d.setDate(d.getDate() - f.daysAgo);
    const cat = f.type === 'injection' ? 'owner_capital' : f.type === 'withdrawal' ? 'cash_drawer' : 'general';
    await dbAdd('finances', {
      type: f.type, amount: f.amount, description: f.description, category: cat,
      date: _seedLocalDateStr(d), createdAt: d.toISOString(), createdBy: 'system',
    });
  }
}

// ── Rebuild the Development database with fresh sample data ─────────
// Hard-guarded: refuses to run unless the app is actually in the
// Development environment AND the currently-open database is the
// dev-suffixed one - a rebuild here can never reach production data.
async function rebuildDevDatabaseWithSeed() {
  if (getFirebaseEnv() !== 'development' || !DB_NAME.endsWith('_dev')) {
    toast('Error: Rebuild with sample data is only available in Development mode', 'err');
    return;
  }

  const input = prompt(
    'REBUILD DEVELOPMENT DATABASE\n\n' +
    'This wipes the local development database (' + DB_NAME + ') only and replaces it with ' +
    'a fresh set of realistic sample data - items (incl. footwear sizes), 3 weeks of sales ' +
    'history, wishlist entries, and finance records.\n\n' +
    'Your production data lives in a separate database and is never touched by this.\n\n' +
    'Type SEED to confirm:'
  );
  if (input !== 'SEED') { toast('Rebuild cancelled', ''); return; }

  try {
    toast('Rebuilding development database...', '');

    await DB.clearAll([
      STORES.ITEMS, STORES.SALES, STORES.SIZES,
      STORES.FINANCES, STORES.BDAYS, STORES.TYPES, STORES.WISHLIST,
    ]);

    allItems  = [];
    activeDay = null;
    types     = [];

    await loadTypes();
    await seedDevDatabase();
    await loadActiveDay();

    allItems = await dbAll('items');
    await enrichShoeItems(allItems);
    renderList();
    renderDashboard();
    updateHeader();
    try { updateLowStockBadge(); } catch(_) { /* intentionally ignored */ }

    toast('Development database rebuilt with sample data!', 'ok');
    console.log('[DEV SEED] Rebuild complete on ' + DB_NAME);
  } catch(e) {
    toast('Error: Rebuild failed: ' + e.message, 'err');
    console.error('[DEV SEED]', e);
  }
}
window.rebuildDevDatabaseWithSeed = rebuildDevDatabaseWithSeed;

async function resetAllData() {
  const confirmed = confirm(
    'RESET ALL DATA\n\n' +
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
    toast('Clearing database...', '');

    // ── 1. Clear IndexedDB using store.clear() ────────────────────
    // This is atomic and reliable - clears entire store in one op
    const stores = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes', 'finances', 'wishlist', 'photos'];
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
        for (const col of ['items', 'sales', 'business_days', 'shoe_sizes', 'finances', 'wishlist']) {
          const snap = await getDocs(fbCol(col));
          if (!snap.empty) {
            // Use batched deletes (max 500 per batch)
            let batch = writeBatch(fbDb);
            let count = 0;
            for (const d of snap.docs) {
              batch.delete(fbDoc(col, d.id));
              count++;
              if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
            }
            if (count > 0) await batch.commit();
          }
        }
        console.log('[RESET] Firebase cleared');
      } catch(e) {
        console.warn('[RESET] Firebase partial:', e.message);
        toast('Warning: Firebase may not be fully cleared: ' + e.message, 'err');
      }
    }

    // ── 3. Reset in-memory state ──────────────────────────────────
    allItems = [];
    activeDay = null;
    clearAllPhotoCache();

    // ── 4. Reset localStorage (keep session + preferences) ───────
    const keep = {
      [KEY_SESSION]:      localStorage.getItem(KEY_SESSION),
      [KEY_FIREBASE_ENV]: localStorage.getItem(KEY_FIREBASE_ENV),
      [KEY_SHOE_GROUPS]:  localStorage.getItem(KEY_SHOE_GROUPS),
    };
    localStorage.clear();
    Object.entries(keep).forEach(([k,v]) => { if (v) localStorage.setItem(k, v); });
    _clearAllDayReconKeys();

    // ── 5. Reload default types + refresh UI ─────────────────────
    await loadTypes();
    renderList();
    renderDashboard();
    updateHeader();
    try { renderSellPage(); } catch(e) {}
    try { updateLowStockBadge(); } catch(e) {}

    toast('All data cleared - fresh start!', 'ok');
    console.log('[RESET] Complete');

  } catch(e) {
    toast('Error: Reset failed: ' + e.message, 'err');
    console.error('[RESET] Error:', e);
  }
}

const _DATA_STORES = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes', 'finances', 'wishlist', 'photos'];
const _FB_COLLECTIONS = ['items', 'sales', 'business_days', 'shoe_sizes', 'finances', 'wishlist', 'customers', 'customer_txns'];

function _clearAllDayReconKeys() {
  const remove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('mgs_recon_')) remove.push(k);
  }
  remove.forEach(k => { try { localStorage.removeItem(k); } catch(_) {} });
}

function _preserveUserPrefs() {
  return {
    [KEY_SESSION]:      localStorage.getItem(KEY_SESSION),
    [KEY_FIREBASE_ENV]: localStorage.getItem(KEY_FIREBASE_ENV),
    [KEY_SHOE_GROUPS]:  localStorage.getItem(KEY_SHOE_GROUPS),
  };
}

function _restoreUserPrefs(keep) {
  localStorage.clear();
  Object.entries(keep).forEach(([k, v]) => { if (v) localStorage.setItem(k, v); });
}

async function _clearIndexedDbStores() {
  const stores = _DATA_STORES.filter(s => db.objectStoreNames.contains(s));
  await new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    tx.onerror = e => reject(e.target.error);
    tx.oncomplete = () => resolve();
    stores.forEach(s => tx.objectStore(s).clear());
  });
  allItems = [];
  activeDay = null;
  types = [];
  clearAllPhotoCache();
}

async function _refreshAppAfterDataChange() {
  await loadTypes();
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList();
  renderDashboard();
  try { renderFinancePage(); } catch (_) { /* intentionally ignored */ }
  try { renderDayState(); } catch (_) { /* intentionally ignored */ }
  try { renderSellPage(); } catch (_) { /* intentionally ignored */ }
  updateHeader();
}

async function _deleteFirebaseCollections(cols) {
  if (!fbReady || !fbDb) return;
  const { collection, getDocs, writeBatch, doc } = await waitForFbImports();
  for (const col of cols) {
    const snap = await getDocs(fbCol(col));
    if (snap.empty) continue;
    let batch = writeBatch(fbDb);
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(fbDoc(col, d.id));
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); n = 0; }
    }
    if (n > 0) await batch.commit();
  }
}

async function clearLocalData(skipConfirm = false) {
  if (!skipConfirm && !confirm('Clear ALL data stored on this device?\n\nCloud data is not affected. Login and settings are kept.')) return;
  try {
    toast('Clearing local data...', '');
    await _clearIndexedDbStores();
    _clearAllDayReconKeys();
    window._financeCoherenceCleaned = false;
    await _refreshAppAfterDataChange();
    toast('Local data cleared', 'ok');
  } catch (e) {
    toast('Error: Failed: ' + e.message, 'err');
  }
}

async function clearCloudData(skipConfirm = false) {
  if (!skipConfirm && !confirm('Delete ALL data in Firebase cloud?\n\nLocal data on this device is not affected. Other devices will lose cloud copies.')) return;
  if (!fbReady || !fbDb) {
    toast('Connect to Firebase first (Settings to Reconnect)', 'err');
    return;
  }
  try {
    toast('Clearing cloud data...', '');
    await _deleteFirebaseCollections(_FB_COLLECTIONS);
    toast('Cloud data cleared', 'ok');
  } catch (e) {
    toast('Error: Failed: ' + e.message, 'err');
  }
}

async function clearBothLocalAndCloud() {
  if (!confirm('Permanently delete ALL local AND cloud data?\n\nItems, sales, finances, and day records. Cannot be undone.')) return;
  await resetAllData();
}

async function clearAppCacheAndReload() {
  if (!confirm('Clear cached app files and reload?\n\nFixes outdated screens; does not delete your business data.')) return;
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (swRegistration) {
      try { await swRegistration.update(); } catch(_) {}
    }
    toast('Reloading...', '');
    setTimeout(() => window.location.reload(), 400);
  } catch (e) {
    window.location.reload();
  }
}

window.clearLocalData = clearLocalData;
window.clearCloudData = clearCloudData;
window.clearBothLocalAndCloud = clearBothLocalAndCloud;
window.clearAppCacheAndReload = clearAppCacheAndReload;

// ===== FIREBASE SYNC =====
let fbApp = null, fbDb = null, fbUnsub = null;
let fbReady = false;
let _localWriting   = false;
let _pushFailCount  = 0;     // consecutive Firestore write failures
let _lastSyncError  = null;  // last error message for diagnostics
let _pushRetryTimer = null;  // retry timer after push failure
let syncQueue = [];
let isSyncing = false;

// ══════════════════════════════════════════════════════════════════
// SYNC VERSION SYSTEM
// Every Firestore write bumps a global version counter.
// Each device tracks the last version it processed.
// When cloud version > local version (from another device) → auto-pull.
// ══════════════════════════════════════════════════════════════════
const KEY_DEVICE_ID    = 'mg_device_id';
const KEY_SYNC_VERSION = 'mg_sync_version';

function getDeviceId() {
  let id = localStorage.getItem(KEY_DEVICE_ID);
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2,7) + Date.now().toString(36).slice(-4);
    localStorage.setItem(KEY_DEVICE_ID, id);
  }
  return id;
}
function _getSyncVersion()  { return parseInt(localStorage.getItem(KEY_SYNC_VERSION) || '0'); }
function _setSyncVersion(v) { localStorage.setItem(KEY_SYNC_VERSION, String(v)); }

// Last cloud version received from _subscribeSyncMeta listener (no getDoc needed)
let _cloudSyncVersion = 0;

/**
 * Update the sync dot next to the username.
 * Uses only local state — no Firestore reads needed.
 * red=offline  orange=local ahead  yellow=cloud ahead  purple=in sync
 */
async function updateSyncDot() {
  const badge    = document.getElementById('sync-dot');
  const badgeLbl = document.getElementById('sync-badge-label');
  const barDot   = document.getElementById('sync-bar-dot');
  const barText  = document.getElementById('sync-bar-text');

  // Helper — apply state to all sync UI elements at once
  function _applySyncState(state, label, barMsg) {
    // Badge next to username
    if (badge) badge.dataset.state = state;
    if (badgeLbl) badgeLbl.textContent = label;
    // Sync bar
    if (barDot) barDot.dataset.state = state;
    if (barText) barText.textContent = barMsg;
    // Context buttons
    const btnPush    = document.getElementById('ssb-btn-push');
    const btnPull    = document.getElementById('ssb-btn-pull');
    const btnSync    = document.getElementById('ssb-btn-sync');
    const btnOffline = document.getElementById('ssb-btn-offline');
    // Refresh button always visible (hidden only when offline — use Reconnect instead)
    if (btnPush)    btnPush.style.display    = (state === 'ahead')   ? 'flex' : 'none';
    if (btnPull)    btnPull.style.display    = (state === 'behind')  ? 'flex' : 'none';
    if (btnSync)    btnSync.style.display    = (state !== 'offline') ? 'flex' : 'none';
    if (btnOffline) btnOffline.style.display = (state === 'offline') ? 'flex' : 'none';
    // Highlight Refresh in red when there's an error
    if (btnSync) btnSync.style.borderColor = (state === 'error') ? 'rgba(220,38,38,.6)' : '';
  }

  // Offline / not connected
  if (!navigator.onLine) {
    _applySyncState('offline', 'Offline', 'No internet — changes saved locally');
    return;
  }
  if (!fbReady || !fbDb) {
    _applySyncState('offline', 'Not connected', 'Firebase not connected — tap Reconnect');
    return;
  }

  try {
    // 1. Push failures
    if (_pushFailCount > 0) {
      const errMsg = _lastSyncError ? _lastSyncError : 'unknown error';
      _applySyncState('ahead', 'Push failed', _pushFailCount + ' write(s) failed: ' + errMsg + ' — tap Push to retry');
      return;
    }

    // 2. Unsynced local items (no fbId)
    const localItems = await dbAll('items');
    const unsynced   = localItems.filter(i => i.id && !i.fbId);
    if (unsynced.length) {
      _applySyncState('ahead', 'Not pushed', unsynced.length + ' local item(s) not yet in cloud — tap Push');
      return;
    }

    // 3. Cloud ahead of local
    const localV = _getSyncVersion();
    if (_cloudSyncVersion > localV) {
      _applySyncState('behind', 'Pull needed', 'Cloud has newer data (v' + _cloudSyncVersion + ') — tap Pull');
      return;
    }

    // 4. All in sync
    const now = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    _applySyncState('synced', 'Synced', 'All data in sync (v' + localV + ') · ' + now);
  } catch(e) {
    _applySyncState('synced', 'Synced', 'In sync');
  }
}
window.updateSyncDot = updateSyncDot;

/** Push only — upload local changes to cloud */
async function syncPushOnly() {
  if (!navigator.onLine || !fbReady || !fbDb) { toast('Not connected', 'err'); return; }
  setFbStatus('syncing');
  try {
    await forcePushToFirebase(true);
    _pushFailCount = 0; _lastSyncError = null;
    setFbStatus('on');
    toast('Pushed to cloud ✓', 'ok');
  } catch(e) { toast('Push failed: ' + e.message, 'err'); }
  await updateSyncDot();
}
window.syncPushOnly = syncPushOnly;

/** Pull only — download cloud changes to this device */
async function syncPullOnly() {
  if (!navigator.onLine || !fbReady || !fbDb) { toast('Not connected', 'err'); return; }
  setFbStatus('syncing');
  try {
    await pullFromFirebase(true);
    await refreshUI({ sync: false });
    setFbStatus('on');
    toast('Pulled from cloud ✓', 'ok');
  } catch(e) { toast('Pull failed: ' + e.message, 'err'); }
  await updateSyncDot();
}
window.syncPullOnly = syncPullOnly;

/** Retry Firebase connection when offline */
async function retryConnection() {
  toast('Reconnecting…', '');
  try { await initFirebase(); }
  catch(e) { toast('Connection failed: ' + e.message, 'err'); }
}
window.retryConnection = retryConnection;

/** Open the sync bar visibly (for badge tap) */
function openSyncPanel() {
  const bar = document.getElementById('sync-bar');
  if (bar) {
    bar.style.display = 'flex';
    updateSyncDot();
  }
}
window.openSyncPanel = openSyncPanel;

/** Manual force-sync: push ALL local data to cloud then pull, with diagnostics */
async function runForceSync(silent = false) {
  if (!navigator.onLine) { toast('No internet connection', 'err'); return; }
  if (!fbReady || !fbDb) {
    toast('Firebase not connected — check Settings', 'err');
    return;
  }
  if (!silent) {
    setFbStatus('syncing');
    toast('Syncing…', '');
  }
  try {
    // Pull first (get authoritative cloud state)
    await pullFromFirebase(true);
    // Remove any duplicates caused by previous sync races
    const dupsRemoved = await deduplicateSales();
    if (dupsRemoved > 0) console.log('[SYNC] Removed ' + dupsRemoved + ' duplicate sale(s)');
    // Push local records not yet in cloud
    await forcePushToFirebase(true);
    _pushFailCount = 0;
    _lastSyncError = null;
    await refreshUI({ sync: false });
    setFbStatus('on');
    if (!silent) toast('Sync complete ✓', 'ok');
  } catch(e) {
    _lastSyncError = e.message;
    if (!silent) toast('Sync failed: ' + e.message, 'err');
    console.error('[SYNC] runForceSync failed:', e);
  }
  await updateSyncDot();
}
window.runForceSync = runForceSync;

/** Atomically increment the global sync version in Firestore after any write. */
async function bumpSyncVersion() {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc, increment } = await waitForFbImports();
    const metaRef = doc(fbDb, '_sync_meta', 'global');
    await setDoc(metaRef, {
      version:   increment(1),
      updatedAt: new Date().toISOString(),
      device:    getDeviceId()
    }, { merge: true });
    updateSyncDot();
  } catch(e) { /* non-critical */ }
}

/** Subscribe to _sync_meta — when another device bumps the version, pull immediately. */
async function _subscribeSyncMeta() {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, getDoc, onSnapshot: onSnap } = await waitForFbImports();
    const metaRef = doc(fbDb, '_sync_meta', 'global');

    // Initialise local version from current cloud state
    try {
      const snap = await getDoc(metaRef);
      if (snap.exists()) {
        _cloudSyncVersion = snap.data().version || 0;
        _setSyncVersion(_cloudSyncVersion);
      }
    } catch(e) { /* _sync_meta may not exist yet */ }

    onSnap(metaRef, async cloudSnap => {
      if (!cloudSnap.exists()) return;
      const cloudVersion = cloudSnap.data().version || 0;
      const cloudDevice  = cloudSnap.data().device  || '';
      _cloudSyncVersion  = cloudVersion;            // cache for updateSyncDot
      const localVersion = _getSyncVersion();

      // Pull whenever cloud is ahead from another device — no _localWriting gate
      if (cloudVersion > localVersion && cloudDevice !== getDeviceId()) {
        console.log(`[SYNC] Cloud v${cloudVersion} > local v${localVersion} (from ${cloudDevice}) — pulling`);
        setFbStatus('syncing');
        try {
          await pullFromFirebase(true);
          _setSyncVersion(cloudVersion);
          await refreshUI({ sync: false });
          setFbStatus('on');
          updateSyncDot();
        } catch(e) { console.warn('[SYNC] auto-pull failed:', e.message); setFbStatus('error'); updateSyncDot(); }
      }
    }, err => console.warn('[SYNC] meta listener error:', err.message));
  } catch(e) { console.warn('[SYNC] _subscribeSyncMeta:', e.message); }
}

/** Called when device comes back online — check version and pull if behind. */
async function _onComeOnline() {
  if (!fbReady || !fbDb) { try { await initFirebase(); } catch(_) {} return; }
  setFbStatus('syncing');
  try {
    const { doc, getDoc } = await waitForFbImports();
    const snap = await getDoc(doc(fbDb, '_sync_meta', 'global'));
    if (snap.exists()) {
      const cloudVersion = snap.data().version || 0;
      if (cloudVersion > _getSyncVersion()) {
        await pullFromFirebase(true);
        _setSyncVersion(cloudVersion);
        await refreshUI({ sync: false });
      }
    }
    await forcePushToFirebase(true);
    setFbStatus('on');
    toast('Online — sync complete', 'ok');
  } catch(e) { setFbStatus('error'); }
}
window.addEventListener('online',  () => _onComeOnline());
window.addEventListener('offline', () => { toast('Offline — changes saved locally', ''); updateSyncDot(); });

/** When the app returns from background/screen-off, catch up on missed changes */
async function _onVisibilityChange() {
  if (document.visibilityState !== 'visible') return;
  if (!fbReady || !fbDb || !navigator.onLine) return;
  try {
    await pullFromFirebase(true);
    await refreshUI({ sync: false });
    setFbStatus('on');
    await updateSyncDot();
  } catch(e) { /* non-critical */ }
}
window._onVisibilityChange = _onVisibilityChange;

function setFbStatus(status) {
  const dot = document.getElementById('fb-status-dot');
  const txt = document.getElementById('fb-status-text');
  const colors = { off:'var(--muted)', connecting:'var(--amber)', on:'var(--green)', error:'var(--red)', syncing:'#3b82f6' };
  const now = new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const envLabel = FIREBASE_ENVIRONMENTS[getFirebaseEnv()]?.label || '';
  const syncV = _getSyncVersion();
  const vStr  = syncV > 0 ? ' · v' + syncV : '';
  const devId = getDeviceId();
  const labels = {
    off:       'Not connected',
    connecting:'Connecting to Firebase...',
    on:        'Synced (' + envLabel + ')' + vStr + ' · ' + devId + ' · ' + now,
    error:     'Sync error — tap Refresh to pull & push all data',
    syncing:   'Syncing' + vStr + '...'
  };
  if (dot) { dot.style.background = colors[status]; dot.style.boxShadow = status==='on' ? '0 0 6px var(--green)' : 'none'; }
  if (txt) txt.textContent = labels[status];

  // Reconnect/Disconnect is a single button whose label/action flips with state
  const toggleBtn = document.getElementById('fb-connection-toggle');
  if (toggleBtn) {
    const connected = status === 'on' || status === 'connecting' || status === 'syncing';
    toggleBtn.textContent = connected ? 'Disconnect' : 'Reconnect';
    toggleBtn.classList.toggle('settings-btn--primary', !connected);
    toggleBtn.classList.toggle('settings-btn--ghost', connected);
    toggleBtn.classList.toggle('settings-btn--danger-text', connected);
  }

  // Update sync bar under header
  const bar = document.getElementById('sync-bar');
  const barDot = document.getElementById('sync-bar-dot');
  const barTxt = document.getElementById('sync-bar-text');
  const barTime = document.getElementById('sync-bar-time');
  if (!bar) return;
  const barColors = { off:'#888', connecting:'#f59e0b', on:'#4ade80', error:'#f87171', syncing:'#60a5fa' };
  const barLabels = { off:'Offline', connecting:'Connecting...', on:'Live', error:'Sync Error', syncing:'Syncing...' };
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

// ===== FIREBASE ENVIRONMENTS =====
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCCHwRweqKLQeXFOOiqNLbZ2vJAzdZAD2U",
  authDomain: "mandela-generals.firebaseapp.com",
  projectId: "mandela-generals",
  storageBucket: "mandela-generals.firebasestorage.app",
  messagingSenderId: "467998749242",
  appId: "1:467998749242:web:222226a3a0e767eb067b03",
  measurementId: "G-W184ZWRGJH"
};

const FIREBASE_ENVIRONMENTS = Object.freeze({
  production: Object.freeze({
    label: 'Production',
    projectId: 'mandela-generals',
    collectionPrefix: '',
    appName: 'mandela-prod',
  }),
  development: Object.freeze({
    label: 'Development',
    projectId: 'mandela-generals',
    collectionPrefix: 'dev_',
    appName: 'mandela-dev',
  }),
});

function getFirebaseEnv() {
  const stored = localStorage.getItem(KEY_FIREBASE_ENV);
  if (stored && FIREBASE_ENVIRONMENTS[stored]) return stored;
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') return 'development';
  return 'production';
}

function getFirebaseEnvConfig() {
  return FIREBASE_ENVIRONMENTS[getFirebaseEnv()];
}

function fbColName(name) {
  return (getFirebaseEnvConfig().collectionPrefix || '') + name;
}

function fbCol(name) {
  if (!fbDb || !window._fbImports) throw new Error('Firebase not ready');
  return window._fbImports.collection(fbDb, fbColName(name));
}

function fbDoc(name, id) {
  if (!fbDb || !window._fbImports) throw new Error('Firebase not ready');
  return window._fbImports.doc(fbDb, fbColName(name), id);
}

function updateFirebaseEnvUI() {
  const env = getFirebaseEnv();
  const cfg = FIREBASE_ENVIRONMENTS[env];
  const isDev = env === 'development';
  document.body.dataset.firebaseEnv = env;
  const nameEl = document.getElementById('fb-env-name');
  if (nameEl) nameEl.textContent = cfg.label;
  const projectEl = document.getElementById('fb-env-project');
  if (projectEl) projectEl.textContent = isDev ? 'None - local database only' : cfg.projectId;
  const prefixEl = document.getElementById('fb-env-prefix');
  if (prefixEl) prefixEl.textContent = isDev ? 'Collections: none (cloud sync disabled)' : 'Collections: items, sales,...';
  const autosyncEl = document.getElementById('fb-env-autosync');
  if (autosyncEl) autosyncEl.textContent = isDev ? 'Disabled (local database only)' : 'On every change (when online)';
  document.getElementById('fb-env-prod')?.classList.toggle('active', env === 'production');
  document.getElementById('fb-env-dev')?.classList.toggle('active', isDev);

  // Developer tools are only ever visible while actually in Development.
  const devCard = document.getElementById('dev-tools-card');
  if (devCard) devCard.style.display = isDev ? '' : 'none';
  const dbNameEl = document.getElementById('dev-tools-dbname');
  if (dbNameEl) dbNameEl.textContent = DB_NAME;

  // Sync actions and diagnostics are inert in Development (cloud is always
  // off there) - hide them so Settings isn't cluttered with dead buttons.
  const syncActions = document.getElementById('fb-sync-actions-wrap');
  if (syncActions) syncActions.style.display = isDev ? 'none' : '';
  const diagnostics = document.getElementById('fb-diagnostics-wrap');
  if (diagnostics) diagnostics.style.display = isDev ? 'none' : '';
}

async function setFirebaseEnvironment(env) {
  if (!FIREBASE_ENVIRONMENTS[env]) return;
  if (getFirebaseEnv() === env) {
    updateFirebaseEnvUI();
    return;
  }
  const label = FIREBASE_ENVIRONMENTS[env].label;
  // Dev and prod each use their own local IndexedDB database, so switching
  // requires a reload to reopen the correct one - there's no way to hot-swap
  // an already-open IndexedDB connection to a different database.
  const msg = env === 'development'
    ? 'Switch to ' + label + '?\n\n' +
      'This moves to a separate local development database - no cloud sync, and it can ' +
      'never affect your real shop data. Use "Rebuild with sample data" in Settings ' +
      'afterward to load realistic test data. The app will reload.'
    : 'Switch to ' + label + '?\n\n' +
      'This returns to your live shop database and cloud sync. The app will reload.';
  if (!confirm(msg)) return;
  localStorage.setItem(KEY_FIREBASE_ENV, env);
  location.reload();
}

async function initFirebase() {
  try {
    updateFirebaseEnvUI();
    // Development never talks to the cloud - it runs entirely on its own
    // local database (see initDB()). This is the single choke point every
    // caller (startup, reconnect, sync debug, env switch) goes through.
    if (getFirebaseEnv() === 'development') {
      fbApp = null; fbDb = null; fbReady = false;
      setFbStatus('off');
      return;
    }
    setFbStatus('connecting');
    const {
      initializeApp, getApps,
      getFirestore, onSnapshot
    } = await waitForFbImports();

    const envCfg = getFirebaseEnvConfig();
    const apps = getApps();
    fbApp  = apps.find(a => a.name === envCfg.appName) || initializeApp(FIREBASE_CONFIG, envCfg.appName);
    fbDb   = getFirestore(fbApp);
    fbReady = true;

    // Unsub old listeners before creating new ones
    if (typeof fbUnsub === 'function')           { fbUnsub(); }
    if (typeof window._fbUnsubSales === 'function') { window._fbUnsubSales(); }
    if (typeof window._fbUnsubFin === 'function') { window._fbUnsubFin(); }
    if (typeof window._fbUnsubWish === 'function') { window._fbUnsubWish(); }
    if (typeof window._fbUnsubSz === 'function') { window._fbUnsubSz(); }
    if (typeof window._fbUnsubBd       === 'function') { window._fbUnsubBd(); }
    if (typeof window._fbUnsubCust     === 'function') { window._fbUnsubCust(); }
    if (typeof window._fbUnsubCustTxn  === 'function') { window._fbUnsubCustTxn(); }
    fbUnsub = null;
    window._fbUnsubSales = null;
    window._fbUnsubFin = null;
    window._fbUnsubWish = null;
    window._fbUnsubSz = null;
    window._fbUnsubBd = null;
    window._fbUnsubCust = null;
    window._fbUnsubCustTxn = null;

    // ── items listener (self-healing) ────────────────────────────
    function _startItemsListener() {
      if (fbUnsub) { try { fbUnsub(); } catch(_) {} }
      fbUnsub = onSnapshot(fbCol('items'), async snap => {
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localItems = await dbAll('items');
        const byFbId = Object.fromEntries(localItems.filter(i=>i.fbId).map(i=>[i.fbId,i]));
        const byCode = Object.fromEntries(localItems.filter(i=>i.code).map(i=>[i.code,i]));
        let changed = false;
        for (const c of changes) {
          const data = {...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id];
            if (loc) { await dbDelete('items', loc.id); changed = true; }
          } else {
            const ex = byFbId[c.doc.id] || byCode[data.code];
            if (ex) { data.id = ex.id; await dbPut('items', data); }
            else    { try { await dbAdd('items', data); } catch(_) {} }
            changed = true;
          }
        }
        if (changed) {
          allItems = await dbAll('items');
          await enrichShoeItems(allItems);
          renderList(); renderDashboard(); updateHeader();
          setFbStatus('on');
          updateSyncDot();
        }
      }, err => {
        console.error('[FB] items listener error:', err.message);
        setFbStatus('error');
        setTimeout(async () => {
          if (!fbReady || !fbDb) return;
          _startItemsListener();
          try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {}
        }, 3000);
      });
    }
    _startItemsListener();

    // ── sales listener (self-healing) ────────────────────────────
    function _startSalesListener() {
      if (window._fbUnsubSales) { try { window._fbUnsubSales(); } catch(_) {} }
      window._fbUnsubSales = onSnapshot(fbCol('sales'), async snap => {
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localSales = await dbAll('sales');
        const byFbId = Object.fromEntries(localSales.filter(s=>s.fbId).map(s=>[s.fbId,s]));
        for (const c of changes) {
          const data = {...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id];
            if (loc) await dbDelete('sales', loc.id);
          } else {
            const ex = byFbId[c.doc.id] || localSales.find(s => _salesMatch(s, data));
            if (ex) { data.id = ex.id; await dbPut('sales', data); }
            else    { try { await dbAdd('sales', data); } catch(_) {} }
          }
        }
        try { if (activeDay) updateDayLiveStats(); } catch(_) {}
        try { renderDashboard(); } catch(_) {}
        updateSyncDot();
      }, err => {
        console.error('[FB] sales listener error:', err.message);
        setFbStatus('error');
        setTimeout(async () => {
          if (!fbReady || !fbDb) return;
          _startSalesListener();
          try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {}
        }, 3000);
      });
    }
    _startSalesListener();

    // ── finances listener (self-healing) ─────────────────────────
    function _startFinListener() {
      if (window._fbUnsubFin) { try { window._fbUnsubFin(); } catch(_) {} }
      window._fbUnsubFin = onSnapshot(fbCol('finances'), async snap => {
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localFin = await dbAll('finances');
        const byFbId = Object.fromEntries(localFin.filter(f => f.fbId).map(f => [f.fbId, f]));
        let changed = false;
        for (const c of changes) {
          const data = {...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id];
            if (loc) { await dbDelete('finances', loc.id); changed = true; }
          } else {
            if (_isDeletedFinanceRemote(c.doc.id, data)) continue;
            const ex = byFbId[c.doc.id] || localFin.find(f => _financeRecordsMatch(f, data));
            if (ex) { data.id = ex.id; await dbPut('finances', data); }
            else { try { await dbAdd('finances', data); } catch(_) {} }
            changed = true;
          }
        }
        if (changed) {
          try { renderFinancePage(); } catch(_) {}
          try { renderDashboard(); } catch(_) {}
        }
      }, err => {
        console.error('[FB] finances listener error:', err.message);
        setFbStatus('error');
        setTimeout(async () => {
          if (!fbReady || !fbDb) return;
          _startFinListener();
          try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {}
        }, 3000);
      });
    }
    _startFinListener();

    // ── wishlist listener (self-healing) ─────────────────────────
    if (db.objectStoreNames.contains('wishlist')) {
      function _startWishListener() {
        if (window._fbUnsubWish) { try { window._fbUnsubWish(); } catch(_) {} }
        window._fbUnsubWish = onSnapshot(fbCol('wishlist'), async snap => {
          const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
          if (!changes.length) return;
          const localWish = await dbAll('wishlist');
          const byFbId = Object.fromEntries(localWish.filter(w => w.fbId).map(w => [w.fbId, w]));
          let changed = false;
          for (const c of changes) {
            const data = {...c.doc.data(), fbId: c.doc.id };
            delete data.id;
            if (c.type === 'removed') {
              const loc = byFbId[c.doc.id];
              if (loc) { await dbDelete('wishlist', loc.id); changed = true; }
            } else {
              const ex = byFbId[c.doc.id];
              if (ex) { data.id = ex.id; await dbPut('wishlist', data); }
              else { try { await dbAdd('wishlist', data); } catch(_) {} }
              changed = true;
            }
          }
          if (changed) try { renderWishlistPage(); } catch(_) {}
        }, err => {
          console.error('[FB] wishlist listener error:', err.message);
          setTimeout(async () => { if (!fbReady||!fbDb) return; _startWishListener(); try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {} }, 3000);
        });
      }
      _startWishListener();
    }

    // ── shoe_sizes listener (self-healing) ────────────────────────
    function _startSzListener() {
      if (window._fbUnsubSz) { try { window._fbUnsubSz(); } catch(_) {} }
      window._fbUnsubSz = onSnapshot(fbCol('shoe_sizes'), async snap => {
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localSizes = await dbAll('shoe_sizes');
        const byFbId = Object.fromEntries(localSizes.filter(s => s.fbId).map(s => [s.fbId, s]));
        const byCS   = Object.fromEntries(localSizes.filter(s => s.codeSize).map(s => [s.codeSize, s]));
        let changed = false;
        for (const c of changes) {
          const data = {...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id];
            if (loc) { await dbDelete('shoe_sizes', loc.id); changed = true; }
          } else {
            const ex = byFbId[c.doc.id] || byCS[data.codeSize];
            if (ex) { data.id = ex.id; await dbPut('shoe_sizes', data); }
            else { try { await dbAdd('shoe_sizes', data); } catch(_) {} }
            changed = true;
          }
        }
        if (changed) {
          allItems = await dbAll('items');
          await enrichShoeItems(allItems);
          renderList(); renderDashboard(); updateHeader();
        }
      }, err => {
        console.error('[FB] shoe_sizes listener error:', err.message);
        setTimeout(async () => { if (!fbReady||!fbDb) return; _startSzListener(); try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {} }, 3000);
      });
    }
    _startSzListener();

    // ── business_days listener (self-healing) ────────────────────
    function _startBdListener() {
      if (window._fbUnsubBd) { try { window._fbUnsubBd(); } catch(_) {} }
      window._fbUnsubBd = onSnapshot(fbCol('business_days'), async snap => {
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localBd = await dbAll('business_days');
        const byFbId  = Object.fromEntries(localBd.filter(b => b.fbId).map(b => [b.fbId, b]));
        const byDate  = Object.fromEntries(localBd.map(b => [(b.businessDate || b.business_date), b]));
        let changed = false;
        for (const c of changes) {
          const data = {...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          const dateKey = data.businessDate || data.business_date;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id] || (dateKey ? byDate[dateKey] : null);
            if (loc) { await dbDelete('business_days', loc.id); changed = true; }
          } else {
            const ex = byFbId[c.doc.id] || (dateKey ? byDate[dateKey] : null);
            if (ex) { data.id = ex.id; await dbPut('business_days', data); }
            else { try { await dbAdd('business_days', data); } catch(_) {} }
            changed = true;
            if (activeDay && ex && ex.id === activeDay.id) {
              activeDay = await dbGet('business_days', ex.id);
            }
          }
        }
        if (changed) {
          try { renderDayState(); } catch(_) {}
          try { renderDaySessionsList(); } catch(_) {}
        }
      }, err => {
        console.error('[FB] business_days listener error:', err.message);
        setTimeout(async () => { if (!fbReady||!fbDb) return; _startBdListener(); try { await pullFromFirebase(true); await refreshUI({sync:false}); setFbStatus('on'); updateSyncDot(); } catch(_) {} }, 3000);
      });
    }
    _startBdListener();

    // ── customers listener (self-healing) ────────────────────────
    if (db.objectStoreNames.contains('customers')) {
      function _startCustListener() {
        if (window._fbUnsubCust) { try { window._fbUnsubCust(); } catch(_) {} }
        window._fbUnsubCust = onSnapshot(fbCol('customers'), async snap => {
          const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
          if (!changes.length) return;
          const local   = await dbAll('customers');
          const byFbId  = Object.fromEntries(local.filter(c => c.fbId).map(c => [c.fbId, c]));
          const byId    = Object.fromEntries(local.filter(c => c.customerId).map(c => [c.customerId, c]));
          let changed = false;
          for (const c of changes) {
            const data = {...c.doc.data(), fbId: c.doc.id}; delete data.id;
            if (c.type === 'removed') {
              const ex = byFbId[c.doc.id];
              if (ex) { await dbDelete('customers', ex.id); changed = true; }
            } else {
              const ex = byFbId[c.doc.id] || byId[data.customerId];
              if (ex) { data.id = ex.id; await dbPut('customers', data); }
              else { try { await dbAdd('customers', data); } catch(_) {} }
              changed = true;
            }
          }
          if (changed) try { renderCustomerList(''); } catch(_) {}
        }, err => {
          console.error('[FB] customers listener error:', err.message);
          setTimeout(async () => { if (!fbReady||!fbDb) return; _startCustListener(); }, 3000);
        });
      }
      _startCustListener();
    }

    // ── customer_txns listener (self-healing) ─────────────────────
    if (db.objectStoreNames.contains('customer_txns')) {
      function _startCustTxnListener() {
        if (window._fbUnsubCustTxn) { try { window._fbUnsubCustTxn(); } catch(_) {} }
        window._fbUnsubCustTxn = onSnapshot(fbCol('customer_txns'), async snap => {
          const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
          if (!changes.length) return;
          const local  = await dbAll('customer_txns');
          const byFbId = Object.fromEntries(local.filter(t => t.fbId).map(t => [t.fbId, t]));
          let changed = false;
          for (const c of changes) {
            const data = {...c.doc.data(), fbId: c.doc.id}; delete data.id;
            if (c.type === 'removed') {
              const ex = byFbId[c.doc.id];
              if (ex) { await dbDelete('customer_txns', ex.id); changed = true; }
            } else {
              const ex = byFbId[c.doc.id];
              if (ex) { data.id = ex.id; await dbPut('customer_txns', data); }
              else { try { await dbAdd('customer_txns', data); } catch(_) {} }
              changed = true;
            }
          }
          // Recalculate balances for affected customers
          if (changed) {
            const custIds = [...new Set(changes.map(c => c.doc.data().customerId).filter(Boolean))];
            for (const cid of custIds) {
              try { await _recalcBalance(cid); } catch(_) {}
            }
            try { renderCustomerList(''); } catch(_) {}
          }
        }, err => {
          console.error('[FB] customer_txns listener error:', err.message);
          setTimeout(async () => { if (!fbReady||!fbDb) return; _startCustTxnListener(); }, 3000);
        });
      }
      _startCustTxnListener();
    }

    setFbStatus('on');
    toast('Firebase connected (' + getFirebaseEnvConfig().label + ')', 'ok');
    await pullFromFirebase(true);
    await deduplicateSales();     // remove any duplicates from previous sync bugs
    await normalizeSyncIds();
    await forcePushToFirebase(true);
    await _subscribeSyncMeta();
    await updateSyncDot();

    // Page visibility: when app comes back from background, pull fresh data
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    document.addEventListener('visibilitychange', _onVisibilityChange);

    // Heartbeat: every 60 s pull + sync dot update
    clearInterval(window._syncHeartbeat);
    window._syncHeartbeat = setInterval(async () => {
      if (!fbReady || !fbDb || !navigator.onLine) return;
      try {
        // Auto-retry if previous writes failed
        if (_pushFailCount > 0) {
          console.log('[SYNC] Heartbeat: retrying ' + _pushFailCount + ' failed push(es)');
          _pushFailCount = 0;
          await forcePushToFirebase(true);
          await updateSyncDot();
          return;
        }
        // Check if cloud is ahead
        const { doc, getDoc } = await waitForFbImports();
        const snap = await getDoc(doc(fbDb, '_sync_meta', 'global'));
        if (!snap.exists()) return;
        const cloudV = snap.data().version || 0;
        if (cloudV > _getSyncVersion()) {
          console.log('[SYNC] Heartbeat: behind cloud v' + cloudV + ' — pulling');
          await pullFromFirebase(true);
          _setSyncVersion(cloudV);
          await refreshUI({ sync: false });
          setFbStatus('on');
        }
        await updateSyncDot();
      } catch(e) { /* non-critical */ }
    }, 60000);

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
  // Config is hardcoded - just reconnect
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  fbApp = null; fbDb = null; fbReady = false;
  await initFirebase();
  } catch(e) { console.error("[saveFirebaseConfig]", e); toast("Error: " + e.message, "err"); }
}

function _fbSlug(s, fallback) {
  const out = String(s || fallback || 'x').toLowerCase().replace(/[^a-z0-9]/g, '');
  return out || (fallback || 'x');
}

function stableItemFbId(item) {
  const code = _fbSlug(item && item.code, 'x');
  const variant = item && item.isShoe ? 'shoe' : _fbSlug(item && (item.variant || item.size), 'std');
  return 'itm_' + code + '_' + variant;
}

function stableWishFbId(wish) {
  if (wish && wish.fbId) return wish.fbId;
  const when = (wish && wish.createdAt || '').replace(/[^0-9]/g, '').slice(0, 14) || '0';
  const name = _fbSlug(wish && wish.name, 'w').slice(0, 24);
  return 'wish_' + when + '_' + name;
}

function stableBusinessDayFbId(bd) {
  const d = (bd && (bd.businessDate || bd.business_date) || 'unknown').replace(/[^0-9-]/g, '');
  return 'bd_' + d;
}

function stableShoeSizeFbId(sz) {
  if (sz && sz.codeSize) return 'sz_' + _fbSlug(sz.codeSize, 'sz');
  return 'sz_' + _fbSlug(sz && sz.code) + '_' + String(sz && sz.size != null ? sz.size : 0);
}

function stableSaleFbId(sale) {
  if (sale && sale.fbId) return sale.fbId;
  const ts = (sale && (sale.createdAt || sale.date) || '').replace(/[^0-9]/g, '').slice(0, 17) || '0';
  const code = _fbSlug(sale && sale.itemCode, 'x');
  const rev = String(Math.round(Number(sale && sale.revenue || 0) * 100));
  return 'sale_' + ts + '_' + code + '_' + rev;
}

async function ensureItemFbId(item) {
  const stable = stableItemFbId(item);
  if (item.fbId === stable) return stable;
  const oldId = item.fbId;
  item.fbId = stable;
  await dbPut('items', item);
  if (fbReady && oldId && oldId !== stable && /^item_/.test(oldId)) {
    fbDeleteItem(oldId).catch(() => {});
  }
  return stable;
}

async function normalizeSyncIds() {
  const items = await dbAll('items');
  for (const item of items) {
    await ensureItemFbId(item);
  }
  const shoeSizes = await dbAll('shoe_sizes');
  for (const sz of shoeSizes) {
    const stable = stableShoeSizeFbId(sz);
    if (sz.fbId !== stable) {
      sz.fbId = stable;
      await dbPut('shoe_sizes', sz);
    }
  }
  const bdays = await dbAll('business_days');
  for (const bd of bdays) {
    const stable = stableBusinessDayFbId(bd);
    if (bd.fbId !== stable) {
      bd.fbId = stable;
      await dbPut('business_days', bd);
    }
  }
  if (db.objectStoreNames.contains('wishlist')) {
    const wishes = await dbAll('wishlist');
    for (const w of wishes) {
      if (!w.fbId) {
        w.fbId = stableWishFbId(w);
        await dbPut('wishlist', w);
      }
    }
  }
}

async function fbSyncItem(item) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    await ensureItemFbId(item);
    const data = sanitiseForFirestore({...item, updatedAt: new Date().toISOString() });
    await setDoc(fbDoc('items', item.fbId), data);
    _pushFailCount = Math.max(0, _pushFailCount - 1);
    _lastSyncError = null;
    bumpSyncVersion();
  } catch(e) {
    _pushFailCount++;
    _lastSyncError = e.message;
    console.error('[SYNC] fbSyncItem failed (' + _pushFailCount + '):', e.message);
    updateSyncDot();
    // Retry after 5 s rather than waiting 60 s heartbeat
    clearTimeout(_pushRetryTimer);
    _pushRetryTimer = setTimeout(() => runForceSync(true), 5000);
  }
}

async function fbDeleteItem(fbId) {
  if (!fbReady || !fbDb || !fbId) return;
  try {
    const { doc, deleteDoc } = await waitForFbImports();
    await deleteDoc(fbDoc('items', fbId));
  } catch (e) { console.error('fbDeleteItem error', e); }
}

async function fbSyncSale(sale) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    if (!sale.fbId) {
      sale.fbId = stableSaleFbId(sale);
      if (sale.id) await dbPut('sales', sale);
    }
    const data = sanitiseForFirestore({...sale });
    await setDoc(fbDoc('sales', sale.fbId), data);
    _pushFailCount = Math.max(0, _pushFailCount - 1);
    bumpSyncVersion();
  } catch(e) {
    _pushFailCount++;
    _lastSyncError = e.message;
    console.error('[SYNC] fbSyncSale failed (' + _pushFailCount + '):', e.message);
    updateSyncDot();
    clearTimeout(_pushRetryTimer);
    _pushRetryTimer = setTimeout(() => runForceSync(true), 5000);
  }
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

/**
 * Remove duplicate sales from LOCAL IndexedDB AND Firestore cloud.
 * Keeps the record with an fbId (or lowest id). Deletes the rest everywhere.
 */
async function deduplicateSales() {
  const all = await dbAll('sales');
  const seen = new Map();     // signature → winning record
  const losers = [];          // {id, fbId} — duplicates to delete

  for (const sale of all) {
    const sig = _saleSignature(sale);
    if (!sig) continue;
    if (seen.has(sig)) {
      const winner = seen.get(sig);
      if (!winner.fbId && sale.fbId) {
        // Current 'sale' is better keeper → demote previous winner
        losers.push(winner);
        seen.set(sig, sale);
      } else {
        losers.push(sale);
      }
    } else {
      seen.set(sig, sale);
    }
  }

  if (!losers.length) return 0;

  for (const loser of losers) {
    // 1. Delete from local IndexedDB
    await dbDelete('sales', loser.id);

    // 2. Delete from Firestore cloud (if it has an fbId)
    if (loser.fbId && fbReady && fbDb) {
      try {
        const { doc, deleteDoc } = await waitForFbImports();
        await deleteDoc(doc(fbDb, fbColName('sales'), loser.fbId));
      } catch(e) { console.warn('[DEDUP] cloud delete failed for', loser.fbId, e.message); }
    }

    // 3. Mark as deleted so pull doesn't re-create it
    if (loser.fbId) _rememberDeletedSale(loser);
  }

  console.log('[DEDUP] Removed ' + losers.length + ' duplicate sale(s) from local + cloud');
  return losers.length;
}
window.deduplicateSales = deduplicateSales;

function _salesMatch(local, remote) {
  if (!local || !remote) return false;
  if (local.fbId && remote.fbId && local.fbId === remote.fbId) return true;
  return _saleSignature(local) === _saleSignature(remote);
}

async function fbDeleteFinanceEntry(entry) {
  if (!fbReady || !fbDb || !entry) return 0;
  try {
    const { collection, doc, getDocs, deleteDoc } = await waitForFbImports();
    const snap = await getDocs(fbCol('finances'));
    const deletes = [];
    for (const d of snap.docs) {
      const remote = {...d.data(), fbId: d.id };
      if (d.id === entry.fbId || _financeRecordsMatch(entry, remote)) {
        deletes.push(deleteDoc(fbDoc('finances', d.id)));
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
    const snap = await getDocs(fbCol('sales'));
    const deletes = [];
    for (const d of snap.docs) {
      const remote = {...d.data(), fbId: d.id };
      if (d.id === sale.fbId || _salesMatch(sale, remote)) {
        deletes.push(deleteDoc(fbDoc('sales', d.id)));
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
  if (!fbReady || !fbDb) { if (!silent) toast('Warning: Connect Firebase first', 'err'); return; }
  if (!silent) setFbStatus('syncing');
  _localWriting = true;
  const items = await dbAll('items');
  const sales = await dbAll('sales');
  const { doc, setDoc, writeBatch } = await waitForFbImports();
  try {
    let batch = writeBatch(fbDb);
    let count = 0;

    for (const item of items) {
      await ensureItemFbId(item);
      batch.set(fbDoc('items', item.fbId), sanitiseForFirestore({...item, updatedAt: new Date().toISOString() }));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    for (const sale of sales) {
      if (!sale.fbId) {
        sale.fbId = stableSaleFbId(sale);
        await dbPut('sales', sale);
      }
      batch.set(fbDoc('sales', sale.fbId), sanitiseForFirestore({...sale }));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push shoe_sizes
    const shoeSizes = await dbAll('shoe_sizes');
    for (const sz of shoeSizes) {
      if (!sz.codeSize) continue;
      const szStable = stableShoeSizeFbId(sz);
      if (sz.fbId !== szStable) { sz.fbId = szStable; await dbPut('shoe_sizes', sz); }
      batch.set(fbDoc('shoe_sizes', sz.fbId), sanitiseForFirestore({...sz}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push finances
    const finances = await dbAll('finances');
    for (const f of finances) {
      if (!f.fbId) { f.fbId = 'fin_' + (f.createdAt||'').replace(/[:.TZ]/g,'-') + '_' + (f.id||Math.random().toString(36).slice(2,6)); await dbPut('finances', f); }
      batch.set(fbDoc('finances', f.fbId), sanitiseForFirestore({...f}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push business_days
    const bdays = await dbAll('business_days');
    for (const bd of bdays) {
      if (!bd.fbId || bd.fbId !== stableBusinessDayFbId(bd)) {
        bd.fbId = stableBusinessDayFbId(bd);
        await dbPut('business_days', bd);
      }
      batch.set(fbDoc('business_days', bd.fbId), sanitiseForFirestore({...bd}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    // Push wishlist
    const wishlist = db.objectStoreNames.contains('wishlist') ? await dbAll('wishlist') : [];
    for (const w of wishlist) {
      if (!w.fbId) {
        w.fbId = stableWishFbId(w);
        await dbPut('wishlist', w);
      }
      batch.set(fbDoc('wishlist', w.fbId), sanitiseForFirestore({...w}));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    if (count > 0) await batch.commit();
    setFbStatus('on');
    if (!silent) toast('Synced ' + items.length + ' items - ' + sales.length + ' sales - ' + shoeSizes.length + ' sizes', 'ok');
  } catch(e) {
    setFbStatus('error');
    if (!silent) toast('Sync error: ' + e.message, 'err');
    console.error('[SYNC] push error:', e);
  } finally {
    _localWriting = false;
  }
}

async function pullFromFirebase(silent = false) {
  if (!fbReady || !fbDb) {
    if (!silent) toast('Warning: Not connected to Firebase', 'err');
    console.warn('[SYNC] pullFromFirebase called but not ready. fbReady=', fbReady, 'fbDb=', !!fbDb);
    return;
  }
  if (!silent) setFbStatus('syncing');
  _localWriting = true;
  try {
    const { collection, doc, getDocs, deleteDoc } = await waitForFbImports();

    // Pull items
    console.log('[SYNC] Pulling items from Firebase...');
    const itemSnap = await getDocs(fbCol('items'));
    console.log('[SYNC] Firebase has', itemSnap.size, 'items');

    // Batch: load all local items once, build index by fbId and code
    const localItems = await dbAll('items');
    const itemsByFbId = Object.fromEntries(localItems.filter(i=>i.fbId).map(i=>[i.fbId,i]));
    const itemsByCode = Object.fromEntries(localItems.filter(i=>i.code).map(i=>[i.code,i]));
    let itemsAdded = 0, itemsUpdated = 0;
    for (const d of itemSnap.docs) {
      const data = {...d.data(), fbId: d.id };
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

    // Pull sales — match by fbId first, then signature to prevent duplicates
    const saleSnap = await getDocs(fbCol('sales'));
    const localSales = await dbAll('sales');
    const salesByFbId = Object.fromEntries(localSales.filter(s=>s.fbId).map(s=>[s.fbId,s]));
    let salesAdded = 0, salesUpdated = 0;
    for (const d of saleSnap.docs) {
      const data = {...d.data(), fbId: d.id };
      delete data.id;
      if (_isDeletedSaleRemote(d.id, data)) {
        deleteDoc(fbDoc('sales', d.id)).catch(() => {});
        continue;
      }
      // Match by fbId first, then by content signature (prevents duplicate creation)
      const existing = salesByFbId[d.id] || localSales.find(s => _salesMatch(s, data));
      if (existing) {
        data.id = existing.id;
        // Update local fbId if it was missing
        if (!existing.fbId) salesByFbId[d.id] = { ...existing, fbId: d.id };
        await dbPut('sales', data);
        salesUpdated++;
      } else {
        try { await dbAdd('sales', data); salesAdded++; } catch(_) { /* intentionally ignored */ }
      }
    }
    console.log('[SYNC] Sales: added=' + salesAdded + ' updated=' + salesUpdated);

    // Pull shoe_sizes
    try {
      const szSnap = await getDocs(fbCol('shoe_sizes'));
      const localSizes = await dbAll('shoe_sizes');
      const szByFbId = Object.fromEntries(localSizes.filter(s=>s.fbId).map(s=>[s.fbId,s]));
      const szByCS   = Object.fromEntries(localSizes.filter(s=>s.codeSize).map(s=>[s.codeSize,s]));
      for (const d of szSnap.docs) {
        const data = {...d.data(), fbId: d.id }; delete data.id;
        const ex = szByFbId[d.id] || szByCS[data.codeSize];
        if (ex) { data.id = ex.id; await dbPut('shoe_sizes', data); }
        else    { try { await dbAdd('shoe_sizes', data); } catch(_) { /* intentionally ignored */ } }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull finances
    try {
      const finSnap = await getDocs(fbCol('finances'));
      const localFin = await dbAll('finances');
      const finByFbId = Object.fromEntries(localFin.filter(f=>f.fbId).map(f=>[f.fbId,f]));
      for (const d of finSnap.docs) {
        const data = {...d.data(), fbId: d.id }; delete data.id;
        if (_isDeletedFinanceRemote(d.id, data)) {
          deleteDoc(fbDoc('finances', d.id)).catch(() => {});
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
        const wishSnap = await getDocs(fbCol('wishlist'));
        const localWish = await dbAll('wishlist');
        const wishByFbId = Object.fromEntries(localWish.filter(w=>w.fbId).map(w=>[w.fbId,w]));
        for (const d of wishSnap.docs) {
          const data = {...d.data(), fbId: d.id }; delete data.id;
          const ex = wishByFbId[d.id];
          if (ex) { data.id = ex.id; await dbPut('wishlist', data); }
          else    { try { await dbAdd('wishlist', data); } catch(_) { /* intentionally ignored */ } }
        }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull business_days
    try {
      const bdSnap = await getDocs(fbCol('business_days'));
      const localBd = await dbAll('business_days');
      const bdByFbId = Object.fromEntries(localBd.filter(b => b.fbId).map(b => [b.fbId, b]));
      const bdByDate = Object.fromEntries(localBd.map(b => [(b.businessDate || b.business_date), b]));
      for (const d of bdSnap.docs) {
        const data = {...d.data(), fbId: d.id };
        delete data.id;
        const dateKey = data.businessDate || data.business_date;
        const ex = bdByFbId[d.id] || (dateKey ? bdByDate[dateKey] : null);
        if (ex) { data.id = ex.id; await dbPut('business_days', data); }
        else { try { await dbAdd('business_days', data); } catch(_) { /* intentionally ignored */ } }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull customers
    try {
      if (db.objectStoreNames.contains('customers')) {
        const custSnap = await getDocs(fbCol('customers'));
        const localCust = await dbAll('customers');
        const custByFbId = Object.fromEntries(localCust.filter(c => c.fbId).map(c => [c.fbId, c]));
        const custById   = Object.fromEntries(localCust.filter(c => c.customerId).map(c => [c.customerId, c]));
        for (const d of custSnap.docs) {
          const data = {...d.data(), fbId: d.id }; delete data.id;
          const ex = custByFbId[d.id] || custById[data.customerId];
          if (ex) { data.id = ex.id; await dbPut('customers', data); }
          else { try { await dbAdd('customers', data); } catch(_) {} }
        }
      }
    } catch(_) { /* intentionally ignored */ }

    // Pull customer_txns
    try {
      if (db.objectStoreNames.contains('customer_txns')) {
        const txnSnap = await getDocs(fbCol('customer_txns'));
        const localTxns = await dbAll('customer_txns');
        const txnByFbId = Object.fromEntries(localTxns.filter(t => t.fbId).map(t => [t.fbId, t]));
        for (const d of txnSnap.docs) {
          const data = {...d.data(), fbId: d.id }; delete data.id;
          const ex = txnByFbId[d.id];
          if (ex) { data.id = ex.id; await dbPut('customer_txns', data); }
          else { try { await dbAdd('customer_txns', data); } catch(_) {} }
        }
      }
    } catch(_) { /* intentionally ignored */ }

    await refreshUI({ sync: false });
    try { renderSellPage(); } catch(_) { /* intentionally ignored */ }
    setFbStatus('on');

    const msg = 'Pulled ' + itemSnap.size + ' items, ' + saleSnap.size + ' sales from Firebase';
    if (!silent) toast(msg, 'ok');
    else if (itemSnap.size > 0) toast(msg, 'ok');
    console.log('[SYNC] Pull complete:', msg);
  } catch (e) {
    setFbStatus('error');
    console.error('[SYNC] Pull error:', e);
    if (!silent) toast('Pull failed: ' + e.message, 'err');
  } finally {
    _localWriting = false;
  }
}

function disconnectFirebase() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  if (typeof window._fbUnsubSales === 'function') { window._fbUnsubSales(); window._fbUnsubSales = null; }
  if (typeof window._fbUnsubFin === 'function') { window._fbUnsubFin(); window._fbUnsubFin = null; }
  if (typeof window._fbUnsubWish === 'function') { window._fbUnsubWish(); window._fbUnsubWish = null; }
  if (typeof window._fbUnsubSz === 'function') { window._fbUnsubSz(); window._fbUnsubSz = null; }
  if (typeof window._fbUnsubBd === 'function') { window._fbUnsubBd(); window._fbUnsubBd = null; }
  fbApp = null; fbDb = null; fbReady = false;
  localStorage.removeItem('fb_config');
  const cfgInput = document.getElementById('fb-config-input');
  if (cfgInput) cfgInput.value = '';
  setFbStatus('off');
  toast('Firebase disconnected', '');
}

async function reconnectFirebase() {
  toast('Reconnecting...', '');
  await initFirebase();
}

// Single button standing in for the old separate Reconnect/Disconnect pair -
// its label already reflects current state (see setFbStatus()).
async function toggleFirebaseConnection() {
  if (fbReady) {
    disconnectFirebase();
  } else {
    await reconnectFirebase();
  }
}
window.toggleFirebaseConnection = toggleFirebaseConnection;

async function runSyncDebug() {
  const log = document.getElementById('debug-log');
  const localEl = document.getElementById('debug-local-items');
  const fbEl = document.getElementById('debug-fb-items');
  const addLog = msg => { if (log) { log.textContent += msg + '\n'; log.scrollTop = log.scrollHeight; } console.log('[DEBUG]', msg); };

  log.textContent = '';
  addLog('Starting sync debug...');
  addLog('Environment: ' + getFirebaseEnvConfig().label + ' (' + fbColName('items') + ',...)');
  addLog('fbReady=' + fbReady + ' fbDb=' + !!fbDb + ' online=' + navigator.onLine);

  const localItems = await dbAll('items');
  if (localEl) localEl.textContent = localItems.length;
  addLog('Local items: ' + localItems.length);
  addLog('Items with fbId: ' + localItems.filter(i => i.fbId).length);

  if (!fbReady || !fbDb) {
    addLog('Error: Firebase not connected! Reconnecting...');
    await initFirebase();
    if (!fbReady) { addLog('Error: Reconnect failed'); return; }
    addLog('Reconnected');
  }

  try {
    const { collection, getDocs } = await waitForFbImports();
    const snap = await getDocs(fbCol('items'));
    if (fbEl) fbEl.textContent = snap.size;
    addLog('Firebase items: ' + snap.size);

    if (snap.size === 0 && localItems.length > 0) {
      addLog('Firebase empty but local has ' + localItems.length + ' items');
      addLog('Pushing all local items now...');
      await forcePushToFirebase(false);
      addLog('Push complete');
    } else if (snap.size > 0) {
      addLog('Pulling ' + snap.size + ' items from Firebase...');
      await pullFromFirebase(false);
      addLog('Pull complete. Local now: ' + (await dbAll('items')).length);
    } else {
      addLog('Both empty. Add items and push.');
    }
  } catch(e) {
    addLog('Error: Error: ' + e.message);
    console.error('[DEBUG]', e);
  }
}




// ===================================================================
// Day status is tracked in Operations to Day (reports/reconciliation only).
// It does not lock tabs, sheets, sales, or inventory actions.
// ===================================================================

function clearDayTabLocks() {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('disabled'));
  const overlay = document.getElementById('day-closed-overlay');
  if (overlay) overlay.classList.remove('show');
}

// ===================================================================
// BUSINESS DAY MANAGEMENT (Operations tab - tracking & reconciliation)
// ===================================================================

let activeDay = null;
let dayCheckTimer = null;
let _warned1145 = null; // date string of the last 11:45 PM warning shown

// ── DATE / TIME HELPERS ──────────────────────────────────────────────
function todayDateStr() {
  // Use local date, not UTC - important for UTC+3 (Nairobi) where
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

// Legacy helpers - day state no longer gates the rest of the app
function isDayOpen() { return true; }
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
    clearDayTabLocks();
    updateDayBanner();
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
    status:        'OPEN',
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
  return all.find(d => (d.businessDate || d.business_date) === dateStr) || null;
}

// ── OPEN DAY ─────────────────────────────────────────────────────────
async function openDay() {
  const today = todayDateStr();
  let bday = await getBusinessDay(today);
  if (!bday) bday = await createDayRecord(today);

  if (bday.status === 'OPEN')   { toast('Day is already open!', 'err'); return; }
  if (bday.status === 'LOCKED') { toast('This day is archived.', 'err'); return; }

  const isReopen = bday.status === 'CLOSED' && !!bday.opened_at;

  if (!bday.opened_at) {
    // First open of the day - snapshot opening stock value
    const items = await dbAll('items');
    bday.openingStockCost   = items.reduce((s, i) => s + (i.buyPrice  || i.buy  || 0) * (i.qty || 0), 0);
    bday.openingStockRetail = items.reduce((s, i) => s + (i.sellPrice || i.sell || 0) * (i.qty || 0), 0);
  }

  bday.status          = 'OPEN';
  bday.opened_at       = bday.opened_at || new Date().toISOString();
  bday.last_opened_at  = new Date().toISOString();
  if (isReopen) bday.reopened_count = (bday.reopened_count || 0) + 1;

  await dbPut('business_days', bday);
  activeDay = bday;
  clearDayTabLocks();
  updateDayBanner();
  updateDayLiveStats();
  renderDaySessionsList();
  toast(isReopen ? 'Day reopened. Continue recording.' : 'Business day opened.', 'ok');
}

// ── CLOSE DAY ────────────────────────────────────────────────────────
async function closeDay() {
  if (!activeDay || activeDay.status !== 'OPEN') { toast('No open day to close.', 'err'); return; }

  const sales = await dbAll('sales');
  const _dayDate = (activeDay.businessDate || activeDay.business_date);
  const daySales = sales.filter(s => (s.businessDate||s.business_date) === _dayDate);
  const revenue   = daySales.reduce((s, x) => s + x.revenue, 0);
  const profit    = daySales.reduce((s, x) => s + x.profit, 0);
  const itemsSold = daySales.reduce((s, x) => s + x.qty, 0);
  // Note: tracks NEW items added today (by createdAt).
  // Restocks to existing items are not separately tracked - a future
  // 'stock_events' log store would capture this properly.
  const todayStart = (activeDay.businessDate || activeDay.business_date) + 'T00:00:00';
  const items     = await dbAll('items');
  const purchases = items.filter(i => i.createdAt && i.createdAt >= todayStart);
  const closingStockCost = items.reduce((s, i) => s + (i.buyPrice || i.buy || 0) * (i.qty || 0), 0);
  const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;
  const avgSale = daySales.length > 0 ? (revenue / daySales.length) : 0;
  const openT = activeDay.opened_at ? fmtTime(activeDay.opened_at) : '?';
  const nowT  = new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

  // Populate summary sheet
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ds-date',       fmtFullDate((activeDay.businessDate || activeDay.business_date)));
  set('ds-time-range', openT + ' to ' + nowT);
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
    let verdict = 'Quiet day. ' + daySales.length + ' sales.';
    let vBg = 'var(--surface2)', vColor = 'var(--muted)';
    if (daySales.length > 0) {
      const m = parseFloat(margin);
      if (m >= 30) { verdict = 'Excellent! ' + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else if (m >= 15) { verdict = 'Good day! ' + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else { verdict = 'Decent. ' + margin + '% margin.'; vBg = 'var(--amber-light)'; vColor = 'var(--amber)'; }
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
  if (confirmBtn) { confirmBtn.style.display = 'block'; confirmBtn.textContent = 'Confirm Close Day'; }
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
  activeDay.purchaseCost   = purchases.reduce((s, i) => s + (i.buyPrice || i.buy || 0) * (i.qty || 0), 0);
  activeDay.closingStockCost = items.reduce((s, i) => s + (i.buyPrice || i.buy || 0) * (i.qty || 0), 0);

  await dbPut('business_days', activeDay);
  document.getElementById('day-summary-sheet').classList.remove('open');
  clearDayTabLocks();
  updateDayBanner();
  renderDaySessionsList();
  renderDashboard();
  toast('Day closed. You can reopen it from Operations to Day anytime.', 'ok');
  scheduleSync();
}

// cancelCloseDay: handled by day reconciliation flow below

// ── BANNER LIVE CLOCK - refresh duration display every minute ────────
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
async function _deleteLocalRevenueForSale(saleId) {
  const localFin = await dbAll('finances');
  for (const f of localFin) {
    if (f.type === 'revenue' && (f.saleId === saleId)) {
      await dbDelete('finances', f.id);
    }
  }
}

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
  const finPayload = {
    type: 'revenue',
    saleId: sale.id,
    amount: sale.revenue,
    date: sale.businessDate || (sale.date || '').split('T')[0],
    description: 'Sale: ' + (sale.itemName || sale.itemCode || 'item')
  };
  await fbDeleteFinanceEntry(finPayload);
  await _deleteLocalRevenueForSale(saleId);
  await dbDelete('sales', saleId);

  // Refresh
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList(); renderDashboard(); updateHeader();
  if (activeDay) updateDayLiveStats();
  try { renderFinancePage(); } catch(_) { /* intentionally ignored */ }
  scheduleSync();
  toast('Sale voided - stock restored', 'ok');
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
    icon.textContent  = 'Open';
    badge.textContent = 'OPEN';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#dcfce7;color:#16a34a;';
    title.textContent = 'Business Day Open';
    title.style.color = 'var(--green)';
    sub.textContent   = 'Opened ' + fmtTime(opened_at)
      + ' - ' + dur + ' running'
      + (reopened_count > 0 ? ' - Reopened ' + reopened_count + 'x' : '');
    if (actionArea) actionArea.innerHTML = '';  // Day tab handles its own buttons now
    clearDayTabLocks();
    updateDayLiveStats();
  } else if (status === 'CLOSED') {
    banner.style.cssText = 'background:#fef3c7;border:2px solid #f5d9a0;border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = 'Closed';
    badge.textContent = 'CLOSED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#fef3c7;color:#92400e;';
    title.textContent = 'Business Day Closed';
    title.style.color = '#d97706';
    sub.textContent   = closed_at
      ? 'Closed at ' + fmtTime(closed_at) + (auto_closed ? ' - auto' : '') + (reopened_count > 0 ? ' - Opened ' + (reopened_count + 1) + 'x today' : '') + ' - Tap to reopen'
      : 'Tap Open Day to begin - ' + fmtFullDate(todayDateStr());
    if (actionArea) actionArea.innerHTML = '';
    clearDayTabLocks();
    updateDayLiveStats();
  } else if (status === 'LOCKED') {
    banner.style.cssText = 'background:var(--surface2);border:2px solid var(--border);border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = 'Locked';
    badge.textContent = 'LOCKED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:var(--surface2);color:var(--muted);';
    title.textContent = 'Archived Day';
    title.style.color = 'var(--muted)';
    sub.textContent   = fmtFullDate((activeDay.businessDate || activeDay.business_date)) + ' - archived';
    if (actionArea) actionArea.innerHTML = '';
    clearDayTabLocks();
    updateDayLiveStats();
  }
}

// ── LIVE STATS - full cash flow summary ─────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay) return;
  // Always the real calendar date - same as the Dashboard's "Today" filter -
  // so these live figures never drift out of sync with it. (activeDay.businessDate
  // can lag behind if the app stays open across midnight without a reload.)
  const today  = todayDateStr();
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
        label: (s.itemName||s.itemCode||'Sale') + (s.itemSize ? '  - '+s.itemSize : ''),
        sub:   (s.qty||1) + ' pc' + ((s.qty||1)!==1?'s':''),
        amt:   s.revenue||0,
        color: 'var(--green)',
        sign:  '+',
        id:    s.id,
        canVoid: true,
      })),
     ...dayFins.map(e => {
        const isMinus = e.type==='expense'||e.type==='withdrawal'||e.type==='stock_purchase';
        const icons = {injection:'Inject',investment:'Invest',stock_purchase:'Stock',expense:'Expense',withdrawal:'Withdraw',other:'Other'};
        return {
          time:  e.date ? e.date+'T12:00:00' : e.createdAt,
          type:  'finance',
          label: icons[e.type]||'Other' + ' ' + (e.description||e.type),
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
            <div class="day-txn-sub">${t.time ? fmtTime(t.time) : ''} - ${t.sub}</div>
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
    .filter(d => (d.businessDate || d.business_date) !== today && (d.status === 'CLOSED' || d.status === 'LOCKED'))
    .sort((a, b) => (b.businessDate || b.business_date || '').localeCompare(a.businessDate || a.business_date || ''));

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
        '<div style="font-size:14px;font-weight:800;color:var(--text);">' + fmtFullDate(s.businessDate || s.business_date) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">' +
          ((s.openedAt || s.opened_at) ? fmtTime(s.openedAt || s.opened_at) : '-') + ' to ' +
          ((s.closedAt || s.closed_at) ? fmtTime(s.closedAt || s.closed_at) : 'auto') +
          ((s.reopenedCount || s.reopened_count || 0) > 0 ? ' - Reopened ' + (s.reopenedCount || s.reopened_count) + 'x' : '') +
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

// ── View past session detail ──────────────────────────────────────────
async function viewPastSession(id) {
  const bday = await dbGet('business_days', id);
  if (!bday) { toast('Session not found', 'err'); return; }
  const date = bday.businessDate || bday.business_date || '';
  const revenue = fmt(bday.revenue || 0);
  const profit  = fmt(bday.profit  || 0);
  const sales   = bday.salesCount  || 0;
  toast(fmtFullDate(date) + ' — Rev: ' + revenue + ', Profit: ' + profit + ', Sales: ' + sales, 'ok');
}
window.viewPastSession = viewPastSession;

// ═══════════════════════════════════════════════════════════
// RESTOCK
// ═══════════════════════════════════════════════════════════
async function toggleRestock() {
  const panel = document.getElementById('restock-panel');
  if (!panel) return;
  const item = currentDetailId ? await dbGet('items', currentDetailId) : null;
  if (item?.isShoe) {
    toast('Pick a size from the grid, then restock that size', 'err');
    return;
  }
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  if (panel.style.display !== 'block') return;
  const buyEl = document.getElementById('restock-buy');
  const sellEl = document.getElementById('restock-sell');
  const qtyEl = document.getElementById('restock-qty');
  if (item && buyEl) buyEl.value = item.buyPrice ?? item.buy ?? item.defaultBuy ?? '';
  if (item && sellEl) sellEl.value = item.sellPrice ?? item.sell ?? item.defaultSell ?? '';
  if (qtyEl) qtyEl.value = '';
  updateDetailRestockBtnLabel();
  (qtyEl || buyEl)?.focus();
}

function updateDetailRestockBtnLabel() {
  const btn = document.getElementById('detail-restock-btn');
  if (!btn) return;
  const sizeEl = document.getElementById('sh-size');
  const sizeText = sizeEl ? (sizeEl.textContent || '').trim() : '';
  const hasSize = sizeText && sizeText !== '-';
  btn.textContent = hasSize ? 'RESTOCK (' + sizeText + ')' : 'RESTOCK';
}

async function confirmRestock() {
  const restockBtn = document.getElementById('detail-restock-btn');
  if (restockBtn) { restockBtn.disabled = true; restockBtn.style.opacity = '0.5'; }
  try {
    const qty = parseInt(document.getElementById('restock-qty').value);
    if (!Validate.restockQty(qty, 'restock-qty')) return;
    const buyRaw = Input.money('restock-buy');
    const sellRaw = Input.money('restock-sell');
    if (buyRaw !== null && buyRaw < 0) return Validate.fail('Invalid buy price', 'restock-buy');
    if (sellRaw !== null && sellRaw < 0) return Validate.fail('Invalid sell price', 'restock-sell');
    const item = await dbGet('items', currentDetailId);
    if (!item) { toast('Warning: Item not found', 'err'); return; }
    if (item.isShoe) {
      toast('Restock a shoe size from the size list', 'err');
      return;
    }
    const unitBuy = buyRaw !== null ? buyRaw : (item.buyPrice || item.buy || 0);
    if (sellRaw !== null) {
      item.sellPrice = sellRaw;
    }
    if (buyRaw !== null) {
      item.buyPrice  = buyRaw;
    }
    item.qty += qty;
    item.updatedAt = new Date().toISOString();
    await dbPut('items', item);
    await recordStockInvestment(item, qty * unitBuy, qty, 'Restock');
    fbSyncItem(item);
    scheduleSync();
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('sh-buy', fmt(item.buyPrice || item.buy || 0));
    set('sh-sell', fmt(item.sellPrice || item.sell || 0));
    set('sh-qty', item.qty + ' pcs');
    const panel = document.getElementById('restock-panel');
    if (panel) panel.style.display = 'none';
    allItems = await dbAll('items');
    await enrichShoeItems(allItems);
    renderList(); renderDashboard(); updateHeader();
    updateLowStockBadge();
    toast('Added ' + qty + ' pcs to ' + (item.name || item.code), 'ok');
  } catch(e) {
    console.error('[confirmRestock]', e);
    toast('Warning: Restock failed: ' + e.message, 'err');
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
    await _deleteLocalRevenueForSale(saleId);
  }
  await dbDelete('sales', saleId);
  await refreshUI();
  refreshSalesViews();
  renderFinancePage();
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
const _wishDetailSheet = document.getElementById('wishlist-detail-sheet');
if (_wishDetailSheet) _wishDetailSheet.addEventListener('click', function(e) {
  if (e.target === this) closeWishlistDetail();
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
    ['update-progress-label','upd-progress-label'].forEach(id=>{const el=document.getElementById(id);if(el)el.textContent='Reloading...';});
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
      '1. Tap the <strong>⋮ menu</strong> at the top right',
      '2. Tap <strong>"Add page to"</strong> to <strong>"Home screen"</strong>',
      '3. Tap <strong>Add</strong> - done!'
    ],
    firefox: [
      '1. Tap the <strong>⋮ menu</strong> at the top right',
      '2. Tap <strong>"Install"</strong> or <strong>"Add to Home Screen"</strong>',
      '3. Tap <strong>Add</strong> - done!'
    ],
    safari: [
      '1. Tap the <strong>Share button ↑</strong> at the bottom',
      '2. Scroll down to tap <strong>"Add to Home Screen"</strong>',
      '3. Tap <strong>Add</strong> - done!'
    ],
    chrome: [
      '1. Tap the <strong>⋮ menu</strong> at the top right',
      '2. Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong>',
      '3. Tap <strong>Add</strong> - done!'
    ],
    edge: [
      '1. Tap the <strong>... menu</strong> at the bottom',
      '2. Tap <strong>"Add to phone"</strong>',
      '3. Tap <strong>Add</strong> - done!'
    ],
    other: [
      '1. Open your <strong>browser menu</strong>',
      '2. Look for <strong>"Add to Home Screen"</strong>',
      '3. Tap <strong>Add</strong> - done!'
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
  toast('App installed on home screen!', 'ok');
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
  const roleLabels = { super: 'Super User - Full Access', user: 'User - Standard Access', clerk: 'Clerk - Limited Access' };
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
  updateFirebaseEnvUI();
  updateUpgradeStepUI(
    document.getElementById('update-state-available')?.style.display !== 'none' ? 'available'
    : document.getElementById('update-state-installing')?.style.display !== 'none' ? 'installing'
    : 'current'
  );
}

// backdrop close
function initCleanNumericInputs() {
  document.addEventListener('focusin', e => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
    const v = (el.value || '').trim();
    if (v === '0' || v === '0.0' || v === '0.00') el.value = '';
    el.dataset.touched = '1';
  });
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number') return;
    const v = (el.value || '').trim();
    if (v === '') {
      el.style.borderColor = '';
      return;
    }
    const n = parseFloat(v);
    if (!Number.isFinite(n)) {
      el.style.borderColor = 'var(--red)';
      toast('Enter a valid number', 'err');
    } else if (n < 0) {
      el.style.borderColor = 'var(--red)';
      toast('Amount cannot be negative', 'err');
    } else {
      el.style.borderColor = '';
    }
  });
}

// ===== PHOTO VIEWER - pan, pinch-zoom, double-tap fullscreen =====
const _photoViewerRegistry = new Map();

function ensurePhotoLightbox() {
  let lb = document.getElementById('photo-lightbox');
  if (lb) return lb;
  lb = document.createElement('div');
  lb.id = 'photo-lightbox';
  lb.className = 'photo-lightbox';
  lb.hidden = true;
  lb.innerHTML =
    '<button type="button" class="photo-lightbox-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>' +
    '<div class="photo-lightbox-viewport" id="photo-lightbox-viewport">' +
    '<img id="photo-lightbox-img" class="photo-pan-img" alt="">' +
    '</div>';
  lb.querySelector('.photo-lightbox-close').addEventListener('click', closePhotoLightbox);
  lb.addEventListener('click', e => { if (e.target === lb) closePhotoLightbox(); });
  document.body.appendChild(lb);
  attachPhotoViewer(
    document.getElementById('photo-lightbox-viewport'),
    document.getElementById('photo-lightbox-img'),
    { key: 'lightbox', allowFullscreen: false }
  );
  return lb;
}

function openPhotoLightbox(src) {
  if (!src) return;
  const lb = ensurePhotoLightbox();
  const img = document.getElementById('photo-lightbox-img');
  if (!img) return;
  img.src = src;
  lb.hidden = false;
  document.body.classList.add('photo-lightbox-open');
  const viewer = _photoViewerRegistry.get('lightbox');
  if (viewer) requestAnimationFrame(() => viewer.reset());
}
window.openPhotoLightbox = openPhotoLightbox;

function closePhotoLightbox() {
  const lb = document.getElementById('photo-lightbox');
  if (!lb) return;
  lb.hidden = true;
  document.body.classList.remove('photo-lightbox-open');
}
window.closePhotoLightbox = closePhotoLightbox;

function attachPhotoViewer(viewport, img, options) {
  if (!viewport || !img) return null;
  const key = (options && options.key) || viewport.id || ('pv' + _photoViewerRegistry.size);
  if (_photoViewerRegistry.has(key)) return _photoViewerRegistry.get(key);

  const allowFullscreen = !options || options.allowFullscreen !== false;
  const isActive = (options && options.isActive) || (() => !!img.src && img.style.display !== 'none');

  viewport.classList.add('photo-viewport');
  img.classList.add('photo-pan-img');

  const state = {
    scale: 1, tx: 0, ty: 0, minScale: 1, maxScale: 5,
    pointers: new Map(),
    dragStart: null,
    moved: false,
    lastTap: 0, lastTapX: 0, lastTapY: 0
  };

  function metrics() {
    const r = viewport.getBoundingClientRect();
    const iw = img.naturalWidth || 1;
    const ih = img.naturalHeight || 1;
    const cover = Math.max(r.width / iw, r.height / ih);
    return { vw: r.width, vh: r.height, iw, ih, cover };
  }

  function clampPan() {
    const { vw, vh, iw, ih } = metrics();
    const sw = iw * state.scale;
    const sh = ih * state.scale;
    const maxX = Math.max(0, (sw - vw) / 2);
    const maxY = Math.max(0, (sh - vh) / 2);
    state.tx = Math.min(maxX, Math.max(-maxX, state.tx));
    state.ty = Math.min(maxY, Math.max(-maxY, state.ty));
  }

  function applyTransform() {
    const { cover } = metrics();
    state.minScale = cover;
    if (state.scale < state.minScale) state.scale = state.minScale;
    if (state.scale > state.maxScale) state.scale = state.maxScale;
    clampPan();
    img.style.transform =
      'translate(calc(-50% + ' + state.tx + 'px), calc(-50% + ' + state.ty + 'px)) scale(' + state.scale + ')';
  }

  function layoutImage() {
    const { iw, ih } = metrics();
    img.style.position = 'absolute';
    img.style.left = '50%';
    img.style.top = '50%';
    img.style.width = iw + 'px';
    img.style.height = ih + 'px';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.objectFit = 'none';
    img.style.transformOrigin = 'center center';
    img.style.userSelect = 'none';
    img.style.webkitUserDrag = 'none';
  }

  function reset() {
    if (!isActive()) return;
    const { cover } = metrics();
    state.scale = cover;
    state.tx = 0;
    state.ty = 0;
    layoutImage();
    applyTransform();
  }

  function pointerDist() {
    const pts = [...state.pointers.values()];
    if (pts.length < 2) return 0;
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.hypot(dx, dy);
  }

  function onPointerDown(e) {
    if (!isActive()) return;
    if (e.target.closest('.add-photo-remove, .photo-lightbox-close, #sh-photo-btn')) return;
    viewport.setPointerCapture(e.pointerId);
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    state.moved = false;
    if (state.pointers.size === 1) {
      state.dragStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    } else if (state.pointers.size === 2) {
      state.pinchStartDist = pointerDist();
      state.pinchStartScale = state.scale;
    }
  }

  function onPointerMove(e) {
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.pointers.size >= 2 && state.pinchStartDist > 0) {
      const dist = pointerDist();
      if (dist > 0) {
        state.scale = state.pinchStartScale * (dist / state.pinchStartDist);
        applyTransform();
        state.moved = true;
      }
      return;
    }
    if (state.pointers.size === 1 && state.dragStart) {
      const dx = e.clientX - state.dragStart.x;
      const dy = e.clientY - state.dragStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.moved = true;
      state.tx = state.dragStart.tx + dx;
      state.ty = state.dragStart.ty + dy;
      applyTransform();
    }
  }

  function onPointerUp(e) {
    if (!state.pointers.has(e.pointerId)) return;
    state.pointers.delete(e.pointerId);
    try { viewport.releasePointerCapture(e.pointerId); } catch (_) { /* intentionally ignored */ }

    if (state.pointers.size === 0) {
      if (!state.moved && allowFullscreen) {
        const now = Date.now();
        const dx = e.clientX - state.lastTapX;
        const dy = e.clientY - state.lastTapY;
        if (now - state.lastTap < 380 && dx * dx + dy * dy < 900) {
          openPhotoLightbox(img.src);
          state.lastTap = 0;
        } else {
          state.lastTap = now;
          state.lastTapX = e.clientX;
          state.lastTapY = e.clientY;
        }
      }
      state.dragStart = null;
      state.pinchStartDist = 0;
    } else if (state.pointers.size === 1) {
      state.dragStart = {
        x: [...state.pointers.values()][0].x,
        y: [...state.pointers.values()][0].y,
        tx: state.tx,
        ty: state.ty
      };
    }
  }

  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  img.addEventListener('dblclick', e => {
    e.preventDefault();
    e.stopPropagation();
    if (allowFullscreen && isActive()) openPhotoLightbox(img.src);
  });
  img.addEventListener('load', () => requestAnimationFrame(reset));

  const viewer = { reset, key };
  _photoViewerRegistry.set(key, viewer);
  if (key === 'detail') window._resetPhotoPan = reset;
  return viewer;
}

function initPhotoViewers() {
  attachPhotoViewer(
    document.getElementById('sh-photo-pan'),
    document.getElementById('sh-photo-img'),
    {
      key: 'detail',
      isActive: () => {
        const pan = document.getElementById('sh-photo-pan');
        return pan && pan.style.display !== 'none' && !!document.getElementById('sh-photo-img')?.src;
      }
    }
  );
  attachPhotoViewer(
    document.getElementById('add-photo-preview'),
    document.getElementById('add-photo-img'),
    {
      key: 'add',
      isActive: () => !!_addFormPhotoData && document.getElementById('add-photo-img')?.style.display !== 'none'
    }
  );
  attachPhotoViewer(
    document.querySelector('.wish-photo-box'),
    document.getElementById('wish-photo-img'),
    {
      key: 'wish',
      isActive: () => !!_wishFormPhotoData && document.getElementById('wish-photo-img')?.style.display !== 'none'
    }
  );
  attachPhotoViewer(
    document.getElementById('wd-photo-wrap'),
    document.getElementById('wd-photo-img'),
    {
      key: 'wishDetail',
      isActive: () => document.getElementById('wd-photo-img')?.style.display !== 'none'
    }
  );
}

document.addEventListener('DOMContentLoaded', () => {
  setLoginReady(!!_appDbReady);
  initCleanNumericInputs();
  initWishlistScreenshotWatch();
  initPhotoViewers();
  const ps = document.getElementById('profile-sheet');
  if (ps) ps.addEventListener('click', e => { if (e.target === ps) closeProfileSheet(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePhotoLightbox();
  });
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
    tabs: ['dash','inventory','sell','customers','operations','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    pinHash: '38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','inventory','sell','customers','operations']
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

let currentUser = null;
let _appDbReady = false;
let _appDataBootstrapped = false;

function navAccessKey(id) {
  if (id === 'list' || id === 'wishlist' || id === 'add' || id === 'monitor') return 'inventory';
  if (id === 'day' || id === 'finance') return 'operations';
  if (id === 'history') return 'sell';
  return id;
}

function userCanAccessNav(id, user) {
  const key = navAccessKey(id);
  if (key === 'sell' && user.tabs.includes('history')) return true;
  return user.tabs.includes(key);
}

function resolveLandingPage(user, rawLastPage) {
  let last = rawLastPage || 'dash';
  if (last === 'day' || last === 'finance') {
    _activeOperationsTab = last;
    last = 'operations';
  }
  if (last === 'list' || last === 'wishlist' || last === 'add' || last === 'monitor') {
    _activeInventoryTab = last === 'list' ? 'stock' : last;
    last = 'inventory';
  }
  if (last === 'history') {
    _activeSalesTab = 'history';
    last = 'sell';
  }
  if (userCanAccessNav(last, user)) return last;
  if (user.role === 'clerk' && user.tabs.includes('inventory')) {
    _activeInventoryTab = 'add';
    return 'inventory';
  }
  return user.tabs[0] || 'dash';
}

async function waitForAppDb(timeoutMs = 30000) {
  if (_appDbReady && db) return;
  const start = Date.now();
  while (!_appDbReady || !db) {
    if (Date.now() - start > timeoutMs) throw new Error('Database not ready');
    await new Promise(r => setTimeout(r, 50));
  }
}

async function bootstrapAppData() {
  if (_appDataBootstrapped) return;
  _appDataBootstrapped = true;
  await loadActiveDay();
  try { await _cleanupFinanceCoherence(true); } catch (_) { /* intentionally ignored */ }
  renderDashboard();
  renderList();
  renderSummary();
  renderSellPage();
  updateLowStockBadge();
}

function setLoginReady(ready) {
  const btn = document.querySelector('#login-screen .login-btn');
  if (!btn) return;
  if (ready) {
    btn.disabled = false;
    if (btn.dataset.loadingLabel) btn.textContent = btn.dataset.loadingLabel;
    delete btn.dataset.loadingLabel;
  } else {
    if (!btn.dataset.loadingLabel) btn.dataset.loadingLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Loading app...';
  }
}

function shakeLogin() {
  const card = document.querySelector('#login-screen .login-card');
  if (!card) return;
  card.classList.remove('login-shake');
  void card.offsetWidth;
  card.classList.add('login-shake');
}

function finishAuthUI(user) {
  document.getElementById('login-screen').style.display = 'none';
  applyRoleRestrictions(user);
  clearDayTabLocks();
  const pill = document.getElementById('user-pill');
  if (pill) {
    pill.style.display = 'inline-flex';
    pill.innerHTML = '<i class="fa-solid fa-user" style="font-size:12px;"></i> ' + user.name;
  }
  const wrap = document.getElementById('user-menu-wrap');
  if (wrap) wrap.style.display = 'block';
}

function applyRoleRestrictions(user) {
  tidySettingsPage();
  const allTabs = ['dash','inventory','sell','list','wishlist','add','history','operations','finance','day','settings'];
  allTabs.forEach(tab => {
    const btn = document.getElementById('tab-' + tab);
    if (!btn) return;
    if (tab === 'history') {
      btn.style.display = 'none';
      return;
    }
    if (tab === 'sell') {
      btn.style.display = userCanAccessNav('sell', user) ? '' : 'none';
      return;
    }
    if (tab === 'list' || tab === 'wishlist' || tab === 'add') {
      btn.style.display = 'none';
      return;
    }
    if (tab === 'finance' || tab === 'day') {
      btn.style.display = userCanAccessNav(tab, user) ? '' : 'none';
      return;
    }
    btn.style.display = user.tabs.includes(tab) ? '' : 'none';
  });

  const header = document.querySelector('.header-title');
  if (header) {
    header.textContent = user.role === 'clerk' ? 'Add Stock - Mandela' : 'Mandela General Stores';
  }
  if (user.role === 'clerk' && user.tabs.includes('inventory')) {
    _activeInventoryTab = 'add';
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
  localStorage.removeItem(KEY_LAST_PAGE);
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



async function attemptLogin() {
  const username = document.getElementById('login-user').value.trim().toLowerCase();
  const pin = document.getElementById('login-pin').value.trim();
  const err = document.getElementById('login-error');

  if (!username || !pin) {
    err.style.display = 'block';
    shakeLogin();
    return;
  }

  const hash = await hashPin(pin);
  const user = USERS.find(u => u.username === username && u.pinHash === hash);
  if (!user) {
    err.style.display = 'block';
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
    shakeLogin();
    return;
  }

  err.style.display = 'none';
  currentUser = user;
  localStorage.setItem(KEY_SESSION, JSON.stringify({ username: user.username, ts: Date.now() }));

  try {
    await waitForAppDb();
    await bootstrapAppData();
  } catch (e) {
    currentUser = null;
    localStorage.removeItem(KEY_SESSION);
    toast('App still loading - try again in a moment', 'err');
    return;
  }

  finishAuthUI(user);
  _origShowPage(resolveLandingPage(user, localStorage.getItem(KEY_LAST_PAGE)));
  toast('Welcome, ' + user.name + '!', 'ok');
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
    const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days - never expire on normal use
    const expired  = ts > 0 && (Date.now() - ts) > SESSION_TTL;
    const user     = USERS.find(u => u.username === username);

    if (user && !expired) {
      localStorage.setItem(KEY_SESSION, JSON.stringify({ username, ts: Date.now() }));
      currentUser = user;
      finishAuthUI(user);
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
  if(e.reason&&e.reason.message&&e.reason.message.includes('Database'))toast('Warning: '+e.reason.message,'err');
});

// ── APP UPDATE SYSTEM ─────────────────────────────────────────────
let _pendingWorker = null;
let _updateBannerDismissed = false;

function _showUpdateState(state) {
  ['current','available','installing'].forEach(s => {
    const el = document.getElementById('update-state-' + s);
    if (el) el.style.display = s === state ? '' : 'none';
  });
  updateUpgradeStepUI(state);
}

function updateUpgradeStepUI(state) {
  const installBtn = document.getElementById('update-install-btn');
  const idleNote   = document.getElementById('upgrade-step-2-idle');
  const stepIds    = ['upgrade-step-1','upgrade-step-2','upgrade-step-3'];
  stepIds.forEach(id => document.getElementById(id)?.classList.remove('settings-step--active'));

  if (state === 'available') {
    if (installBtn) installBtn.style.display = '';
    if (idleNote)   idleNote.style.display   = 'none';
    document.getElementById('upgrade-step-2')?.classList.add('settings-step--active');
  } else if (state === 'installing') {
    if (installBtn) installBtn.style.display = 'none';
    if (idleNote)   idleNote.style.display   = 'none';
    document.getElementById('upgrade-step-3')?.classList.add('settings-step--active');
  } else {
    if (installBtn) installBtn.style.display = 'none';
    if (idleNote)   idleNote.style.display   = '';
    document.getElementById('upgrade-step-1')?.classList.add('settings-step--active');
  }
}

function _setUpdateLastCheck() {
  const el = document.getElementById('update-last-check');
  if (el) el.textContent = 'Checked: ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  if (typeof updateUpgradeStepUI === 'function') {
    const st = document.getElementById('update-state-available');
    const installing = document.getElementById('update-state-installing');
    updateUpgradeStepUI(
      st && st.style.display !== 'none' ? 'available'
      : installing && installing.style.display !== 'none' ? 'installing'
      : 'current'
    );
  }
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
  if (installBtn) { installBtn.disabled = false; installBtn.style.opacity = '1'; installBtn.textContent = 'Install update now'; }
  if (laterBtn)   laterBtn.style.display  = 'block';
  // Show banner
  banner.style.display = 'flex';
}

function dismissAppUpdate() {
  const banner = document.getElementById('app-update-banner');
  if (banner) banner.style.display = 'none';
  _updateBannerDismissed = true;
  // Keep the dot on settings tab so they can still find it
  toast('Update ready - tap Settings to install when ready', '');
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
    { pct:15,  lbl:'Downloading update...',     delay:0   },
    { pct:35,  lbl:'Verifying files...',         delay:400 },
    { pct:55,  lbl:'Installing...',              delay:700 },
    { pct:75,  lbl:'Clearing old cache...',      delay:1100},
    { pct:90,  lbl:'Finalising...',              delay:1500},
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
  // controllerchange will fire to reloads page; we also update settings card
  _showUpdateState('installing');
}

// Legacy alias kept for settings page button
function installAppUpdate() { applyAppUpdate(); }

// ===================================================================
// FINANCE MODULE
// Tracks: investments, expenses, withdrawals, other money flows
// ===================================================================

let _finFilter = 'all';

async function deleteFinanceEntry(id) {
  if (!confirm('Delete this transaction? This cannot be undone.')) return;
  const entry = await dbGet('finances', id);
  if (entry) {
    _rememberDeletedFinance(entry);
    await fbDeleteFinanceEntry(entry);
  }
  await dbDelete('finances', id);
  renderFinancePage();
  renderDashboard();
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
    injection: '#dcfce7',
    expense: '#fee2e2',
    withdrawal: '#fef3c7'
  };
  sel.style.background = colors[sel.value] || '';
  const catEl = document.getElementById('fin-category');
  if (catEl) {
    const autoCat = {
      injection: 'owner_capital',
      expense: 'general',
      withdrawal: 'cash_drawer'
    };
    catEl.value = autoCat[sel.value] || 'general';
  }
}


// ── Shoe group expand/collapse ────────────────────────────────────
async function _cleanupFinanceCoherence(force) {
  if (!force && window._financeCoherenceCleaned) return;
  window._financeCoherenceCleaned = true;
  const entries = await dbAll('finances');
  let changedAny = false;
  for (const e of entries) {
    if (e.type === 'reconciliation' || e.type === 'revenue') {
      await dbDelete('finances', e.id);
      changedAny = true;
      continue;
    }
    let changed = false;
    if (e.type === 'investment') { e.type = 'injection'; changed = true; }
    if (e.type === 'other') { e.type = 'expense'; changed = true; }
    if (changed) { await dbPut('finances', e); changedAny = true; }
  }
  if (changedAny) scheduleSync();
}

async function reconcileFinances() {
  if (!confirm(
    'Rebuild finance figures from sales and manual entries?\n\n' +
    'Removes duplicate auto-sale rows and old reconciliation entries.'
  )) return;
  window._financeCoherenceCleaned = false;
  const sales = await dbAll('sales');
  const saleIds = new Set(sales.map(s => s.id));
  const finances = await dbAll('finances');
  let removed = 0;
  for (const e of finances) {
    const drop =
      e.type === 'reconciliation' ||
      e.type === 'revenue' ||
      (e.saleId && !saleIds.has(e.saleId));
    if (!drop) continue;
    if (e.fbId && fbReady && fbDb) {
      try {
        const { doc, deleteDoc } = await waitForFbImports();
        await deleteDoc(fbDoc('finances', e.fbId));
      } catch(_) { /* intentionally ignored */ }
    }
    await dbDelete('finances', e.id);
    removed++;
  }
  await _cleanupFinanceCoherence(true);
  if (fbReady && fbDb) await forcePushToFirebase(true);
  window._finReconcileUnlocked = false;
  _showFinReconcile(false);
  renderFinancePage();
  renderDashboard();
  toast('Finances reconciled - removed ' + removed + ' duplicate row(s)', 'ok');
}
window.reconcileFinances = reconcileFinances;

async function _computeFinanceMovement() {
  await _cleanupFinanceCoherence();
  const finances = await dbAll('finances');
  const sales = await dbAll('sales');
  const cleanFin = finances.filter(e => e.type !== 'reconciliation' && e.type !== 'revenue');
  const cashToBusiness = cleanFin.filter(e => e.type === 'injection' || e.type === 'investment').reduce((s,e)=>s+(e.amount||0),0);
  const stockAdded = cleanFin.filter(e => e.type === 'stock_purchase').reduce((s,e)=>s+(e.amount||0),0);
  const businessSpend = cleanFin.filter(e => e.type === 'expense' || e.type === 'other').reduce((s,e)=>s+(e.amount||0),0);
  const personalWithdraws = cleanFin.filter(e => e.type === 'withdrawal').reduce((s,e)=>s+(e.amount||0),0);
  const salesRevenue = sales.reduce((s,e)=>s+(e.revenue||0),0);
  const salesProfit = sales.reduce((s,e)=>s+(e.profit||0),0);
  const salesCostOut = sales.reduce((s,e)=>{
    const cost = Number.isFinite(e.buyPrice) && e.qty ? (e.buyPrice||0) * (e.qty||0) : ((e.revenue||0) - (e.profit||0));
    return s + Math.max(0, cost || 0);
  },0);
  const businessPool = cashToBusiness + stockAdded - salesCostOut + salesProfit - businessSpend - personalWithdraws;
  return { finances: cleanFin, sales, cashToBusiness, stockAdded, businessSpend, personalWithdraws, salesRevenue, salesProfit, salesCostOut, businessPool };
}

function _setFinanceRecordOptions() {
  const sel = document.getElementById('fin-type');
  if (!sel) return;
  const cur = ['injection','expense','withdrawal'].includes(sel.value) ? sel.value : '';
  sel.innerHTML =
    '<option value="">Select...</option>' +
    '<option value="injection">Cash to Business</option>' +
    '<option value="expense">Business Expenses</option>' +
    '<option value="withdrawal">Personal Withdraws</option>';
  sel.value = cur;
}

let renderFinancePage;
renderFinancePage = async function() {
  const dateEl = document.getElementById('fin-date');
  if (dateEl && !dateEl.value) dateEl.value = todayDateStr();
  _setFinanceRecordOptions();
  const money = await _computeFinanceMovement();
  const setT = (id, v) => { const el=document.getElementById(id); if(el) el.textContent=fmt(v); };
  const setLabel = (id, text) => {
    const el = document.getElementById(id);
    const lbl = el && el.parentElement ? el.parentElement.querySelector('.fin-kpi-lbl') : null;
    if (lbl) lbl.textContent = text;
  };
  setLabel('fin-net', 'Business Pool');
  setLabel('fin-invested', 'Sales Out');
  setLabel('fin-revenue', 'Revenue');
  setLabel('fin-profit', 'Profit Realized');
  setLabel('fin-expenses', 'Business Spend');
  setLabel('fin-withdrawn', 'Personal Withdraw');
  setT('fin-net', money.businessPool);
  setT('fin-invested', money.salesCostOut);
  setT('fin-revenue', money.salesRevenue);
  setT('fin-profit', money.salesProfit);
  setT('fin-expenses', money.businessSpend);
  setT('fin-withdrawn', money.personalWithdraws);
  const netEl = document.getElementById('fin-net');
  const netKpi = document.getElementById('fin-net-kpi');
  if (netEl) netEl.style.color = money.businessPool >= 0 ? 'var(--green)' : 'var(--red)';
  if (netKpi) netKpi.className = 'fin-kpi ' + (money.businessPool >= 0 ? 'green' : 'red');
  const filterInvestment = document.getElementById('fin-filter-investment');
  const filterExpense = document.getElementById('fin-filter-expense');
  if (filterInvestment) filterInvestment.textContent = 'Business';
  if (filterExpense) filterExpense.textContent = 'Out';

  const saleRows = money.sales.map(s => ({
    id: 'sale_' + s.id,
    type: 'sale_out',
    amount: Math.max(0, (s.revenue||0) - (s.profit||0)),
    profit: s.profit || 0,
    revenue: s.revenue || 0,
    description: 'Sale: ' + (s.itemName || s.itemCode || 'item') + ' x ' + (s.qty || 1),
    date: s.businessDate || (s.date || '').split('T')[0],
    createdAt: s.date,
    isSaleRow: true
  }));
  const financeRows = money.finances.filter(e => ['injection','stock_purchase','expense','withdrawal'].includes(e.type));
  let listEntries = [...financeRows,...saleRows];
  if (_finFilter === 'investment') listEntries = listEntries.filter(e => e.type === 'injection' || e.type === 'stock_purchase');
  if (_finFilter === 'expense') listEntries = listEntries.filter(e => e.type === 'expense' || e.type === 'withdrawal' || e.type === 'sale_out');
  listEntries.sort((a,b)=>new Date(b.date||b.createdAt||0)-new Date(a.date||a.createdAt||0));
  const summaryLine = document.getElementById('fin-summary-line');
  if (summaryLine) {
    summaryLine.textContent = 'Pool ' + fmt(money.businessPool) + ' - Cash in ' + fmt(money.cashToBusiness) + ' - Stock added ' + fmt(money.stockAdded) + ' - Profit ' + fmt(money.salesProfit);
  }
  renderFinList(listEntries);
  if (!window._finReconcileUnlocked) _showFinReconcile(false);
};

let renderFinList;
renderFinList = function(entries) {
  const list = document.getElementById('fin-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div style="text-align:center;padding:28px 16px;color:var(--muted);font-size:13px;">No transactions yet.</div>';
    return;
  }
  const cfgMap = {
    sale_out:       { icon:'KES', color:'var(--accent2)', label:'Sales Out', out:true },
    injection:      { icon:'KES', color:'var(--green)', label:'Cash to Business', out:false },
    stock_purchase: { icon:'+', color:'#1d4ed8', label:'Stock Added', out:false },
    expense:        { icon:'-', color:'var(--red)', label:'Business Expense', out:true },
    withdrawal:     { icon:'-', color:'#d97706', label:'Personal Withdraw', out:true }
  };
  const groupLabel = e => e.type === 'sale_out' ? 'Sales' : (e.type === 'injection' || e.type === 'stock_purchase' ? 'Business In' : 'Business Out');
  let lastGroup = '';
  const rows = entries.map(e => {
    const c = cfgMap[e.type] || cfgMap.expense;
    const ds = e.date || (e.createdAt||'').split('T')[0];
    const fd = ds ? new Date(ds+'T12:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '-';
    const grp = groupLabel(e) + ' - ' + fd;
    const header = grp !== lastGroup ? '<div style="background:var(--surface2);padding:7px 12px;font-size:10px;font-weight:900;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">' + grp + '</div>' : '';
    lastGroup = grp;
    const delBtn = (!e.isSaleRow && currentUser&&currentUser.role==='super')
      ? '<button onclick="deleteFinanceEntry('+e.id+')" style="font-size:10px;color:var(--muted);background:none;border:none;cursor:pointer;padding:2px 4px;flex-shrink:0;">x</button>'
      : '';
    const sub = e.type === 'sale_out'
      ? 'Cost: ' + fmt(e.amount || 0) + ' - Profit: ' + fmt(e.profit || 0)
      : c.label;
    return header + '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--surface);border-bottom:1px solid var(--border);">' +
      '<span style="font-size:13px;font-weight:900;min-width:24px;text-align:center;color:'+c.color+';">'+c.icon+'</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:12px;font-weight:800;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+escapeHtml(e.description||c.label)+'</div>' +
        '<div style="font-size:10px;color:var(--muted);margin-top:1px;">'+sub+'</div>' +
      '</div>' +
      '<div style="font-size:13px;font-weight:900;font-family:var(--mono);color:'+c.color+';flex-shrink:0;">'+(c.out?'-':'+')+fmt(e.amount||0)+'</div>' +
      delBtn +
    '</div>';
  });
  list.innerHTML = '<div style="border:1.5px solid var(--border);border-radius:var(--r-lg);overflow:hidden;">' + rows.join('') + '</div>';
};

let saveFinanceEntry;
saveFinanceEntry = async function() {
  const type   = document.getElementById('fin-type').value;
  const amount = Input.money('fin-amount');
  const desc   = Input.text('fin-desc');
  const date   = document.getElementById('fin-date').value || todayDateStr();
  const cat    = type === 'injection' ? 'owner_capital' : type === 'withdrawal' ? 'cash_drawer' : 'general';
  const validTypes = ['injection','expense','withdrawal'];
  if (!type || !validTypes.includes(type)) return Validate.fail('Select a transaction type', 'fin-type');
  if (!Validate.moneyRequired(amount, 'fin-amount', 'Amount')) return;
  if (!Validate.text(desc, 'fin-desc', 'Description')) return;
  if (desc.length > 200) return Validate.fail('Description too long (max 200 characters)', 'fin-desc');
  const dateCheck = Validate.financeDate(date, 'fin-date');
  if (dateCheck === false) return;
  if (dateCheck === 'future' && !confirm('Date is in the future - are you sure?')) return;
  const entry = { type, amount, description: desc, category: cat, date, createdAt: new Date().toISOString(), createdBy: currentUser ? currentUser.username : 'system' };
  entry.id = await dbAdd('finances', entry);
  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      entry.fbId = 'fin_manual_' + Date.now();
      await setDoc(fbDoc('finances', entry.fbId), sanitiseForFirestore({...entry}));
      await dbPut('finances', entry);
    } catch(e) { console.warn('[SYNC] finance entry:', e.message); }
  }
  document.getElementById('fin-type').value   = '';
  document.getElementById('fin-amount').value = '';
  document.getElementById('fin-desc').value   = '';
  document.getElementById('fin-date').value   = todayDateStr();
  window._finReconcileUnlocked = true;
  _showFinReconcile(true);
  renderFinancePage();
  renderDashboard();
  scheduleSync();
  toast('Transaction recorded: ' + fmt(amount), 'ok');
};

function _showFinReconcile(show) {
  const btn = document.getElementById('fin-reconcile-btn');
  const hint = document.getElementById('fin-reconcile-hint');
  if (btn) btn.style.display = show ? 'block' : 'none';
  if (hint) hint.style.display = show ? 'block' : 'none';
}
window._showFinReconcile = _showFinReconcile;

let _expandedShoeGroups = new Set();
let _expandedTypeGroups = new Set();
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

// ══════════════════════════════════════════════════════════════════
// AI ASSISTANT  —  Google Gemini Flash (free)
// ══════════════════════════════════════════════════════════════════
const KEY_GEMINI = 'mg_gemini_key';
const KEY_UNITS  = 'mg_units';

// ══════════════════════════════════════════════════════════════════
// UNITS OF MEASUREMENT
// ══════════════════════════════════════════════════════════════════

const DEFAULT_UNITS = [
  { abbr: 'Pcs',  name: 'Pieces',       active: true  },
  { abbr: 'Pkt',  name: 'Packet',       active: true  },
  { abbr: 'Box',  name: 'Box',          active: true  },
  { abbr: 'Ctn',  name: 'Carton',       active: true  },
  { abbr: 'Dzn',  name: 'Dozen',        active: true  },
  { abbr: 'Pr',   name: 'Pair',         active: true  },
  { abbr: 'Set',  name: 'Set',          active: true  },
  { abbr: 'Bdl',  name: 'Bundle',       active: false },
  { abbr: 'Roll', name: 'Roll',         active: false },
  { abbr: 'Btl',  name: 'Bottle',       active: true  },
  { abbr: 'Can',  name: 'Can',          active: false },
  { abbr: 'Bag',  name: 'Bag',          active: true  },
  { abbr: 'Sack', name: 'Sack',         active: false },
  { abbr: 'Kg',   name: 'Kilogram',     active: true  },
  { abbr: 'g',    name: 'Gram',         active: false },
  { abbr: 'L',    name: 'Litre',        active: true  },
  { abbr: 'ml',   name: 'Millilitre',   active: false },
  { abbr: 'm',    name: 'Metre',        active: false },
  { abbr: 'cm',   name: 'Centimetre',   active: false },
  { abbr: 'm²',   name: 'Square metre', active: false },
  { abbr: 'm³',   name: 'Cubic metre',  active: false },
  { abbr: 'Hr',   name: 'Hour',         active: false },
  { abbr: 'Day',  name: 'Day',          active: false },
];

/** Returns the current units array (from localStorage, or defaults) */
function getUnits() {
  try {
    const saved = localStorage.getItem(KEY_UNITS);
    return saved ? JSON.parse(saved) : [...DEFAULT_UNITS];
  } catch(_) { return [...DEFAULT_UNITS]; }
}

/** Returns only active units */
function getActiveUnits() {
  return getUnits().filter(u => u.active);
}
window.getActiveUnits = getActiveUnits;

function _saveUnits(units) {
  localStorage.setItem(KEY_UNITS, JSON.stringify(units));
}

function toggleUnit(abbr) {
  const units = getUnits();
  const u = units.find(x => x.abbr === abbr);
  if (u) u.active = !u.active;
  _saveUnits(units);
  renderUnitsSettings();
}
window.toggleUnit = toggleUnit;

function resetUnitsToDefault() {
  if (!confirm('Reset units to the default list?')) return;
  _saveUnits([...DEFAULT_UNITS]);
  renderUnitsSettings();
  toast('Units reset to defaults', 'ok');
}
window.resetUnitsToDefault = resetUnitsToDefault;

function addCustomUnit() {
  const abbr = (document.getElementById('unit-add-abbr')?.value || '').trim();
  const name = (document.getElementById('unit-add-name')?.value || '').trim();
  if (!abbr) { toast('Enter abbreviation (e.g. Pkt)', 'err'); return; }
  if (!name) { toast('Enter full name (e.g. Packet)', 'err'); return; }
  const units = getUnits();
  if (units.find(u => u.abbr.toLowerCase() === abbr.toLowerCase())) {
    toast('"' + abbr + '" already exists', 'err'); return;
  }
  units.push({ abbr, name, active: true, custom: true });
  _saveUnits(units);
  document.getElementById('unit-add-abbr').value = '';
  document.getElementById('unit-add-name').value = '';
  renderUnitsSettings();
  toast('Unit added', 'ok');
}
window.addCustomUnit = addCustomUnit;

function removeCustomUnit(abbr) {
  if (!confirm('Remove "' + abbr + '" unit?')) return;
  const units = getUnits().filter(u => u.abbr !== abbr);
  _saveUnits(units);
  renderUnitsSettings();
}
window.removeCustomUnit = removeCustomUnit;

function renderUnitsSettings() {
  const container = document.getElementById('units-chip-list');
  if (!container) return;
  const units = getUnits();
  container.innerHTML = units.map(u => `
    <div class="unit-chip ${u.active ? 'unit-chip-on' : ''}" onclick="toggleUnit('${escapeHtml(u.abbr)}')">
      <span class="unit-chip-abbr">${escapeHtml(u.abbr)}</span>
      <span class="unit-chip-name">${escapeHtml(u.name)}</span>
      ${u.custom ? `<button type="button" class="unit-chip-del" onclick="event.stopPropagation();removeCustomUnit('${escapeHtml(u.abbr)}')" title="Remove">×</button>` : ''}
    </div>`).join('');
  // Update active count
  const countEl = document.getElementById('units-active-count');
  if (countEl) countEl.textContent = units.filter(u => u.active).length + ' active';
}
window.renderUnitsSettings = renderUnitsSettings;

function getGeminiKey() { return localStorage.getItem(KEY_GEMINI) || ''; }

function saveGeminiKey() {
  const val = (document.getElementById('gemini-api-key-input')?.value || '').trim();
  if (!val) { toast('Paste your Gemini API key first', 'err'); return; }
  if (!val.startsWith('AIza')) { toast('Key should start with "AIza" — check you copied the full key', 'err'); return; }
  localStorage.setItem(KEY_GEMINI, val);
  _aiUpdateKeyUI(true);
  _aiShowFab();
  toast('AI key saved — tap ✦ button to use AI', 'ok');
}
window.saveGeminiKey = saveGeminiKey;

function clearGeminiKey() {
  if (!confirm('Remove the Gemini API key? AI features will be disabled.')) return;
  localStorage.removeItem(KEY_GEMINI);
  const inp = document.getElementById('gemini-api-key-input');
  if (inp) inp.value = '';
  _aiUpdateKeyUI(false);
  _aiShowFab();
  toast('API key removed', '');
}
window.clearGeminiKey = clearGeminiKey;

function _aiUpdateKeyUI(hasKey) {
  const st  = document.getElementById('gemini-key-status');
  const dot = document.getElementById('gemini-key-dot');
  if (st) {
    st.textContent  = hasKey ? '✓ Active — AI Assistant is ready' : '';
    st.style.color  = hasKey ? 'var(--green)' : 'var(--muted)';
  }
  if (dot) {
    dot.className = 'ai-set-dot ' + (hasKey ? 'ai-set-dot-on' : 'ai-set-dot-off');
  }
}

function _aiShowFab() {
  const fab = document.getElementById('ai-fab');
  if (fab) fab.style.display = getGeminiKey() ? 'flex' : 'none';
}

/** Calls Gemini Flash and returns the text response */
async function _callGemini(userPrompt, systemPrompt) {
  const key = getGeminiKey();
  if (!key) { toast('Add Gemini API key in Settings → AI', 'err'); return null; }
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + key;
  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 1500 }
  };
  const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Gemini error');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Panel open/close ───────────────────────────────────────────────
function openAIPanel() {
  const panel   = document.getElementById('ai-panel');
  const overlay = document.getElementById('ai-panel-overlay');
  const noKey   = document.getElementById('ai-no-key');
  const actions = document.getElementById('ai-actions');
  const chat    = document.getElementById('ai-chat');
  if (!panel) return;
  panel.style.display   = 'flex';
  overlay.style.display = 'block';
  chat.style.display    = 'none';
  const hasKey = !!getGeminiKey();
  if (noKey)   noKey.style.display   = hasKey ? 'none' : 'block';
  if (actions) actions.style.display = hasKey ? 'flex'  : 'none';
}
window.openAIPanel = openAIPanel;

function closeAIPanel() {
  document.getElementById('ai-panel').style.display   = 'none';
  document.getElementById('ai-panel-overlay').style.display = 'none';
}
window.closeAIPanel = closeAIPanel;

function aiBack() {
  document.getElementById('ai-chat').style.display    = 'none';
  document.getElementById('ai-actions').style.display = 'flex';
}
window.aiBack = aiBack;

function aiAskMode() {
  document.getElementById('ai-actions').style.display   = 'none';
  document.getElementById('ai-chat').style.display      = 'flex';
  document.getElementById('ai-chat-title').textContent  = '💬 Ask Anything';
  document.getElementById('ai-ask-input-row').style.display = 'flex';
  document.getElementById('ai-chat-body').innerHTML = '<div class="ai-msg ai-msg-ai">Ask me anything about your inventory, sales, pricing or business performance. I have access to your data.</div>';
}
window.aiAskMode = aiAskMode;

function _aiShowLoading(title) {
  document.getElementById('ai-actions').style.display   = 'none';
  document.getElementById('ai-chat').style.display      = 'flex';
  document.getElementById('ai-chat-title').textContent  = title;
  document.getElementById('ai-ask-input-row').style.display = 'none';
  document.getElementById('ai-chat-body').innerHTML =
    '<div class="ai-loading"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span> Thinking…</div>';
}

function _aiShowResult(html, showInput) {
  document.getElementById('ai-chat-body').innerHTML = html;
  if (showInput) document.getElementById('ai-ask-input-row').style.display = 'flex';
}

// ── Build compact context string from current data ─────────────────
async function _aiContext() {
  const items = allItems.length ? allItems : await dbAll('items');
  const sales = await dbAll('sales');
  const today = todayDateStr();

  const topItems = [...items].sort((a,b)=>(b.sellPrice||0)-(a.sellPrice||0)).slice(0,30);
  const last30sales = sales.filter(s=>{
    const d = s.businessDate || (s.date||'').slice(0,10);
    return d >= today.slice(0,7)+'-01';
  }).slice(-200);

  const itemsSummary = topItems.map(i=>
    `${i.code}|${i.name}|${i.type}|buy:${i.buyPrice||0}|sell:${i.sellPrice||0}|qty:${i.qty||0}|${i.isRecord?'RECORD':''}`
  ).join('\n');

  const salesSummary = last30sales.map(s=>
    `${s.businessDate||s.date?.slice(0,10)}|${s.itemCode}|${s.itemName}|qty:${s.qty||1}|rev:${s.revenue||0}|profit:${s.profit||0}`
  ).join('\n');

  return `SHOP: Mandela General Stores
TODAY: ${today}
INVENTORY (${items.length} items):\n${itemsSummary}
RECENT SALES (last 30 days):\n${salesSummary}`;
}

// ── Feature 1: Restock Scanner ─────────────────────────────────────
async function aiRestockScan() {
  _aiShowLoading('📦 Restock Scanner');
  try {
    const items    = allItems.length ? allItems : await dbAll('items');
    const allSales = await dbAll('sales');
    const itemCodes = new Set(items.map(i => i.code));

    // Group sales of items NOT in inventory
    const missing = {};
    allSales.forEach(s => {
      if (!s.itemCode || itemCodes.has(s.itemCode)) return;
      if (!missing[s.itemCode]) missing[s.itemCode] = { code: s.itemCode, name: s.itemName || s.itemCode, sales: 0, revenue: 0, lastSold: '' };
      missing[s.itemCode].sales   += (s.qty || 1);
      missing[s.itemCode].revenue += (s.revenue || 0);
      if (s.businessDate > missing[s.itemCode].lastSold) missing[s.itemCode].lastSold = s.businessDate || '';
    });

    const list = Object.values(missing).sort((a,b) => b.revenue - a.revenue);

    if (!list.length) {
      _aiShowResult('<div class="ai-msg ai-msg-ai">✅ All items sold in your history are already in your inventory. Nothing missing!</div>');
      return;
    }

    const prompt = `You are an inventory advisor for a small retail shop.
Items sold but NOT in inventory (code | name | times sold | revenue):
${list.map(x=>`${x.code} | ${x.name} | ${x.sales}x | KES ${x.revenue}`).join('\n')}

For each item: suggest a short restocking note (1 line). Format as JSON array: [{"code":"..","name":"..","suggestion":".."}]`;

    const sys = 'You are a concise retail inventory advisor. Respond only with valid JSON.';
    const aiText = await _callGemini(prompt, sys);

    let suggestions = [];
    try { suggestions = JSON.parse(aiText.replace(/```json?/g,'').replace(/```/g,'').trim()); } catch(_) { suggestions = []; }

    const cards = list.map((x, i) => {
      const sug = suggestions.find(s => s.code === x.code)?.suggestion || '';
      return `<div class="ai-restock-card">
        <div class="ai-restock-main">
          <div class="ai-restock-name">${escapeHtml(x.name)}</div>
          <div class="ai-restock-code">${escapeHtml(x.code)}</div>
          ${sug ? '<div class="ai-restock-sug">' + escapeHtml(sug) + '</div>' : ''}
        </div>
        <div class="ai-restock-stats">
          <span>${x.sales}× sold</span>
          <span>${fmt(x.revenue)}</span>
        </div>
        <button class="ai-restock-add" onclick="aiAddToInventory('${escapeHtml(x.code)}','${escapeHtml(x.name)}')">
          <i class="fa-solid fa-plus"></i> Add
        </button>
      </div>`;
    }).join('');

    _aiShowResult(`<div class="ai-msg ai-msg-ai" style="margin-bottom:10px;">Found <strong>${list.length}</strong> items sold but not in inventory. Tap <strong>Add</strong> to add any to your stock.</div>${cards}`);
  } catch(e) { _aiShowResult('<div class="ai-msg ai-msg-err">Error: ' + escapeHtml(e.message) + '</div>'); }
}
window.aiRestockScan = aiRestockScan;

function aiAddToInventory(code, name) {
  closeAIPanel();
  showPage('add');
  setTimeout(async () => {
    const _defaultType = types.find(t => t.name === 'General' && isCategoryActive(t)) ? 'General' : '';
    setAddFormType(_defaultType, { skipTypeChange: false });
    await new Promise(r => setTimeout(r, 80));
    const el = id => document.getElementById(id);
    if (el('f-code')) el('f-code').value = code;
    if (el('f-name')) el('f-name').value = name;
    setItemMode(true);
    toast('Pre-filled — add buy price and save', '');
  }, 100);
}
window.aiAddToInventory = aiAddToInventory;

// ── Feature 2: Insights ────────────────────────────────────────────
async function aiInsights() {
  _aiShowLoading('📊 Business Insights');
  try {
    const ctx    = await _aiContext();
    const prompt = ctx + '\n\nAnalyse this business data and give:\n1. Top 3 best-selling items\n2. Top 3 highest-profit items\n3. Items not selling (qty > 0 but 0 sales)\n4. 2-3 actionable recommendations for the shop owner\nKeep it concise and practical.';
    const sys    = 'You are a friendly business advisor for a small Kenyan retail shop. Be concise, use bullet points, mention specific item names and numbers. Use KES for currency.';
    const text   = await _callGemini(prompt, sys);
    // Convert markdown-ish to HTML
    const html = text.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
                     .replace(/\*(.*?)\*/g,'<em>$1</em>')
                     .replace(/^#+\s(.+)/gm,'<div class="ai-section-head">$1</div>')
                     .replace(/\n/g,'<br>');
    _aiShowResult('<div class="ai-msg ai-msg-ai">' + html + '</div>');
  } catch(e) { _aiShowResult('<div class="ai-msg ai-msg-err">Error: ' + escapeHtml(e.message) + '</div>'); }
}
window.aiInsights = aiInsights;

// ── Feature 3: Ask anything ────────────────────────────────────────
async function aiSendQuestion() {
  const inp = document.getElementById('ai-ask-input');
  const q   = (inp?.value || '').trim();
  if (!q) return;
  if (inp) inp.value = '';

  const body = document.getElementById('ai-chat-body');
  body.innerHTML += '<div class="ai-msg ai-msg-user">' + escapeHtml(q) + '</div>';
  body.innerHTML += '<div class="ai-loading" id="ai-inline-loading"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span></div>';
  body.scrollTop = body.scrollHeight;

  try {
    const ctx  = await _aiContext();
    const prompt = ctx + '\n\nUser question: ' + q;
    const sys  = 'You are a helpful business assistant for Mandela General Stores, a small Kenyan retail shop. Use the inventory and sales data provided. Be concise and practical. Use KES for currency.';
    const text = await _callGemini(prompt, sys);
    const el   = document.getElementById('ai-inline-loading');
    if (el) el.remove();
    const html = text.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
    body.innerHTML += '<div class="ai-msg ai-msg-ai">' + html + '</div>';
    body.scrollTop = body.scrollHeight;
  } catch(e) {
    const el = document.getElementById('ai-inline-loading');
    if (el) el.textContent = 'Error: ' + e.message;
  }
}
window.aiSendQuestion = aiSendQuestion;

// ── Init: always show FAB (dims when no key, active when key set) ──
function _aiShowFab() {
  const fab = document.getElementById('ai-fab');
  if (!fab) return;
  fab.style.display = 'flex';
  fab.style.opacity = getGeminiKey() ? '1' : '0.5';
  fab.title = getGeminiKey() ? 'AI Assistant' : 'AI Assistant — add API key in Settings';
}
setTimeout(_aiShowFab, 500);

// ══════════════════════════════════════════════════════════════════
// GLOBAL SEARCH  (dashboard quick-find + inventory enhancement)
// ══════════════════════════════════════════════════════════════════

let _gscTimer = null;

/** Score how well an item matches the query (higher = better match) */
function _gscScore(item, q) {
  if (!q) return 0;
  const name    = (item.name    || '').toLowerCase();
  const code    = (item.code    || '').toLowerCase();
  const type    = (item.type    || '').toLowerCase();
  const variant = (item.variant || item.size || '').toLowerCase();
  let s = 0;
  if (code === q)         s += 120;
  if (name === q)         s += 100;
  if (code.startsWith(q)) s +=  70;
  if (name.startsWith(q)) s +=  60;
  if (code.includes(q))   s +=  40;
  if (name.includes(q))   s +=  35;
  if (variant.includes(q))s +=  20;
  if (type.includes(q))   s +=  10;
  return s;
}

/** Wrap matching text in a highlight span */
function _gscHighlight(text, q) {
  if (!q || !text) return escapeHtml(text || '');
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) +
    '<mark class="gsc-hl">' + escapeHtml(text.slice(idx, idx + q.length)) + '</mark>' +
    escapeHtml(text.slice(idx + q.length));
}

async function _gscSearch(raw) {
  const q = (raw || '').trim().toLowerCase();
  if (!q) { gscHideResults(); return; }

  const items = allItems.length ? allItems : await dbAll('items');
  await enrichShoeItems(items);

  // Score & sort
  const scored = items
    .map(item => ({ item, score: _gscScore(item, q) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const container = document.getElementById('gsc-results');
  if (!container) return;

  if (!scored.length) {
    container.innerHTML = '<div class="gsc-empty"><i class="fa-solid fa-magnifying-glass"></i> No items match "<strong>' + escapeHtml(raw) + '</strong>"</div>';
    container.style.display = 'block';
    return;
  }

  const allSizes = await dbAll('shoe_sizes');
  const allSales = await dbAll('sales');
  const soldMap  = {};
  allSales.forEach(s => { soldMap[s.itemId] = (soldMap[s.itemId] || 0) + (s.qty || 1); });

  let html = '';
  for (const { item } of scored) {
    const t        = getTypeObj(item.type);
    const sell     = item.sellPrice || item.sell || 0;
    const sellMin  = item.sellPriceMin || 0;
    const isRec    = !!item.isRecord;
    const qty      = item.isShoe
      ? allSizes.filter(s => s.itemCode === item.code).reduce((n, s) => n + (s.qty || 0), 0)
      : (item.qty || 0);
    const sold     = soldMap[item.id] || 0;

    const stockCls  = isRec ? 'gsc-badge-rec' : qty === 0 ? 'gsc-badge-out' : qty <= LOW_STOCK_LEVEL ? 'gsc-badge-low' : 'gsc-badge-ok';
    const stockLbl  = isRec ? 'Record' : qty === 0 ? 'Out' : qty + ' pcs';
    const priceStr  = sellMin > 0 && sellMin < sell
      ? fmt(sellMin) + ' – ' + fmt(sell)
      : sell > 0 ? fmt(sell) : '—';

    html += `<div class="gsc-item" onclick="gscOpenItem(${item.id})" role="button" tabindex="0">
      <div class="gsc-item-icon" style="background:${t.color||'var(--surface2)'};">${t.emoji}</div>
      <div class="gsc-item-body">
        <div class="gsc-item-name">${_gscHighlight(item.name || item.code, raw)}</div>
        <div class="gsc-item-meta">
          <span class="gsc-item-code">${_gscHighlight(item.code, raw)}</span>
          <span class="gsc-item-type">${escapeHtml(item.type || '')}</span>
          ${sold ? '<span class="gsc-item-sold">' + sold + ' sold</span>' : ''}
        </div>
      </div>
      <div class="gsc-item-right">
        <div class="gsc-item-price">${priceStr}</div>
        <span class="gsc-badge ${stockCls}">${stockLbl}</span>
      </div>
    </div>`;
  }

  // Footer action
  html += `<div class="gsc-footer">
    <button class="gsc-view-all" onclick="gscViewAll()">
      <i class="fa-solid fa-list"></i>
      View all ${scored.length === 12 ? '12+' : scored.length} results in Inventory
    </button>
  </div>`;

  container.innerHTML = html;
  container.style.display = 'block';
  const backdrop = document.getElementById('gsc-backdrop');
  if (backdrop) backdrop.style.display = 'block';
}

function gscOnInput(val) {
  const clearBtn = document.getElementById('gsc-clear');
  if (clearBtn) clearBtn.style.display = val ? 'flex' : 'none';
  clearTimeout(_gscTimer);
  if (!val.trim()) { gscHideResults(); return; }
  _gscTimer = setTimeout(() => _gscSearch(val), 120);
}

function gscOnKey(e) {
  if (e.key === 'Escape') { gscClear(); return; }
  if (e.key === 'Enter') {
    const first = document.querySelector('.gsc-item');
    if (first) first.click();
  }
}

function gscHideResults() {
  const r = document.getElementById('gsc-results');
  const b = document.getElementById('gsc-backdrop');
  if (r) r.style.display = 'none';
  if (b) b.style.display = 'none';
}

function gscClear() {
  const inp = document.getElementById('gsc-input');
  const btn = document.getElementById('gsc-clear');
  if (inp) inp.value = '';
  if (btn) btn.style.display = 'none';
  gscHideResults();
}

function gscOpenItem(itemId) {
  gscClear();
  openSheet(itemId);
}

function gscViewAll() {
  const q = (document.getElementById('gsc-input')?.value || '').trim();
  gscClear();
  showPage('list');
  const inv = document.getElementById('search');
  if (inv) {
    inv.value = q;
    onInventorySearch(q);
  }
}

window.gscOnInput  = gscOnInput;
window.gscOnKey    = gscOnKey;
window.gscClear    = gscClear;
window.gscOpenItem = gscOpenItem;
window.gscViewAll  = gscViewAll;

// ── Inventory search wrapper (adds clear button, re-uses renderList) ─
function onInventorySearch(val) {
  const btn = document.getElementById('search-clear');
  if (btn) btn.style.display = val ? 'flex' : 'none';
  renderList();
}

function clearInventorySearch() {
  const inp = document.getElementById('search');
  const btn = document.getElementById('search-clear');
  if (inp) { inp.value = ''; }
  if (btn) btn.style.display = 'none';
  renderList();
}

window.onInventorySearch    = onInventorySearch;
window.clearInventorySearch = clearInventorySearch;

function toggleTypeGroup(parentTypeId) {
  if (_expandedTypeGroups.has(parentTypeId)) {
    _expandedTypeGroups.delete(parentTypeId);
  } else {
    _expandedTypeGroups.add(parentTypeId);
  }
  renderList();
}
window.toggleTypeGroup = toggleTypeGroup;

// ══════════════════════════════════════════════════════════════════
// GENERAL VARIANT UI FUNCTIONS
// ══════════════════════════════════════════════════════════════════

function setItemMode(isRecord) {
  _addFormIsRecord = !!isRecord;

  // Sync checkbox state (called programmatically during clearForm)
  const toggleInput = document.getElementById('mode-toggle-input');
  if (toggleInput) toggleInput.checked = !isRecord;

  // Highlight the active label
  const modeBar     = document.getElementById('item-mode-toggle');
  const optRecord   = document.getElementById('mode-opt-record');
  const optTrack    = document.getElementById('mode-opt-track');
  if (optRecord) optRecord.classList.toggle('mode-opt-active', !!isRecord);
  if (optTrack)  optTrack.classList.toggle('mode-opt-active', !isRecord);
  if (modeBar)   modeBar.classList.toggle('record-mode', !!isRecord);

  // Show/hide qty field and record note
  const qtyField   = document.getElementById('f-qty')?.closest('.add-field');
  const recordNote = document.getElementById('record-mode-note');
  if (isRecord) {
    if (qtyField)   qtyField.style.display = 'none';
    if (recordNote) recordNote.style.display = 'flex';
    const qtyEl = document.getElementById('f-qty');
    if (qtyEl) qtyEl.value = '0';
  } else {
    if (qtyField)   qtyField.style.removeProperty('display');
    if (recordNote) recordNote.style.display = 'none';
  }

  // Re-evaluate shoe panel visibility — toggling mode on a footwear category
  // must show/hide sizes immediately without waiting for onTypeChange
  applyAddFormFootwearUI(isAddFormFootwearContext());
}
window.setItemMode = setItemMode;

function setSizeGroupFilter(group) {
  window._activeSizeGroupFilter = group;
  document.querySelectorAll('[id^="sgf-"]').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('sgf-' + group);
  if (btn) btn.classList.add('active');
  renderList();
}
window.setSizeGroupFilter = setSizeGroupFilter;

function _renderSizeGroupFilter() {
  const wrap = document.getElementById('shoe-size-filter');
  if (!wrap) return;
  const footwearSelected = activeTypeFilter !== 'all' && isFootwearType(activeTypeFilter);
  wrap.style.display = footwearSelected ? 'flex' : 'none';
  if (!footwearSelected) {
    window._activeSizeGroupFilter = 'all';
    document.querySelectorAll('[id^="sgf-"]').forEach(b => b.classList.remove('active'));
  }
}


// ═══════════════════════════════════════════════════════════
// DAY RECONCILIATION - FLOW CONTROLLER
// Steps keyed by date in localStorage:
//   no data        to step: open  (show Open Day btn)
//   opened_only    to step: opening_form (show opening balances form)
//   opening_locked to step: close_btn (show Close Day btn)
//   closing_form   to step: closing_form (show closing form)
//   reconciled     to step: reconciled (insights only)
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
  renderDayState(); // resets the opening form to 0 as part of showing it
};
window.openDay = openDay;

// ── initCloseDay: show closing form ─────────────────────────────
function initCloseDay() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data  = _getDayRecon(today) || {};
  _saveDayRecon(today, {...data, step: 'closing_form' });
  renderDayState(); // resets the closing form to 0 as part of showing it
}
window.initCloseDay = initCloseDay;

// ── cancelCloseDay (from closing form Cancel btn) ────────────────
function cancelCloseDay() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data  = _getDayRecon(today) || {};
  _saveDayRecon(today, {...data, step: 'opening_locked' });
  renderDayState();
}
window.cancelCloseDay = cancelCloseDay;

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
  activeDay.closingStockCost = items.reduce((s,i)=>s+(i.buyPrice||i.buy||0)*(i.qty||0),0);
  await dbPut('business_days', activeDay);
  clearDayTabLocks();
  renderDashboard();
}

// ── Render locked opening summary ───────────────────────────────
function _renderOpeningSummary(data) {
  const el = document.getElementById('day-opening-summary');
  if (!el || !data || !data.opening) return;
  const o   = data.opening;
  const f   = v => v ? fmt(v) : '-';
  const t   = new Date(data.lockedAt||0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);">'+f(o.cash)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Cash</div></div>' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);">'+f(o.till)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Till</div></div>' +
      '<div style="text-align:center;"><div style="font-size:15px;font-weight:900;font-family:var(--mono);color:#6366f1;">'+f(o.mpesa)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">M-Pesa</div></div>' +
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
  const cl = data.closing;
  const sy = data.system;
  const an = data.analysis || {};
  if (an.correctDay == null && an.correct != null) an.correctDay = an.correct;
  if (an.actualDay == null && an.exact != null) an.actualDay = an.exact;
  if (an.variance == null && an.correctDay != null) an.variance = (an.actualDay || 0) - (an.correctDay || 0);
  an.netMove = an.netMove ?? 0;
  an.opTotal = an.opTotal ?? 0;

  const absV = Math.abs(an.variance || 0);
  const isOk = absV <= 5;
  const isWn = !isOk && absV <= 300;
  const vc   = isOk ? 'var(--green)' : isWn ? '#d97706' : 'var(--red)';
  const vi   = isOk ? 'OK' : an.variance > 0 ? 'Up' : 'Down';
  const vl   = isOk ? 'Balanced'
             : an.variance > 0 ? '+'+fmt(an.variance)+' surplus'
             : fmt(absV)+' short';
  // ── Insights ──────────────────────────────────────────
  const ins = [];
  // Show the working behind the verdict, not just the conclusion - one line per calculation.
  ins.push({i:'', c:'rc-info', t:
    'Should have: Opening ' + fmt(an.opTotal) + ' + Sales ' + fmt(sy.sysTotalRev) + ' = <b>' + fmt(an.correctDay) + '</b><br>' +
    'Actually have: Injected ' + fmt(cl.injected) + ' + Cash ' + fmt(cl.cash) + ' + Till ' + fmt(cl.till) +
    ' + M-Pesa ' + fmt(cl.mpesa) + ' + Expenses ' + fmt(cl.expenses) + ' + Withdrawn ' + fmt(cl.withdrawn) + ' = <b>' + fmt(an.actualDay) + '</b><br>' +
    'Variance: ' + fmt(an.actualDay) + ' − ' + fmt(an.correctDay) + ' = <b>' + (an.variance >= 0 ? '+' : '') + fmt(an.variance) + '</b>'
  });
  if (isOk) {
    ins.push({i:'',c:'rc-ok',  t:'Perfect - every shilling accounted for!'});
  } else if (an.variance > 0) {
    ins.push({i:'',c:'rc-warn',t:'Surplus of '+fmt(an.variance)+'. More cash than expected. Check for unrecorded injection, or a deposit not captured.'});
  } else {
    ins.push({i:'',c:'rc-bad', t:'Short by '+fmt(absV)+'. Less cash than expected. Check for unrecorded expense, undeclared withdrawal, or theft.'});
  }
  if (cl.expenses > 0 && sy.sysTotalRev > 0 && cl.expenses > sy.sysTotalRev * 0.35)
    ins.push({i:'',c:'rc-warn',t:'Expenses ('+fmt(cl.expenses)+') are '+((cl.expenses/sy.sysTotalRev)*100).toFixed(0)+'% of revenue - high for today.'});
  if (sy.margin < 10 && sy.sysTotalRev > 0)
    ins.push({i:'',c:'rc-warn',t:'Low margin: '+sy.margin.toFixed(1)+'%. Review prices or costs.'});
  else if (sy.margin >= 30 && sy.sysTotalRev > 0)
    ins.push({i:'',c:'rc-ok', t:'Great margin: '+sy.margin.toFixed(1)+'%!'});
  if (an.netMove < 0)
    ins.push({i:'',c:'rc-bad',t:'Net movement is negative ('+fmt(an.netMove)+'). Business paid out more than it earned today.'});
  if (sy.salesCount === 0)
    ins.push({i:'',c:'rc-warn',t:'No sales recorded today.'});

  el.innerHTML =
    // ── Sales summary ──────────────────────────────────
    '<div class="day-section-label">Today Summary</div>' +
    '<div style="border:1.5px solid #a8d8b5;border-radius:var(--r-lg);overflow:hidden;margin-bottom:8px;">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;text-align:center;background:var(--surface);">' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:16px;font-weight:900;font-family:var(--mono);color:var(--green);">'+sy.salesCount+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Sales</div></div>' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">'+fmt(sy.sysTotalRev)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Revenue</div></div>' +
        '<div style="padding:10px 4px;border-right:1px solid var(--border);"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--green);">'+fmt(sy.sysTotalProf)+'</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Profit</div></div>' +
        '<div style="padding:10px 4px;"><div style="font-size:13px;font-weight:900;font-family:var(--mono);color:var(--accent);">'+sy.margin.toFixed(1)+'%</div><div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;margin-top:2px;">Margin</div></div>' +
      '</div>' +
      (cl.injected > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>Injected</span><span style="font-weight:800;color:var(--green);">+'+fmt(cl.injected)+'</span></div>' : '') +
      (cl.expenses  > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>Expenses</span><span style="font-weight:800;color:var(--red);">-'+fmt(cl.expenses)+'</span></div>' : '') +
      (cl.withdrawn > 0 ? '<div style="display:flex;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--border);font-size:11px;background:var(--surface);"><span>Withdrawn</span><span style="font-weight:800;color:#d97706;">-'+fmt(cl.withdrawn)+'</span></div>' : '') +
      '<div style="display:flex;justify-content:space-between;padding:9px 12px;border-top:1px solid #a8d8b5;background:#f0faf4;font-size:12px;font-weight:800;">' +
        '<span style="color:var(--green);">Net Movement</span>' +
        '<span style="font-family:var(--mono);color:'+(an.netMove>=0?'var(--green)':'var(--red)')+';">'+(an.netMove>=0?'+':'')+fmt(an.netMove)+'</span>' +
      '</div>' +
    '</div>' +

    // ── The two money totals ────────────────────────────
    '<div class="day-section-label">Day Money Check</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
      '<div style="background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Should Have</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:2;margin-bottom:8px;">' +
          'Opening: <b>'+fmt(an.opTotal)+'</b><br>+ Sales: <b>'+fmt(sy.sysTotalRev)+'</b>' +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:var(--accent);border-top:1px solid var(--border);padding-top:8px;">'+fmt(an.correctDay)+'</div>' +
      '</div>' +
      '<div style="background:'+(isOk?'var(--green-light)':isWn?'#fef3c7':'var(--red-light)')+';border:1.5px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';border-radius:var(--r-lg);padding:12px 14px;">' +
        '<div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Actually Have</div>' +
        '<div style="font-size:10px;color:var(--muted);line-height:2;margin-bottom:8px;">' +
          (cl.injected>0?'Injected: <b>'+fmt(cl.injected)+'</b><br>':'') +
          'Cash: <b>'+fmt(cl.cash)+'</b><br>Till: <b>'+fmt(cl.till)+'</b><br>M-Pesa: <b>'+fmt(cl.mpesa)+'</b>' +
          (cl.expenses>0?'<br>Expenses: <b>'+fmt(cl.expenses)+'</b>':'') +
          (cl.withdrawn>0?'<br>Withdrawn: <b>'+fmt(cl.withdrawn)+'</b>':'') +
        '</div>' +
        '<div style="font-size:18px;font-weight:900;font-family:var(--mono);color:'+vc+';border-top:1px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';padding-top:8px;">'+fmt(an.actualDay)+'</div>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:'+(isOk?'var(--green-light)':isWn?'#fef3c7':'var(--red-light)')+';border:1.5px solid '+(isOk?'#a8d8b5':isWn?'#f5d9a0':'#fca5a5')+';border-radius:var(--r-lg);margin-bottom:8px;">' +
      '<span style="font-size:13px;font-weight:800;color:'+vc+';">Variance</span>' +
      '<span style="font-size:20px;font-weight:900;font-family:var(--mono);color:'+vc+';">'+vi+' '+vl+'</span>' +
    '</div>' +

    // ── Insights ─────────────────────────────────────────
    '<div class="day-section-label">Insights</div>' +
    ins.map(i=>'<div class="'+i.c+'" style="display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border-radius:var(--r);margin-bottom:5px;font-size:12px;font-weight:600;line-height:1.4;"><span style="font-size:16px;flex-shrink:0;">'+i.i+'</span><span>'+i.t+'</span></div>').join('') +
    '<div style="text-align:center;font-size:10px;color:var(--muted);padding:6px 0;">Reconciled at '+new Date(data.reconciledAt||0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+'</div>';
}

// ── Auto-close at 11:59 PM ───────────────────────────────────────
function _clearClosingInputsOnly() {
  ['cl-injected','cl-cash','cl-till','cl-mpesa','cl-expenses','cl-withdrawn']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
}

function _clearOpeningInputsOnly() {
  ['op-cash','op-till','op-mpesa']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
}

function _moveSalesDetailsAfterOpening() {
  const sales = document.getElementById('day-sales-details');
  const openingLocked = document.getElementById('day-opening-locked');
  const openingForm = document.getElementById('day-step-opening-form');
  if (!sales) return;
  if (openingLocked && openingLocked.style.display !== 'none') openingLocked.insertAdjacentElement('afterend', sales);
  else if (openingForm && openingForm.style.display !== 'none') openingForm.insertAdjacentElement('afterend', sales);
}

let renderDayState;
renderDayState = function() {
  const today = activeDay ? (activeDay.businessDate || activeDay.business_date) : todayDateStr();
  const titleEl = document.getElementById('day-banner-title');
  const subEl = document.getElementById('day-banner-sub');
  const iconEl = document.getElementById('day-banner-icon');
  if (titleEl) titleEl.textContent = fmtFullDate(today);
  if (subEl) subEl.textContent = today;
  if (iconEl) iconEl.textContent = '';

  const data = _getDayRecon(today);
  const isOpen = activeDay && activeDay.status === 'OPEN';
  const step = data ? data.step : (isOpen ? 'opening_form' : 'open');

  const salesDetails = document.getElementById('day-sales-details');
  if (salesDetails) salesDetails.style.display = step === 'reconciled' ? 'none' : 'grid';

  ['open','opening-form','close-btn','closing-form','reconciled'].forEach(s => {
    const el = document.getElementById('day-step-' + s);
    if (el) el.style.display = 'none';
  });
  const openLocked = document.getElementById('day-opening-locked');
  if (openLocked) openLocked.style.display = 'none';

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
    _clearClosingInputsOnly(); // always 0 on every render of this form - no stale values ever
  } else if (step === 'opening_locked' || (data && data.opening)) {
    if (openLocked) openLocked.style.display = '';
    _renderOpeningSummary(data);
    const el = document.getElementById('day-step-close-btn');
    if (el) el.style.display = '';
  } else if (step === 'opening_form' || isOpen) {
    const el = document.getElementById('day-step-opening-form');
    if (el) el.style.display = '';
    _clearOpeningInputsOnly(); // always 0 on every render of this form - no stale values ever
  } else {
    const el = document.getElementById('day-step-open');
    if (el) el.style.display = '';
  }
  _moveSalesDetailsAfterOpening();
};
window.renderDayState = renderDayState;

let lockOpeningBalances;
lockOpeningBalances = async function() {
  if (!activeDay) {
    const today = todayDateStr();
    let bday = await getBusinessDay(today);
    if (!bday) bday = await createDayRecord(today);
    activeDay = bday;
  }
  const cashRaw = Input.money('op-cash');
  const tillRaw = Input.money('op-till');
  const mpesaRaw = Input.money('op-mpesa');
  if (!Validate.dayOpening(cashRaw, tillRaw, mpesaRaw)) return;
  const [cash, till, mpesa] = Input.moneyZero(cashRaw, tillRaw, mpesaRaw);
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  _saveDayRecon(today, { step:'opening_locked', date:today, lockedAt:new Date().toISOString(), opening:{ cash, till, mpesa, total:cash+till+mpesa } });
  toast('Opening balances saved', 'ok');
  renderDayState();
};
window.lockOpeningBalances = lockOpeningBalances;

let reconcileDay;
reconcileDay = async function() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  const data = _getDayRecon(today);
  if (!data || !data.opening) { toast('Record opening balances first', 'err'); return; }

  const injectedRaw  = Input.money('cl-injected');
  const cashRaw      = Input.money('cl-cash');
  const tillRaw      = Input.money('cl-till');
  const mpesaRaw     = Input.money('cl-mpesa');
  const expensesRaw  = Input.money('cl-expenses');
  const withdrawnRaw = Input.money('cl-withdrawn');

  if (!Validate.dayClosingPhysical(cashRaw, tillRaw, mpesaRaw)) return;
  if (!Validate.moneyOptional(injectedRaw, 'cl-injected', 'Cash to business')) return;
  if (!Validate.moneyOptional(expensesRaw, 'cl-expenses', 'Expenses')) return;
  if (!Validate.moneyOptional(withdrawnRaw, 'cl-withdrawn', 'Withdrawn')) return;

  const [injected, cash, till, mpesa, expenses, withdrawn] = Input.moneyZero(
    injectedRaw, cashRaw, tillRaw, mpesaRaw, expensesRaw, withdrawnRaw
  );

  let useInjected = injected;
  let useExpenses = expenses;
  let useWithdrawn = withdrawn;

  const finTotals = await _financeTotalsForDay(today);
  const mismatchLines = _warnFinanceClosingMismatch(finTotals, { injected, expenses, withdrawn });
  if (mismatchLines.length) {
    const useFin = confirm(
      'Closing figures differ from Finance tab records:\n\n' +
      mismatchLines.join('\n') +
      '\n\nUse Finance tab totals instead?'
    );
    if (useFin) {
      useInjected = finTotals.injection || 0;
      useExpenses = finTotals.expense || 0;
      useWithdrawn = finTotals.withdrawal || 0;
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v || 0); };
      setVal('cl-injected', useInjected);
      setVal('cl-expenses', useExpenses);
      setVal('cl-withdrawn', useWithdrawn);
    } else if (!confirm('Continue with the figures you entered?')) return;
  }

  const allSales = await dbAll('sales');
  const daySales = allSales.filter(s =>
    (s.businessDate||s.business_date||(s.date||'').split('T')[0]) === today);

  const sysCashRev   = daySales.filter(s => !s.paymentMethod || s.paymentMethod === 'cash').reduce((a,s) => a + (s.revenue||0), 0);
  const sysMpesaRev  = daySales.filter(s => s.paymentMethod === 'mpesa').reduce((a,s) => a + (s.revenue||0), 0);
  const sysTotalRev  = daySales.reduce((a,s) => a + (s.revenue||0), 0);
  const sysTotalProf = daySales.reduce((a,s) => a + (s.profit||0), 0);
  const salesCount   = daySales.length;
  const margin       = sysTotalRev > 0 ? (sysTotalProf / sysTotalRev * 100) : 0;

  // Expected total = Opening + Revenue only. Reconciliation checks the
  // day's TOTAL money, not per-pocket - cash/till/mpesa balances shift
  // around between each other during the day (e.g. topping up M-Pesa
  // float from cash), so a per-pocket "expected vs physical" check would
  // flag normal transfers as if they were discrepancies.
  const opTotal    = (data.opening.cash||0) + (data.opening.till||0) + (data.opening.mpesa||0);
  const correctDay = opTotal + sysTotalRev;
  // Actual/"Day Money" = Injected + Cash + Till + M-Pesa + Expenses + Withdrawn.
  const actualDay  = useInjected + cash + till + mpesa + useExpenses + useWithdrawn;
  const variance   = actualDay - correctDay;
  const netMove    = sysTotalRev + useInjected - useExpenses - useWithdrawn;

  _saveDayRecon(today, {
    step: 'reconciled', date: today,
    lockedAt: data.lockedAt, opening: data.opening,
    reconciledAt: new Date().toISOString(),
    closing: { injected: useInjected, cash, till, mpesa, expenses: useExpenses, withdrawn: useWithdrawn },
    system: { sysCashRev, sysMpesaRev, sysTotalRev, sysTotalProf, salesCount, margin },
    analysis: { opTotal, correctDay, actualDay, variance, netMove }
  });

  await _doCloseDay();
  await _cleanupFinanceCoherence(true);
  scheduleSync();
  toast('Day closed and reconciled', 'ok');
  renderDayState();
  renderDaySessionsList();
  renderFinancePage();
};
window.reconcileDay = reconcileDay;

let dayStartOver;
dayStartOver = async function() {
  const today = activeDay ? (activeDay.businessDate||activeDay.business_date) : todayDateStr();
  if (!confirm("Clear today's closing records only?\n\nOpening balances will be kept.")) return;
  const data = _getDayRecon(today);
  if (data && data.opening) {
    _saveDayRecon(today, {
      step: 'closing_form',
      date: today,
      lockedAt: data.lockedAt,
      opening: data.opening
    });
  } else {
    _clearDayRecon(today);
  }
  const fins = await dbAll('finances');
  for (const e of fins) {
    if (e.type === 'reconciliation' && (e.date || '').slice(0, 10) === today) await dbDelete('finances', e.id);
  }
  if (activeDay) {
    activeDay.status = 'OPEN';
    activeDay.closed_at = null;
    await dbPut('business_days', activeDay);
    clearDayTabLocks();
  }
  toast('Closing cleared - redo end-of-day', '');
  renderDayState(); // resets the closing form to 0 as part of showing it
  renderFinancePage();
};
window.dayStartOver = dayStartOver;

// Midnight auto-close removed - day status is for Operations reporting only.


// ═══════════════════════════════════════════════════════════
// INITIALISATION
// ═══════════════════════════════════════════════════════════
initDB();
updateFirebaseEnvUI();
setTimeout(initFirebase, 800);
setTimeout(() => setItemMode(true), 0);
// Update sync dot 3s after startup — Firebase should be connected by then
setTimeout(updateSyncDot, 3000);

// ── Debounced sync (pull remote, then push local) ───────────
let _autoSyncTimer = null;
let _syncRunning = false;
function scheduleSync() {
  if (!navigator.onLine || !fbReady || !fbDb) return;
  clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(async () => {
    if (_syncRunning) return;
    _syncRunning = true;
    try {
      // Only push items that genuinely have no fbId yet (unsynced local records).
      // Individual fbSyncItem/Sale calls already handle normal writes — this is
      // a safety net for records created while offline.
      const items = await dbAll('items');
      const unsyncedItems = items.filter(i => !i.fbId);
      if (unsyncedItems.length > 0) {
        console.log('[SYNC] scheduleSync: pushing', unsyncedItems.length, 'unsynced item(s)');
        for (const item of unsyncedItems) fbSyncItem(item);
      }
      const sales = await dbAll('sales');
      const unsyncedSales = sales.filter(s => !s.fbId);
      if (unsyncedSales.length > 0) {
        console.log('[SYNC] scheduleSync: pushing', unsyncedSales.length, 'unsynced sale(s)');
        for (const sale of unsyncedSales) fbSyncSale(sale);
      }
    } catch (_) { /* intentionally ignored */ }
    finally { _syncRunning = false; updateSyncDot(); }
  }, 2000);
}

// ═══════════════════════════════════════════════════════════
// WINDOW EXPORTS - all onclick= handlers
// ═══════════════════════════════════════════════════════════
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
window.deleteType = deleteType;
window.disconnectFirebase = disconnectFirebase;
window.reconnectFirebase = reconnectFirebase;
window.setFirebaseEnvironment = setFirebaseEnvironment;
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
window.clearLocalData = clearLocalData;
window.clearCloudData = clearCloudData;
window.clearBothLocalAndCloud = clearBothLocalAndCloud;
window.clearAppCacheAndReload = clearAppCacheAndReload;
window.runSyncDebug = runSyncDebug;
window.saveFinanceEntry = saveFinanceEntry;
window.saveFirebaseConfig = saveFirebaseConfig;
window.saveItem = saveItem;
window.saveWishlistItem = saveWishlistItem;
window.searchSell = searchSell;
window.selectPayment = selectPayment;
window.showPage = showPage;
window.showInventoryTab = showInventoryTab;
window.showSalesTab = showSalesTab;
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
  const typeEl = UI.el('f-type');
  const type   = typeEl ? String(typeEl.value || '').trim() : '';
  const shoePanel  = UI.el('shoe-size-panel');
  const stdPricing = UI.el('std-pricing-section');
  if (!shoePanel || !stdPricing) return;

  const isShoe = isAddFormFootwearContext();
  _lastAddFormType = type;

  if (isShoe !== _addFormWasFootwear) {
    _shoeState.reset();
    if (!isShoe) resetShoeUiPanels();
    _preloadShoeCode = '';
  }
  _addFormWasFootwear = isShoe;

  applyAddFormFootwearUI(isShoe);
}
window.onTypeChange = onTypeChange;

async function renderHistoryPage() {
  const today     = todayDateStr();
  // Ensure allItems is fresh for inventory status badges
  if (!allItems.length) allItems = await dbAll('items');

  const allSales = await dbAll('sales');

  const filterEl  = UI.el('hist-period-filter');
  const filterVal = filterEl ? filterEl.value : 'today';

  // ── Timezone-safe local date helpers (no UTC shift) ────────────
  function _localDateStr(offsetDays) {
    const [y, m, d] = today.split('-').map(Number);
    const dt = new Date(y, m - 1, d + offsetDays);
    return dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getDate()).padStart(2, '0');
  }
  function _monthStr(yearOff, monthOff) {
    const [y, m] = today.split('-').map(Number);
    const dt = new Date(y, m - 1 + monthOff + yearOff * 12, 1);
    return dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-01';
  }

  // ── Filter ranges ──────────────────────────────────────────────
  // cutoffStr  = earliest date to include (d >= cutoffStr)
  // ceilingStr = exclusive upper bound    (d <  ceilingStr)
  // includeToday = whether today's records appear in this view
  let cutoffStr    = null;
  let ceilingStr   = null;
  let includeToday = false;
  let rangeLabel   = 'Records';

  if (filterVal === 'today') {
    cutoffStr    = today;           // only today (00:00 → now)
    ceilingStr   = null;
    includeToday = true;
    rangeLabel   = new Date().toLocaleDateString('en-GB',
      { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  } else if (filterVal === 'week') {
    cutoffStr    = _localDateStr(-6); // 7 days incl. today
    includeToday = true;
    rangeLabel   = _localDateStr(-6) + ' – ' + today;
  } else if (filterVal === 'prev_week') {
    cutoffStr    = _localDateStr(-7); // 7 days before today
    ceilingStr   = today;             // today excluded
    rangeLabel   = _localDateStr(-7) + ' – ' + _localDateStr(-1);
  } else if (filterVal === 'month') {
    cutoffStr    = _monthStr(0, 0);   // 1st of this month → today
    includeToday = true;
    rangeLabel   = _monthStr(0, 0) + ' – ' + today;
  } else if (filterVal === 'prev_month') {
    cutoffStr    = _localDateStr(-29); // rolling 30 days incl. today
    includeToday = true;
    rangeLabel   = _localDateStr(-29) + ' – ' + today;
  } else if (filterVal === 'all') {
    cutoffStr    = null;
    includeToday = true;
    rangeLabel   = 'All records';
  }

  // Show date range label
  const rangeEl = document.getElementById('hist-range-label');
  if (rangeEl) rangeEl.textContent = rangeLabel;

  const byDate = {};
  allSales.forEach(s => {
    const d = s.businessDate || (s.date ? s.date.slice(0, 10) : null) || today;
    if (d === today && !includeToday) return;    // skip today unless filter includes it
    if (d > today) return;                        // never show future records
    if (cutoffStr  && d < cutoffStr)  return;
    if (ceilingStr && d >= ceilingStr) return;
    if (!byDate[d]) byDate[d] = { sales:[], revenue:0, profit:0, cost:0, qty:0, hours:{} };
    byDate[d].sales.push(s);
    byDate[d].revenue += (s.revenue || 0);
    byDate[d].profit  += (s.profit  || 0);
    byDate[d].cost    += ((s.revenue||0) - (s.profit||0));
    byDate[d].qty     += (s.qty || 0);
    // Track hourly distribution for sparkline (0-23)
    const hr = s.date ? new Date(s.date).getHours() : 12;
    byDate[d].hours[hr] = (byDate[d].hours[hr] || 0) + (s.revenue || 0);
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
  const periodCost = datesSorted.reduce((s,d) => s + byDate[d].cost,    0);
  const periodProf = datesSorted.reduce((s,d) => s + byDate[d].profit,  0);
  const periodSales= datesSorted.reduce((s,d) => s + byDate[d].sales.length, 0);
  const pMargin    = periodRev > 0 ? (periodProf / periodRev * 100).toFixed(1) : '0.0';

  // Date range label
  const firstDate = datesSorted[datesSorted.length - 1];
  const lastDate  = datesSorted[0];
  const fmtDR = d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB',{ day:'numeric', month:'short', year:'numeric' });
  const dateRangeLabel = firstDate === lastDate ? fmtDR(firstDate) : fmtDR(firstDate) + ' – ' + fmtDR(lastDate);

  // Insights — best day by revenue
  const bestRevDay  = datesSorted.reduce((best,d) => byDate[d].revenue > (byDate[best]?.revenue||0) ? d : best, datesSorted[0]);
  const bestRevInfo = byDate[bestRevDay];
  const bestRevDt   = new Date(bestRevDay + 'T12:00:00').toLocaleDateString('en-GB',{ weekday:'short', day:'numeric', month:'short' });
  const insightText = `Your best day was ${bestRevDt} with ${_fmtNum(bestRevInfo.revenue)} in sales and ${_fmtNum(bestRevInfo.profit)} in earning.`;

  // Store byDate for click access
  window._histByDate = byDate;

  // Helper: build a 6-bar sparkline SVG from hourly data
  function _sparkline(hours) {
    const slots = [
      [5,9,'Morning'], [9,12,'Late morning'], [12,15,'Afternoon'],
      [15,18,'Eve'], [18,22,'Night'], [22,5,'Late night']
    ];
    const vals = slots.map(([from, to]) => {
      let v = 0;
      for (let h = from; h !== to; h = (h + 1) % 24) v += (hours[h] || 0);
      return v;
    });
    const max = Math.max(...vals, 1);
    const bars = vals.map((v, i) => {
      const h = Math.round((v / max) * 20) || 1;
      const x = i * 9 + 1;
      return `<rect x="${x}" y="${22 - h}" width="7" height="${h}" rx="1" fill="${v > 0 ? '#16a34a' : '#e5e7eb'}"/>`;
    }).join('');
    return `<svg width="56" height="24" viewBox="0 0 56 24" class="hdc-spark">${bars}</svg>`;
  }

  // Running total for cumulative profit
  let runningProfit = 0;

  // Day cards (5 per row), newest first
  const dayCards = datesSorted.map(date => {
    const day    = byDate[date];
    const safeId = date.replace(/-/g,'');
    const dt     = new Date(date + 'T12:00:00');
    const wday   = dt.toLocaleDateString('en-GB', { weekday:'short' });
    const dnum   = dt.getDate();
    const mon    = dt.toLocaleDateString('en-GB', { month:'short' });
    const earningColor = day.profit >= 0 ? '#16a34a' : '#dc2626';
    const isBest  = date === bestRevDay && datesSorted.length > 1;
    const isToday = date === today;
    runningProfit += day.profit;
    const spark = _sparkline(day.hours || {});

    return `<div class="pr-day-card${isBest ? ' hdc-best' : ''}${isToday ? ' hdc-today' : ''}" onclick="expandHistDay('${safeId}')">
      ${isBest  ? '<div class="hdc-best-badge">★ Best day</div>' : ''}
      ${isToday ? '<div class="hdc-today-badge">Today</div>' : ''}
      <div class="pr-day-header">
        <span class="pr-day-date"><strong>${wday} ${dnum}</strong> ${mon}</span>
        <span class="pr-day-meta">${day.sales.length} sales • ${fmtN(day.qty)} pcs</span>
      </div>
      <div class="pr-day-figures">
        <div class="pr-fig">
          <div class="pr-fig-lbl">Sales</div>
          <div class="pr-fig-val pr-col-blue">${_fmtNum(day.revenue)}</div>
        </div>
        <div class="pr-fig">
          <div class="pr-fig-lbl">Cost</div>
          <div class="pr-fig-val pr-col-orange">${_fmtNum(day.cost)}</div>
        </div>
        <div class="pr-fig">
          <div class="pr-fig-lbl">Earning</div>
          <div class="pr-fig-val" style="color:${earningColor};font-weight:900;font-family:var(--mono);">${_fmtNum(day.profit)}</div>
        </div>
      </div>
      <div class="hdc-footer">
        ${spark}
        <span class="hdc-running" style="color:${runningProfit>=0?'#16a34a':'#dc2626'};">
          Σ ${_fmtNum(runningProfit)}
        </span>
      </div>
    </div>`;
  }).join('');

  recList.innerHTML = `
    <!-- Period summary — 4 compact cards in one row -->
    <div class="pr-sum-row">
      <div class="pr-sum-card">
        <div class="pr-sum-lbl">Revenue</div>
        <div class="pr-sum-val pr-col-green">${_fmtNum(periodRev)}</div>
      </div>
      <div class="pr-sum-card">
        <div class="pr-sum-lbl">Cost</div>
        <div class="pr-sum-val pr-col-orange">${_fmtNum(periodCost)}</div>
      </div>
      <div class="pr-sum-card pr-sum-highlight">
        <div class="pr-sum-lbl" style="color:rgba(255,255,255,.75);">Earning</div>
        <div class="pr-sum-val" style="color:white;">${_fmtNum(periodProf)}</div>
      </div>
      <div class="pr-sum-card">
        <div class="pr-sum-lbl">Sales</div>
        <div class="pr-sum-val pr-col-blue">${periodSales}</div>
      </div>
    </div>

    <!-- Day cards — horizontal scroll row -->
    <div class="pr-days-grid">${dayCards}</div>

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
    </div>`;

  // Auto-expand today's card when "Today" filter is selected
  if (filterVal === 'today' && byDate[today]) {
    _expandedHistDay = null;  // reset so expandHistDay doesn't collapse
    setTimeout(() => expandHistDay(today.replace(/-/g, '')), 0);
  }
}

// Money formatted for a table cell (no currency prefix - shown once in the header instead)
function _fmtNum(n) {
  return (parseFloat(n) || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ── Tabular sale record renderer — totals pinned top, newest first ─
function _histTable(sales, totalBuy, totalSell, totalProfit) {
  // Newest first — oldest at bottom
  const sorted = [...sales].sort((a, b) => new Date(b.date||0) - new Date(a.date||0));
  const n = sorted.length;

  const detailRows = sorted.map((s, i) => {
    const qty    = s.qty || 1;
    const buy    = (s.buyPrice || 0) * qty;
    const sell   = (s.actualPrice || s.sellPrice || 0) * qty;
    const profit = s.profit || 0;
    const rawName = (s.itemName || s.itemCode || 'Item') +
      (s.itemSize ? ' · Sz ' + s.itemSize : '') +
      (qty > 1 ? ' ×' + qty : '');
    const click   = s.id ? `onclick="openSaleDetail(${s.id})"` : '';
    const profCls = profit >= 0 ? 'hp-pos' : 'hp-neg';
    const inInv   = allItems.some(item =>
      (s.itemId && item.id === s.itemId) || (s.itemCode && item.code === s.itemCode));
    const invBadge = inInv
      ? '<span class="inv-circle inv-circle-found" title="In inventory">✓</span>'
      : '<span class="inv-circle inv-circle-missing" title="Not in inventory">✕</span>';
    // Row number: 1 = most recent (top), n = oldest (bottom)
    return `<tr class="hist-clickable-row" ${click}>` +
      `<td class="hist-num">${i + 1}</td>` +
      `<td>${escapeHtml(rawName)}</td>` +
      `<td>${_fmtNum(buy)}</td>` +
      `<td>${_fmtNum(sell)}</td>` +
      `<td class="${profCls}">${_fmtNum(profit)}</td>` +
      `<td class="hist-td-chevron">${invBadge}</td>` +
    `</tr>`;
  }).join('');

  // Totals row — pinned at TOP below header
  const profCls = totalProfit >= 0 ? 'hp-pos' : 'hp-neg';
  const totalsRow =
    `<tr class="hist-totals-top">` +
      `<td class="hist-num" style="color:var(--muted);font-size:9px;">${n}</td>` +
      `<td style="font-weight:800;color:var(--muted);font-size:11px;letter-spacing:.3px;">TOTALS</td>` +
      `<td>${_fmtNum(totalBuy)}</td>` +
      `<td>${_fmtNum(totalSell)}</td>` +
      `<td class="${profCls}">${_fmtNum(totalProfit)}</td>` +
      `<td></td>` +
    `</tr>`;

  return `<div class="hist-table-wrap"><table class="hist-table hist-table-lined">` +
    `<thead><tr>` +
      `<th class="hist-num">#</th>` +
      `<th>Item</th>` +
      `<th>Cost</th>` +
      `<th>Revenue</th>` +
      `<th>Profit</th>` +
      `<th></th>` +
    `</tr></thead>` +
    `<tbody>${totalsRow}${detailRows}</tbody>` +
  `</table></div>`;
}
window.renderHistoryPage = renderHistoryPage;

/**
 * After a new item is saved, find every sale that shares the same itemCode
 * but hasn't been linked to this item's ID yet, and update them.
 * This makes itemCode the stable cross-system key — itemId is kept in sync.
 */
async function _backfillSalesForItem(item) {
  if (!item || !item.code || !item.id) return 0;
  const allSales = await dbAll('sales');
  const toFix = allSales.filter(s =>
    s.itemCode === item.code && s.itemId !== item.id
  );
  if (!toFix.length) return 0;
  for (const sale of toFix) {
    sale.itemId    = item.id;
    // Also ensure itemName and itemType are current
    if (item.name) sale.itemName = item.name;
    if (item.type) sale.itemType = item.type;
    sale.updatedAt = new Date().toISOString();
    await dbPut('sales', sale);
    fbSyncSale(sale);
  }
  console.log(`[BACKFILL] Linked ${toFix.length} sale(s) to item ${item.code} (id=${item.id})`);
  return toFix.length;
}

// ── History day drill-down: hide grid, show full day detail ────────
let _expandedHistDay = null;

function expandHistDay(safeId) {
  const grid = document.querySelector('.pr-days-grid');
  const area = document.getElementById('hist-expanded-area');
  if (!area || !grid) return;

  // Collapse if same card tapped again
  if (_expandedHistDay === safeId) {
    collapseHistDay();
    return;
  }
  _expandedHistDay = safeId;

  const date = safeId.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
  const day  = (window._histByDate || {})[date];
  if (!day) return;

  const dt       = new Date(date + 'T12:00:00');
  const label    = dt.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  const rows     = [...day.sales].sort((a,b) => new Date(b.date) - new Date(a.date));
  const profColor = day.profit >= 0 ? '#16a34a' : '#dc2626';
  const totalPcs  = rows.reduce((s, r) => s + (r.qty || 1), 0);
  const isToday   = date === todayDateStr();

  area.innerHTML = `
    <div class="hist-drill-header">
      ${!isToday ? `<button class="hist-drill-back" onclick="collapseHistDay()">
        <i class="fa-solid fa-arrow-left"></i> All days
      </button>` : ''}
      <div class="hist-drill-title">${label}</div>
    </div>
    <div class="hist-day-stats-row">
      <div class="hdsr-card">
        <div class="hdsr-val pr-col-blue">${_fmtNum(day.revenue)}</div>
        <div class="hdsr-lbl">Revenue</div>
      </div>
      <div class="hdsr-card">
        <div class="hdsr-val pr-col-orange">${_fmtNum(day.cost)}</div>
        <div class="hdsr-lbl">Cost</div>
      </div>
      <div class="hdsr-card hdsr-card-earn">
        <div class="hdsr-val" style="color:${profColor};">${_fmtNum(day.profit)}</div>
        <div class="hdsr-lbl">Earning</div>
      </div>
      <div class="hdsr-card">
        <div class="hdsr-val">${fmtN(totalPcs)}</div>
        <div class="hdsr-lbl">Sold</div>
      </div>
    </div>
    ${_histTable(rows, day.cost, day.revenue, day.profit)}`;

  // Hide the grid, show detail
  grid.style.display = 'none';
  area.style.display = 'block';
}
window.expandHistDay = expandHistDay;

async function exportSalesReport() {
  // Export only the currently visible period + filters
  const allSales = await dbAll('sales');
  const filterVal = document.getElementById('hist-period-filter')?.value || 'all';
  const today = todayDateStr();
  const _histPay = window._histPayFilter || 'all';
  const _histSearch = (document.getElementById('hist-item-search')?.value || '').toLowerCase().trim();

  const filtered = [...allSales].filter(s => {
    const d = s.businessDate || (s.date||'').slice(0,10);
    if (filterVal === 'today') { if (d !== today) return false; }
    else if (filterVal === 'yesterday') {
      const y = new Date(); y.setDate(y.getDate()-1);
      if (d !== y.toISOString().split('T')[0]) return false;
    } else if (filterVal !== 'all') {
      // reuse same logic — just approximate by checking if in visible byDate
      if (!window._histByDate?.[d] && d !== today) return false;
    }
    if (_histPay !== 'all' && (s.paymentMethod||'cash').toLowerCase() !== _histPay) return false;
    if (_histSearch && !(s.itemName||'').toLowerCase().includes(_histSearch) && !(s.itemCode||'').toLowerCase().includes(_histSearch)) return false;
    return true;
  }).sort((a,b)=>(b.businessDate||'').localeCompare(a.businessDate||''));

  const periodLabel = filterVal.replace('_',' ');
  const rows = [['Date','Item','Code','Qty','Buy Price','Revenue','Profit','Payment']];
  filtered.forEach(s => rows.push([
    s.businessDate || (s.date||'').slice(0,10),
    s.itemName || '', s.itemCode || '',
    s.qty||1, s.buyPrice||0, s.revenue||0, s.profit||0, s.paymentMethod||'cash'
  ]));
  const csv  = rows.map(r => r.map(v => '"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\n');
  const blob = new Blob([csv], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:'sales-'+periodLabel+'.csv' });
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast(filtered.length + ' records exported', 'ok');
}
window.exportSalesReport = exportSalesReport;

/** Payment method chip selector */
function histSetPay(method) {
  window._histPayFilter = method;
  document.querySelectorAll('.hist-pay-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.pay === method);
  });
  renderHistoryPage();
}
window.histSetPay = histSetPay;

function collapseHistDay() {
  _expandedHistDay = null;
  const grid = document.querySelector('.pr-days-grid');
  const area = document.getElementById('hist-expanded-area');
  if (grid) grid.style.display = 'grid';
  if (area) { area.style.display = 'none'; area.innerHTML = ''; }
}
window.collapseHistDay = collapseHistDay;

function toggleHistDay(safeId) { expandHistDay(safeId); }
window.toggleHistDay = toggleHistDay;

// ══════════════════════════════════════════════════════════════════
// SALE DETAIL SHEET
// ══════════════════════════════════════════════════════════════════

async function openSaleDetail(saleId) {
  const sale = await dbGet('sales', saleId);
  if (!sale) { toast('Sale not found', 'err'); return; }

  document.getElementById('sds-id').value = saleId;

  // Populate view
  const qty   = sale.qty || 1;
  const price = sale.actualPrice || sale.sellPrice || 0;
  const buy   = sale.buyPrice || 0;
  const profit= sale.profit || qty * (price - buy);
  const dateStr = sale.date
    ? new Date(sale.date).toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
    : (sale.businessDate || '—');

  document.getElementById('sds-name').textContent    = sale.itemName || '—';
  document.getElementById('sds-code').textContent    = sale.itemCode || '';
  document.getElementById('sds-qty').textContent     = fmtN(qty);
  document.getElementById('sds-price').textContent   = fmt(price);
  document.getElementById('sds-revenue').textContent = fmt(qty * price);
  const profEl = document.getElementById('sds-profit');
  profEl.textContent  = (profit >= 0 ? '+' : '') + fmt(profit);
  profEl.style.color  = profit >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('sds-date').textContent = dateStr;

  const pm = (sale.paymentMethod || 'cash').toUpperCase();
  const pmBadge = document.getElementById('sds-payment-badge');
  pmBadge.textContent = pm;
  pmBadge.className = 'sds-item-badge sds-pm-' + (sale.paymentMethod || 'cash').toLowerCase();

  // Pre-fill edit form
  document.getElementById('sds-edit-qty').value   = qty;
  document.getElementById('sds-edit-price').value = price;
  const pmSel = document.getElementById('sds-edit-payment');
  if (pmSel) pmSel.value = sale.paymentMethod || 'cash';

  // Reset to view mode
  document.getElementById('sds-edit-form').style.display = 'none';
  document.getElementById('sds-view').style.display      = 'block';
  document.getElementById('sds-actions').style.display   = 'flex';

  document.getElementById('sale-detail-sheet').classList.add('open');
}
window.openSaleDetail = openSaleDetail;

function closeSaleDetailSheet() {
  document.getElementById('sale-detail-sheet').classList.remove('open');
}
window.closeSaleDetailSheet = closeSaleDetailSheet;

function toggleSaleEditForm() {
  const form = document.getElementById('sds-edit-form');
  const view = document.getElementById('sds-view');
  const acts = document.getElementById('sds-actions');
  const showing = form.style.display !== 'none';
  form.style.display = showing ? 'none' : 'block';
  view.style.display = 'block';
  // Hide action buttons while editing to reduce clutter
  if (!showing) acts.style.display = 'none';
  else          acts.style.display = 'flex';
}
window.toggleSaleEditForm = toggleSaleEditForm;

function discardSaleEdit() {
  document.getElementById('sds-edit-form').style.display = 'none';
  document.getElementById('sds-actions').style.display   = 'flex';
}
window.discardSaleEdit = discardSaleEdit;

async function saveSaleEdit() {
  const id    = parseInt(document.getElementById('sds-id').value);
  const qty   = parseInt(document.getElementById('sds-edit-qty').value)   || 1;
  const price = parseFloat(document.getElementById('sds-edit-price').value) || 0;
  const pm    = document.getElementById('sds-edit-payment').value || 'cash';
  if (qty <= 0)  { toast('Qty must be at least 1', 'err'); return; }
  if (price < 0) { toast('Price cannot be negative', 'err'); return; }
  const sale = await dbGet('sales', id);
  if (!sale) { toast('Sale not found', 'err'); return; }
  const buy = sale.buyPrice || 0;
  sale.qty           = qty;
  sale.actualPrice   = price;
  sale.sellPrice     = price;
  sale.paymentMethod = pm;
  sale.revenue       = qty * price;
  sale.profit        = qty * (price - buy);
  sale.updatedAt     = new Date().toISOString();
  await dbPut('sales', sale);
  fbSyncSale(sale);
  closeSaleDetailSheet();
  await refreshUI();
  await renderHistoryPage();
  try { await renderSellPage(); } catch(_) {}
  toast('Sale updated', 'ok');
}
window.saveSaleEdit = saveSaleEdit;

async function deleteSaleFromDetail() {
  const id = parseInt(document.getElementById('sds-id').value);
  if (!id) return;
  const sale = await dbGet('sales', id);
  const label = sale ? (sale.itemName || sale.itemCode || 'this sale') : 'this sale';
  if (!confirm('⚠ Delete sale of "' + label + '"?\n\nThis cannot be undone.')) return;
  closeSaleDetailSheet();
  // Skip deleteSale's own confirm — already confirmed above
  if (sale) {
    _rememberDeletedSale(sale);
    await fbDeleteSale(sale);
    await _deleteLocalRevenueForSale(id);
  }
  await dbDelete('sales', id);
  await refreshUI();
  refreshSalesViews();
  renderFinancePage();
  toast('Sale deleted', '');
}
window.deleteSaleFromDetail = deleteSaleFromDetail;

async function saleAddToInventoryFromDetail() {
  const id = parseInt(document.getElementById('sds-id').value);
  const sale = await dbGet('sales', id);
  if (!sale) { toast('Sale not found', 'err'); return; }
  closeSaleDetailSheet();
  showPage('add');
  await new Promise(r => setTimeout(r, 100));
  // Match type or default to General
  const matchType = types.find(t => t.name === sale.itemType && isCategoryActive(t));
  const useType   = matchType ? sale.itemType : (types.find(t => t.name === 'General' && isCategoryActive(t)) ? 'General' : '');
  setAddFormType(useType, { skipTypeChange: false });
  await new Promise(r => setTimeout(r, 80));
  const el = id => document.getElementById(id);
  if (el('f-code')) el('f-code').value = sale.itemCode || '';
  if (el('f-name')) el('f-name').value = sale.itemName || '';
  if (el('f-buy'))  el('f-buy').value  = sale.buyPrice > 0 ? sale.buyPrice : '';
  if (el('f-sell')) el('f-sell').value = sale.sellPrice > 0 ? sale.sellPrice : '';
  updateProfitPreview();
  setItemMode(true);   // Default to Record Only
  toast('Pre-filled from sale — save to link across system', '');
}
window.saleAddToInventoryFromDetail = saleAddToInventoryFromDetail;

function renderAllShoeGroupCards() {
  const groups = getShoeGroups();
  ['S', 'M', 'L'].forEach(g => {
    const container = document.getElementById('sg-card-sizes-' + g);
    const card = document.getElementById('sg-card-' + g);
    const rng = document.getElementById('sg-range-' + g);
    if (!container) return;
    if (!groups[g]) {
      container.innerHTML = '';
      if (card) card.classList.remove('sg-card-active');
      return;
    }
    const { min, max } = groups[g];
    if (rng) {
      const lbl = groups[g].label ? groups[g].label + ' - ' : '';
      rng.textContent = lbl + min + '–' + max;
    }
    container.innerHTML = '';
    for (let s = min; s <= max; s++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isLocked = _shoeState.lockedSizes.has(s);
      btn.className = 'sz-btn' + (_shoeState.sizes.has(s) ? ' sz-active' : '') + (isLocked ? ' sz-locked' : '');
      btn.id = 'sz-' + s;
      btn.textContent = String(s);
      if (isLocked) {
        btn.disabled = true;
        btn.title = 'Already in stock';
      } else {
        btn.onclick = () => toggleShoeSize(s);
      }
      container.appendChild(btn);
    }
    const anySelected = _getGroupSizes(g).some(sz => _shoeState.sizes.has(sz));
    if (card) card.classList.toggle('sg-card-active', anySelected);
    if (anySelected) _shoeState.shownGroups.add(g);
    else _shoeState.shownGroups.delete(g);
  });
}

function selectSizeGroup(g) {
  const sizes = _getGroupSizes(g);
  if (!sizes.length) return;
  const allOn = sizes.every(s => _shoeState.sizes.has(s));
  sizes.forEach(s => {
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
  updateShoeCollectiveSummary();
}
window.setShoeMode = setShoeMode;

let _shoeCollectiveListenersOn = false;

function initShoeCollectiveSummaryListeners() {
  if (_shoeCollectiveListenersOn) return;
  _shoeCollectiveListenersOn = true;
  ['shoe-shared-qty', 'shoe-shared-buy', 'shoe-shared-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateShoeCollectiveSummary);
  });
  const rows = document.getElementById('shoe-rows');
  if (rows) {
    rows.addEventListener('input', e => {
      if (e.target && e.target.classList && e.target.classList.contains('shoe-cell')) {
        updateShoeCollectiveSummary();
      }
    });
  }
}

function updateShoeCollectiveSummary() {
  renderShoeSummary();
  const qtyEl = document.getElementById('shoe-metric-qty');
  const bpEl = document.getElementById('shoe-metric-bp');
  const spEl = document.getElementById('shoe-metric-sp');
  if (!qtyEl || !bpEl || !spEl) return;

  const sorted = _shoeState.sortedSizes;
  const n = sorted.length;
  if (!n) {
    qtyEl.textContent = '0';
    bpEl.textContent = '-';
    spEl.textContent = '-';
    bpEl.classList.remove('accent');
    spEl.classList.remove('accent');
    return;
  }

  if (!_shoeState.perSizeMode) {
    const qPer = parseInt(UI.el('shoe-shared-qty')?.value || '0', 10) || 0;
    const bp = parseFloat(UI.el('shoe-shared-buy')?.value || '0') || 0;
    const sp = parseFloat(UI.el('shoe-shared-sell')?.value || '0') || 0;
    const totalQty = qPer * n;
    qtyEl.textContent = String(totalQty);
    bpEl.textContent = bp > 0 ? fmt(bp) : '-';
    spEl.textContent = sp > 0 ? fmt(sp) : '-';
    bpEl.classList.toggle('accent', bp > 0);
    spEl.classList.toggle('accent', sp > 0);
    return;
  }

  let totalQty = 0;
  let buySum = 0;
  let sellSum = 0;
  let priced = 0;
  sorted.forEach(s => {
    const q = parseInt(UI.el('shr-qty-' + s)?.value || '0', 10) || 0;
    const b = parseFloat(UI.el('shr-buy-' + s)?.value || '0') || 0;
    const p = parseFloat(UI.el('shr-sell-' + s)?.value || '0') || 0;
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
    bpEl.classList.add('accent');
    spEl.classList.add('accent');
  } else {
    bpEl.textContent = '-';
    spEl.textContent = '-';
    bpEl.classList.remove('accent');
    spEl.classList.remove('accent');
  }
}
window.updateShoeCollectiveSummary = updateShoeCollectiveSummary;

async function upsertShoeSize(record, opts) {
  const addQty = !!(opts && opts.addQty);
  const all = await dbAll('shoe_sizes');
  const existing = all.find(s => s.itemCode === record.itemCode && s.size === record.size);
  if (existing) {
    const incomingQty = record.qty || 0;
    const updated = {
     ...existing,
     ...record,
      qty: addQty ? (existing.qty || 0) + incomingQty : incomingQty,
      id: existing.id
    };
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
        // Unique codeSize violation - find and update existing
        const byCS = all.find(s => s.codeSize === record.codeSize);
        if (byCS) {
          const updated = {...byCS,...record, id: byCS.id };
          await dbPut('shoe_sizes', updated);
          return updated;
        }
      }
      throw e;
    }
  }
}

async function saveShoeItems(baseCode, baseName, type) {
  if (_shoeState.sizes.size === 0) { toast('Warning: Select at least one size', 'err'); return false; }

  if (!_shoeState.group) {
    const firstSize = [..._shoeState.sizes][0];
    _shoeState.group = _shoeState.groupFor(firstSize) || 'S';
  }

  let sharedQty = 0, sharedBuy = 0, sharedSell = 0;
  if (!_shoeState.perSizeMode) {
    sharedQty  = parseInt(UI.el('shoe-shared-qty')?.value  || '0') || 0;
    sharedBuy  = parseFloat(UI.el('shoe-shared-buy')?.value  || '0') || 0;
    sharedSell = parseFloat(UI.el('shoe-shared-sell')?.value || '0') || 0;
    if (sharedQty < 0)  { toast('Warning: Quantity cannot be negative', 'err'); return false; }
    if (sharedBuy < 0)  { toast('Warning: Buy price cannot be negative', 'err'); return false; }
    if (sharedSell < 0) { toast('Warning: Sell price cannot be negative', 'err'); return false; }
    if (sharedBuy > 0 && sharedSell > 0 && sharedSell < sharedBuy) { toast('Warning: Sell price cannot be less than buy price', 'err'); return false; }
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
      if (qty < 0)  { perSizeErrors.push('Size ' + size + ': quantity cannot be negative'); continue; }
      if (buy < 0)  { perSizeErrors.push('Size ' + size + ': buy price cannot be negative'); continue; }
      if (sell < 0) { perSizeErrors.push('Size ' + size + ': sell price cannot be negative'); continue; }
      if (buy > 0 && sell > 0 && sell < buy) { perSizeErrors.push('Size ' + size + ': sell price cannot be less than buy price'); continue; }
    } else { qty = sharedQty; buy = sharedBuy; sell = sharedSell; }

    await upsertShoeSize({
      itemCode: baseCode, itemId: product.id,
      size, sizeGroup: _shoeState.groupFor(size),
      qty, buyPrice: buy, sellPrice: sell, profit: sell - buy,
      codeSize: baseCode + '_' + size,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, { addQty: true });
    saved++;
    stockCost += qty * buy;
    stockQty += qty;
  }

  if (perSizeErrors.length) toast('Warning: Skipped: ' + perSizeErrors.join(' - '), 'err');
  if (saved === 0) { toast('Warning: No sizes saved - check quantity and price values', 'err'); return false; }

  const allSz = await getShoeSizes(baseCode);
  product.qty = allSz.reduce((t, s) => t + s.qty, 0);
  await dbPut('items', product);
  await recordStockInvestment(product, stockCost, stockQty, 'Shoe stock');
  await markWishlistStockedForItem(product);
  fbSyncItem(product);

  if (_addFormPhotoData && product?.id) {
    await setItemPhoto(product.id, _addFormPhotoData);
  }

  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      for (const sz of allSz) {
        const szStable = stableShoeSizeFbId(sz);
        if (sz.fbId !== szStable) { sz.fbId = szStable; await dbPut('shoe_sizes', sz); }
        await setDoc(fbDoc('shoe_sizes', sz.fbId), sanitiseForFirestore({...sz}));
      }
    } catch(e) { console.warn('[SYNC] shoe_sizes:', e.message); }
  }
  return saved;
}
window.saveShoeItems = saveShoeItems;

function deselectSizeGroup(g) {
  _getGroupSizes(g).forEach(s => _shoeState.sizes.delete(s));
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
  if (_shoeState.sizes.has(s)) _shoeState.sizes.delete(s); else _shoeState.sizes.add(s);

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
  const item = await dbGet('items', itemId);
  if (!item) { toast('Item not found', 'err'); return; }
  const sizes  = await getShoeSizes(item.code);
  const sizeRec = sizes.find(s => s.size === size);
  if (!sizeRec) { toast('Size record not found', 'err'); return; }
  closeShoeSizeActions();
  closeSheet();
  showPage('add');
  setTimeout(() => {
    setAddFormType(item.type || '', { skipTypeChange: true });
    UI.el('f-code').value  = item.code  || '';
    UI.el('f-name').value  = item.name  || '';
    UI.el('edit-id').value = 'shoe_restock_' + itemId + '_' + size;
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || '';
    setAddTypeLocked(true);
    showRestockView({
      code: item.code,
      name: item.name,
      type: item.type,
      size,
      stock: sizeRec.qty || 0,
      stockUnit: ' pcs',
      buy: sizeRec.buyPrice || item.buyPrice || 0,
      sell: sizeRec.sellPrice || item.sellPrice || 0
    });
    updateProfitPreview();
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
    setAddFormType(item.type || '', { skipTypeChange: true });
    UI.el('f-code').value  = item.code  || '';
    UI.el('f-name').value  = item.name  || '';
    UI.el('f-size').value  = size;
    UI.el('f-qty').value   = sizeRec.qty   ?? '';
    UI.el('f-buy').value   = sizeRec.buyPrice  || '';
    UI.el('f-sell').value  = sizeRec.sellPrice || '';
    UI.el('edit-id').value = 'shoe_edit_' + itemId + '_' + size;
    onTypeChange();
    ['f-code','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = true; el.style.opacity = '0.45'; el.style.cursor = 'not-allowed'; }
    });
    setAddTypeLocked(true);
    setSaveBtnLabel('Save size ' + size);
    const _ml3 = UI.el('form-mode-label');
    if (_ml3) { _ml3.hidden = false; _ml3.textContent = 'Edit size ' + size + ' - ' + item.code; }
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
  if (el('sm-meta'))  el('sm-meta').textContent  = item.code + ' - Size ' + size;
  if (el('sm-stock')) el('sm-stock').textContent = sizeRec.qty;
  if (el('sm-sell'))  el('sm-sell').textContent  = fmt(sizeRec.sellPrice || item.sellPrice || 0);
  if (el('sm-cur'))   el('sm-cur').textContent   = currency;
  if (el('sm-qty'))   { el('sm-qty').value = 0; el('sm-qty').min = 0; el('sm-qty').max = sizeRec.qty; }
  if (el('sm-actual')) el('sm-actual').value = '';
  _toggleSmBuyField(sizeRec.buyPrice || item.buyPrice || 0);
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
  const defaults = JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  const saved = localStorage.getItem(KEY_SHOE_GROUPS);
  if (!saved) return defaults;
  try {
    const parsed = JSON.parse(saved);
    const out = Object.assign({}, defaults);
    for (const g of ['S', 'M', 'L']) {
      const cfg = parsed[g];
      const min = parseInt(cfg?.min, 10);
      const max = parseInt(cfg?.max, 10);
      if (Number.isFinite(min) && Number.isFinite(max) && min >= 1 && max <= 60 && min <= max) {
        out[g] = { min, max, label: cfg.label || defaults[g]?.label || '' };
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
  const rows = document.getElementById('shoe-rows');
  if (!rows) return;
  if (!_shoeState.perSizeMode) { rows.innerHTML = ''; return; }
  const sorted = _shoeState.sortedSizes;
  rows.innerHTML = sorted.map(s =>
    '<div class="shoe-row">' +
    '<span class="shoe-sz-lbl">' + s + '</span>' +
    '<input type="number" class="shoe-cell" id="shr-qty-' + s + '" min="0" inputmode="numeric" placeholder="Qty">' +
    '<input type="number" class="shoe-cell" id="shr-buy-' + s + '" min="0" inputmode="decimal" placeholder="BP">' +
    '<input type="number" class="shoe-cell" id="shr-sell-' + s + '" min="0" inputmode="decimal" placeholder="SP">' +
    '</div>'
  ).join('');
  updateShoeCollectiveSummary();
}
function renderShoeSummary() {
  const el = UI.el('shoe-selected-summary');
  if (!el) return;
  const sorted = _shoeState.sortedSizes;
  if (!sorted.length) {
    el.innerHTML = '<span class="shoe-selected-chips-empty">-</span>';
  } else {
    el.innerHTML = sorted.map(s => {
      const g = (_shoeState.groupFor(s) || 's').toLowerCase();
      return '<span class="shoe-selected-chip shoe-chip-' + g + '">' + s + '</span>';
    }).join('');
  }
  const saveBtn = UI.el('save-btn');
  const panel   = UI.el('shoe-size-panel');
  if (saveBtn && panel && panel.style.display !== 'none' && sorted.length) {
    setSaveBtnLabel('Save ' + sorted.length + ' size' + (sorted.length > 1 ? 's' : ''));
  }
}

// ═══════════════════════════════════════════════════════════
// PHOTO IMPORT MODULE — Import inventory from a handwritten stock photo
// ═══════════════════════════════════════════════════════════

var _piExtractedRows = [];
var _piImageDataUrl = '';

function openPhotoImport() {
  _piExtractedRows = [];
  _piImageDataUrl = '';
  var sheet = document.getElementById('photo-import-sheet');
  if (!sheet) return;
  _piShowStep('capture');
  var prevWrap = document.getElementById('pi-preview-wrap');
  if (prevWrap) prevWrap.style.display = 'none';
  var img = document.getElementById('pi-image-preview');
  if (img) img.src = '';
  sheet.classList.add('active');
}

function closePhotoImport() {
  var sheet = document.getElementById('photo-import-sheet');
  if (sheet) sheet.classList.remove('active');
}

function _piShowStep(step) {
  var steps = ['capture', 'loading', 'preview', 'importing'];
  for (var i = 0; i < steps.length; i++) {
    var el = document.getElementById('pi-step-' + steps[i]);
    if (el) el.style.display = (steps[i] === step) ? '' : 'none';
  }
}

function onPhotoImportFileSelected(input) {
  if (!input || !input.files || !input.files[0]) return;
  var file = input.files[0];
  var reader = new FileReader();
  reader.onload = function(e) {
    _piImageDataUrl = e.target.result;
    // Show thumbnail briefly on capture step
    var img = document.getElementById('pi-image-preview');
    if (img) { img.src = _piImageDataUrl; img.style.display = 'block'; }
    // Auto-extract — no extra button tap needed
    extractFromPhoto();
  };
  reader.readAsDataURL(file);
}

async function extractFromPhoto() {
  if (!_piImageDataUrl) {
    toast('Please select an image first', 'err');
    return;
  }
  var key = getGeminiKey();
  if (!key) {
    toast('Add your Gemini API key in Settings first', 'err');
    return;
  }

  _piShowStep('loading');
  // Show photo thumbnail in loading screen for context
  var thumb = document.getElementById('pi-loading-thumb');
  if (thumb && _piImageDataUrl) { thumb.src = _piImageDataUrl; thumb.style.display = 'block'; }

  try {
    var base64Match = _piImageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!base64Match) throw new Error('Invalid image format');
    var mimeType = base64Match[1];
    var base64Data = base64Match[2];

    var prompt = 'Look at this handwritten stock list image. Extract all inventory items you can see. ' +
      'Return ONLY a valid JSON array (no markdown, no code fences, no explanation) where each element has these fields: ' +
      '"name" (string, product name), "code" (string, short product code or abbreviation, uppercase, max 12 chars), ' +
      '"category" (string, product category if visible, else empty string), ' +
      '"qty" (number, quantity, default 0 if not visible), ' +
      '"buyPrice" (number, buying/cost price, default 0 if not visible), ' +
      '"sellPrice" (number, selling price, default 0 if not visible). ' +
      'Return an empty array [] if no items are found. Output only the JSON array.';

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=' + key;

    var body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ]
      }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    };

    var response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      var errText = await response.text();
      throw new Error('Gemini API error ' + response.status + ': ' + errText.slice(0, 200));
    }

    var data = await response.json();
    var rawText = '';
    try {
      rawText = data.candidates[0].content.parts[0].text || '';
    } catch (_e) {
      throw new Error('Unexpected Gemini response format');
    }

    // Strip markdown code fences if present
    rawText = rawText.trim();
    rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    var parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed)) throw new Error('AI did not return an array');

    _piExtractedRows = parsed.map(function(r) {
      return {
        name:      String(r.name || '').trim(),
        code:      String(r.code || '').trim().toUpperCase(),
        category:  String(r.category || '').trim(),
        qty:       parseFloat(r.qty) || 0,
        buyPrice:  parseFloat(r.buyPrice) || 0,
        sellPrice: parseFloat(r.sellPrice) || 0
      };
    });

    if (_piExtractedRows.length === 0) {
      toast('No items found in image. Try a clearer photo.', 'err');
      _piShowStep('capture');
      return;
    }

    _piRenderPreviewTable();
    _piShowStep('preview');

  } catch (err) {
    console.error('[PhotoImport] extractFromPhoto error:', err);
    toast('AI extraction failed: ' + (err.message || 'Unknown error'), 'err');
    _piShowStep('capture');
  }
}

function _piRenderPreviewTable() {
  var tbody = document.getElementById('pi-preview-tbody');
  if (!tbody) return;

  var badge = document.getElementById('pi-count-badge');
  if (badge) badge.textContent = _piExtractedRows.length + ' item' + (_piExtractedRows.length !== 1 ? 's' : '');

  // Build category options from global types array
  var catOptions = '<option value="">— None —</option>';
  var sortedTypes = (types || []).slice().sort(function(a, b) {
    return (a.name || '').localeCompare(b.name || '');
  });
  for (var ti = 0; ti < sortedTypes.length; ti++) {
    var t = sortedTypes[ti];
    catOptions += '<option value="' + escapeHtml(t.name) + '">' +
      escapeHtml((t.emoji || '') + ' ' + t.name) + '</option>';
  }

  var html = '';
  for (var i = 0; i < _piExtractedRows.length; i++) {
    var row = _piExtractedRows[i];
    var catSel = catOptions.replace(
      'value="' + escapeHtml(row.category) + '"',
      'value="' + escapeHtml(row.category) + '" selected'
    );
    html += '<tr id="pi-row-' + i + '">' +
      '<td><input class="pi-cell" type="text" value="' + escapeHtml(row.name) + '"' +
        ' onchange="_piUpdateRow(' + i + ',\'name\',this.value)" placeholder="Item name"></td>' +
      '<td><input class="pi-cell pi-mono" type="text" value="' + escapeHtml(row.code) + '"' +
        ' onchange="_piUpdateRow(' + i + ',\'code\',this.value)" placeholder="CODE" style="text-transform:uppercase;"></td>' +
      '<td><select class="pi-select" onchange="_piUpdateRow(' + i + ',\'category\',this.value)">' +
        catSel + '</select></td>' +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' + row.qty + '" min="0"' +
        ' onchange="_piUpdateRow(' + i + ',\'qty\',this.value)"></td>' +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' + row.buyPrice + '" min="0"' +
        ' onchange="_piUpdateRow(' + i + ',\'buyPrice\',this.value)"></td>' +
      '<td class="pi-num"><input class="pi-cell pi-num" type="number" value="' + row.sellPrice + '" min="0"' +
        ' onchange="_piUpdateRow(' + i + ',\'sellPrice\',this.value)"></td>' +
      '<td><button class="pi-del-btn" onclick="_piDeleteRow(' + i + ')" title="Remove row">' +
        '<i class="fa-solid fa-trash-can"></i></button></td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

function _piUpdateRow(i, field, value) {
  if (!_piExtractedRows[i]) return;
  if (field === 'qty' || field === 'buyPrice' || field === 'sellPrice') {
    _piExtractedRows[i][field] = parseFloat(value) || 0;
  } else {
    _piExtractedRows[i][field] = String(value || '').trim();
  }
}

function _piDeleteRow(i) {
  _piExtractedRows.splice(i, 1);
  _piRenderPreviewTable();
}

function piAddRow() {
  _piExtractedRows.push({ name: '', code: '', category: '', qty: 0, buyPrice: 0, sellPrice: 0 });
  _piRenderPreviewTable();
  // Scroll to new row
  var tbody = document.getElementById('pi-preview-tbody');
  if (tbody) {
    var rows = tbody.querySelectorAll('tr');
    if (rows.length) rows[rows.length - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function importPhotoItems() {
  // Collect current input values from DOM (user may have typed without triggering onchange)
  var tbody = document.getElementById('pi-preview-tbody');
  if (tbody) {
    var domRows = tbody.querySelectorAll('tr[id^="pi-row-"]');
    for (var di = 0; di < domRows.length; di++) {
      var inputs = domRows[di].querySelectorAll('input, select');
      var idx = parseInt(domRows[di].id.replace('pi-row-', ''), 10);
      if (isNaN(idx) || !_piExtractedRows[idx]) continue;
      var fields = ['name', 'code', 'category', 'qty', 'buyPrice', 'sellPrice'];
      for (var fi = 0; fi < inputs.length && fi < fields.length; fi++) {
        var val = inputs[fi].value;
        var fld = fields[fi];
        if (fld === 'qty' || fld === 'buyPrice' || fld === 'sellPrice') {
          _piExtractedRows[idx][fld] = parseFloat(val) || 0;
        } else {
          _piExtractedRows[idx][fld] = String(val || '').trim();
        }
      }
    }
  }

  // Validate rows
  var valid = [];
  var skipped = 0;
  for (var vi = 0; vi < _piExtractedRows.length; vi++) {
    var r = _piExtractedRows[vi];
    if (!r.name || !r.code) { skipped++; continue; }
    valid.push(r);
  }

  if (valid.length === 0) {
    toast('No valid rows (name + code required for each item)', 'err');
    return;
  }

  _piShowStep('importing');

  var imported = 0;
  var restocked = 0;
  var errors = 0;

  for (var ii = 0; ii < valid.length; ii++) {
    var row = valid[ii];

    // Update progress UI
    var pct = Math.round(((ii + 1) / valid.length) * 100);
    var fill = document.getElementById('pi-progress-fill');
    var label = document.getElementById('pi-progress-label');
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = 'Importing ' + (ii + 1) + ' of ' + valid.length + ': ' + escapeHtml(row.name);

    try {
      var buy = parseFloat(row.buyPrice) || 0;
      var sell = parseFloat(row.sellPrice) || 0;
      var qty = parseFloat(row.qty) || 0;
      var profit = sell - buy;

      // Check if item with this code already exists
      var existing = null;
      for (var ei = 0; ei < allItems.length; ei++) {
        if ((allItems[ei].code || '').trim().toUpperCase() === row.code.toUpperCase()) {
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
        await dbPut('items', existing);
        await recordStockInvestment(existing, qty * buy, qty, 'Photo import restock');
        fbSyncItem(existing);
        restocked++;
      } else {
        // Create new item
        var now = new Date().toISOString();
        var newItem = {
          code:       row.code.toUpperCase(),
          name:       row.name,
          type:       row.category || '',
          category:   row.category || '',
          buyPrice:   buy,
          sellPrice:  sell,
          profit:     profit,
          qty:        qty,
          isRecord:   false,
          isShoe:     false,
          hasVariants:false,
          variant:    '',
          createdAt:  now,
          updatedAt:  now
        };
        newItem.fbId = stableItemFbId(newItem);
        var newId = await dbAdd('items', newItem);
        newItem.id = newId;
        await markWishlistStockedForItem(newItem);
        await recordStockInvestment(newItem, qty * buy, qty, 'Photo import');
        fbSyncItem(newItem);
        imported++;
      }
    } catch (rowErr) {
      console.error('[PhotoImport] Row error for', row.code, rowErr);
      errors++;
    }
  }

  // Refresh app state
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList();
  renderDashboard();
  updateHeader();
  scheduleSync();

  closePhotoImport();

  var msg = '';
  if (imported > 0) msg += imported + ' new item' + (imported !== 1 ? 's' : '') + ' added. ';
  if (restocked > 0) msg += restocked + ' item' + (restocked !== 1 ? 's' : '') + ' restocked. ';
  if (skipped > 0) msg += skipped + ' row' + (skipped !== 1 ? 's' : '') + ' skipped (missing name/code). ';
  if (errors > 0) msg += errors + ' error' + (errors !== 1 ? 's' : '') + '.';

  if (errors > 0 && imported === 0 && restocked === 0) {
    toast(msg.trim() || 'Import failed', 'err');
  } else {
    toast(msg.trim() || 'Import complete', 'ok');
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

let _currentCustomerId = null;

// ── Generate next customer ID: C-0001, C-0002, … ──────────────────
async function _nextCustomerId() {
  const all = await dbAll('customers');
  if (!all.length) return 'C-0001';
  const nums = all.map(c => {
    const m = (c.customerId || '').match(/^C-(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  });
  const next = Math.max(...nums) + 1;
  return 'C-' + String(next).padStart(4, '0');
}

// ── Add Customer sheet ─────────────────────────────────────────────
async function openAddCustomerSheet() {
  const overlay = document.getElementById('add-customer-sheet');
  if (!overlay) return;
  const n = document.getElementById('cust-form-name');
  const p = document.getElementById('cust-form-phone');
  if (n) n.value = '';
  if (p) p.value = '';
  overlay.classList.add('open');
  setTimeout(() => { if (n) n.focus(); }, 120);
}
window.openAddCustomerSheet = openAddCustomerSheet;

function closeAddCustomerSheet() {
  const sheet = document.getElementById('add-customer-sheet');
  if (sheet) sheet.classList.remove('open');
}
window.closeAddCustomerSheet = closeAddCustomerSheet;

let _custSaving = false;   // prevent double-save on all customer forms

function _custUpdateHeaderBal(bal) {
  const el  = document.getElementById('cust-detail-bal');
  const lbl = document.getElementById('cust-detail-bal-lbl');
  if (!el) return;
  if (bal > 0) {
    el.textContent  = fmt(bal);
    el.style.color  = '#ff6b6b';
    if (lbl) { lbl.textContent = 'Owes you'; lbl.style.color = 'rgba(255,255,255,.7)'; }
  } else if (bal < 0) {
    el.textContent  = fmt(Math.abs(bal));
    el.style.color  = '#6bffb8';
    if (lbl) { lbl.textContent = 'You owe them'; lbl.style.color = 'rgba(255,255,255,.7)'; }
  } else {
    el.textContent  = 'Clear';
    el.style.color  = 'rgba(255,255,255,.8)';
    if (lbl) { lbl.textContent = 'No balance'; lbl.style.color = 'rgba(255,255,255,.5)'; }
  }
}

function onCustItemTypeChange() {
  const type   = document.getElementById('cust-item-type')?.value || 'item';
  const title  = document.querySelector('#cust-item-sheet .sheet-title');
  if (title) title.textContent = type === 'return' ? 'Record Return' : 'Add Item';
}
window.onCustItemTypeChange = onCustItemTypeChange;

async function saveNewCustomer() {
  if (_custSaving) return;
  const name  = (document.getElementById('cust-form-name')?.value  || '').trim();
  const phone = (document.getElementById('cust-form-phone')?.value || '').trim();
  if (!name) { toast('Customer name is required', 'err'); return; }

  _custSaving = true;
  try {
    const customerId = await _nextCustomerId();
    const now = new Date().toISOString();
    const customer = {
      customerId, name, phone,
      balance: 0, totalTaken: 0, totalPaid: 0,
      lastDate: '', createdAt: now, updatedAt: now, fbId: ''
    };
    const id = await dbAdd('customers', customer);
    customer.id = id;
    fbSyncCustomer(customer);
    closeAddCustomerSheet();
    await renderCustomerList('');
    toast('✓ Customer added', 'ok');
  } catch(e) {
    toast('Failed to save customer', 'err');
    console.error('[CUST]', e);
  } finally { _custSaving = false; }
}
window.saveNewCustomer = saveNewCustomer;

// ── Customer List ──────────────────────────────────────────────────
async function renderCustomerList(query) {
  const container = document.getElementById('customer-list');
  if (!container) return;
  let customers = (await dbAll('customers')).filter(c => !c.isDeleted);
  const q = (query || '').trim().toLowerCase();
  if (q) {
    customers = customers.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.phone || '').toLowerCase().includes(q)
    );
  }
  // Sort by balance descending (highest debtors first), then name
  customers.sort((a, b) => {
    const bd = (b.balance || 0) - (a.balance || 0);
    if (bd !== 0) return bd;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (!customers.length) {
    container.innerHTML = `<div class="empty-state" style="padding:40px 20px;text-align:center;color:var(--muted);">
      <i class="fa-solid fa-users" style="font-size:32px;margin-bottom:10px;display:block;opacity:.3;"></i>
      <div>${q ? 'No customers match your search.' : 'No customers yet. Tap <strong>+ Add Customer</strong> to get started.'}</div>
    </div>`;
    return;
  }

  container.innerHTML = customers.map(c => {
    const initials  = (c.name || '?').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
    const bal       = c.balance || 0;
    const balNum    = fmt(Math.abs(bal));
    const balColor  = bal > 0 ? '#dc2626' : bal < 0 ? '#16a34a' : 'var(--muted)';
    const balLabel  = bal > 0 ? 'Owes' : bal < 0 ? 'Credit' : 'Clear';
    const balVal    = bal !== 0 ? balNum : '';
    const avatarBg  = bal > 0 ? '#dc2626' : bal < 0 ? '#16a34a' : 'var(--accent)';
    const lastTxt   = c.lastDate ? c.lastDate : '';
    return `<div class="cust-card" onclick="openCustomerDetail('${escapeHtml(c.customerId)}')">
      <div class="cust-avatar" style="background:${avatarBg};">${escapeHtml(initials)}</div>
      <div class="cust-info">
        <div class="cust-name">${escapeHtml(c.name || '')}</div>
        <div class="cust-meta">${escapeHtml(c.phone || 'No phone')}${lastTxt ? ' · ' + lastTxt : ''}</div>
      </div>
      <div class="cust-balance-col">
        ${bal !== 0 ? `<div class="cust-balance-val" style="color:${balColor};">${balVal}</div>` : ''}
        <div class="cust-balance-lbl" style="color:${balColor};font-weight:${bal !== 0 ? '800' : '600'};">${balLabel}</div>
      </div>
      <i class="fa-solid fa-chevron-right" style="color:var(--muted);font-size:10px;margin-left:2px;flex-shrink:0;"></i>
    </div>`;
  }).join('');
}
window.renderCustomerList = renderCustomerList;

function onCustomerSearch(val) {
  const btn = document.getElementById('cust-search-clear');
  if (btn) btn.style.display = val ? 'flex' : 'none';
  renderCustomerList(val);
}
window.onCustomerSearch = onCustomerSearch;

// ── Customer Detail (full page, not popup) ────────────────────────
async function openCustomerDetail(customerId) {
  _currentCustomerId = customerId;
  const customer = (await dbAll('customers')).find(c => c.customerId === customerId);
  if (!customer) { toast('Customer not found', 'err'); return; }

  const nameEl = document.getElementById('cust-detail-name');
  const idEl   = document.getElementById('cust-detail-id');
  if (nameEl) nameEl.textContent = customer.name || '';
  if (idEl)   idEl.textContent  = customer.phone || customer.customerId;
  _custUpdateHeaderBal(customer.balance || 0);

  // Navigate to the detail page (full screen, no popup)
  _origShowPage('customer-detail');
  showCustomerTab('ledger');
}
window.openCustomerDetail = openCustomerDetail;

function closeCustomerDetail() {
  _currentCustomerId = null;
  _origShowPage('customers');   // go back to customer list
}
window.closeCustomerDetail = closeCustomerDetail;

// ── Delete customer (soft delete → recycle bin) ────────────────────
async function deleteCustomer() {
  if (!_currentCustomerId) return;
  const all      = await dbAll('customers');
  const customer = all.find(c => c.customerId === _currentCustomerId);
  if (!customer) return;
  if (!confirm('Move "' + (customer.name || 'this customer') + '" to recycle bin?\n\nTheir records will be kept and can be restored later.')) return;

  customer.isDeleted  = true;
  customer.deletedAt  = new Date().toISOString();
  customer.updatedAt  = new Date().toISOString();
  await dbPut('customers', customer);
  fbSyncCustomer(customer);
  toast('Moved to recycle bin', '');
  closeCustomerDetail();
  await renderCustomerList('');
}
window.deleteCustomer = deleteCustomer;

function showCustomerTab(tab) {
  // Update tab button states
  document.querySelectorAll('.cust-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  // Show/hide tab panes
  document.querySelectorAll('.cust-tab-pane').forEach(pane => {
    pane.style.display = pane.dataset.tab === tab ? 'block' : 'none';
  });

  // All views now combined in the ledger — just refresh it
  if (!_currentCustomerId) return;
  _renderCustomerLedger(_currentCustomerId);
}
window.showCustomerTab = showCustomerTab;

// ── Summary tab: 4 stat cards ──────────────────────────────────────
async function _renderCustomerOverview(customer) {
  const el = document.getElementById('cust-tab-overview');
  if (!el) return;
  const txns    = (await dbAll('customer_txns')).filter(t => t.customerId === customer.customerId);
  const taken   = txns.filter(t => t.type === 'item').reduce((s,t) => s + (t.totalValue || 0), 0);
  const returns = txns.filter(t => t.type === 'return').reduce((s,t) => s + (t.totalValue || 0), 0);
  const paid    = txns.filter(t => t.type === 'payment').reduce((s,t) => s + (t.amount || 0), 0);
  const bal     = taken - returns - paid;
  const balColor = bal > 0 ? '#dc2626' : '#16a34a';

  el.innerHTML = `<div style="padding:12px;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
      <div style="padding:12px;border-radius:var(--r);background:var(--surface);border:1px solid var(--border);">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Total Taken (Dr)</div>
        <div style="font-size:17px;font-weight:900;font-family:var(--mono);color:#dc2626;">Ksh ${fmt(taken)}</div>
      </div>
      <div style="padding:12px;border-radius:var(--r);background:var(--surface);border:1px solid var(--border);">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Returns (Cr)</div>
        <div style="font-size:17px;font-weight:900;font-family:var(--mono);color:#f97316;">Ksh ${fmt(returns)}</div>
      </div>
      <div style="padding:12px;border-radius:var(--r);background:var(--surface);border:1px solid var(--border);">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Payments (Cr)</div>
        <div style="font-size:17px;font-weight:900;font-family:var(--mono);color:#16a34a;">Ksh ${fmt(paid)}</div>
      </div>
      <div style="padding:12px;border-radius:var(--r);background:${bal > 0 ? 'rgba(220,38,38,.06)' : 'rgba(22,163,74,.06)'};border:1.5px solid ${balColor};">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Balance Owed</div>
        <div style="font-size:17px;font-weight:900;font-family:var(--mono);color:${balColor};">${bal > 0 ? 'Ksh ' + fmt(bal) : bal < 0 ? 'Credit ' + fmt(Math.abs(bal)) : 'Clear'}</div>
      </div>
    </div>
    ${customer.phone ? `<div style="font-size:12px;color:var(--muted);"><i class="fa-solid fa-phone" style="margin-right:4px;"></i>${escapeHtml(customer.phone)}</div>` : ''}
    <div style="font-size:11px;color:var(--muted);margin-top:6px;">${fmtN(txns.length)} transaction${txns.length !== 1 ? 's' : ''} · Last: ${customer.lastDate || 'none'}</div>
  </div>`;
}

// ── Ledger: summary cards on top + balance-sheet table ─────────────
async function _renderCustomerLedger(customerId) {
  const el = document.getElementById('cust-tab-ledger');
  if (!el) return;
  const allCust = await dbAll('customers');
  const customer = allCust.find(c => c.customerId === customerId);
  const txns = (await dbAll('customer_txns')).filter(t => t.customerId === customerId);
  // Sort oldest first (running balance flows forward in time)
  txns.sort((a, b) => (a.date||'').localeCompare(b.date||'') || (a.createdAt||'').localeCompare(b.createdAt||''));

  // ── Summary cards ──────────────────────────────────────────────
  const taken   = txns.filter(t => t.type === 'item').reduce((s,t) => s + (t.totalValue||0), 0);
  const returns = txns.filter(t => t.type === 'return').reduce((s,t) => s + (t.totalValue||0), 0);
  const paid    = txns.filter(t => t.type === 'payment').reduce((s,t) => s + (t.amount||0), 0);
  const bal     = taken - returns - paid;
  const balColor = bal > 0 ? '#dc2626' : '#16a34a';

  const balLabel = bal > 0 ? 'Owes You' : bal < 0 ? 'You Owe' : 'Clear';
  const summaryHtml = `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border-bottom:2px solid var(--border);">
    <div style="background:var(--surface);padding:9px 7px;text-align:center;">
      <div style="font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:3px;">Taken</div>
      <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:#dc2626;">${fmt(taken)}</div>
    </div>
    <div style="background:var(--surface);padding:9px 7px;text-align:center;">
      <div style="font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:3px;">Returns</div>
      <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:#f97316;">${fmt(returns)}</div>
    </div>
    <div style="background:var(--surface);padding:9px 7px;text-align:center;">
      <div style="font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:3px;">Paid</div>
      <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:#16a34a;">${fmt(paid)}</div>
    </div>
    <div style="background:${bal > 0 ? 'rgba(220,38,38,.08)' : bal < 0 ? 'rgba(22,163,74,.08)' : 'var(--surface)'};padding:9px 7px;text-align:center;">
      <div style="font-size:8px;color:${balColor};text-transform:uppercase;font-weight:800;margin-bottom:3px;">${balLabel}</div>
      <div style="font-size:13px;font-weight:900;font-family:var(--mono);color:${balColor};">${bal !== 0 ? fmt(Math.abs(bal)) : '—'}</div>
    </div>
  </div>`;

  if (!txns.length) {
    el.innerHTML = summaryHtml + '<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">No transactions yet.</div>';
    return;
  }

  let runningBal = 0;
  const rows = txns.map(t => {
    const isDebit  = t.type === 'item';    // increases balance
    const isCredit = t.type !== 'item';    // payment or return
    const debit    = isDebit  ? (t.totalValue || (t.qty||1)*(t.unitPrice||0)) : 0;
    const credit   = isCredit ? (t.type === 'payment' ? (t.amount||0) : (t.totalValue||(t.qty||1)*(t.unitPrice||0))) : 0;
    runningBal += debit - credit;
    const balColor = runningBal > 0 ? '#dc2626' : '#16a34a';
    const typeLabel = t.type === 'item' ? (t.itemName || 'Item') :
                      t.type === 'return' ? 'Return: ' + (t.itemName || '') :
                      'Payment' + (t.paymentMethod ? ' · ' + t.paymentMethod : '');
    const detail = t.type === 'item' ? ` ×${t.qty||1} @ ${fmt(t.unitPrice||0)}` : '';
    const deleteBtn = t.id ? `<button onclick="deleteCustTxn(${t.id})" title="Delete" style="background:none;border:none;color:var(--muted);cursor:pointer;padding:0 2px;font-size:11px;opacity:.5;">✕</button>` : '';
    return `<tr class="cust-ledger-row">
      <td class="cust-ledger-date">${t.date || ''}</td>
      <td class="cust-ledger-desc">${escapeHtml(typeLabel)}${escapeHtml(detail)}${t.note ? '<br><span style="font-size:10px;color:var(--muted);font-style:italic;">' + escapeHtml(t.note) + '</span>' : ''}</td>
      <td class="cust-ledger-num" style="color:#dc2626;">${debit  > 0 ? fmt(debit)  : ''}</td>
      <td class="cust-ledger-num" style="color:#16a34a;">${credit > 0 ? fmt(credit) : ''}</td>
      <td class="cust-ledger-num" style="color:${balColor};font-weight:900;">${fmt(Math.abs(runningBal))}${runningBal < 0 ? ' Cr' : ''}</td>
      <td style="padding:4px 2px;text-align:center;">${deleteBtn}</td>
    </tr>`;
  }).join('');

  const finalBal = runningBal;
  const finalColor = finalBal > 0 ? '#dc2626' : '#16a34a';
  el.innerHTML = summaryHtml + `<div style="overflow-x:auto;">
    <table class="cust-ledger-table cust-ledger-lined">
      <thead><tr>
        <th>Date</th><th>Description</th>
        <th class="cust-ledger-num">Debit</th>
        <th class="cust-ledger-num">Credit</th>
        <th class="cust-ledger-num">Balance</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr style="border-top:2px solid var(--border);">
        <td colspan="4" style="padding:8px 6px;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--muted);">Balance carried forward</td>
        <td class="cust-ledger-num" style="font-weight:900;color:${finalColor};font-size:13px;">${finalBal > 0 ? fmt(finalBal) + ' Dr' : finalBal < 0 ? fmt(Math.abs(finalBal)) + ' Cr' : 'Nil'}</td>
        <td></td>
      </tr></tfoot>
    </table>
  </div>`;
}

// _renderCustomerHistory replaced by _renderCustomerLedger above

// ── Add Item to Customer ───────────────────────────────────────────
async function openCustItemSheet() {
  ['cust-item-name','cust-item-price','cust-item-note'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const qty  = document.getElementById('cust-item-qty');  if (qty)  qty.value  = '1';
  const date = document.getElementById('cust-item-date'); if (date) date.value = todayDateStr();
  const type = document.getElementById('cust-item-type'); if (type) type.value = 'item';
  onCustItemTypeChange();
  const overlay = document.getElementById('cust-item-sheet');
  if (overlay) overlay.classList.add('open');
  setTimeout(() => { const n = document.getElementById('cust-item-name'); if (n) n.focus(); }, 120);
}
window.openCustItemSheet = openCustItemSheet;

function closeCustItemSheet() {
  const sheet = document.getElementById('cust-item-sheet');
  if (sheet) sheet.classList.remove('open');
}
window.closeCustItemSheet = closeCustItemSheet;

async function saveCustItem() {
  if (!_currentCustomerId) return;
  const g    = id => document.getElementById(id);
  const type = g('cust-item-type')?.value || 'item';   // 'item' or 'return'
  const itemName  = (g('cust-item-name')?.value  || '').trim();
  const qty       = parseFloat(g('cust-item-qty')?.value)   || 0;
  const unitPrice = parseFloat(g('cust-item-price')?.value) || 0;
  const note      = (g('cust-item-note')?.value  || '').trim();
  const date      = g('cust-item-date')?.value || todayDateStr();

  if (!itemName)     { toast('Description is required', 'err'); return; }
  if (qty <= 0)      { toast('Quantity must be greater than 0', 'err'); return; }
  if (unitPrice <= 0){ toast('Price must be greater than 0', 'err'); return; }

  const totalValue = qty * unitPrice;
  const now = new Date().toISOString();
  const customer = (await dbAll('customers')).find(c => c.customerId === _currentCustomerId);
  if (!customer) { toast('Customer not found', 'err'); return; }
  const txn = {
    customerId: _currentCustomerId,
    customerName: customer.name || '',
    type,   // 'item' = debit, 'return' = credit
    itemName, qty, unitPrice, totalValue,
    amount: type === 'return' ? -totalValue : totalValue,
    paymentMethod: '',
    note, date, createdAt: now, fbId: ''
  };
  if (_custSaving) return;
  _custSaving = true;
  try {
    const txnId = await dbAdd('customer_txns', txn);
    txn.id = txnId;
    await _recalcBalance(_currentCustomerId);
    fbSyncCustTxn(txn);
    closeCustItemSheet();
    // Update header balance
    const updated = (await dbAll('customers')).find(c => c.customerId === _currentCustomerId);
    if (updated) _custUpdateHeaderBal(updated.balance || 0);
    showCustomerTab('ledger');
    toast(type === 'return' ? '✓ Return recorded' : '✓ Item saved', 'ok');
  } catch(e) {
    toast('Failed to save', 'err');
    console.error('[CUST]', e);
  } finally { _custSaving = false; }
}
window.saveCustItem = saveCustItem;

// ── Record Payment ─────────────────────────────────────────────────
async function openCustPaymentSheet() {
  const a = document.getElementById('cust-pay-amount'); if (a) a.value = '';
  const m = document.getElementById('cust-pay-method'); if (m) m.value = 'Cash';
  const n = document.getElementById('cust-pay-note');   if (n) n.value = '';
  const d = document.getElementById('cust-pay-date');   if (d) d.value = todayDateStr();
  const overlay = document.getElementById('cust-payment-sheet');
  if (overlay) overlay.classList.add('open');
  setTimeout(() => { if (a) a.focus(); }, 120);
}
window.openCustPaymentSheet = openCustPaymentSheet;

function closeCustPaymentSheet() {
  const sheet = document.getElementById('cust-payment-sheet');
  if (sheet) sheet.classList.remove('open');
}
window.closeCustPaymentSheet = closeCustPaymentSheet;

async function saveCustPayment() {
  if (!_currentCustomerId) return;
  const g = id => document.getElementById(id);
  const amount        = parseFloat(g('cust-pay-amount')?.value) || 0;
  const paymentMethod = (g('cust-pay-method')?.value || 'Cash').trim();
  const note          = (g('cust-pay-note')?.value   || '').trim();
  const date          = g('cust-pay-date')?.value    || todayDateStr();

  if (amount <= 0) { toast('Amount must be greater than 0', 'err'); return; }

  const now = new Date().toISOString();
  const customer = (await dbAll('customers')).find(c => c.customerId === _currentCustomerId);
  if (!customer) { toast('Customer not found', 'err'); return; }
  const txn = {
    customerId: _currentCustomerId,
    customerName: customer.name || '',
    type: 'payment',
    itemName: '', variant: '', size: '',
    qty: 0, unitPrice: 0, totalValue: 0,
    amount, paymentMethod,
    note, date, createdAt: now, fbId: ''
  };
  if (_custSaving) return;
  _custSaving = true;
  try {
    const txnId = await dbAdd('customer_txns', txn);
    txn.id = txnId;
    await _recalcBalance(_currentCustomerId);
    fbSyncCustTxn(txn);
    closeCustPaymentSheet();
    const updated = (await dbAll('customers')).find(c => c.customerId === _currentCustomerId);
    if (updated) _custUpdateHeaderBal(updated.balance || 0);
    showCustomerTab('ledger');
    toast('✓ Payment recorded', 'ok');
  } catch(e) {
    toast('Failed to save payment', 'err');
    console.error('[CUST]', e);
  } finally { _custSaving = false; }
}
window.saveCustPayment = saveCustPayment;

// ── Balance recalculation ──────────────────────────────────────────
async function _recalcBalance(customerId) {
  const txns = await dbAll('customer_txns');
  const custTxns = txns.filter(t => t.customerId === customerId);
  const totalTaken   = custTxns.filter(t => t.type === 'item').reduce((s, t) => s + (t.totalValue || 0), 0);
  const totalReturns = custTxns.filter(t => t.type === 'return').reduce((s, t) => s + (t.totalValue || 0), 0);
  const totalPaid    = custTxns.filter(t => t.type === 'payment').reduce((s, t) => s + (t.amount || 0), 0);
  const balance      = totalTaken - totalReturns - totalPaid;
  const sorted     = [...custTxns].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const lastDate   = sorted[0]?.date || '';

  const all      = await dbAll('customers');
  const customer = all.find(c => c.customerId === customerId);
  if (customer) {
    customer.totalTaken = totalTaken;
    customer.totalPaid  = totalPaid;
    customer.balance    = balance;
    customer.lastDate   = lastDate;
    customer.updatedAt  = new Date().toISOString();
    await dbPut('customers', customer);
    fbSyncCustomer(customer);
  }
}

// ── Delete a transaction ───────────────────────────────────────────
async function deleteCustTxn(txnId) {
  if (!confirm('Delete this record? The balance will be recalculated.')) return;
  const txns = await dbAll('customer_txns');
  const txn  = txns.find(t => t.id === txnId);
  if (!txn) return;
  await dbDelete('customer_txns', txnId);
  await _recalcBalance(txn.customerId);
  const upd = (await dbAll('customers')).find(c => c.customerId === txn.customerId);
  if (upd) _custUpdateHeaderBal(upd.balance || 0);
  showCustomerTab('ledger');
  // Refresh header balance
  const all = await dbAll('customers');
  const cust = all.find(c => c.customerId === txn.customerId);
  if (cust) {
    const balEl = document.getElementById('cust-detail-bal');
    if (balEl) {
      const bal = cust.balance || 0;
      balEl.textContent = bal > 0 ? `Ksh ${fmt(bal)} owed` : (bal < 0 ? `Ksh ${fmt(Math.abs(bal))} credit` : 'Balance clear');
      // color handled by _custUpdateHeaderBal
    }
  }
  toast('Record deleted', '');
}
window.deleteCustTxn = deleteCustTxn;

// ── Firebase sync ──────────────────────────────────────────────────
async function fbSyncCustomer(customer) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    if (!customer.fbId) {
      customer.fbId = 'cust_' + customer.customerId;
      await dbPut('customers', customer);
    }
    await setDoc(doc(fbDb, fbColName('customers'), customer.fbId), sanitiseForFirestore({ ...customer }));
    bumpSyncVersion();
  } catch (e) { console.error('[SYNC] fbSyncCustomer:', e.message); }
}

async function fbSyncCustTxn(txn) {
  if (!fbReady || !fbDb) return;
  try {
    const { doc, setDoc } = await waitForFbImports();
    if (!txn.fbId) {
      // Use txn id + timestamp to guarantee uniqueness
      const ts = (txn.createdAt || new Date().toISOString()).replace(/[^0-9]/g, '').slice(0, 14);
      txn.fbId = 'ctxn_' + (txn.customerId || 'x') + '_' + ts + '_' + (txn.id || Math.floor(Math.random() * 9999));
      await dbPut('customer_txns', txn);
    }
    await setDoc(doc(fbDb, fbColName('customer_txns'), txn.fbId), sanitiseForFirestore({ ...txn }));
  } catch (e) { console.error('[SYNC] fbSyncCustTxn:', e.message); }
}

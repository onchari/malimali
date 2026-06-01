// ===================================================================
// DATABASE SCHEMA  v11 —  Mandela General Stores
// ===================================================================
let db;
const DB_NAME = 'InventoryApp';
const DB_VER  = 11;

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

    // Compressed item/wish photos (JPEG/WebP data URLs). key: "item_12" | "wish_3"
    if (!d.objectStoreNames.contains('photos')) {
      d.createObjectStore('photos', { keyPath: 'key' });
    }

    // NOTE: day_sessions store (legacy) intentionally NOT created in v9.
    //       Existing data migrated to business_days by migrateData().
  };

  req.onerror = e => {
    console.error('[DB] Open error:', e.target.error);
    toast('Database error — try refreshing', 'err');
    setLoginReady(true);
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
      toast('Database setup failed — refresh the page', 'err');
      setLoginReady(true);
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
  let html = '<option value="">Parent category…</option>';
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

function openAllShoeSizeGroupsForAdd() {
  const grid = document.getElementById('sz-grid');
  if (!grid) return;
  ['S', 'M', 'L'].forEach(g => ensureSizeGroupOpen(g));
  const szGrid = document.getElementById('shoe-sizes-grid');
  const rowsWrap = document.getElementById('shoe-rows-wrap');
  const sharedWrap = document.getElementById('shoe-shared-wrap');
  if (szGrid) szGrid.style.removeProperty('display');
  if (rowsWrap) rowsWrap.style.display = 'block';
  if (sharedWrap && !_shoeState.perSizeMode) sharedWrap.style.display = 'block';
}

function revealShoeSizePickerUI() {
  openAllShoeSizeGroupsForAdd();
}

function applyAddFormFootwearUI(isShoe) {
  const pageAdd = document.getElementById('page-add');
  if (pageAdd) pageAdd.classList.toggle('footwear-add-mode', !!isShoe);
  const shoePanel  = UI.el('shoe-size-panel');
  const stdPricing = UI.el('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  const inRestock  = pageAdd?.classList.contains('restock-mode');
  if (inRestock) {
    if (shoePanel) shoePanel.style.display = 'none';
    if (stdPricing) stdPricing.style.display = 'block';
    return;
  }
  if (isShoe) {
    if (shoePanel) shoePanel.style.removeProperty('display');
    if (stdPricing) stdPricing.style.display = 'none';
    if (sizeField) sizeField.style.display = 'none';
    renderShoeGroupButtons();
    openAllShoeSizeGroupsForAdd();
  } else {
    if (shoePanel) shoePanel.style.display = 'none';
    if (stdPricing) stdPricing.style.removeProperty('display');
    if (sizeField) sizeField.style.removeProperty('display');
  }
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

  /** Optional money — empty allowed, must be >= 0 if entered */
  moneyOptional(value, fieldId, label) {
    if (value === null) return true;
    if (!Number.isFinite(value)) return this.fail('Enter a valid number', fieldId);
    if (value < 0) return this.fail((label || 'Amount') + ' cannot be negative', fieldId);
    if (value > 99999999) return this.fail((label || 'Amount') + ' is too large', fieldId);
    return true;
  },

  /** Opening day — at least one pocket entered; empty ≠ zero */
  dayOpening(cash, till, mpesa) {
    const vals = [cash, till, mpesa];
    const ids = ['op-cash', 'op-till', 'op-mpesa'];
    if (vals.every(v => v === null)) {
      return this.fail('Enter opening balances — type 0 if a pocket is empty', 'op-cash');
    }
    for (let i = 0; i < vals.length; i++) {
      if (vals[i] === null) continue;
      if (!Number.isFinite(vals[i])) return this.fail('Enter valid numbers only', ids[i]);
      if (vals[i] < 0) return this.fail('Opening balance cannot be negative', ids[i]);
    }
    return true;
  },

  /** Closing physical count — cash/till/mpesa required (not all blank) */
  dayClosingPhysical(cash, till, mpesa) {
    const vals = [cash, till, mpesa];
    const ids = ['cl-cash', 'cl-till', 'cl-mpesa'];
    if (vals.every(v => v === null)) {
      return this.fail('Enter closing cash, till, or M-Pesa — type 0 if empty', 'cl-cash');
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

  /** Integer qty optional (empty → null) */
  intOptional(value, fieldId, label) {
    if (value === null) return true;
    if (!Number.isFinite(value)) return this.fail('Enter a valid whole number', fieldId);
    if (value < 0) return this.fail((label || 'Quantity') + ' cannot be negative', fieldId);
    return true;
  },
};

/** Unified input parsing — empty field is null, not zero */
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
  if (id === 'settings') { renderCategorySettings(); }
}

// Guard: wrap showPage to enforce tab access by role
// Defined immediately after showPage so _origShowPage is available at startup
const _origShowPage = showPage;
showPage = function(id) {
  if (currentUser && !userCanAccessNav(id, currentUser)) {
    toast('⛔ Access denied', 'err');
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
    for (const t of DEFAULT_TYPES) await dbAdd('types', { ...t });
    types = await dbAll('types');
  }
  await normalizeTypeRecords();
  if (!types.some(t => isFootwearType(t.name))) {
    await dbAdd('types', { ...DEFAULT_TYPES[0] });
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
  el.value = config.valueMode === 'id' ? String(rec.id) : rec.name;
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
    breadcrumb.textContent = pathRecs.map(t => (t.emoji || '📦') + ' ' + t.name).join(' › ');
  } else if (pathRecs.length) {
    breadcrumb.hidden = false;
    breadcrumb.textContent = pathRecs.map(t => (t.emoji || '📦') + ' ' + t.name).join(' › ') + ' › …';
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
  const ph0 = config.placeholder || 'Choose category…';
  const phN = config.placeholderSub || 'Choose sub-category…';
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
    placeholder: base.placeholder || 'Choose category…',
    placeholderSub: base.placeholderSub || 'Choose sub-category…',
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
  const config = _makeCascadeConfig({ ...opts, wrap, idPrefix });
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
    placeholder: 'Category…'
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
    placeholder: 'Category…'
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
    placeholder: 'Parent category…'
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
    // Do not close over opts.skipTypeChange — config.rerender() reuses this callback after
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
        '<input type="search" class="cat-picker-search" placeholder="Search categories…" autocomplete="off" spellcheck="false">' +
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
    searchEl.focus();
  });
}
window.openCategoryPicker = openCategoryPicker;

function setAddFormSubtitle(text) {
  const el = document.getElementById('add-form-sub');
  if (el) el.textContent = text || 'Category → details → stock → save';
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
    if (el) el.textContent = (val != null && val !== '') ? val : '—';
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
    stockEl.textContent = stock != null ? (stock + (meta.stockUnit || '')) : '—';
    stockEl.classList.toggle('rs-stock-out', stock === 0);
    stockEl.classList.toggle('rs-stock-ok', stock != null && stock > 0);
  }
  setCell('rs-buy', meta.buy != null ? fmt(meta.buy) : '—');
  setCell('rs-sell', meta.sell != null ? fmt(meta.sell) : '—');

  setRestockBanner(false);
  const ml = UI.el('form-mode-label');
  if (ml) ml.textContent = meta.size != null ? 'Restock · Size ' + meta.size : 'Restock';
  setAddFormSubtitle(meta.code ? meta.code + (meta.name ? ' · ' + meta.name : '') : 'Add quantity to stock');

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
  if (szWrap) szWrap.style.display = 'none';
  if (szInner) szInner.innerHTML = '';
  const sum = UI.el('shoe-selected-summary');
  if (sum) sum.innerHTML = '';
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
              (footwear ? ' · Size-grid mode' : '') + '</div>' +
          '</div>' +
          '<div class="cat-toggles">' +
            '<button type="button" class="cat-toggle' + (active ? ' on' : '') + '" onclick="toggleCategoryActive(' + t.id + ')" title="Show in dropdowns">' +
              (active ? 'ON' : 'OFF') + '</button>' +
            '<button type="button" class="cat-toggle foot' + (footwear ? ' on' : '') + '" onclick="toggleCategoryFootwear(' + t.id + ')" title="Use shoe size grid">' +
              '👟</button>' +
            '<button type="button" class="type-del" onclick="deleteType(' + t.id + ')">✕</button>' +
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
        '<input id="sg-label-' + g + '" type="text" class="type-input" placeholder="' + g + ' — display name" value="' + escapeHtml(lbl) + '" style="flex:1;min-width:0;" aria-label="' + g + ' display name">' +
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

async function addType() {
  try {
  const name = document.getElementById('new-type-name').value.trim();
  if (!name) { toast('Enter a category name', 'err'); return; }
  if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Category already exists', 'err'); return; }
  const isFootwear = document.getElementById('new-type-footwear')?.checked || false;
  await dbAdd('types', {
    name, emoji: selectedEmoji, color: '#1e293b',
    active: true, parentId: null, isFootwear, sortOrder: types.length + 1
  });
  document.getElementById('new-type-name').value = '';
  const ft = document.getElementById('new-type-footwear');
  if (ft) ft.checked = false;
  await loadTypes();
  renderCategorySettings();
  toast('Category added', 'ok');
  } catch(e) { console.error("[addType]", e); toast("Error: " + e.message, "err"); }
}

async function addSubCategory() {
  try {
    const parentId = parseInt(document.getElementById('new-sub-parent')?.value, 10);
    const name = (document.getElementById('new-sub-name')?.value || '').trim();
    if (!parentId) return Validate.fail('Select a parent category', 'new-sub-parent');
    if (!name) { toast('Enter sub-category name', 'err'); return; }
    if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Name already exists', 'err'); return; }
    const parent = getTypeById(parentId);
    const inheritFootwear = parent ? isFootwearType(parent.name) : false;
    await dbAdd('types', {
      name,
      emoji: parent?.emoji || selectedEmoji,
      color: parent?.color || '#1e293b',
      active: true,
      parentId,
      isFootwear: inheritFootwear,
      sortOrder: types.filter(t => _typeParentMatches(t.parentId, parentId)).length + 1
    });
    document.getElementById('new-sub-name').value = '';
    await loadTypes();
    renderCategorySettings();
    toast('Sub-category added', 'ok');
  } catch (e) {
    console.error('[addSubCategory]', e);
    toast('Error: ' + e.message, 'err');
  }
}
window.addSubCategory = addSubCategory;

async function deleteType(id) {
  try {
  const allItems = await dbAll('items');
  const typeObj = getTypeById(id);
  const descIds = collectCategoryDescendantIds(id);
  const descRecords = descIds.map(did => getTypeById(did)).filter(Boolean);
  const namesToCheck = [typeObj?.name, ...descRecords.map(t => t.name)].filter(Boolean);
  const inUse = allItems.filter(i => namesToCheck.includes(i.type)).length;
  let msg = 'Delete "' + (typeObj ? typeObj.name : 'this category') + '"?';
  if (descIds.length) msg += '\n\nAlso deletes ' + descIds.length + ' nested sub-categor' + (descIds.length === 1 ? 'y' : 'ies') + '.';
  if (inUse > 0) msg += '\n\n' + inUse + ' item(s) still use these names — they will keep the label.';
  if (!confirm(msg)) return;
  for (const did of descIds) await dbDelete('types', did);
  await dbDelete('types', id);
  await loadTypes();
  renderCategorySettings();
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
      toast('Storage full — photo not saved', 'err');
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
      toast('Storage full — photo not saved', 'err');
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
    if (text) text.textContent = 'You\'re back — tap Import now to attach the screenshot.';
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
      '<div class="clipboard-wait-icon">📋</div>' +
      '<div class="clipboard-wait-title">Waiting for screenshot</div>' +
      '<p class="clipboard-wait-text">Open another app, take your screenshot, tap <strong>Done</strong> or <strong>Complete</strong>, then switch back here.</p>' +
      '<button type="button" class="clipboard-wait-import" id="clipboard-wait-import-btn">Import now</button>' +
      '<button type="button" class="clipboard-wait-gallery" id="clipboard-wait-gallery-btn">🖼️ Pick from gallery instead</button>' +
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
          toast('Could not read clipboard — tap Import now or use Gallery', 'err');
        }
      }
      return null;
    }
  } else if (!silent) {
    toast('Clipboard not supported — use Gallery and pick your screenshot', 'err');
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
        toast('No screenshot in clipboard — try Gallery or take the screenshot again', 'err');
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
      '<button type="button" data-src="camera" style="' + btnStyle + 'background:var(--accent);color:white;">📸 Take photo</button>' +
      '<button type="button" data-src="gallery" style="' + btnStyle + 'background:var(--surface2);color:var(--text);border:1.5px solid var(--border);">🖼️ Choose from gallery</button>' +
      '<button type="button" data-src="clipboard" style="' + btnStyle + 'background:var(--surface2);color:var(--text);border:1.5px solid var(--border);">📋 Screenshot from another app</button>' +
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
          if (opts.onPick) opts.onPick(dataUrl);
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
      toast('Photo ready', 'ok');
    }
  });
}

// ===== WISHLIST PHOTO =====
let _wishFormPhotoData = null;

function updateWishPhotoPreview() {
  const photoImg = document.getElementById('wish-photo-img');
  const placeholder = document.getElementById('wish-photo-placeholder');
  const removeBtn = document.getElementById('wish-photo-remove');
  if (_wishFormPhotoData) {
    if (photoImg) { photoImg.src = _wishFormPhotoData; photoImg.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'block';
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
    onPick: async dataUrl => {
      _wishFormPhotoData = dataUrl;
      updateWishPhotoPreview();
      toast('Photo attached', 'ok');
    }
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

async function openWishlistDetail(wishId) {
  const wish = await dbGet('wishlist', wishId);
  if (!wish) {
    toast('Wishlist item not found', 'err');
    return;
  }
  _currentWishDetailId = wishId;
  const sheet = document.getElementById('wishlist-detail-sheet');
  const photo = getWishPhoto(wishId);
  const photoImg = document.getElementById('wd-photo-img');
  const photoEmpty = document.getElementById('wd-photo-empty');
  if (photo && photoImg) {
    photoImg.src = photo;
    photoImg.style.display = 'block';
    if (photoEmpty) photoEmpty.style.display = 'none';
  } else {
    if (photoImg) { photoImg.src = ''; photoImg.style.display = 'none'; }
    if (photoEmpty) photoEmpty.style.display = 'flex';
  }
  const nameEl = document.getElementById('wd-name');
  const codeEl = document.getElementById('wd-code');
  const metaEl = document.getElementById('wd-meta');
  const noteEl = document.getElementById('wd-note');
  if (nameEl) nameEl.textContent = wish.name || wish.code || 'Prospective item';
  if (codeEl) codeEl.textContent = wish.code ? 'Code: ' + wish.code : 'No code';
  if (metaEl) {
    const parts = [];
    if (wish.type) parts.push(wish.type);
    if (wish.qty) parts.push('Target qty: ' + wish.qty);
    if (wish.estimatedCost) parts.push('Est. buy: ' + fmt(wish.estimatedCost));
    metaEl.textContent = parts.length ? parts.join(' · ') : 'No extra details';
  }
  if (noteEl) {
    if (wish.note) {
      noteEl.textContent = wish.note;
      noteEl.style.display = 'block';
    } else {
      noteEl.textContent = '';
      noteEl.style.display = 'none';
    }
  }
  if (sheet) sheet.classList.add('open');
}
window.openWishlistDetail = openWishlistDetail;

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
      ['f-code','f-name','f-size'].forEach(id=>{const el=document.getElementById(id);if(el){el.disabled=false;el.style.opacity='';el.style.cursor='';}});
      setAddTypeLocked(false);
      setRestockBanner(false);
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('\u2705 Size '+size+' updated \u00b7 '+qty+' pcs \u00b7 '+fmt(sell),'ok');
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
    if (!type) {
      toast('Select a category (and sub-category if shown)', 'err');
      const firstCat = document.getElementById('f-type-parent') || document.querySelector('#f-type-cascade .cat-pick-btn');
      if (firstCat) firstCat.focus();
      return;
    }
    if(!code){toast('\u26a0\ufe0f Enter item code','err');return;}
    if (!editIdRaw) {
      const codeMatches = await findCodeMatchesForSave(code);
      const existingCode = codeMatches.find(i => i.code === code);
      // Footwear: same code is OK when adding/updating sizes on an existing shoe SKU
      const addingShoeSizes = existingCode && isFootwearType(type) && existingCode.isShoe;
      if (existingCode && !addingShoeSizes) {
        showCodeDropdown(codeMatches, code);
        toast('\u26a0\ufe0f Item code already exists — select it from the dropdown', 'err');
        UI.el('f-code')?.focus();
        return;
      }
    }

    // SHOE MODE
    if (isFootwearType(type) && !editIdRaw) {
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
      if (_addFormPhotoData) await setItemPhoto(saved.id, _addFormPhotoData);
      fbSyncItem(saved);
      clearForm();
      allItems=await dbAll('items');await enrichShoeItems(allItems);
      renderList();renderDashboard();updateHeader();scheduleSync();
      toast('\u2705 Item updated!','ok');showPage('list');
    }else{
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
  _lastAddFormType = '';
  setAddFormType('', { skipTypeChange: true });
  UI.el('f-code').value    = '';
  UI.el('f-name').value    = '';
  UI.el('f-size').value    = '';
  UI.el('f-qty').value     = '';
  UI.el('f-buy').value     = '';
  UI.el('f-sell').value    = '';
  const pp = UI.el('profit-preview');
  if (pp) pp.style.display = 'none';
  setSaveBtnLabel('Add to inventory');
  const ml = UI.el('form-mode-label');
  if (ml) ml.textContent = 'New item';
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

  clearCodeMatchSelect();
  hideCodeDropdown();
}

// Code autocomplete helpers
let _codeDropdownActive = false;
let _editOriginItemId   = null;
let _editingItemId      = null;  // tracks current edit ID reliably (backup to hidden input)
let _lastAddFormType    = '';    // last f-type value — avoid wiping shoe sizes on tab switch
let _addFormWasFootwear = false;
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
  groupsNeeded.forEach(g => ensureSizeGroupOpen(g));

  records.forEach(sz => _shoeState.sizes.add(sz.size));
  document.querySelectorAll('.sz-btn').forEach(b => {
    const n = parseInt(b.textContent, 10);
    if (Number.isFinite(n)) b.classList.toggle('sz-active', _shoeState.sizes.has(n));
  });

  const szWrap = UI.el('shoe-rows-wrap');
  if (szWrap) szWrap.style.display = _shoeState.sizes.size > 0 ? 'block' : 'none';
  renderShoeGroupButtons();
  renderShoeSummary();
  if (_shoeState.perSizeMode) renderShoeRows();
}

function showCodeDropdown(items, typedCode) {
  const select = document.getElementById('code-match-select');
  if (select) {
    select.onchange = () => selectExistingItemFromDropdown(select.value);
    select.disabled = !items.length;
    select.style.opacity = items.length ? '1' : '0.55';
    select.style.cursor = items.length ? 'pointer' : 'not-allowed';
    select.innerHTML = '<option value="">Match existing code…</option>' +
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

function clearCodeMatchSelect(label = 'Match existing code…') {
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
    const matchType = itemMatchesTypeFilter(item, activeTypeFilter);
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
          const stockLabel = isOut?'✕ Out':sz.qty+' pcs';
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
  if (isAdd) document.getElementById('wish-name')?.focus();
}
window.showWishlistSection = showWishlistSection;

async function renderWishlistPage() {
  renderWishlistTypeOptions();
  await renderStockMonitorSummary();
  const list = document.getElementById('wishlist-list');
  if (!list) return;
  const rows = filterStockRows(await getStockMonitorRows(), 'prospective');
  const addBar = '<div class="wish-list-toolbar">' +
    '<button type="button" class="wish-add-open-btn" onclick="showWishlistSection(\'add\')"><i class="fa-solid fa-plus"></i> Add item</button>' +
    '</div>';
  if (!rows.length) {
    list.innerHTML = addBar + '<div class="empty" style="padding:36px 12px;"><div class="e-icon">+</div><p>No prospective items yet.</p></div>';
    return;
  }
  list.innerHTML = addBar + rows.map(row => {
    const photo = getWishPhoto(row.wishId);
    const thumb = photo
      ? '<img src="' + photo + '" alt="" class="wish-list-thumb">'
      : '<div class="wish-list-thumb wish-list-thumb-empty">📷</div>';
    return '<div class="stock-monitor-row prospective" onclick="openWishlistDetail(' + row.wishId + ')" role="button" tabindex="0">' +
      thumb +
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
        '<button class="stock-monitor-action restock" onclick="event.stopPropagation();openWishlistDetail(' + row.wishId + ')" title="View"><i class="fa-solid fa-eye"></i></button>' +
        '<button class="stock-monitor-action restock" onclick="event.stopPropagation();startWishlistRestock(' + row.wishId + ')" title="Stock it"><i class="fa-solid fa-boxes-stacked"></i></button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function saveWishlistItem() {
  const name = Input.text('wish-name');
  const code = Input.text('wish-code').toUpperCase();
  const type = document.getElementById('wish-type')?.value || '';
  const qtyRaw = Input.int('wish-qty');
  const costRaw = Input.money('wish-cost');
  const note = Input.text('wish-note');
  if (!name) return Validate.fail('Enter item name', 'wish-name');
  if (!Validate.intOptional(qtyRaw, 'wish-qty', 'Quantity')) return;
  if (!Validate.moneyOptional(costRaw, 'wish-cost', 'Estimated cost')) return;
  const qty = (qtyRaw === null || qtyRaw <= 0) ? 1 : qtyRaw;
  const estimatedCost = costRaw === null ? 0 : costRaw;
  const entry = {
    name,
    code,
    type,
    qty,
    estimatedCost,
    note,
    status: 'prospective',
    createdAt: new Date().toISOString(),
    createdBy: currentUser ? currentUser.username : 'system'
  };
  entry.id = await dbAdd('wishlist', entry);
  if (_wishFormPhotoData) await setWishPhoto(entry.id, _wishFormPhotoData);
  ['wish-name','wish-code','wish-qty','wish-cost','wish-note'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  clearWishPhotoForm();
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
    setAddFormSubtitle('From wishlist — check details and save to stock');
    setSaveBtnLabel('Add to inventory');
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
    <button type="button" class="detail-sheet-close" onclick="closeShoeSizeActions()" aria-label="Close">✕</button>
    <div class="detail-sheet-hero">
      <div class="shoe-size-badge ${isOut ? 'out' : isLow ? 'low' : ''}" style="width:56px;height:56px;font-size:24px;">${size}</div>
      <div class="detail-sheet-hero-text">
        <div class="detail-sheet-title">${escapeHtml(item.name || item.code)}</div>
        <div class="detail-sheet-sub">${escapeHtml(item.code)} · Size ${size} · ${groupLbl}</div>
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
      ${!isOut ? `<button type="button" class="detail-sell-btn" onclick="closeShoeSizeActions();closeSheet();openSellShoeModal(${item.id},${size})">💰 SELL — Size ${size}</button>` :
        `<div class="detail-sell-muted">Out of stock — restock first</div>`}
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
      if (typeof window._resetPhotoPan === 'function') window._resetPhotoPan();
      const btn = document.getElementById('sh-photo-btn');
      if (btn) btn.textContent = '📷 Photo';
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
    set('sh-buy',  fmt(item.defaultBuy  || 0));
    set('sh-sell', fmt(item.defaultSell || 0));
    set('sh-qty',  totalQty + ' pcs');
    if (sizeSec) sizeSec.style.display = 'block';
    if (sizebar) { sizebar.style.display = 'none'; sizebar.textContent = ''; }
    await renderShoeDetailGrid(item);
  } else {
    set('sh-buy',  fmt(item.buy  || 0));
    set('sh-sell', fmt(item.sell || 0));
    set('sh-qty',  item.qty + ' pcs');
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
  if (itemSales.length > 0) msg += '\n\n⚠️ This item has ' + itemSales.length + ' sale record(s). The sales history will remain but the item cannot be restocked.';
  if (!confirm(msg)) return;
  if (toDelete.isShoe) {
    const sizes = await getShoeSizes(toDelete.code);
    for (const sz of sizes) {
      await dbDelete('shoe_sizes', sz.id);
      if (sz.fbId && fbReady && fbDb) {
        try {
          const { doc, deleteDoc } = await waitForFbImports();
          await deleteDoc(doc(fbDb, 'shoe_sizes', sz.fbId));
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
    if (!size) { toast('⚠️ Select a size first before editing', 'err'); setTimeout(()=>openSheet(item.id),100); return; }
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
  setAddFormType(item.type || '', { skipTypeChange: true });
  UI.el('f-code').value  = item.code  || '';
  UI.el('f-name').value  = item.name  || '';
  UI.el('f-size').value  = item.variant || item.size || '';   // normalized field name
  UI.el('f-qty').value   = item.qty   ?? '';
  UI.el('f-buy').value   = item.buyPrice  || item.buy  || '';  // normalized field name
  UI.el('f-sell').value  = item.sellPrice || item.sell || '';  // normalized field name
  // Lock code and type — identifying fields
  ['f-code'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled=true; el.style.opacity='0.45'; el.style.cursor='not-allowed'; }
  });
  setAddTypeLocked(true);
  setSaveBtnLabel('Save changes');
  UI.el('form-mode-label').textContent = '✏️ Edit · ' + (item.name || item.code);
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
    const d = s.businessDate || (s.date || '').split('T')[0];
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
  }
}
window.goDashNav = goDashNav;

async function _renderDashSummary(ctx) {
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const wrap = document.getElementById('d-summary-wrap');
  if (!wrap) return;

  const {
    allItems, allSales, sales, totalItems, totalQty, stockRetail, stockCost,
    totalRevenue, totalProfitEarned, totalSalesCount, totalPiecesSold,
    outStk, lowStk, margin, today, todayDashSales, todayDashRev, todayDashProf
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
  const headlineParts = [];
  if (totalItems === 0) headlineParts.push('Add your first items to start tracking stock and sales.');
  else {
    if (dayOpen && _dashPeriod === 'today') headlineParts.push('Day is open — record sales as they happen.');
    else if (dayLabel) headlineParts.push(dayLabel + '.');
    if (totalSalesCount > 0) headlineParts.push(periodLbl + ': ' + fmtN(totalSalesCount) + ' sales, ' + fmt(totalRevenue) + ' revenue.');
    if (alertCount > 0) headlineParts.push(alertCount + ' stock alert' + (alertCount !== 1 ? 's' : '') + ' need attention.');
    else if (totalItems > 0) headlineParts.push('Stock levels look healthy.');
  }
  setEl('d-summary-headline', headlineParts.join(' '));

  const cards = [];
  cards.push(_dashSumCard('📦', fmtN(totalItems) + ' SKUs', 'Inventory', fmtN(totalQty) + ' pcs · retail ' + fmt(stockRetail), null, 'stock'));
  cards.push(_dashSumCard('💰', fmt(totalRevenue), periodLbl + ' revenue', trendNote || (fmt(totalProfitEarned) + ' profit · ' + margin.toFixed(1) + '% margin'), totalProfitEarned >= 0 ? 'var(--green)' : 'var(--red)'));
  cards.push(_dashSumCard('🛒', fmtN(totalSalesCount), 'Sales · ' + fmtN(totalPiecesSold) + ' pcs', totalSalesCount ? 'Avg ' + fmt(totalRevenue / totalSalesCount) + ' per sale' : 'No sales in period'));
  cards.push(_dashSumCard(
    dayOpen ? '🟢' : (activeDay ? '🔒' : '⏸️'),
    dayOpen ? 'Open' : (activeDay ? activeDay.status : '—'),
    'Business day',
    _dashPeriod === 'today' && todayDashSales.length
      ? fmtN(todayDashSales.length) + ' sales · ' + fmt(todayDashProf) + ' profit today'
      : (money ? 'Pool ' + fmt(money.businessPool) : dayLabel)
  ));
  if (wishCount > 0) {
    cards.push(_dashSumCard(
      '📋',
      fmtN(wishCount),
      'Wishlist',
      wishCount + ' item' + (wishCount !== 1 ? 's' : '') + ' to stock — tap to open',
      'var(--accent)',
      'wishlist'
    ));
  }
  if (alertCount > 0) {
    cards.push(_dashSumCard(
      '⚠️',
      fmtN(alertCount) + ' alerts',
      'Needs attention',
      (outStk.length ? outStk.length + ' out · ' : '') + (lowStk.length ? lowStk.length + ' low' : ''),
      'var(--amber)',
      'stock'
    ));
  }
  if (money && (money.businessPool || money.salesProfit)) {
    cards.push(_dashSumCard('💼', fmt(money.businessPool), 'Business pool', 'Profit ' + fmt(money.salesProfit) + ' · cost out ' + fmt(money.salesCostOut), money.businessPool >= 0 ? 'var(--accent2)' : 'var(--red)'));
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
  const totalQty    = allItems.reduce((s,i) => s+(i.qty||0), 0);
  const stockCost   = allItems.reduce((s,i) => s+((i.buyPrice||i.buy||0)*(i.qty||0)), 0);
  const stockRetail = allItems.reduce((s,i) => s+((i.sellPrice||i.sell||0)*(i.qty||0)), 0);
  const potProfit   = stockRetail - stockCost;

  const totalRevenue      = sales.reduce((s,x) => s+(x.revenue||0), 0);
  const totalProfitEarned = sales.reduce((s,x) => s+(x.profit||0), 0);
  const totalPiecesSold   = sales.reduce((s,x) => s+(x.qty||0), 0);
  const totalSalesCount   = sales.length;
  const margin = totalRevenue > 0 ? (totalProfitEarned/totalRevenue*100) : 0;
  const avgSale = totalSalesCount > 0 ? totalRevenue/totalSalesCount : 0;

  const outStk = allItems.filter(i => i.qty === 0);
  const lowStk = allItems.filter(i => i.qty > 0 && i.qty <= LOW_STOCK_LEVEL);
  const todayDashSales = allSales.filter(s => (s.businessDate||(s.date||'').split('T')[0]) === today);
  const todayDashRev   = todayDashSales.reduce((s,x)=>s+(x.revenue||0),0);
  const todayDashProf  = todayDashSales.reduce((s,x)=>s+(x.profit||0),0);

  await _renderDashSummary({
    allItems, allSales, sales, totalItems, totalQty, stockRetail, stockCost,
    totalRevenue, totalProfitEarned, totalSalesCount, totalPiecesSold,
    outStk, lowStk, margin, today, todayDashSales, todayDashRev, todayDashProf
  });

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
  const todayDashQty   = todayDashSales.reduce((s,x)=>s+(x.qty||0),0);
  const todayDashRecon = typeof _getDayRecon === 'function' ? _getDayRecon(today) : null;
  const todayDashVariance = todayDashRecon?.analysis ? todayDashRecon.analysis.variance : null;
  const todayWrap = document.getElementById('d-today-wrap');
  if (todayWrap) {
    if (_dashPeriod === 'today') {
      todayWrap.style.display = '';
      const grid = document.getElementById('d-today-grid');
      if (grid) grid.innerHTML = [
        { label:'Sales',   val:fmtN(todayDashSales.length), color:'var(--accent)' },
        { label:'Revenue', val:fmt(todayDashRev), color:'var(--green)' },
        { label:'Profit',  val:fmt(todayDashProf), color: todayDashProf>=0?'var(--accent2)':'var(--red)' },
        {
          label: todayDashVariance === null ? 'Pieces' : 'Variance',
          val: todayDashVariance === null ? fmtN(todayDashQty) : ((todayDashVariance>=0?'+':'') + fmt(todayDashVariance)),
          color: todayDashVariance === null ? 'var(--accent)' : (Math.abs(todayDashVariance) < 1 ? 'var(--green)' : 'var(--red)')
        },
      ].map(k=>`<div class="stat-box" style="padding:10px 8px;"><div class="stat-lbl" style="margin-bottom:3px;">${k.label}</div><div class="stat-val" style="font-size:15px;color:${k.color};">${k.val}</div></div>`).join('');
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
  const alertEl = document.getElementById('d-alerts');
  if (alertEl) {
    let html = '';
    const alertStyle = 'cursor:pointer;border-radius:var(--r);padding:10px 12px;margin-bottom:6px;font-size:12px;font-weight:600;';
    if (outStk.length) html += `<div role="button" tabindex="0" onclick="goDashNav('stock')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();goDashNav('stock');}" style="background:var(--red-light);border:1px solid rgba(192,57,43,0.25);color:var(--red);${alertStyle}">⚠️ <strong>${outStk.length}</strong> out of stock — tap to view stock</div>`;
    if (lowStk.length) html += `<div role="button" tabindex="0" onclick="goDashNav('stock')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();goDashNav('stock');}" style="background:var(--amber-light);border:1px solid #f5d9a0;color:var(--amber);${alertStyle}">📉 <strong>${lowStk.length}</strong> running low — tap to view stock</div>`;
    alertEl.innerHTML = html;
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
  const type = document.getElementById('off-type')?.value || '';
  const size = Input.text('off-size');
  const qty = Input.int('off-qty');
  const buyPrice = Input.money('off-buy');
  const sellPrice = Input.money('off-sell');
  const paymentMethod = 'cash';
  if (!name && !code) return Validate.fail('Enter item name or code', 'off-name');
  if (!type) return Validate.fail('Select a category', 'off-type');
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
  document.getElementById('sm-qty').value = 0;
  document.getElementById('sm-qty').min = 0;
  document.getElementById('sm-qty').max = item.qty;
  document.getElementById('sm-actual').value = '';
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
  const baseBuy   = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.buyPrice  || item.buyPrice  || item.buy  || 0) : (item.buy  || item.buyPrice  || 0);
  const maxStock  = (_isShoeSale && _sellShoeSize) ? (_sellShoeSize.qty || 0) : (item.qty || 0);
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
  const confirmBtn = document.getElementById('confirm-sale-btn');
  if (confirmBtn) {
    confirmBtn.textContent = 'CONFIRM SALE';
    confirmBtn.style.background = '#1e7a3e';
    confirmBtn.title = priceUsed < baseBuy && priceUsed > 0 ? 'Warning: selling below cost price' : '';
  }
  } catch(e) { console.error("[updateSellModal]", e); toast("Error: " + e.message, "err"); }
}

function adjSellQty(d) {
  const inp = document.getElementById('sm-qty');
  let v = (parseInt(inp.value) || 0) + d;
  const max = parseInt(inp.max) || 9999;
  if (v > max) { toast('⚠️ Only ' + max + ' in stock', 'err'); v = max; }
  inp.value = Math.max(0, v);
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
  const qty       = parseInt(qtyEl?.value || '0');
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
  if (!Number.isFinite(qty) || qty <= 0) {
    Validate.fail('Enter quantity to sell', 'sm-qty');
    _overlay.hide();
    return;
  }
  if (qty > maxQty) {
    Validate.fail('Only ' + maxQty + ' in stock - cannot sell ' + qty, 'sm-qty');
    _overlay.hide();
    return;
  }
  if (!Validate.stock(qty, maxQty, itemLabel)) { _overlay.hide(); return; }

  // ── Validate sale price ────────────────────────────────────────
  if (!Validate.salePrice(priceUsed, buyPrice, sellPrice)) { _overlay.hide(); return; }

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

  // Sales are the source of truth for revenue — no duplicate finance row.

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
    _clearAllDayReconKeys();

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
    clearAllPhotoCache();

    // ── 4. Reset localStorage (keep session + preferences) ───────
    const keep = {
      [KEY_SESSION]:     localStorage.getItem(KEY_SESSION),
      [KEY_CURRENCY]:    localStorage.getItem(KEY_CURRENCY),
      [KEY_SHOE_GROUPS]: localStorage.getItem(KEY_SHOE_GROUPS),
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

    toast('✅ All data cleared — fresh start!', 'ok');
    console.log('[RESET] Complete');

  } catch(e) {
    toast('❌ Reset failed: ' + e.message, 'err');
    console.error('[RESET] Error:', e);
  }
}

const _DATA_STORES = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes', 'finances', 'wishlist', 'photos'];
const _FB_COLLECTIONS = ['items', 'sales', 'business_days', 'shoe_sizes', 'finances', 'wishlist'];

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
    [KEY_SESSION]:     localStorage.getItem(KEY_SESSION),
    [KEY_CURRENCY]:    localStorage.getItem(KEY_CURRENCY),
    [KEY_SHOE_GROUPS]: localStorage.getItem(KEY_SHOE_GROUPS),
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
}

async function _deleteFirebaseCollections(cols) {
  if (!fbReady || !fbDb) return;
  const { collection, getDocs, writeBatch, doc } = await waitForFbImports();
  for (const col of cols) {
    const snap = await getDocs(collection(fbDb, col));
    if (snap.empty) continue;
    let batch = writeBatch(fbDb);
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(doc(fbDb, col, d.id));
      if (++n % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); n = 0; }
    }
    if (n > 0) await batch.commit();
  }
}

async function clearLocalDataAndPull() {
  if (!confirm('Clear ALL data on this device and download from cloud?\n\nLocal-only changes will be lost.')) return;
  if (!fbReady || !fbDb) {
    toast('Connect to Firebase first (Settings → Reconnect)', 'err');
    return;
  }
  try {
    toast('Clearing local data…', '');
    await _clearIndexedDbStores();
    _clearAllDayReconKeys();
    const keep = _preserveUserPrefs();
    _restoreUserPrefs(keep);
    window._financeCoherenceCleaned = false;
    await pullFromFirebase(true);
    await loadTypes();
    allItems = await dbAll('items');
    await enrichShoeItems(allItems);
    renderList();
    renderDashboard();
    renderFinancePage();
    renderDayState();
    updateHeader();
    toast('✅ Local cleared — cloud data loaded', 'ok');
  } catch (e) {
    toast('❌ Failed: ' + e.message, 'err');
  }
}

async function clearCloudDataAndPush() {
  if (!confirm('Delete ALL cloud data and upload what is on this device?\n\nOther devices will lose cloud copies.')) return;
  if (!fbReady || !fbDb) {
    toast('Connect to Firebase first (Settings → Reconnect)', 'err');
    return;
  }
  try {
    toast('Clearing cloud…', '');
    await _deleteFirebaseCollections(_FB_COLLECTIONS);
    await forcePushToFirebase(true);
    toast('✅ Cloud cleared — this device is now the source', 'ok');
  } catch (e) {
    toast('❌ Failed: ' + e.message, 'err');
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
    toast('Reloading…', '');
    setTimeout(() => window.location.reload(), 400);
  } catch (e) {
    window.location.reload();
  }
}

window.clearLocalDataAndPull = clearLocalDataAndPull;
window.clearCloudDataAndPush = clearCloudDataAndPush;
window.clearBothLocalAndCloud = clearBothLocalAndCloud;
window.clearAppCacheAndReload = clearAppCacheAndReload;

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
    if (typeof window._fbUnsubFin === 'function') { window._fbUnsubFin(); }
    if (typeof window._fbUnsubWish === 'function') { window._fbUnsubWish(); }
    if (typeof window._fbUnsubSz === 'function') { window._fbUnsubSz(); }
    if (typeof window._fbUnsubBd === 'function') { window._fbUnsubBd(); }
    fbUnsub = null;
    window._fbUnsubSales = null;
    window._fbUnsubFin = null;
    window._fbUnsubWish = null;
    window._fbUnsubSz = null;
    window._fbUnsubBd = null;

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
          const ex = byFbId[c.doc.id] || localSales.find(s => _salesMatch(s, data));
          if (ex) { data.id = ex.id; await dbPut('sales', data); }
          else    { try { await dbAdd('sales', data); } catch(_) { /* intentionally ignored */ } }
        }
      }
      try { if (activeDay) updateDayLiveStats(); } catch(_) { /* intentionally ignored */ }
      try { renderDashboard(); } catch(_) { /* intentionally ignored */ }
    }, err => { console.error('[FB] sales listener:', err.message); });

    // ── finances listener ────────────────────────────────────────
    window._fbUnsubFin = onSnapshot(collection(fbDb, 'finances'), async snap => {
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
      if (!changes.length) return;
      const localFin = await dbAll('finances');
      const byFbId = Object.fromEntries(localFin.filter(f => f.fbId).map(f => [f.fbId, f]));
      let changed = false;
      for (const c of changes) {
        const data = { ...c.doc.data(), fbId: c.doc.id };
        delete data.id;
        if (c.type === 'removed') {
          const loc = byFbId[c.doc.id];
          if (loc) { await dbDelete('finances', loc.id); changed = true; }
        } else {
          if (_isDeletedFinanceRemote(c.doc.id, data)) continue;
          const ex = byFbId[c.doc.id] || localFin.find(f => _financeRecordsMatch(f, data));
          if (ex) { data.id = ex.id; await dbPut('finances', data); }
          else { try { await dbAdd('finances', data); } catch(_) { /* intentionally ignored */ } }
          changed = true;
        }
      }
      if (changed) {
        try { renderFinancePage(); } catch(_) { /* intentionally ignored */ }
        try { renderDashboard(); } catch(_) { /* intentionally ignored */ }
      }
    }, err => { console.error('[FB] finances listener:', err.message); });

    // ── wishlist listener ────────────────────────────────────────
    if (db.objectStoreNames.contains('wishlist')) {
      window._fbUnsubWish = onSnapshot(collection(fbDb, 'wishlist'), async snap => {
        if (_localWriting) return;
        const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
        if (!changes.length) return;
        const localWish = await dbAll('wishlist');
        const byFbId = Object.fromEntries(localWish.filter(w => w.fbId).map(w => [w.fbId, w]));
        let changed = false;
        for (const c of changes) {
          const data = { ...c.doc.data(), fbId: c.doc.id };
          delete data.id;
          if (c.type === 'removed') {
            const loc = byFbId[c.doc.id];
            if (loc) { await dbDelete('wishlist', loc.id); changed = true; }
          } else {
            const ex = byFbId[c.doc.id];
            if (ex) { data.id = ex.id; await dbPut('wishlist', data); }
            else { try { await dbAdd('wishlist', data); } catch(_) { /* intentionally ignored */ } }
            changed = true;
          }
        }
        if (changed) {
          try { renderWishlistPage(); } catch(_) { /* intentionally ignored */ }
        }
      }, err => { console.error('[FB] wishlist listener:', err.message); });
    }

    // ── shoe_sizes listener ──────────────────────────────────────
    window._fbUnsubSz = onSnapshot(collection(fbDb, 'shoe_sizes'), async snap => {
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
      if (!changes.length) return;
      const localSizes = await dbAll('shoe_sizes');
      const byFbId = Object.fromEntries(localSizes.filter(s => s.fbId).map(s => [s.fbId, s]));
      const byCS = Object.fromEntries(localSizes.filter(s => s.codeSize).map(s => [s.codeSize, s]));
      let changed = false;
      for (const c of changes) {
        const data = { ...c.doc.data(), fbId: c.doc.id };
        delete data.id;
        if (c.type === 'removed') {
          const loc = byFbId[c.doc.id];
          if (loc) { await dbDelete('shoe_sizes', loc.id); changed = true; }
        } else {
          const ex = byFbId[c.doc.id] || byCS[data.codeSize];
          if (ex) { data.id = ex.id; await dbPut('shoe_sizes', data); }
          else { try { await dbAdd('shoe_sizes', data); } catch(_) { /* intentionally ignored */ } }
          changed = true;
        }
      }
      if (changed) {
        allItems = await dbAll('items');
        await enrichShoeItems(allItems);
        renderList();
        renderDashboard();
        updateHeader();
      }
    }, err => { console.error('[FB] shoe_sizes listener:', err.message); });

    // ── business_days listener ───────────────────────────────────
    window._fbUnsubBd = onSnapshot(collection(fbDb, 'business_days'), async snap => {
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => !c.doc.metadata.hasPendingWrites);
      if (!changes.length) return;
      const localBd = await dbAll('business_days');
      const byFbId = Object.fromEntries(localBd.filter(b => b.fbId).map(b => [b.fbId, b]));
      const byDate = Object.fromEntries(localBd.map(b => [(b.businessDate || b.business_date), b]));
      let changed = false;
      for (const c of changes) {
        const data = { ...c.doc.data(), fbId: c.doc.id };
        delete data.id;
        const dateKey = data.businessDate || data.business_date;
        if (c.type === 'removed') {
          const loc = byFbId[c.doc.id] || (dateKey ? byDate[dateKey] : null);
          if (loc) { await dbDelete('business_days', loc.id); changed = true; }
        } else {
          const ex = byFbId[c.doc.id] || (dateKey ? byDate[dateKey] : null);
          if (ex) { data.id = ex.id; await dbPut('business_days', data); }
          else { try { await dbAdd('business_days', data); } catch(_) { /* intentionally ignored */ } }
          changed = true;
          if (activeDay && ex && ex.id === activeDay.id) {
            activeDay = await dbGet('business_days', ex.id);
          }
        }
      }
      if (changed) {
        try { renderDayState(); } catch(_) { /* intentionally ignored */ }
        try { renderDaySessionsList(); } catch(_) { /* intentionally ignored */ }
      }
    }, err => { console.error('[FB] business_days listener:', err.message); });

    setFbStatus('on');
    toast('☁️ Firebase connected', 'ok');
    await pullFromFirebase(true);
    await normalizeSyncIds();
    await forcePushToFirebase(true);

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
      sale.fbId = stableSaleFbId(sale);
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
  _localWriting = true;
  const items = await dbAll('items');
  const sales = await dbAll('sales');
  const { doc, setDoc, writeBatch } = await waitForFbImports();
  try {
    let batch = writeBatch(fbDb);
    let count = 0;

    for (const item of items) {
      await ensureItemFbId(item);
      batch.set(doc(fbDb, 'items', item.fbId), sanitiseForFirestore({ ...item, updatedAt: new Date().toISOString() }));
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    for (const sale of sales) {
      if (!sale.fbId) {
        sale.fbId = stableSaleFbId(sale);
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
      const szStable = stableShoeSizeFbId(sz);
      if (sz.fbId !== szStable) { sz.fbId = szStable; await dbPut('shoe_sizes', sz); }
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
      if (!bd.fbId || bd.fbId !== stableBusinessDayFbId(bd)) {
        bd.fbId = stableBusinessDayFbId(bd);
        await dbPut('business_days', bd);
      }
      batch.set(doc(fbDb, 'business_days', bd.fbId), sanitiseForFirestore({...bd}));
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
  } finally {
    setTimeout(() => { _localWriting = false; }, 2000);
  }
}

async function pullFromFirebase(silent = false) {
  if (!fbReady || !fbDb) {
    if (!silent) toast('⚠️ Not connected to Firebase', 'err');
    console.warn('[SYNC] pullFromFirebase called but not ready. fbReady=', fbReady, 'fbDb=', !!fbDb);
    return;
  }
  if (!silent) setFbStatus('syncing');
  _localWriting = true;
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

    // Pull business_days
    try {
      const bdSnap = await getDocs(collection(fbDb, 'business_days'));
      const localBd = await dbAll('business_days');
      const bdByFbId = Object.fromEntries(localBd.filter(b => b.fbId).map(b => [b.fbId, b]));
      const bdByDate = Object.fromEntries(localBd.map(b => [(b.businessDate || b.business_date), b]));
      for (const d of bdSnap.docs) {
        const data = { ...d.data(), fbId: d.id };
        delete data.id;
        const dateKey = data.businessDate || data.business_date;
        const ex = bdByFbId[d.id] || (dateKey ? bdByDate[dateKey] : null);
        if (ex) { data.id = ex.id; await dbPut('business_days', data); }
        else { try { await dbAdd('business_days', data); } catch(_) { /* intentionally ignored */ } }
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
  } finally {
    setTimeout(() => { _localWriting = false; }, 1500);
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
// Day status is tracked in Operations → Day (reports/reconciliation only).
// It does not lock tabs, sheets, sales, or inventory actions.
// ===================================================================

function clearDayTabLocks() {
  document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('disabled'));
  const overlay = document.getElementById('day-closed-overlay');
  if (overlay) overlay.classList.remove('show');
}

// ===================================================================
// BUSINESS DAY MANAGEMENT (Operations tab — tracking & reconciliation)
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

// Legacy helpers — day state no longer gates the rest of the app
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
  clearDayTabLocks();
  updateDayBanner();
  updateDayLiveStats();
  renderDaySessionsList();
  toast(isReopen ? '🔓 Day reopened! Continue recording.' : '🌅 Business day opened!', 'ok');
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
  clearDayTabLocks();
  updateDayBanner();
  renderDaySessionsList();
  renderDashboard();
  toast('🌙 Day closed. You can reopen it from Operations → Day anytime.', 'ok');
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
    clearDayTabLocks();
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
    clearDayTabLocks();
    updateDayLiveStats();
  } else if (status === 'LOCKED') {
    banner.style.cssText = 'background:var(--surface2);border:2px solid var(--border);border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = '🔒';
    badge.textContent = 'LOCKED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:var(--surface2);color:var(--muted);';
    title.textContent = 'Archived Day';
    title.style.color = 'var(--muted)';
    sub.textContent   = fmtFullDate((activeDay.businessDate || activeDay.business_date)) + ' — archived';
    if (actionArea) actionArea.innerHTML = '';
    clearDayTabLocks();
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
        sub:   (s.qty||1) + ' pc' + ((s.qty||1)!==1?'s':''),
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
  const hasSize = sizeText && sizeText !== '—';
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
    if (!item) { toast('⚠️ Item not found', 'err'); return; }
    if (item.isShoe) {
      toast('Restock a shoe size from the size list', 'err');
      return;
    }
    const unitBuy = buyRaw !== null ? buyRaw : (item.buyPrice || item.buy || 0);
    if (sellRaw !== null) {
      item.sellPrice = sellRaw;
      item.sell = sellRaw;
    }
    if (buyRaw !== null) {
      item.buyPrice = buyRaw;
      item.buy = buyRaw;
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
    toast('✅ Added ' + qty + ' pcs to ' + (item.name || item.code), 'ok');
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
    await _deleteLocalRevenueForSale(saleId);
  }
  await dbDelete('sales', saleId);
  refreshSalesViews();
  renderDashboard();
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

document.addEventListener('DOMContentLoaded', () => {
  setLoginReady(!!_appDbReady);
  initCleanNumericInputs();
  initWishlistScreenshotWatch();
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
    tabs: ['dash','inventory','sell','operations','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    pinHash: '38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','inventory','sell','operations']
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
    btn.textContent = 'Loading app…';
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
    header.textContent = user.role === 'clerk' ? 'Add Stock — Mandela' : 'Mandela General Stores';
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

  const user = USERS.find(u => u.username === username && u.pin === pin);
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
    toast('App still loading — try again in a moment', 'err');
    return;
  }

  finishAuthUI(user);
  _origShowPage(resolveLandingPage(user, localStorage.getItem(KEY_LAST_PAGE)));
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
        await deleteDoc(doc(fbDb, 'finances', e.fbId));
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
  toast('✅ Finances reconciled — removed ' + removed + ' duplicate row(s)', 'ok');
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
  let listEntries = [...financeRows, ...saleRows];
  if (_finFilter === 'investment') listEntries = listEntries.filter(e => e.type === 'injection' || e.type === 'stock_purchase');
  if (_finFilter === 'expense') listEntries = listEntries.filter(e => e.type === 'expense' || e.type === 'withdrawal' || e.type === 'sale_out');
  listEntries.sort((a,b)=>new Date(b.date||b.createdAt||0)-new Date(a.date||a.createdAt||0));
  const summaryLine = document.getElementById('fin-summary-line');
  if (summaryLine) {
    summaryLine.textContent = 'Pool ' + fmt(money.businessPool) + ' · Cash in ' + fmt(money.cashToBusiness) + ' · Stock added ' + fmt(money.stockAdded) + ' · Profit ' + fmt(money.salesProfit);
  }
  renderFinList(listEntries);
  if (!window._finReconcileUnlocked) _showFinReconcile(false);
};

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
    const grp = groupLabel(e) + ' · ' + fd;
    const header = grp !== lastGroup ? '<div style="background:var(--surface2);padding:7px 12px;font-size:10px;font-weight:900;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">' + grp + '</div>' : '';
    lastGroup = grp;
    const delBtn = (!e.isSaleRow && currentUser&&currentUser.role==='super')
      ? '<button onclick="deleteFinanceEntry('+e.id+')" style="font-size:10px;color:var(--muted);background:none;border:none;cursor:pointer;padding:2px 4px;flex-shrink:0;">x</button>'
      : '';
    const sub = e.type === 'sale_out'
      ? 'Cost: ' + fmt(e.amount || 0) + ' · Profit: ' + fmt(e.profit || 0)
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
  if (dateCheck === 'future' && !confirm('Date is in the future — are you sure?')) return;
  const entry = { type, amount, description: desc, category: cat, date, createdAt: new Date().toISOString(), createdBy: currentUser ? currentUser.username : 'system' };
  entry.id = await dbAdd('finances', entry);
  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      entry.fbId = 'fin_manual_' + Date.now();
      await setDoc(doc(fbDb, 'finances', entry.fbId), sanitiseForFirestore({...entry}));
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
  clearDayTabLocks();
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
  const an = data.analysis || {};
  if (an.correctDay == null && an.correct != null) an.correctDay = an.correct;
  if (an.actualDay == null && an.exact != null) an.actualDay = an.exact;
  if (an.variance == null && an.correctDay != null) an.variance = (an.actualDay || 0) - (an.correctDay || 0);
  an.expCash = an.expCash ?? 0;
  an.expMpesa = an.expMpesa ?? 0;
  an.physCash = an.physCash ?? ((cl.cash || 0) + (cl.till || 0));
  an.physMpesa = an.physMpesa ?? (cl.mpesa || 0);
  an.cashVar = an.cashVar ?? (an.physCash - an.expCash);
  an.mpesaVar = an.mpesaVar ?? (an.physMpesa - an.expMpesa);
  an.netMove = an.netMove ?? 0;
  an.opTotal = an.opTotal ?? 0;

  const absV = Math.abs(an.variance || 0);
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

// ── Auto-close at 11:59 PM ───────────────────────────────────────
function _clearClosingInputsOnly() {
  ['cl-injected','cl-cash','cl-till','cl-mpesa','cl-expenses','cl-withdrawn']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
}

function _moveSalesDetailsAfterOpening() {
  const sales = document.getElementById('day-sales-details');
  const openingLocked = document.getElementById('day-opening-locked');
  const openingForm = document.getElementById('day-step-opening-form');
  if (!sales) return;
  if (openingLocked && openingLocked.style.display !== 'none') openingLocked.insertAdjacentElement('afterend', sales);
  else if (openingForm && openingForm.style.display !== 'none') openingForm.insertAdjacentElement('afterend', sales);
}

async function _prefillClosingFromFinances(today) {
  try {
    const fins = await dbAll('finances');
    const day = (today || '').slice(0, 10);
    const sumType = type => fins
      .filter(e => e.type === type && (e.date || (e.createdAt || '').split('T')[0]).slice(0, 10) === day)
      .reduce((s, e) => s + (e.amount || 0), 0);
    const setIfEmpty = (id, val) => {
      const el = document.getElementById(id);
      if (el && el.value === '' && val > 0) el.value = String(val);
    };
    setIfEmpty('cl-injected', sumType('injection'));
    setIfEmpty('cl-expenses', sumType('expense'));
    setIfEmpty('cl-withdrawn', sumType('withdrawal'));
  } catch (_) { /* intentionally ignored */ }
}

renderDayState = function() {
  const today = activeDay ? (activeDay.businessDate || activeDay.business_date) : todayDateStr();
  const titleEl = document.getElementById('day-banner-title');
  const subEl = document.getElementById('day-banner-sub');
  const iconEl = document.getElementById('day-banner-icon');
  if (titleEl) titleEl.textContent = fmtFullDate(today);
  if (subEl) subEl.textContent = today;
  if (iconEl) iconEl.textContent = '📅';

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
    _prefillClosingFromFinances(today);
  } else if (step === 'opening_locked' || (data && data.opening)) {
    if (openLocked) openLocked.style.display = '';
    _renderOpeningSummary(data);
    const el = document.getElementById('day-step-close-btn');
    if (el) el.style.display = '';
  } else if (step === 'opening_form' || isOpen) {
    const el = document.getElementById('day-step-opening-form');
    if (el) el.style.display = '';
  } else {
    const el = document.getElementById('day-step-open');
    if (el) el.style.display = '';
  }
  _moveSalesDetailsAfterOpening();
};
window.renderDayState = renderDayState;

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
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v > 0 ? String(v) : ''; };
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

  const opTotal    = (data.opening.cash||0) + (data.opening.till||0) + (data.opening.mpesa||0);
  const correctDay = opTotal + sysTotalRev + useInjected - useExpenses - useWithdrawn;
  const actualDay  = cash + till + mpesa;
  const variance   = actualDay - correctDay;

  const expCash   = (data.opening.cash||0) + (data.opening.till||0) + sysCashRev + useInjected - useExpenses - useWithdrawn;
  const expMpesa  = (data.opening.mpesa||0) + sysMpesaRev;
  const physCash  = cash + till;
  const physMpesa = mpesa;
  const cashVar   = physCash - expCash;
  const mpesaVar  = physMpesa - expMpesa;
  const netMove   = sysTotalRev + useInjected - useExpenses - useWithdrawn;

  _saveDayRecon(today, {
    step: 'reconciled', date: today,
    lockedAt: data.lockedAt, opening: data.opening,
    reconciledAt: new Date().toISOString(),
    closing: { injected: useInjected, cash, till, mpesa, expenses: useExpenses, withdrawn: useWithdrawn },
    system: { sysCashRev, sysMpesaRev, sysTotalRev, sysTotalProf, salesCount, margin },
    analysis: { opTotal, correctDay, actualDay, variance, expCash, expMpesa, physCash, physMpesa, cashVar, mpesaVar, netMove }
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
  _clearClosingInputsOnly();
  toast('Closing cleared — redo end-of-day', '');
  renderDayState();
  renderFinancePage();
};
window.dayStartOver = dayStartOver;

// Midnight auto-close removed — day status is for Operations reporting only.


// ═══════════════════════════════════════════════════════════
// INITIALISATION
// ═══════════════════════════════════════════════════════════
initDB();
setTimeout(initFirebase, 800);

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
      await pullFromFirebase(true);
      await forcePushToFirebase(true);
    } catch (_) { /* intentionally ignored */ }
    finally { _syncRunning = false; }
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
window.deleteType = deleteType;
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
window.clearLocalDataAndPull = clearLocalDataAndPull;
window.clearCloudDataAndPush = clearCloudDataAndPush;
window.clearBothLocalAndCloud = clearBothLocalAndCloud;
window.clearAppCacheAndReload = clearAppCacheAndReload;
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
  const title = `${escapeHtml(s.itemName||s.itemCode||'Item')}${s.itemSize ? ' · ' + (mode === 'full' ? 'Size ' : 'Sz ') + escapeHtml(s.itemSize) : ''}`;
  const unitPrice = fmt(s.actualPrice||s.sellPrice||0);
  const revenue = fmt(s.revenue||0);
  const profit = `${profSign}${fmt(s.profit||0)}`;
  if (mode === 'full') {
    return `
      <div class="hist-sale-row">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${title}
          </div>
          <div style="font-size:16px;font-weight:900;font-family:var(--mono);color:var(--accent2);margin-top:2px;">${revenue}</div>
          <div style="font-size:11px;color:var(--muted);">${s.qty} x ${unitPrice} · ${fmtTime(s.date)}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:800;">Profit</div>
          <div style="font-size:12px;font-weight:800;font-family:var(--mono);color:${profColor};">${profit}</div>
        </div>
        ${s.id ? `<button type="button" onclick="deleteSale(${s.id})" title="Delete sale" style="background:var(--red-light);border:none;color:var(--red);border-radius:6px;padding:6px 8px;cursor:pointer;font-size:13px;flex-shrink:0;margin-left:6px;">🗑</button>` : ''}
      </div>`;
  }
  // compact — used in past records
  return `
    <div class="hist-sale-row" style="border-top:1px solid var(--border);">
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${title}
        </div>
        <div style="font-size:14px;font-weight:900;font-family:var(--mono);color:var(--accent2);margin-top:1px;">${revenue}</div>
        <div style="font-size:10px;color:var(--muted);">${s.qty} x ${unitPrice} · ${fmtTime(s.date)}</div>
      </div>
      <div style="text-align:right;flex-shrink:0;">
        <div style="font-size:9px;color:var(--muted);text-transform:uppercase;font-weight:800;">Profit</div>
        <div style="font-size:11px;font-weight:700;font-family:var(--mono);color:${profColor};">${profit}</div>
      </div>
    </div>`;
}
window.renderHistoryPage = renderHistoryPage;

function ensureSizeGroupOpen(g) {
  if (_shoeState.shownGroups.has(g)) return;
  const groups = getShoeGroups();
  if (!groups[g]) return;
  const { min, max } = groups[g];
  const sizes = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  const grid = UI.el('sz-grid');
  if (!grid) return;

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
    (g === 'S' ? 'Small / Children' : g === 'M' ? 'Medium / Teens' : 'Large / Adults') +
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
}

function selectSizeGroup(g) {
  if (!getShoeGroups()[g] || !UI.el('sz-grid')) return;
  if (!_shoeState.shownGroups.has(g)) {
    ensureSizeGroupOpen(g);
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
      size, sizeGroup: _shoeState.groupFor(size),
      qty, buyPrice: buy, sellPrice: sell, profit: sell - buy,
      codeSize: baseCode + '_' + size,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, { addQty: true });
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

  if (_addFormPhotoData && product?.id) {
    await setItemPhoto(product.id, _addFormPhotoData);
  }

  if (fbReady && fbDb) {
    try {
      const { doc, setDoc } = await waitForFbImports();
      for (const sz of allSz) {
        const szStable = stableShoeSizeFbId(sz);
        if (sz.fbId !== szStable) { sz.fbId = szStable; await dbPut('shoe_sizes', sz); }
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
  if (el('sm-qty'))   { el('sm-qty').value = 0; el('sm-qty').min = 0; el('sm-qty').max = sizeRec.qty; }
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
  const groups = getShoeGroups();
  ['S','M','L'].forEach(g => {
    const btn = document.getElementById('sg-btn-' + g);
    const rng = document.getElementById('sg-range-' + g);
    const hasSelected = _getGroupSizes(g).some(s => _shoeState.sizes.has(s));
    if (btn) btn.classList.toggle('sg-active', hasSelected || _shoeState.shownGroups.has(g));
    if (rng && groups[g]) {
      const lbl = groups[g].label ? groups[g].label + ' · ' : '';
      rng.textContent = lbl + groups[g].min + '–' + groups[g].max;
    }
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
    setSaveBtnLabel('Save ' + sorted.length + ' shoe size' + (sorted.length > 1 ? 's' : ''));
  }
}

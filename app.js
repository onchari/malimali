// ===================================================================
// DATABASE SCHEMA  v8  —  Mandela General Stores
// ===================================================================
let db;
const DB_NAME = 'InventoryApp';
const DB_VER  = 9;

// ── APP CONSTANTS ─────────────────────────────────────────────────────
const KEY_SESSION     = 'mg_session';
const KEY_LAST_PAGE   = 'mg_last_page';
const KEY_SHOE_GROUPS = 'mgs_shoe_groups';
const KEY_CURRENCY    = 'mgs_currency';
const CODE_MAX_QTY    = 9999;
const LOW_STOCK_LEVEL = 1;
const OUT_STOCK_LEVEL = 0;

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

      const lastPage = localStorage.getItem(KEY_LAST_PAGE) || 'dash';
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
  }

  show(label = 'Saving…') {
    const overlay = UI.el('saving-overlay');
    const arc     = UI.el('saving-arc');
    const lbl     = UI.el('saving-label');
    const btn     = UI.el('save-btn');
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
    const btn = UI.el('save-btn');
    if (arc) arc.style.strokeDashoffset = 0; // snap to 100%

    setTimeout(() => {
      const overlay = UI.el('saving-overlay');
      if (overlay) overlay.style.display = 'none';
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.pointerEvents = ''; }
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
  if (badge)     try { updateLowStockBadge(); } catch(_) {}
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
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  document.getElementById('tab-' + id).classList.add('active');
  if (id === 'dash') renderDashboard();
  if (id === 'list') renderList();
  if (id === 'sell') { renderSellPage(); setTimeout(()=>document.getElementById('sell-search').focus(),150); }
  // summary removed


  if (id === 'history') { renderHistoryPage(); }
}

// ===== TYPES =====
const DEFAULT_TYPES = [
  { name: 'Shoes', emoji: '👟', color: '#1e3a5f' },
  { name: 'Clothes', emoji: '👕', color: '#2d1b4e' },
  { name: 'Plastics', emoji: '🪣', color: '#1a3a2a' },
  { name: 'Electronics', emoji: '📱', color: '#1e2a3a' },
  { name: 'Food', emoji: '🍱', color: '#3a2a1a' },
  { name: 'Cosmetics', emoji: '💄', color: '#3a1a2a' },
  { name: 'General', emoji: '📦', color: '#1e293b' },
];

async function loadTypes() {
  types = await dbAll('types');
  if (types.length === 0) {
    for (const t of DEFAULT_TYPES) await dbAdd('types', t);
    types = await dbAll('types');
  }
  renderTypeSelect();
  renderTypeChips();
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
  types = await dbAll('types');
  renderTypeSelect();
  const list = document.getElementById('types-list');
  if (!types.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px;">No types yet</div>'; return; }
  list.innerHTML = types.map(t => `
    <div class="type-row">
      <div class="type-name"><span>${t.emoji}</span>${t.name}</div>
      <button class="type-del" onclick="deleteType(${t.id})">✕</button>
    </div>`).join('');
}

function pickEmoji(el) {
  document.querySelectorAll('.ep').forEach(e => e.classList.remove('sel'));
  el.classList.add('sel');
  selectedEmoji = el.dataset.e;
}

async function addType() {
  const name = document.getElementById('new-type-name').value.trim();
  if (!name) { toast('Enter a type name', 'err'); return; }
  if (types.find(t => t.name.toLowerCase() === name.toLowerCase())) { toast('Type already exists', 'err'); return; }
  await dbAdd('types', { name, emoji: selectedEmoji, color: '#1e293b' });
  document.getElementById('new-type-name').value = '';
  await loadTypes();
  renderTypes();
  toast('✅ Type added!', 'ok');
}

async function deleteType(id) {
  if (!confirm('Delete this type? Items using it will still show.')) return;
  await dbDelete('types', id);
  await loadTypes();
  renderTypes();
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
      const editIdRaw = UI.el('edit-id').value;

  // Stock management (add/edit/restock) does NOT require an open day.
  // Only sales (confirmSale) require the day to be open.

  // ── SHOE SIZE EDIT ─────────────────────────────────────────────
  if (editIdRaw && editIdRaw.startsWith('shoe_edit_')) {
    const parts   = editIdRaw.replace('shoe_edit_','').split('_');
    const itemId  = parseInt(parts[0]);
    const size    = parseInt(parts[1]);
    const item    = await dbGet('items', itemId);
    const allSz   = await getShoeSizes(item ? item.code : '');
    const sizeRec = allSz.find(s => s.size === size);
    if (!sizeRec) { toast('Size record not found', 'err'); return; }

    const qty  = parseInt(UI.el('f-qty').value);
    const buy  = parseFloat(UI.el('f-buy').value)  || sizeRec.buyPrice  || 0;
    const sell = parseFloat(UI.el('f-sell').value) || sizeRec.sellPrice || 0;
    if (isNaN(qty) || qty < 0) { toast('⚠️ Enter valid quantity', 'err'); return; }
    if (buy  <= 0) { toast('⚠️ Enter buying price',  'err'); return; }
    if (sell <= 0) { toast('⚠️ Enter selling price', 'err'); return; }

    sizeRec.qty = qty; sizeRec.buyPrice = buy; sizeRec.sellPrice = sell;
    sizeRec.profit = sell - buy; sizeRec.updatedAt = new Date().toISOString();
    await dbPut('shoe_sizes', sizeRec);

    if (item) {
      const updatedSizes = await getShoeSizes(item.code);
      item.qty = updatedSizes.reduce((t,s) => t+s.qty, 0);
      item.defaultBuy = buy; item.defaultSell = sell;
      item.updatedAt = new Date().toISOString();
      item.updatedBy = currentUser ? currentUser.username : 'system';
      await dbPut('items', item);
      fbSyncItem(item);
    }

    // Re-enable locked fields
    ['f-code','f-type','f-name','f-size'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = false; el.style.opacity = ''; el.style.cursor = ''; }
    });
    const banner = document.getElementById('restock-mode-banner');
    if (banner) banner.style.display = 'none';

    clearForm();
    await refreshUI();
    toast('✅ Size ' + size + ' updated · ' + qty + ' pairs · ' + fmt(sell), 'ok');
    showPage('list');
    return;
  }

  // ── RESTOCK MODE ───────────────────────────────────────────────
  if (editIdRaw && editIdRaw.startsWith('restock_')) {
    const existing = await dbGet('items', parseInt(editIdRaw.replace('restock_','')));
    if (!existing) { toast('⚠️ Item not found', 'err'); exitRestockMode(); return; }
    const qtyEl  = UI.el('f-qty');
    const addQty = parseInt(qtyEl ? qtyEl.value.trim() : '0');
    if (!addQty || addQty <= 0) { toast('⚠️ Enter quantity to add', 'err'); if(qtyEl) qtyEl.focus(); return; }
    if (addQty > CODE_MAX_QTY && !confirm('Adding ' + addQty + ' units — confirm?')) return;
    const newQty = existing.qty + addQty;
    if (newQty > 999999) { toast('⚠️ Exceeds max 999,999', 'err'); return; }
    existing.qty = newQty; existing.updatedAt = new Date().toISOString();
    await dbPut('items', existing);
    fbSyncItem(existing);
    await refreshUI();
    exitRestockMode();
    toast('📦 ' + existing.code + ': +' + addQty + ' → ' + newQty, 'ok');
    return;
  }

  // Read common fields
  const type = UI.el('f-type').value;
  const code = sanitiseCode(UI.el('f-code').value);
  const name = (UI.el('f-name').value||'').trim().replace(/\s+/g,' ') || (type + ' ' + code);

  if (!type) { toast('⚠️ Select an item type', 'err'); return; }
  if (!code) { toast('⚠️ Enter item code', 'err'); return; }

  // ── SHOE MODE ──────────────────────────────────────────────────
  if (isFootwearType(type) && !editIdRaw) {
    const savedCount = await saveShoeItems(code, name, type);
    if (!savedCount) return;
    clearForm(); clearAddFormPhoto();
    await refreshUI();
    toast('✅ ' + savedCount + ' shoe size(s) saved!', 'ok');
    return;
  }

  // ── STANDARD ADD / EDIT ────────────────────────────────────────
  const size   = UI.el('f-size').value.trim();
  const qtyRaw = UI.el('f-qty').value;
  const qty    = parseInt(qtyRaw);
  const buy    = parseFloat(UI.el('f-buy').value)  || 0;
  const sell   = parseFloat(UI.el('f-sell').value) || 0;

  if (!size)                                  { toast('⚠️ Enter a size (or N/A)', 'err'); return; }
  if (qtyRaw === '' || isNaN(qty) || qty < 0) { toast('⚠️ Enter quantity',       'err'); return; }
  if (qty > CODE_MAX_QTY && !confirm('Adding ' + qty + ' units — confirm?')) return;
  if (buy  <= 0) { toast('⚠️ Enter buying price',  'err'); return; }
  if (sell <= 0) { toast('⚠️ Enter selling price', 'err'); return; }

  const profit = sell - buy;
  const item   = { type, code, name, variant: size, buyPrice: buy, sellPrice: sell, profit, qty, createdAt: new Date().toISOString() };

  try {
    if (editIdRaw) {
      const original = await dbGet('items', parseInt(editIdRaw));
      item.id        = parseInt(editIdRaw);
      item.createdAt = original ? (original.createdAt || item.createdAt) : item.createdAt;
      item.updatedAt = new Date().toISOString();
      item.updatedBy = currentUser ? currentUser.username : 'system';
      item.fbId      = original ? original.fbId : undefined;
      await dbPut('items', item);
      if (_addFormPhotoData) setItemPhoto(item.id, _addFormPhotoData);
      fbSyncItem(item);
      clearForm();
      allItems = await dbAll('items');
      await enrichShoeItems(allItems);
      renderList(); renderDashboard(); updateHeader();
      scheduleSync();
      toast('✅ Item updated!', 'ok');
      showPage('list');
    } else {
      const newId = await dbAdd('items', item);
      item.id = newId;
      if (_addFormPhotoData) setItemPhoto(newId, _addFormPhotoData);
      fbSyncItem(item);
      clearForm(); clearAddFormPhoto();
      allItems = await dbAll('items');
      await enrichShoeItems(allItems);
      renderList(); renderDashboard(); updateHeader();
      scheduleSync();
      showSplash(name, sell, profit);
      if (activeDay) updateDayLiveStats();
    }
  } catch(e) {
    if (e.name === 'ConstraintError') {
      const dup = allItems.find(i => i.code === code && i.id !== parseInt(editIdRaw));
      if (dup && !editIdRaw) { toast('⚠️ Code "' + code + '" exists — select from dropdown to restock', 'err'); }
      else toast('⚠️ Duplicate code "' + code + '"', 'err');
    } else { toast('⚠️ Save failed: ' + (e.message||'Unknown'), 'err'); console.error('[SAVE]', e); }
  }
  } catch(err) {
    toast('⚠️ Save failed: ' + (err.message || 'Unknown error'), 'err');
    console.error('[SAVE]', err);
  } finally {
    _overlay.hide(); // ALWAYS runs — on success, error, or early return
  }
}
function clearForm() {
  UI.el('edit-id').value   = '';
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

  hideCodeDropdown();
}

// Code autocomplete helpers
let _codeDropdownActive = false;
let _editOriginItemId   = null;

function onCodeInput() {
  const clean = UI.el('f-code').value.toUpperCase().replace(/[^A-Z0-9\-.]/g,'');
  UI.el('f-code').value = clean;
  if (!clean) { hideCodeDropdown(); return; }
  const exact      = allItems.filter(i => i.code === clean);
  const startsWith = allItems.filter(i => i.code !== clean && i.code && i.code.startsWith(clean));
  const contains   = allItems.filter(i => i.code !== clean && i.code && !i.code.startsWith(clean) && i.code.includes(clean));
  const matches    = [...exact, ...startsWith, ...contains].slice(0,8);
  if (!matches.length) { hideCodeDropdown(); return; }
  showCodeDropdown(matches, clean);
}

function showCodeDropdown(items, typedCode) {
  let dd = document.getElementById('code-dropdown');
  if (!dd) {
    dd = document.createElement('div'); dd.id = 'code-dropdown'; dd.className = 'code-dd';
    const cf = UI.el('f-code');
    if (cf) cf.parentNode.insertBefore(dd, cf.nextSibling);
  }
  dd.innerHTML = items.map(item => {
    const isExact = item.code === typedCode;
    const sc = item.qty<=0?'var(--red)':item.qty<=LOW_STOCK_LEVEL?'#d97706':'var(--green)';
    const sl = item.qty<=0?'Out':item.qty+' in stock';
    return '<div class="code-dd-item' + (isExact?' code-dd-exact':'') + '" onclick="selectExistingItem(' + item.id + ')">' +
      '<span class="code-dd-code">' + escapeHtml(item.code) + (isExact?' <span class="code-dd-match-badge">exact</span>':'') + '</span>' +
      '<span class="code-dd-stock" style="color:' + sc + ';">' + sl + '</span>' +
    '</div>';
  }).join('');
  dd.style.display = 'block';
}

function hideCodeDropdown() {
  const dd = document.getElementById('code-dropdown'); if (dd) dd.style.display = 'none';
}

async function selectExistingItem(itemId) {
  const item = await dbGet('items', itemId);
  if (!item) { toast('⚠️ Item not found', 'err'); hideCodeDropdown(); return; }
  hideCodeDropdown();
  _codeDropdownActive = true;
  UI.el('f-code').value = item.code;
  UI.el('f-name').value = item.name || '';
  UI.el('f-size').value = item.size || '';
  const typeEl = UI.el('f-type'); if (typeEl) typeEl.value = item.type || '';
  onTypeChange();
  UI.el('edit-id').value = 'restock_' + itemId;

  let banner = document.getElementById('restock-mode-banner');
  if (!banner) {
    banner = document.createElement('div'); banner.id = 'restock-mode-banner'; banner.className = 'restock-banner';
    const cf = UI.el('f-code'); if (cf) cf.closest('.add-field').after(banner);
  }
  const sc = item.qty<=0?'var(--red)':item.qty<=LOW_STOCK_LEVEL?'#d97706':'var(--green)';
  banner.innerHTML = '<i class="fa-solid fa-boxes-stacked" style="color:var(--accent);font-size:18px;"></i>' +
    '<div style="flex:1;min-width:0;">' +
      '<div style="font-size:13px;font-weight:800;">Restock Mode</div>' +
      '<div style="font-size:11px;color:var(--muted);">' + escapeHtml(item.code) + (item.name?' · '+escapeHtml(item.name):'') +
        ' · Stock: <strong style="color:' + sc + ';">' + item.qty + '</strong>' +
        ' · Sell: ' + fmt(item.sell||item.defaultSell||0) +
      '</div>' +
    '</div>' +
    '<button onclick="exitRestockMode()" class="restock-banner-exit" title="Cancel">✕</button>';
  banner.style.display = 'flex';

  ['f-code','f-name','f-size','f-type','f-buy','f-sell'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled=true; el.style.opacity='0.4'; el.style.cursor='not-allowed'; }
  });
  const qtyEl = UI.el('f-qty');
  if (qtyEl) { qtyEl.disabled=false; qtyEl.style.opacity='1'; qtyEl.style.cursor=''; qtyEl.value=''; }

  UI.el('save-btn').textContent = '📦 Add to Stock';
  UI.el('form-mode-label').textContent = '📦 Restock';
  UI.el('cancel-edit-btn').style.display = 'block';
  setTimeout(() => { if (qtyEl) { qtyEl.focus(); qtyEl.select(); } }, 150);
}

function exitRestockMode() {
  _codeDropdownActive = false;
  clearForm();
}


function cancelEdit() { clearForm(); clearAddFormPhoto(); showPage('list'); }

// ===== RENDER LIST =====
async function renderList() {
  allItems = await dbAll('items');
  const search = (UI.el('search')?.value || '').toLowerCase();
  renderTypeChips();

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
    list.innerHTML = `<div class="empty">
      <div class="e-icon">${allItems.length ? '🔍' : '📦'}</div>
      <p>${allItems.length ? 'No items match your search.' : 'No items yet.\nTap ➕ Add Item to get started.'}</p>
    </div>`;
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

      // Group header (not tappable separately — just a label divider)
      cards.push(`
        <div class="shoe-group-header">
          <div class="shoe-group-icon" style="background:${t.color || '#1e3a5f'};">${t.emoji}</div>
          <div class="shoe-group-info">
            <span class="shoe-group-code">${escapeHtml(item.code)}</span>
            <span class="shoe-group-name">${escapeHtml(item.name || '')}</span>
          </div>
          <span class="tag tag-cyan" style="font-size:10px;flex-shrink:0;">${escapeHtml(item.type)}</span>
        </div>`);

      // One row per size
      sizes.forEach(sz => {
        const price       = sz.sellPrice || item.sellPrice || 0;
        const buy         = sz.buyPrice  || item.buyPrice  || 0;
        const isOut       = sz.qty <= 0;
        const isLow       = !isOut && sz.qty <= LOW_STOCK_LEVEL;
        const stockColor  = isOut ? 'tag-red' : isLow ? 'tag-amber' : 'tag-green';
        const stockLabel  = isOut ? '✕ Out'   : sz.qty + ' prs';
        const soldQty     = salesBySize[item.code + '_' + sz.size] || 0;

        cards.push(`
          <div class="item-card shoe-size-row" onclick="openShoeSizeCard('${escapeHtml(item.code)}',${sz.size})">
            <div class="item-top">
              <!-- Big green size number -->
              <div class="shoe-size-badge ${isOut ? 'out' : isLow ? 'low' : ''}">${sz.size}</div>
              <div class="item-body">
                <!-- Item name + group label only — no "Size XX" text -->
                <div class="item-code">${escapeHtml(item.name || item.code)}</div>
                <div class="item-tags">
                  ${sz.sizeGroup ? `<span class="tag tag-gray">${sz.sizeGroup==='S'?'Children':sz.sizeGroup==='M'?'Teens':'Adults'}</span>` : ''}
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

      // Spacer between shoe groups
      cards.push('<div style="height:6px;"></div>');

    } else {
      // ── STANDARD ITEM — single card ───────────────────────────────
      const stockColor = item.qty === 0 ? 'tag-red' : item.qty <= LOW_STOCK_LEVEL ? 'tag-amber' : 'tag-green';
      const stockLabel = item.qty === 0 ? '✕ Out'   : item.qty + ' pcs';
      const soldQty    = (salesByItem[item.id] || {}).qty || 0;
      const sellPrice  = item.sellPrice || item.sell || 0;
      const buyPrice   = item.buyPrice  || item.buy  || 0;

      cards.push(`
        <div class="item-card" onclick="openSheet(${item.id})">
          <div class="item-top">
            <div class="item-icon" style="background:${t.color || 'var(--surface2)'};">${t.emoji}</div>
            <div class="item-body">
              <div class="item-code">${escapeHtml(item.code)}${(item.variant||item.size) ? ' · ' + escapeHtml(item.variant||item.size) : ''}</div>
              <div class="item-name">${escapeHtml(item.name || '')}</div>
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

  list.innerHTML = cards.join('');
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
  const photoPan = document.getElementById('sh-photo-pan');
  if (photo) {
    photoImg.src = photo;
    if (photoPan) photoPan.style.display = 'block';
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
    renderShoeDetailGrid(item);
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

function closeSheet() { document.getElementById('detail-sheet').classList.remove('open'); }

async function deleteItem() {
  if (!confirm('Delete this item?')) return;
  const toDelete = await dbGet('items', currentDetailId);
  await dbDelete('items', currentDetailId);
  if (toDelete && toDelete.fbId) fbDeleteItem(toDelete.fbId);
  closeSheet();
  allItems = await dbAll('items');
  renderList();
  renderDashboard();
  renderSummary();
  updateHeader();
  toast('Item deleted');
}

async function editItem() {
  const item = await dbGet('items', currentDetailId);
  if (!item) { toast('Item not found.', 'err'); return; }
  closeSheet();

  if (item.isShoe) {
    const size = _selectedShoeSize;
    if (!size) { toast('⚠️ Select a size first before editing', 'err'); setTimeout(()=>openSheet(item.id),100); return; }
    const sizes = await getShoeSizes(item.code);
    const sizeRec = sizes.find(s => s.size === size);
    if (!sizeRec) { toast('Size record not found', 'err'); return; }
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
  showPage('add');
  UI.el('edit-id').value = item.id;
  UI.el('f-type').value  = item.type  || '';
  UI.el('f-code').value  = item.code  || '';
  UI.el('f-name').value  = item.name  || '';
  UI.el('f-size').value  = item.size  || '';
  UI.el('f-qty').value   = item.qty   ?? '';
  UI.el('f-buy').value   = item.buy   || '';
  UI.el('f-sell').value  = item.sell  || '';
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
}

// ===== DASHBOARD =====
async function renderDashboard() {
  const items = await dbAll('items');
  const sales = await dbAll('sales');

  const totalItems = items.length;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const stockCost = items.reduce((s, i) => s + i.buy * i.qty, 0);
  const stockRetail = items.reduce((s, i) => s + i.sell * i.qty, 0);

  // Sales aggregates
  const totalRevenue = sales.reduce((s, x) => s + x.revenue, 0);
  const totalProfitEarned = sales.reduce((s, x) => s + x.profit, 0);
  const totalPiecesSold = sales.reduce((s, x) => s + x.qty, 0);
  const totalSalesCount = sales.length;

  // Stock value remaining = current stock retail value
  const stockRemaining = stockRetail;

  // Top stat boxes
  document.getElementById('d-items').textContent = totalItems;
  document.getElementById('d-qty').textContent = fmtN(totalQty);
  document.getElementById('d-stock-val').textContent = fmt(stockCost);
  document.getElementById('d-total-sold').textContent = totalSalesCount;

  // Stock card
  document.getElementById('d-cost-total').textContent = fmt(stockCost);
  document.getElementById('d-retail-total').textContent = fmt(stockRetail);
  document.getElementById('d-remaining').textContent = fmt(stockRemaining);

  // Sales card
  document.getElementById('d-revenue').textContent = fmt(totalRevenue);
  document.getElementById('d-profit-earned').textContent = fmt(totalProfitEarned);
  document.getElementById('d-pieces-sold').textContent = fmtN(totalPiecesSold);

  // Insights
  const insightsEl = document.getElementById('d-insights');
  const insights = [];
  if (totalItems === 0) {
    insights.push({ icon: '📦', text: 'No items yet — tap ➕ Add to get started', color: 'var(--muted)' });
  } else {
    // Best selling type
    const typeRevMap = {};
    sales.forEach(s => { typeRevMap[s.type] = (typeRevMap[s.type] || 0) + s.revenue; });
    const bestType = Object.entries(typeRevMap).sort((a,b) => b[1]-a[1])[0];
    if (bestType) insights.push({ icon: '🏆', text: 'Best selling type: <strong>' + bestType[0] + '</strong> (' + fmt(bestType[1]) + ' revenue)', color: 'var(--accent2)' });

    // Profit margin overall
    if (totalRevenue > 0) {
      const margin = ((totalProfitEarned / totalRevenue) * 100).toFixed(1);
      insights.push({ icon: '📈', text: 'Overall profit margin: <strong>' + margin + '%</strong>', color: margin >= 20 ? 'var(--green)' : 'var(--amber)' });
    }

    // Out of stock
    const outStock = items.filter(i => i.qty === 0);
    if (outStock.length) insights.push({ icon: '⚠️', text: '<strong>' + outStock.length + '</strong> item' + (outStock.length>1?'s':'') + ' out of stock: ' + outStock.map(i=>i.code).join(', '), color: 'var(--red)' });

    // Low stock
    const lowStock = items.filter(i => i.qty > 0 && i.qty <= 3);
    if (lowStock.length) insights.push({ icon: '📉', text: '<strong>' + lowStock.length + '</strong> item' + (lowStock.length>1?'s':'') + ' running low (≤3 pcs): ' + lowStock.map(i=>i.code).join(', '), color: 'var(--amber)' });

    // Stock turnover hint
    if (totalPiecesSold > 0 && totalQty > 0) {
      const ratio = (totalPiecesSold / (totalPiecesSold + totalQty) * 100).toFixed(0);
      insights.push({ icon: '🔄', text: '<strong>' + ratio + '%</strong> of your stock has been sold', color: 'var(--accent)' });
    }

    if (insights.length === 0) insights.push({ icon: '✅', text: 'All good — stock levels healthy', color: 'var(--green)' });
  }

  insightsEl.innerHTML = insights.map(ins => `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">
      <span style="font-size:18px;flex-shrink:0;">${ins.icon}</span>
      <span style="font-size:13px;font-weight:500;color:${ins.color};line-height:1.5;">${ins.text}</span>
    </div>`).join('').replace(/border-bottom[^;]+;(?=[^<]*<\/div>\s*$)/, '');

  // Alerts separately
  const outStk = items.filter(i => i.qty === 0);
  const lowStk = items.filter(i => i.qty > 0 && i.qty <= 3);
  const alertEl = document.getElementById('d-alerts');
  let alertHTML = '';
  if (outStk.length) alertHTML += `<div style="background:var(--red-light);border:1px solid rgba(192,57,43,0.25);border-radius:var(--r);padding:12px 14px;margin-bottom:8px;font-size:13px;color:var(--red);">⚠️ <strong>${outStk.length}</strong> out of stock: ${outStk.map(i=>i.code).join(', ')}</div>`;
  if (lowStk.length) alertHTML += `<div style="background:var(--amber-light);border:1px solid #f5d9a0;border-radius:var(--r);padding:12px 14px;margin-bottom:12px;font-size:13px;color:var(--amber);">📉 <strong>${lowStk.length}</strong> low stock: ${lowStk.map(i=>i.code).join(', ')}</div>`;
  alertEl.innerHTML = alertHTML;

  // Top 5 items by stock value
  const sorted = [...items].sort((a, b) => (b.sell * b.qty) - (a.sell * a.qty)).slice(0, 5);
  const topEl = document.getElementById('d-top-items');
  if (!sorted.length) { topEl.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No items yet</div>'; }
  else {
    const maxVal = sorted[0].sell * sorted[0].qty || 1;
    topEl.innerHTML = sorted.map(item => {
      const val = item.sell * item.qty;
      const pct = Math.max(6, (val / maxVal) * 100);
      const t = getTypeObj(item.type);
      return `<div class="card" style="padding:12px;margin-bottom:8px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
          <span style="font-size:20px;">${t.emoji}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</div>
            <div style="font-size:11px;font-family:var(--mono);color:var(--muted);">${item.code} · ${item.qty} pcs</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div style="font-size:13px;font-weight:700;font-family:var(--mono);color:var(--accent2);">${fmt(val)}</div>
          </div>
        </div>
        <div style="background:var(--surface2);border-radius:4px;height:6px;overflow:hidden;">
          <div style="height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:4px;width:${pct}%;"></div>
        </div>
      </div>`;
    }).join('');
  }

  // By type
  const byType = {};
  items.forEach(item => {
    if (!byType[item.type]) byType[item.type] = { qty: 0, cost: 0, retail: 0, count: 0 };
    byType[item.type].qty += item.qty;
    byType[item.type].cost += item.buy * item.qty;
    byType[item.type].retail += item.sell * item.qty;
    byType[item.type].count++;
  });
  const typeEl = document.getElementById('d-by-type');
  if (!Object.keys(byType).length) { typeEl.innerHTML = ''; return; }
  typeEl.innerHTML = Object.entries(byType).map(([type, data]) => {
    const t = getTypeObj(type);
    return `<div class="card" style="margin-bottom:8px;padding:12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">
        <span style="font-size:22px;">${t.emoji}</span>
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;">${type}</div>
          <div style="font-size:11px;font-family:var(--mono);color:var(--muted);">${data.count} item${data.count!==1?'s':''} · ${fmtN(data.qty)} pcs</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div class="detail-box" style="padding:10px;">
          <div class="detail-key" style="font-size:10px;">STOCK COST</div>
          <div class="detail-val" style="font-size:13px;color:var(--text2);">${fmt(data.cost)}</div>
        </div>
        <div class="detail-box" style="padding:10px;">
          <div class="detail-key" style="font-size:10px;">STOCK VALUE</div>
          <div class="detail-val" style="font-size:13px;color:var(--accent2);">${fmt(data.retail)}</div>
        </div>
      </div>
    </div>`;
  }).join('');
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
  document.getElementById('currency-sel').value = currency;
  document.getElementById('bp-cur').textContent = currency;
  document.getElementById('sp-cur').textContent = currency;
  document.getElementById('splash-cur').textContent = currency;
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
      showPage('list');
    }, 350);
  }, 2200);
}

// ===== EXPORT =====





// ===== MAKE A SALE =====
let currentSellItemId = null;
let _selectedPayment = 'Cash'; // Cash | M-Pesa | Credit

async function searchSell() {
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
}

function selectPayment(method) {
  _selectedPayment = method;
  ['Cash','M-Pesa','Credit'].forEach(m => {
    const btn = document.getElementById('pm-' + m);
    if (btn) btn.classList.toggle('pm-active', m === method);
  });
}

async function openSellModal(itemId) {
  const item = await dbGet('items', itemId);
  currentSellItemId = itemId;
  const t = getTypeObj(item.type);
  document.getElementById('sm-icon').textContent = t.emoji;
  document.getElementById('sm-icon').style.background = t.color || 'var(--surface2)';
  document.getElementById('sm-name').textContent = item.name;
  document.getElementById('sm-meta').textContent = item.code + (item.size ? ' · ' + item.size : '');
  document.getElementById('sm-stock').textContent = item.qty;
  document.getElementById('sm-sell').textContent = fmt(item.sell);
  const _tpel=document.getElementById('sm-total-profit'); if(_tpel) _tpel.textContent = (item.profit >= 0 ? '+' : '') + fmt(item.profit);
  document.getElementById('sm-cur').textContent = currency;
  document.getElementById('sm-qty').value = 1;
  document.getElementById('sm-qty').max = item.qty;
  document.getElementById('sm-actual').value = '';
  updateSellModal();
  selectPayment('Cash'); // reset payment method
  document.getElementById('sell-modal').classList.add('open');
}

function closeSellModal() {
  document.getElementById('sell-modal').classList.remove('open');
  currentSellItemId = null;
}

async function updateSellModal() {
  if (!currentSellItemId) return;
  const item = await dbGet('items', currentSellItemId);
  const qty = Math.max(1, parseInt(document.getElementById('sm-qty').value) || 1);
  const actualRaw = parseFloat(document.getElementById('sm-actual').value);
  const priceUsed = (!isNaN(actualRaw) && actualRaw > 0) ? actualRaw : item.sell;
  const totalRev = qty * priceUsed;
  const totalProfit = qty * (priceUsed - item.buy);
  const overridden = !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== item.sell;
  document.getElementById('sm-price-used').textContent = fmt(priceUsed) + (overridden ? ' (custom)' : ' (default)');
  document.getElementById('sm-total-rev').textContent = fmt(totalRev);
  document.getElementById('sm-total-profit').textContent = (totalProfit >= 0 ? '+' : '') + fmt(totalProfit);
  document.getElementById('sm-total-profit').style.color = totalProfit >= 0 ? 'var(--green)' : 'var(--red)';
  // cap qty at stock
  document.getElementById('sm-qty').max = item.qty;
}

function adjSellQty(d) {
  const inp = document.getElementById('sm-qty');
  let v = (parseInt(inp.value) || 1) + d;
  const max = parseInt(inp.max) || 9999;
  inp.value = Math.max(1, Math.min(v, max));
  updateSellModal();
}

async function confirmSale() {
  if (!currentSellItemId) return;

  const item = await dbGet('items', currentSellItemId);
  if (!item) { toast('Item not found', 'err'); closeSellModal(); return; }

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
  if (priceUsed <= 0) { toast('⚠️ No selling price set', 'err'); return; }

  // ── Validate qty ───────────────────────────────────────────────
  const maxQty = _isShoeSale && _sellShoeSize ? _sellShoeSize.qty : item.qty;
  if (qty > maxQty) { toast('⚠️ Only ' + maxQty + ' in stock', 'err'); return; }

  // ── Validate actual price ≥ buy price ─────────────────────────
  if (!isNaN(actualRaw) && actualRaw > 0 && actualRaw < buyPrice) {
    toast('⚠️ Sale price cannot be below buying price (' + fmt(buyPrice) + ')', 'err');
    return;
  }

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
    await dbAdd('finances', finEntry);
    // Sync to Firebase
    if (fbReady && fbDb) {
      try {
        const { doc, setDoc } = await waitForFbImports();
        const fbFinId = 'fin_sale_' + newSaleId;
        finEntry.fbId = fbFinId;
        await setDoc(doc(fbDb, 'finances', fbFinId), sanitiseForFirestore({...finEntry}));
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
  try { renderSellPage(); } catch(_) {}
  try { if (activeDay) updateDayLiveStats(); } catch(_) {}
  // Refresh finance page if it's currently visible
  try {
    if (document.getElementById('page-finance')?.classList.contains('active')) {
      renderFinancePage();
    }
  } catch(_) {}

  toast('✅ ' + fmt(revenue) + ' · Profit: ' + fmt(profit), 'ok');
}

async function renderSellPage() {
  const sales = await dbAll('sales');
  const todayStr = new Date().toISOString().split('T')[0];
  const todaySales = sales.filter(s => s.date.startsWith(todayStr));
  const todayRev = todaySales.reduce((a, s) => a + s.revenue, 0);
  const todayProfit = todaySales.reduce((a, s) => a + s.profit, 0);
  document.getElementById('sell-today-rev').textContent = fmt(todayRev);
  document.getElementById('sell-today-profit').textContent = fmt(todayProfit);

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
      const t = getTypeObj(s.type);
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
}

// close sell modal on backdrop click
document.getElementById('sell-modal').addEventListener('click', function(e) {
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
      STORES.FINANCES, STORES.BDAYS, STORES.TYPES,
    ]);
    console.log('[DB] All stores cleared');

    // 2. Clear Firebase if connected
    if (fbReady && fbDb) {
      try {
        const { collection, getDocs, writeBatch, doc } = await waitForFbImports();
        for (const col of [STORES.ITEMS, STORES.SALES, STORES.SIZES, STORES.FINANCES, STORES.BDAYS]) {
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
    try { updateLowStockBadge(); } catch(_) {}

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
    const stores = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes', 'finances'];
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
        for (const col of ['items', 'sales', 'business_days', 'shoe_sizes']) {
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
          else    { try { await dbAdd('items', data); } catch(_) {} }
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
          else    { try { await dbAdd('sales', data); } catch(_) {} }
        }
      }
      try { if (activeDay) updateDayLiveStats(); } catch(_) {}
      try { renderDashboard(); } catch(_) {}
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
  // Config is hardcoded — just reconnect
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  fbApp = null; fbDb = null; fbReady = false;
  await initFirebase();
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
    const { collection, getDocs } = await waitForFbImports();

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
        try { await dbAdd('items', data); itemsAdded++; } catch(_) {}
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
      const existing = salesByFbId[d.id];
      if (existing) {
        data.id = existing.id;
        await dbPut('sales', data);
        salesUpdated++;
      } else {
        try { await dbAdd('sales', data); salesAdded++; } catch(_) {}
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
        else    { try { await dbAdd('shoe_sizes', data); } catch(_) {} }
      }
    } catch(_) {}

    // Pull finances
    try {
      const finSnap = await getDocs(collection(fbDb, 'finances'));
      const localFin = await dbAll('finances');
      const finByFbId = Object.fromEntries(localFin.filter(f=>f.fbId).map(f=>[f.fbId,f]));
      for (const d of finSnap.docs) {
        const data = { ...d.data(), fbId: d.id }; delete data.id;
        const ex = finByFbId[d.id];
        if (ex) { data.id = ex.id; await dbPut('finances', data); }
        else    { try { await dbAdd('finances', data); } catch(_) {} }
      }
    } catch(_) {}

    await refreshUI({ sync: false });
    try { renderSellPage(); } catch(_) {}
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

function cancelCloseDay() {
  document.getElementById('day-summary-sheet').classList.remove('open');
}

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
  if (!confirm('Void this sale? Stock will be restored.')) return;
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
  await dbDelete('sales', saleId);

  // Refresh
  allItems = await dbAll('items');
  await enrichShoeItems(allItems);
  renderList(); renderDashboard(); updateHeader();
  if (activeDay) updateDayLiveStats();
  scheduleSync();
  toast('↩️ Sale voided · stock restored', 'ok');
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
    actionArea.innerHTML = '<button onclick="closeDay()" style="' + BTN + 'background:var(--red);color:white;"><i class="fa-solid fa-moon"></i> Close Day</button>';
    if (liveSection) liveSection.style.display = 'block';
    setDayMode(true);
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
    actionArea.innerHTML = '<button onclick="openDay()" style="' + BTN + 'background:var(--accent);color:white;"><i class="fa-solid fa-sun"></i> Open Day</button>';
    if (liveSection) liveSection.style.display = 'none';
    setDayMode(false);
  } else if (status === 'LOCKED') {
    banner.style.cssText = 'background:var(--surface2);border:2px solid var(--border);border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent  = '🔒';
    badge.textContent = 'LOCKED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 12px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:var(--surface2);color:var(--muted);';
    title.textContent = 'Archived Day';
    title.style.color = 'var(--muted)';
    sub.textContent   = fmtFullDate((activeDay.businessDate || activeDay.business_date)) + ' — read only';
    actionArea.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:10px 0;">This day is read-only. A new day will appear automatically tomorrow.</div>';
    if (liveSection) liveSection.style.display = 'none';
    setDayMode(false);
  }
}

// ── LIVE STATS ───────────────────────────────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay) return;
  const sales = await dbAll('sales');
  const _dayDate = (activeDay.businessDate || activeDay.business_date);
  const daySales = sales.filter(s => (s.businessDate||s.business_date) === _dayDate);
  const rev   = daySales.reduce((a, s) => a + s.revenue, 0);
  const profit = daySales.reduce((a, s) => a + s.profit, 0);
  const count = daySales.length;
  const items = await dbAll('items');
  const purchases = items.filter(i => activeDay.opened_at && i.createdAt >= activeDay.opened_at);

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('day-sales-count', count);
  set('day-revenue',     fmt(rev));
  set('day-profit',      fmt(profit));
  set('day-purchases',   purchases.length);

  // Today's sales list
  const sl = document.getElementById('day-sales-list');
  if (sl) {
    sl.innerHTML = daySales.length
      ? daySales.slice().reverse().slice(0, 20).map(s =>
          '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">' +
          '<div style="flex:1;"><div style="font-size:13px;font-weight:700;">' + (s.itemName||'') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' + fmtTime(s.date) + ' · ' + (s.itemCode||'') + ' · ' + (s.paymentMethod||'Cash') + '</div></div>' +
          '<div style="text-align:right;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(s.revenue) + '</div>' +
          '<div style="font-size:11px;color:var(--green);">+' + fmt(s.profit) + '</div></div>' +
          (isDayOpen() ? '<button onclick="voidSale(' + s.id + ')" style="font-size:10px;padding:2px 8px;background:var(--red-light);color:var(--red);border:1px solid var(--red);border-radius:4px;cursor:pointer;font-weight:700;flex-shrink:0;">Void</button>' : '') +
          '</div>'
        ).join('')
      : '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No sales yet today</div>';
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
  const qty = parseInt(document.getElementById('restock-qty').value) || 0;
  if (qty <= 0) { toast('⚠️ Enter quantity to add', 'err'); return; }
  const item = await dbGet('items', currentDetailId);
  item.qty += qty;
  await dbPut('items', item);
  fbSyncItem(item);
  scheduleSync();
  document.getElementById('sh-qty').textContent = item.qty + ' pcs';
  document.getElementById('restock-panel').style.display = 'none';
  allItems = await dbAll('items');
  renderList();
  renderDashboard();
  updateHeader();
  updateLowStockBadge();
  toast('✅ Added ' + qty + ' pcs to ' + item.name, 'ok');
}

// ═══════════════════════════════════════════════════════════
// LOW STOCK BADGE IN HEADER
// ═══════════════════════════════════════════════════════════
async function updateLowStockBadge() {
  const items = await dbAll('items');
  const badge = document.getElementById('low-stock-badge');
  // low stock badge removed from header
}

// ═══════════════════════════════════════════════════════════
// DELETE SALE
// ═══════════════════════════════════════════════════════════
async function deleteSale(saleId) {
  if (!confirm('Delete this sale record? Stock will NOT be restored.')) return;
  await dbDelete('sales', saleId);
  renderSellPage();
  renderDashboard();
  scheduleSync();
  toast('Sale record deleted', '');
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
document.getElementById('detail-sheet').addEventListener('click', function(e) {
  if (e.target === this) closeSheet();
});
document.getElementById('day-summary-sheet').addEventListener('click', function(e) {
  if (e.target === this) cancelCloseDay();
});
document.getElementById('past-session-sheet').addEventListener('click', function(e) {
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
      const t=document.getElementById('tab-settings');
      if(t&&!document.getElementById('update-dot')){const d=document.createElement('span');d.id='update-dot';d.style.cssText='position:absolute;top:4px;right:4px;width:8px;height:8px;background:var(--red);border-radius:50%;';t.style.position='relative';t.appendChild(d);}
    }
    reg.addEventListener('updatefound',()=>{const w=reg.installing;w.addEventListener('statechange',()=>{if(w.state==='installed'&&navigator.serviceWorker.controller)onNewWorker(w);});});
    if(reg.waiting&&navigator.serviceWorker.controller)onNewWorker(reg.waiting);
    setInterval(()=>reg.update().then(()=>_setUpdateLastCheck()).catch(()=>{}), 30*60*1000);
  }).catch(()=>{});
  let _reloading=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    if(_reloading)return;_reloading=true;
    const bar=document.getElementById('update-progress-bar');
    const pct=document.getElementById('update-progress-pct');
    const lbl=document.getElementById('update-progress-label');
    if(bar)bar.style.width='100%';if(pct)pct.textContent='100%';if(lbl)lbl.textContent='Reloading…';
    setTimeout(()=>window.location.reload(),600);
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
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    if (result.outcome === 'accepted') {
      hideInstallBanner();
      localStorage.setItem('install_dismissed', '1');
    }
    deferredInstallPrompt = null;
  }
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
  const tabLabels = { dash: 'Dashboard', list: 'Stock', add: 'Add Item', sell: 'Sell', day: 'Day', settings: 'Settings' };
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
    tabs: ['dash','list','add','history','finance','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    pinHash: '38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','list','add','history','finance']
  },
  {
    username: 'trevor',
    pin: '3456',
    pinHash: 'ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd',
    name: 'Trevor',
    role: 'clerk',
    roleLabel: 'Clerk',
    // Clerk: view stock + add stock
    tabs: ['list','add']
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
  // Show/hide nav tabs based on role
  const allTabs = ['dash','list','add','history','finance','settings'];
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
  ['dash','list','add','sell','day','types','settings'].forEach(tab => {
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



// Guard showPage - block access to restricted tabs
const _origShowPage = showPage;
showPage = function(id) {
  if (currentUser && !currentUser.tabs.includes(id)) {
    toast('⛔ Access denied', 'err');
    return;
  }
  if (currentUser) localStorage.setItem(KEY_LAST_PAGE, id);
  _origShowPage(id);
};

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
  const lastPage = localStorage.getItem(KEY_LAST_PAGE) || 'dash';
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
function _showUpdateState(state){['current','available','installing'].forEach(s=>{const el=document.getElementById('update-state-'+s);if(el)el.style.display=s===state?'':'none';});}
function _setUpdateLastCheck(){const el=document.getElementById('update-last-check');if(el)el.textContent='Checked: '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
function installAppUpdate(){
  if(!_pendingWorker)return;
  _showUpdateState('installing');
  let pct=0;
  const steps=[{t:20,l:'Downloading…',d:300},{t:45,l:'Installing…',d:500},{t:70,l:'Clearing cache…',d:400},{t:90,l:'Finalising…',d:400}];
  function run(i){if(i>=steps.length)return;const{t,l,d}=steps[i];setTimeout(()=>{pct=t;const bar=document.getElementById('update-progress-bar');const pctEl=document.getElementById('update-progress-pct');const lblEl=document.getElementById('update-progress-label');if(bar)bar.style.width=pct+'%';if(pctEl)pctEl.textContent=pct+'%';if(lblEl)lblEl.textContent=l;run(i+1);},d);}
  run(0);
  _pendingWorker.postMessage({type:'SKIP_WAITING'});
}

// ===================================================================
// FINANCE MODULE
// Tracks: investments, expenses, withdrawals, other money flows
// ===================================================================

let _finFilter = 'all';

async function renderFinancePage() {
  // Set today as default date
  const dateEl = document.getElementById('fin-date');
  if (dateEl && !dateEl.value) dateEl.value = todayDateStr();

  const entries = await dbAll('finances');
  const sales   = await dbAll('sales');

  // Compute totals
  const invested  = entries.filter(e=>e.type==='investment').reduce((s,e)=>s+e.amount,0);
  const expenses  = entries.filter(e=>e.type==='expense').reduce((s,e)=>s+e.amount,0);
  const withdrawn = entries.filter(e=>e.type==='withdrawal').reduce((s,e)=>s+e.amount,0);
  // Revenue from both sales entries (auto-recorded) and direct sales table
  const salesRevEntries = entries.filter(e=>e.type==='revenue'&&e.category==='sales');
  const revenue   = salesRevEntries.length
    ? salesRevEntries.reduce((s,e)=>s+e.amount,0)
    : sales.reduce((s,e)=>s+e.revenue,0);
  const profit    = salesRevEntries.length
    ? salesRevEntries.reduce((s,e)=>s+(e.profit||0),0)
    : sales.reduce((s,e)=>s+e.profit,0);
  const net       = invested + revenue - expenses - withdrawn;

  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=fmt(v); };
  set('fin-invested',  invested);
  set('fin-expenses',  expenses);
  set('fin-withdrawn', withdrawn);
  set('fin-revenue',   revenue);
  set('fin-profit',    profit);

  // Net position colour
  const netEl = document.getElementById('fin-net');
  if (netEl) {
    netEl.textContent = fmt(net);
    netEl.style.color = net >= 0 ? 'var(--green)' : 'var(--red)';
    const kpi = netEl.closest('.fin-kpi');
    if (kpi) { kpi.classList.remove('green','red','cyan'); kpi.classList.add(net>=0?'green':'red'); }
  }

  // Filter and render list
  const filtered = _finFilter === 'all' ? entries : entries.filter(e=>e.type===_finFilter);
  const sorted   = filtered.sort((a,b)=>new Date(b.date)-new Date(a.date));
  renderFinList(sorted);
}

function renderFinList(entries) {
  const list = document.getElementById('fin-list');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted);font-size:14px;">No transactions yet.<br><span style="font-size:12px;">Record your first investment, expense or withdrawal above.</span></div>';
    return;
  }
  const typeConfig = {
    investment: { icon:'💵', color:'var(--green)',  label:'Investment' },
    expense:    { icon:'💸', color:'var(--red)',    label:'Expense'    },
    withdrawal: { icon:'🏧', color:'var(--amber)',  label:'Withdrawal' },
    revenue:    { icon:'🛒', color:'var(--accent2)',label:'Sale Revenue'},
    other:      { icon:'📝', color:'var(--muted)',  label:'Other'      },
  };
  list.innerHTML = entries.map(e => {
    const cfg   = typeConfig[e.type] || typeConfig.other;
    const fdate = e.date ? new Date(e.date+'T00:00:00').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '';
    return '<div class="fin-entry" style="border-left:3px solid ' + cfg.color + ';">' +
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:22px;">' + cfg.icon + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:13px;font-weight:700;color:var(--text);">' + escapeHtml(e.description||cfg.label) + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:1px;">' + cfg.label + ' · ' + fdate + '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:15px;font-weight:800;font-family:var(--mono);color:' + cfg.color + ';">' + fmt(e.amount) + '</div>' +
          '<button onclick="deleteFinanceEntry(' + e.id + ')" ' +
            'style="font-size:10px;color:var(--muted);background:none;border:none;cursor:pointer;padding:2px;">✕ delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function saveFinanceEntry() {
  const type   = document.getElementById('fin-type').value;
  const amount = parseFloat(document.getElementById('fin-amount').value);
  const desc   = (document.getElementById('fin-desc').value||'').trim();
  const date   = document.getElementById('fin-date').value || todayDateStr();

  if (!type)              { toast('⚠️ Select a transaction type', 'err'); return; }
  if (!amount || amount<=0){ toast('⚠️ Enter a valid amount', 'err'); return; }

  const entry = {
    type,
    amount,
    description: desc,
    category:    'other',
    date,
    createdAt:   new Date().toISOString(),
    createdBy:   currentUser ? currentUser.username : 'system',
  };
  await dbAdd('finances', entry);

  // Clear form
  document.getElementById('fin-type').value   = '';
  document.getElementById('fin-amount').value = '';
  document.getElementById('fin-desc').value   = '';
  document.getElementById('fin-date').value   = todayDateStr();

  renderFinancePage();
  toast('✅ Transaction recorded', 'ok');
}

async function deleteFinanceEntry(id) {
  if (!confirm('Delete this transaction?')) return;
  await dbDelete('finances', id);
  renderFinancePage();
  toast('Entry deleted', '');
}

function filterFinance(type) {
  _finFilter = type;
  document.querySelectorAll('.fin-filter-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('fin-filter-' + type);
  if (btn) btn.classList.add('active');
  renderFinancePage();
}

function updateFinTypeColor() {
  // Visual feedback when type is selected
  const sel = document.getElementById('fin-type');
  if (!sel) return;
  const colors = { investment:'#dcfce7', expense:'#fee2e2', withdrawal:'#fef3c7', other:'var(--surface2)' };
  sel.style.background = colors[sel.value] || 'var(--bg)';
}

// ===== INIT =====
initDB();
setTimeout(initFirebase, 800);

// ===== AUTO SYNC =====
let autoSyncTimer = null;
let pendingSyncTimer = null;

// Debounced sync — runs 2s after last change, avoids hammering Firebase
function scheduleSync() {
  if (!navigator.onLine || !fbReady || !fbDb) return;
  clearTimeout(pendingSyncTimer);
  pendingSyncTimer = setTimeout(async () => {
    try {
      await forcePushToFirebase(true);
      await pullFromFirebase(true);
    } catch(e) { console.warn('Auto sync error:', e); }
  }, 2000);
}

// Expose so all data-change functions can call it
window.scheduleSync = scheduleSync;

function startAutoSync() {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  // Also run every 2 minutes as a heartbeat
  autoSyncTimer = setInterval(async () => {
    if (!fbReady || !fbDb || !navigator.onLine) return;
    try {
      await forcePushToFirebase(true);
      await pullFromFirebase(true);
      setFbStatus('on');
    } catch(e) { setFbStatus('error'); }
  }, 2 * 60 * 1000);
}

// Auto sync immediately when internet comes back online
window.addEventListener('online', async () => {
  if (!fbReady || !fbDb) return;
  toast('📶 Back online — syncing…', '');
  setFbStatus('syncing');
  try {
    await forcePushToFirebase(true);
    await pullFromFirebase(true);
    setFbStatus('on');
    toast('✅ Synced!', 'ok');
  } catch(e) { setFbStatus('error'); }
});

window.addEventListener('offline', () => {
  toast('📴 Offline — changes saved locally', '');
  setFbStatus('off');
});

// Start auto sync after Firebase connects
const _origInitFirebase = initFirebase;
initFirebase = async function() {
  await _origInitFirebase();
  if (fbReady) startAutoSync();
};
// ===================================================================
// SHOE INVENTORY SYSTEM
// ===================================================================

const SHOE_GROUP_DEFAULTS = {
  S: { min: 20, max: 28, label: 'Small (Children)'  },
  M: { min: 29, max: 36, label: 'Medium (Teens)'    },
  L: { min: 37, max: 45, label: 'Large (Adults)'    },
};

function getShoeGroups() {
  const saved = localStorage.getItem(KEY_SHOE_GROUPS);
  if (!saved) return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  try { return JSON.parse(saved); } catch(e) { return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS)); }
}

function isFootwearType(typeName) {
  if (!typeName) return false;
  const t = typeName.toLowerCase();
  return t.includes('shoe') || t.includes('footwear') || t.includes('sandal') || t.includes('boot') || t.includes('sneaker');
}

// Get all size records for a shoe code
async function getShoeSizes(itemCode) {
  const all = await dbAll('shoe_sizes');
  return all.filter(s => s.itemCode === itemCode).sort((a,b) => a.size - b.size);
}

// Upsert a shoe size record
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

// Enrich shoe items: compute virtual qty + size chip HTML from shoe_sizes
async function enrichShoeItems(items) {
  const shoeCodes = items.filter(i => i.isShoe).map(i => i.code);
  if (!shoeCodes.length) return;
  const allSizes = await dbAll('shoe_sizes');
  for (const item of items) {
    if (!item.isShoe) continue;
    const sizes = allSizes.filter(s => s.itemCode === item.code).sort((a,b) => a.size - b.size);
    item.qty = sizes.reduce((t,s) => t + (s.qty||0), 0);
    item._sizeSummary = sizes.filter(s=>s.qty>0).map(s => {
      const sc = s.qty <= OUT_STOCK_LEVEL ? 'out' : s.qty <= LOW_STOCK_LEVEL ? 'low' : '';
      return '<span class="shoe-size-chip' + (sc?' '+sc:'') + '">' + s.size + '×' + s.qty + '</span>';
    }).join('');
  }
}

// ── SHOE ADD FORM GLOBALS ─────────────────────────────────────────
// _shoeSizes and _shownGroups are now properties of _shoeState instance
let _isShoeSale   = false;
let _sellShoeItem = null;
let _sellShoeSize = null;

// Called when type dropdown changes
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

function _getGroupSizes(g) {
  const groups = getShoeGroups();
  if (!groups[g]) return [];
  const { min, max } = groups[g];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

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
    block.style.marginBottom = '10px';

    const label = document.createElement('div');
    label.className = 'sz-group-divider';
    label.innerHTML = '<span class="sz-group-tag sz-group-' + g + '" style="cursor:pointer;">' +
      (g==='S'?'Small / Children':g==='M'?'Medium / Teens':'Large / Adults') +
      ' (' + min + '–' + max + ') ✕</span>';
    label.onclick = () => deselectSizeGroup(g);
    block.appendChild(label);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
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

// Switch between Shared (all sizes) and Per-Size pricing modes
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

// Keep old togglePerSizeMode as alias so any lingering calls don't break
function togglePerSizeMode() { setShoeMode(_shoeState.perSizeMode ? 'shared' : 'persize'); }

// Save shoe items: one parent + one shoe_sizes record per size
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
      type, category: _shoeState.group, isShoe: true,
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
  }

  if (perSizeErrors.length) toast('⚠️ Skipped: ' + perSizeErrors.join(' · '), 'err');
  if (saved === 0) { toast('⚠️ No sizes saved — fill all required fields', 'err'); return false; }

  const allSz = await getShoeSizes(baseCode);
  product.qty = allSz.reduce((t, s) => t + s.qty, 0);
  await dbPut('items', product);
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


// ===================================================================
// HISTORY PAGE — automated daily timeline
// Replaces the old "Day" tab. No manual open/close.
// Groups all sales and activities by calendar date automatically.
// ===================================================================

async function renderHistoryPage() {
  const today     = todayDateStr();
  const todayFull = new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  // Set today header
  UI.setText('hist-today-date', todayFull);

  // All data
  const allSales    = await dbAll('sales');
  const allFinances = await dbAll('finances');

  // Today's sales
  const todaySales = allSales.filter(s => (s.businessDate || s.date?.slice(0,10)) === today);
  const todayRev   = todaySales.reduce((s,x) => s + x.revenue, 0);
  const todayProf  = todaySales.reduce((s,x) => s + x.profit, 0);

  UI.setText('hist-today-revenue', fmt(todayRev));
  UI.setText('hist-today-profit',  fmt(todayProf));
  UI.setText('hist-today-sales',   todaySales.length);

  // Today sales list
  const todayList = UI.el('hist-today-list');
  if (todayList) {
    if (!todaySales.length) {
      todayList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No sales today yet.</div>';
    } else {
      const sorted = [...todaySales].sort((a,b) => new Date(b.date) - new Date(a.date));
      todayList.innerHTML = sorted.map(s => `
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
            <div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(s.revenue)}</div>
            <div style="font-size:11px;color:var(--green);font-family:var(--mono);">+${fmt(s.profit)}</div>
          </div>
        </div>`).join('');
    }
  }

  // Past records grouped by date
  const filterEl = UI.el('hist-period-filter');
  const days     = filterEl ? parseInt(filterEl.value) || 999 : 30;
  const cutoff   = new Date();
  if (!isNaN(days)) cutoff.setDate(cutoff.getDate() - days);

  // Group sales by date (excluding today)
  const byDate = {};
  allSales.forEach(s => {
    const d = s.businessDate || s.date?.slice(0,10) || today;
    if (d === today) return; // today shown separately
    if (!isNaN(days) && new Date(d) < cutoff) return;
    if (!byDate[d]) byDate[d] = { sales: [], revenue: 0, profit: 0 };
    byDate[d].sales.push(s);
    byDate[d].revenue += s.revenue;
    byDate[d].profit  += s.profit;
  });

  const datesSorted = Object.keys(byDate).sort((a,b) => b.localeCompare(a));
  const recList = UI.el('hist-records-list');
  if (recList) {
    if (!datesSorted.length) {
      recList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:16px 0;text-align:center;">No historical records in this period.</div>';
    } else {
      recList.innerHTML = datesSorted.map(date => {
        const day   = byDate[date];
        const label = new Date(date + 'T12:00:00').toLocaleDateString('en-GB',
                      { weekday:'short', day:'numeric', month:'short', year:'numeric' });
        const rows  = [...day.sales]
          .sort((a,b) => new Date(b.date) - new Date(a.date))
          .slice(0, 5)
          .map(s => `
            <div class="hist-sale-row" style="border-top:1px solid var(--border);">
              <div style="flex:1;min-width:0;">
                <div style="font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${escapeHtml(s.itemName||s.itemCode||'Item')}${s.itemSize?' · Sz'+escapeHtml(s.itemSize):''}
                </div>
                <div style="font-size:10px;color:var(--muted);">${s.qty} × ${fmt(s.actualPrice||s.sellPrice||0)} · ${fmtTime(s.date)}</div>
              </div>
              <div style="text-align:right;flex-shrink:0;font-size:12px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(s.revenue)}</div>
            </div>`).join('');
        const more  = day.sales.length > 5
          ? `<div style="font-size:11px;color:var(--muted);padding:6px 0;text-align:center;">+${day.sales.length-5} more sales</div>` : '';

        return `
          <div class="hist-day-card">
            <div class="hist-day-header">
              <div>
                <div style="font-size:14px;font-weight:800;">${label}</div>
                <div style="font-size:11px;color:var(--muted);">${day.sales.length} sale${day.sales.length!==1?'s':''}</div>
              </div>
              <div style="text-align:right;">
                <div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">${fmt(day.revenue)}</div>
                <div style="font-size:11px;color:var(--green);font-family:var(--mono);">+${fmt(day.profit)}</div>
              </div>
            </div>
            ${rows}${more}
          </div>`;
      }).join('');
    }
  }
}
window.renderHistoryPage = renderHistoryPage;

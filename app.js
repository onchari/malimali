// ===== DB =====
const DB_NAME = 'InventoryApp';
let db;
// ── CHECK SESSION IMMEDIATELY (before DB opens) ──────────────────────
// This prevents the login screen from flashing on refresh.
// We do a quick localStorage check — full validation happens after DB.
(function() {
  const saved = localStorage.getItem('mg_session');
  if (!saved) {
    // No session at all — show login right away
    document.getElementById('login-screen').style.display = 'flex';
  }
  // If session exists, login screen stays hidden until DB validates it
})();


const DB_VER = 6;

function initDB() {
  const req = indexedDB.open(DB_NAME, DB_VER);
  req.onupgradeneeded = e => {
    const d = e.target.result;
    e.target.transaction.onerror = ev => console.error('[DB] Upgrade error:', ev);
    if (!d.objectStoreNames.contains('items')) {
      const s = d.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
      s.createIndex('code', 'code', { unique: true });
      s.createIndex('type', 'type', { unique: false });
    }
    if (!d.objectStoreNames.contains('types')) {
      d.createObjectStore('types', { keyPath: 'id', autoIncrement: true });
    }
    if (!d.objectStoreNames.contains('sales')) {
      const ss = d.createObjectStore('sales', { keyPath: 'id', autoIncrement: true });
      ss.createIndex('itemId', 'itemId', { unique: false });
      ss.createIndex('date', 'date', { unique: false });
    }
    if (!d.objectStoreNames.contains('day_sessions')) {
      d.createObjectStore('day_sessions', { keyPath: 'id', autoIncrement: true });
    }
    if (!d.objectStoreNames.contains('business_days')) {
      const bds = d.createObjectStore('business_days', { keyPath: 'id', autoIncrement: true });
      bds.createIndex('business_date', 'business_date', { unique: false }); // non-unique: supports parallel sessions
      bds.createIndex('status', 'status', { unique: false });
    }

  };
  req.onsuccess = e => {
    db = e.target.result;
    loadTypes().then(async () => {
      updateCurrencyUI();
      loadShoeGroupSettings(); // populate S/M/L range labels in add form
      // 1. Restore session FIRST (before any page rendering)
      const sessionRestored = checkSession();
      if (!sessionRestored) return; // login screen showing, stop here

      // 2. Load all data
      await loadActiveDay();
      renderDashboard();
      renderList();
      renderSummary();
      renderSellPage();
      updateLowStockBadge();

      // 3. Restore last visited page (or go to day if day not open)
      const lastPage = localStorage.getItem('mg_last_page') || 'dash';
      const today = todayDateStr();

      // Check if day needs opening
      const bday = await getBusinessDay(today);
      const dayOpen = bday && bday.status === 'OPEN';

      if (!dayOpen && lastPage !== 'day' && lastPage !== 'settings') {
        // Show a gentle reminder but stay on last page
        setTimeout(() => toast('⚠️ Business day not open yet', ''), 1000);
      }

      // Restore last page — respect both role and day-state restrictions
      let allowedPage = currentUser && currentUser.tabs.includes(lastPage) ? lastPage : currentUser.tabs[0];
      if (DAY_REQUIRED_PAGES.includes(allowedPage) && !dayOpen) {
        allowedPage = 'day'; // redirect to day if page needs open day
      }
      _doShowPage(allowedPage);
    });
  };
  req.onerror = e => { console.error('[DB] Open error:', e); toast('Database error — try refreshing the page.', 'err'); };
}

// DB ready check — called before every transaction
function _dbReady(rej) {
  if (!db) {
    const err = new Error('Database not ready yet — please wait a moment.');
    console.error('[DB]', err.message);
    if (rej) rej(err);
    return false;
  }
  return true;
}

function dbAll(store) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx = db.transaction(store, 'readonly');
      tx.objectStore(store).getAll().onsuccess = e => res(e.target.result);
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
      const tx = db.transaction(store, 'readwrite');
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
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(data).onsuccess = res;
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}
function dbDelete(store, id) {
  return new Promise((res, rej) => {
    if (!_dbReady(rej)) return;
    try {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(id).onsuccess = res;
      tx.onerror = e => rej(e.target.error);
    } catch(e) { rej(e); }
  });
}

// ===== STATE =====
let types = [];
let allItems = [];
let activeTypeFilter = 'all';
let selectedEmoji = '📦';
let currency = localStorage.getItem('inv_currency') || 'KES';
let currentDetailId = null;

// ===== HELPERS =====
function fmt(n) {
  const v = Number(n || 0);
  return currency + ' ' + v.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtN(n) { return Number(n || 0).toLocaleString(); }
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
// Pages that require OPEN day to access
const DAY_REQUIRED_PAGES = ['dash', 'add'];

function showPage(id) {
  // Role restriction
  if (currentUser && !currentUser.tabs.includes(id)) {
    toast('⛔ Access denied', 'err');
    return;
  }
  // Day restriction — redirect to Day tab if page needs open day
  if (DAY_REQUIRED_PAGES.includes(id) && !isDayOpen()) {
    _doShowPage('day');
    return;
  }
  _doShowPage(id);
}

function _doShowPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const page = document.getElementById('page-' + id);
  const tab  = document.getElementById('tab-' + id);
  if (page) page.classList.add('active');
  if (tab)  tab.classList.add('active');
  if (id === 'dash')     renderDashboard();
  if (id === 'list')     renderList();
  if (id === 'sell')     { renderSellPage(); setTimeout(() => { const el = document.getElementById('sell-search'); if (el) el.focus(); }, 150); }
  if (id === 'day')      refreshDayTab();
  if (id === 'settings') { loadShoeGroupSettings(); renderTypesList(); }
  if (id === 'add')      onTypeChange();
  if (id === 'list' || id === 'day') {}  // always accessible
  // Save last visited page for session restore
  if (currentUser) localStorage.setItem('mg_last_page', id);
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
  const sel = document.getElementById('f-type');
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
  const buy  = parseFloat(document.getElementById('f-buy').value)  || 0;
  const sell = parseFloat(document.getElementById('f-sell').value) || 0;
  const qty  = parseInt(document.getElementById('f-qty').value)    || 0;
  const preview = document.getElementById('profit-preview');
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
// ===================================================================
// SHOE SIZE GROUP SETTINGS
// Stored in localStorage as mgs_shoe_groups: { S, M, L: { min, max } }
// Loaded into Settings page fields, previewed live, saved on button tap.
// ===================================================================

const SHOE_GROUP_DEFAULTS = { S:{min:20,max:28}, M:{min:29,max:36}, L:{min:37,max:45} };

function getShoeGroups() {
  const saved = localStorage.getItem('mgs_shoe_groups');
  if (!saved) return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  try { return JSON.parse(saved); } catch(e) { return JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS)); }
}

// Populate settings inputs from stored values
function loadShoeGroupSettings() {
  const g = getShoeGroups();
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  set('sg-s-min', g.S.min); set('sg-s-max', g.S.max);
  set('sg-m-min', g.M.min); set('sg-m-max', g.M.max);
  set('sg-l-min', g.L.min); set('sg-l-max', g.L.max);
  previewShoeGroups();
}

// Live preview: show which sizes each group contains
function previewShoeGroups() {
  const get = id => parseInt(document.getElementById(id)?.value) || 0;
  const groups = {
    S: { min: get('sg-s-min'), max: get('sg-s-max') },
    M: { min: get('sg-m-min'), max: get('sg-m-max') },
    L: { min: get('sg-l-min'), max: get('sg-l-max') },
  };
  const el = document.getElementById('shoe-group-preview');
  if (!el) return;
  let valid = true;
  const lines = Object.entries(groups).map(([g, { min, max }]) => {
    if (!min || !max || min > max) { valid = false; return `${g}: ⚠️ invalid range`; }
    const count = max - min + 1;
    const sizes = Array.from({length: Math.min(count, 10)}, (_, i) => min + i);
    return `${g} (${count} sizes): ${sizes.join(', ')}${count > 10 ? '…' + max : ''}`;
  });
  el.innerHTML = lines.join('<br>');
  el.style.color = valid ? 'var(--text2)' : 'var(--red)';
}

// Save customized groups to localStorage
function saveShoeGroups() {
  const get = id => parseInt(document.getElementById(id)?.value) || 0;
  const groups = {
    S: { min: get('sg-s-min'), max: get('sg-s-max') },
    M: { min: get('sg-m-min'), max: get('sg-m-max') },
    L: { min: get('sg-l-min'), max: get('sg-l-max') },
  };

  // Validate each group
  for (const [g, { min, max }] of Object.entries(groups)) {
    if (!min || !max) { toast('⚠️ Group ' + g + ': enter both min and max', 'err'); return; }
    if (min >= max)   { toast('⚠️ Group ' + g + ': min must be less than max', 'err'); return; }
    if (max - min > 30){ toast('⚠️ Group ' + g + ': range too large (max 30 sizes)', 'err'); return; }
  }

  // Save to localStorage
  localStorage.setItem('mgs_shoe_groups', JSON.stringify(groups));

  // ── Update Add form immediately ─────────────────────────────────

  // 1. Update S/M/L button range labels
  ['S','M','L'].forEach(g => {
    const el = document.getElementById('sg-range-' + g);
    if (el) el.textContent = groups[g].min + '–' + groups[g].max;
  });

  // 2. If a group is already selected in the add form, re-render sizes
  //    and clear any selected sizes that are now out of the new range
  if (_shoeGroup && groups[_shoeGroup]) {
    const { min, max } = groups[_shoeGroup];

    // Remove selected sizes that are outside new range
    _shoeSizes.forEach(s => { if (s < min || s > max) _shoeSizes.delete(s); });

    // Re-render the size buttons grid
    const grid = document.getElementById('sz-grid');
    if (grid) {
      const sizes = Array.from({ length: max - min + 1 }, (_, i) => min + i);
      grid.innerHTML = sizes.map(s =>
        '<button type="button" class="sz-btn' + (_shoeSizes.has(s) ? ' sz-active' : '') +
        '" id="sz-' + s + '" onclick="toggleShoeSize(' + s + ')">' + s + '</button>'
      ).join('');
    }

    // Update shared fields visibility
    const wrap = document.getElementById('shoe-rows-wrap');
    if (wrap) wrap.style.display = _shoeSizes.size > 0 ? 'block' : 'none';
    renderShoeSummary();
  }

  // 3. Update live preview in settings (already shown but refresh)
  previewShoeGroups();

  toast('✅ Shoe size groups saved!', 'ok');
}

function resetShoeGroups() {
  localStorage.removeItem('mgs_shoe_groups');
  // Reset any shoe selection in the add form
  _shoeGroup = null;
  _shoeSizes.clear();
  // Reload settings fields with defaults
  loadShoeGroupSettings();
  // Refresh add form group buttons range labels
  const defaults = JSON.parse(JSON.stringify(SHOE_GROUP_DEFAULTS));
  ['S','M','L'].forEach(g => {
    const el = document.getElementById('sg-range-' + g);
    if (el) el.textContent = defaults[g].min + '–' + defaults[g].max;
  });
  // Hide size grid and shared fields if open
  const szGrid = document.getElementById('shoe-sizes-grid');
  const szWrap = document.getElementById('shoe-rows-wrap');
  if (szGrid) szGrid.style.display = 'none';
  if (szWrap) szWrap.style.display = 'none';
  toast('↺ Reset to defaults (S:20–28, M:29–36, L:37–45)', 'ok');
}

// Call loadShoeGroupSettings when settings tab is opened

// When type is footwear, replace single size field with interactive
// S/M/L group picker → individual size buttons → per-size qty+price
// Each selected size saves as a separate inventory item.
// ===================================================================

// Default size group ranges (customisable via Settings in future)
function getShoeGroups() {
  const saved = localStorage.getItem('mgs_shoe_groups');
  return saved ? JSON.parse(saved) : { S:{min:20,max:28}, M:{min:29,max:36}, L:{min:37,max:45} };
}

function isFootwearType(typeName) {
  return typeName && (typeName.toLowerCase().includes('shoe') ||
                      typeName.toLowerCase().includes('footwear') ||
                      typeName.toLowerCase().includes('sandal') ||
                      typeName.toLowerCase().includes('boot'));
}

// Called when type selector changes — switches between standard and shoe mode
function onTypeChange() {
  const typeEl   = document.getElementById('f-type');
  const type     = typeEl ? typeEl.value : '';
  const shoePanel  = document.getElementById('shoe-size-panel');
  const stdPricing = document.getElementById('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  if (!shoePanel || !stdPricing) return;

  const isShoe = isFootwearType(type);

  shoePanel.style.display  = isShoe ? 'block' : 'none';
  stdPricing.style.display = isShoe ? 'none'  : 'block';
  if (sizeField) sizeField.style.display = isShoe ? 'none' : 'block';

  if (isShoe) {
    _shoeGroup = null;
    _shoeSizes.clear();
    _shoeData  = {};
    renderShoeGroups();
    const szGrid = document.getElementById('shoe-sizes-grid');
    const szWrap = document.getElementById('shoe-rows-wrap');
    if (szGrid) szGrid.style.display = 'none';
    if (szWrap) szWrap.style.display = 'none';
  }
}

let _shoeGroup = null;       // 'S' | 'M' | 'L'
let _shoeSizes = new Set();  // Set of selected size numbers
let _shoeData  = {};         // { size: { qty, buy, sell } }

function renderShoeGroups() {
  const groups = getShoeGroups();
  ['S','M','L'].forEach(g => {
    const rng = document.getElementById('sg-range-' + g);
    if (rng) rng.textContent = groups[g].min + '–' + groups[g].max;
    const btn = document.querySelector(`.sg-btn[onclick="selectSizeGroup('${g}')"]`);
    if (btn) btn.classList.toggle('sg-active', _shoeGroup === g);
  });
}

function selectSizeGroup(g) {
  _shoeGroup = g;
  _shoeSizes.clear();
  renderShoeGroups();

  const groups = getShoeGroups();
  const { min, max } = groups[g];
  const sizes = Array.from({ length: max - min + 1 }, (_, i) => min + i);

  const grid = document.getElementById('sz-grid');
  grid.innerHTML = sizes.map(s =>
    `<button type="button" class="sz-btn" id="sz-${s}" onclick="toggleShoeSize(${s})">${s}</button>`
  ).join('');
  document.getElementById('shoe-sizes-grid').style.display = 'block';
  document.getElementById('shoe-rows-wrap').style.display  = 'none';
}

function toggleShoeSize(s) {
  if (_shoeSizes.has(s)) _shoeSizes.delete(s);
  else _shoeSizes.add(s);

  // Update button active state
  document.querySelectorAll('.sz-btn').forEach(b => {
    const sz = parseInt(b.textContent);
    b.classList.toggle('sz-active', _shoeSizes.has(sz));
  });

  // Show/hide shared fields
  const wrap = document.getElementById('shoe-rows-wrap');
  if (wrap) wrap.style.display = _shoeSizes.size > 0 ? 'block' : 'none';

  // Update selected sizes summary pill
  renderShoeSummary();
}

function renderShoeSummary() {
  const el = document.getElementById('shoe-selected-summary');
  if (!el) return;
  if (_shoeSizes.size === 0) { el.innerHTML = ''; return; }
  const sorted = [..._shoeSizes].sort((a, b) => a - b);
  el.innerHTML = '<div class="shoe-pills-row">' +
    sorted.map(s => `<span class="shoe-pill">${s}</span>`).join('') +
    `<span style="font-size:11px;color:var(--muted);margin-left:6px;align-self:center;">${sorted.length} size${sorted.length>1?'s':''} selected</span>` +
    '</div>';
}

function saveShoeFieldData() {} // no-op — shared fields read directly in saveShoeItems

// Save one item per selected shoe size, all with same qty/buy/sell
async function saveShoeItems(baseCode, baseName, type) {
  if (!_shoeGroup)           { toast('⚠️ Select a size group (S/M/L)', 'err'); return false; }
  if (_shoeSizes.size === 0) { toast('⚠️ Select at least one size', 'err'); return false; }

  const qty  = parseInt(document.getElementById('shoe-shared-qty').value)   || 0;
  const buy  = parseFloat(document.getElementById('shoe-shared-buy').value) || 0;
  const sell = parseFloat(document.getElementById('shoe-shared-sell').value)|| 0;

  if (qty <= 0)  { toast('⚠️ Enter quantity per size', 'err'); return false; }
  if (buy <= 0)  { toast('⚠️ Enter buying price', 'err'); return false; }
  if (sell <= 0) { toast('⚠️ Enter selling price', 'err'); return false; }

  const profit = sell - buy;
  const sorted = [..._shoeSizes].sort((a, b) => a - b);
  let savedCount = 0;

  for (const size of sorted) {
    const item = {
      type,
      code: baseCode + '-' + size,
      name: (baseName || type + ' ' + baseCode) + ' (Size ' + size + ')',
      size: String(size),
      sizeGroup: _shoeGroup,
      qty, buy, sell, profit,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const newId = await dbAdd('items', item);
      item.id = newId;
      if (_addFormPhotoData) setItemPhoto(newId, _addFormPhotoData);
      fbSyncItem(item);
      savedCount++;
    } catch(e) {
      toast('⚠️ Size ' + size + ': ' + e.message, 'err');
    }
  }
  return savedCount;
}

// ===================================================================
// SAVE ITEM — handles both regular and shoe/footwear items
// ===================================================================
async function saveItem() {
  const editId = document.getElementById('edit-id').value;
  const type   = document.getElementById('f-type').value;
  const code   = document.getElementById('f-code').value.trim().toUpperCase();
  const name   = document.getElementById('f-name').value.trim();

  if (!requireOpenDay()) return;
  if (!type) { toast('⚠️ Select an item type', 'err'); return; }
  if (!code) { toast('⚠️ Enter item code', 'err'); return; }

  // ── SHOE MODE ────────────────────────────────────────────────────
  if (isFootwearType(type) && !editId) {
    const savedCount = await saveShoeItems(code, name, type);
    if (!savedCount) return;
    clearForm();
    clearAddFormPhoto();
    allItems = await dbAll('items');
    renderList();
    renderDashboard();
    updateHeader();
    scheduleSync();
    toast('✅ ' + savedCount + ' shoe size(s) added!', 'ok');
    if (activeDay) updateDayLiveStats();
    return;
  }

  // ── STANDARD MODE ────────────────────────────────────────────────
  const size   = document.getElementById('f-size').value.trim();
  const qtyRaw = document.getElementById('f-qty').value;
  const qty    = parseInt(qtyRaw);
  const buy    = parseFloat(document.getElementById('f-buy').value) || 0;
  const sell   = parseFloat(document.getElementById('f-sell').value) || 0;

  if (!size)   { toast('⚠️ Enter a size (or type N/A)', 'err'); return; }
  if (qtyRaw === '' || isNaN(qty) || qty < 0) { toast('⚠️ Enter quantity stocked', 'err'); return; }
  if (buy <= 0)  { toast('⚠️ Enter buying price', 'err'); return; }
  if (sell <= 0) { toast('⚠️ Enter selling price', 'err'); return; }

  const profit = sell - buy;
  const itemName = name || (type + ' ' + code);
  const item = { type, code, name: itemName, size, buy, sell, profit, qty, createdAt: new Date().toISOString() };

  try {
    if (editId) {
      item.id = parseInt(editId);
      await dbPut('items', item);
      fbSyncItem(item);
      toast('✅ Item updated!', 'ok');
      clearForm();
      allItems = await dbAll('items');
      renderList(); renderDashboard(); updateHeader();
      showPage('list');
    } else {
      const newId = await dbAdd('items', item);
      item.id = newId;
      if (_addFormPhotoData) setItemPhoto(newId, _addFormPhotoData);
      fbSyncItem(item);
      clearForm(); clearAddFormPhoto();
      allItems = await dbAll('items');
      renderList(); renderDashboard(); updateHeader();
      showSplash(itemName, sell, profit);
      if (activeDay) updateDayLiveStats();
    }
    scheduleSync();
  } catch (e) {
    if (e.name === 'ConstraintError') toast('Code "' + code + '" already exists!', 'err');
    else toast('Error saving: ' + e.message, 'err');
  }
}

function clearForm() {
  document.getElementById('edit-id').value   = '';
  document.getElementById('f-type').value    = '';
  document.getElementById('f-code').value    = '';
  document.getElementById('f-name').value    = '';
  document.getElementById('f-size').value    = '';
  document.getElementById('f-qty').value     = '';
  document.getElementById('f-buy').value     = '';
  document.getElementById('f-sell').value    = '';
  document.getElementById('profit-preview').style.display = 'none';
  document.getElementById('save-btn').textContent = '+ Add to Inventory';
  document.getElementById('form-mode-label').textContent  = 'New Item';
  document.getElementById('cancel-edit-btn').style.display = 'none';
  // Reset shoe state
  _shoeGroup = null; _shoeSizes.clear(); _shoeData = {};
  const shoePanel  = document.getElementById('shoe-size-panel');
  const stdPricing = document.getElementById('std-pricing-section');
  const sizeField  = document.getElementById('f-size-field');
  if (shoePanel)  shoePanel.style.display  = 'none';
  if (stdPricing) stdPricing.style.display = 'block';
  if (sizeField)  sizeField.style.display  = 'block';
  // Clear shared shoe inputs
  const sqty  = document.getElementById('shoe-shared-qty');
  const sbuy  = document.getElementById('shoe-shared-buy');
  const ssell = document.getElementById('shoe-shared-sell');
  const ssum  = document.getElementById('shoe-selected-summary');
  const swrap = document.getElementById('shoe-rows-wrap');
  const sgrid = document.getElementById('shoe-sizes-grid');
  if (sqty)  sqty.value  = '';
  if (sbuy)  sbuy.value  = '';
  if (ssell) ssell.value = '';
  if (ssum)  ssum.innerHTML = '';
  if (swrap) swrap.style.display = 'none';
  if (sgrid) sgrid.style.display = 'none';
}

function cancelEdit() { clearForm(); clearAddFormPhoto(); showPage('list'); }

// ===== RENDER LIST =====
async function renderList() {
  allItems = await dbAll('items');
  const search = (document.getElementById('search').value || '').toLowerCase();
  renderTypeChips();

  let filtered = allItems.filter(item => {
    const matchSearch = !search ||
      item.name.toLowerCase().includes(search) ||
      item.code.toLowerCase().includes(search) ||
      (item.size || '').toLowerCase().includes(search) ||
      item.type.toLowerCase().includes(search);
    const matchType = activeTypeFilter === 'all' || item.type === activeTypeFilter;
    return matchSearch && matchType;
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // newest first

  updateHeader();

  const list = document.getElementById('item-list');
  if (!filtered.length) {
    list.innerHTML = `<div class="empty"><div class="e-icon">${allItems.length ? '🔍' : '📦'}</div><p>${allItems.length ? 'No items match your search.' : 'No items yet.\nTap ➕ Add Item to get started.'}</p></div>`;
    return;
  }

  // Get sales data for profit calculations
  const allSales = await dbAll('sales');
  const salesByItem = {};
  allSales.forEach(s => {
    if (!salesByItem[s.itemId]) salesByItem[s.itemId] = { revenue: 0, profit: 0, qty: 0 };
    salesByItem[s.itemId].revenue += s.revenue;
    salesByItem[s.itemId].profit += s.profit;
    salesByItem[s.itemId].qty += s.qty;
  });

  list.innerHTML = filtered.map(item => {
    const t = getTypeObj(item.type);
    const stockColor = item.qty === 0 ? 'tag-red' : item.qty <= 3 ? 'tag-amber' : 'tag-green';
    const stockLabel = item.qty === 0 ? '✕ Out' : item.qty + ' pcs';
    const itemSales = salesByItem[item.id] || { profit: 0, qty: 0 };
    const soldQty = itemSales.qty;
    return `<div class="item-card" onclick="openSheet(${item.id})">
      <div class="item-top">
        <div class="item-icon" style="background:${t.color || 'var(--surface2)'};">${t.emoji}</div>
        <div class="item-body">
          <div class="item-code">${item.code}${item.size ? ' · ' + item.size : ''}</div>
          <div class="item-name">${item.name || ''}</div>
          <div class="item-tags">
            <span class="tag tag-cyan">${item.type}</span>
            <span class="tag tag-gray">${soldQty} sold</span>
            <span class="tag ${stockColor}">${stockLabel}</span>
          </div>
        </div>
        <div class="item-right">
          <div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">Sell: ${fmt(item.sell)}</div>
          <div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">Buy: ${fmt(item.buy)}</div>
          <div style="font-size:11px;color:var(--accent);font-family:var(--mono);margin-top:2px;">${item.qty} in store</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ===== DETAIL SHEET =====

function openSellFromSheet() {
  if (!isDayOpen()) {
    toast('⚠️ Open the business day to make sales.', 'err');
    return;
  }
  const id = currentDetailId;
  closeSheet();
  setTimeout(() => openSellModal(id), 150);
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

  // Out of stock
  const outBadge = document.getElementById('sh-out-badge');
  const sellBtn = document.getElementById('sh-sell-btn');
  if (item.qty <= 0) {
    if (outBadge) outBadge.style.display = 'block';
    if (sellBtn) { sellBtn.disabled = true; sellBtn.style.opacity = '0.4'; sellBtn.style.cursor = 'not-allowed'; sellBtn.textContent = 'OUT OF STOCK'; }
  } else {
    if (outBadge) outBadge.style.display = 'none';
    if (sellBtn) { sellBtn.disabled = false; sellBtn.style.opacity = '1'; sellBtn.style.cursor = 'pointer'; sellBtn.textContent = 'SELL'; }
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
  if (!isDayOpen()) { toast('⚠️ Open the business day to edit items.', 'err'); return; }
  const item = await dbGet('items', currentDetailId);
  closeSheet();
  showPage('add');
  document.getElementById('edit-id').value = item.id;
  document.getElementById('f-type').value = item.type;
  document.getElementById('f-code').value = item.code;
  document.getElementById('f-name').value = item.name;
  document.getElementById('f-size').value = item.size || '';
  document.getElementById('f-qty').value = item.qty;
  document.getElementById('f-buy').value = item.buy;
  document.getElementById('f-sell').value = item.sell;
  document.getElementById('save-btn').textContent = '💾 Save Changes';
  document.getElementById('form-mode-label').textContent = 'Edit Item';
  document.getElementById('cancel-edit-btn').style.display = 'block';
  updateProfitPreview();
  // Load existing photo if any
  const existingPhoto = getItemPhoto(item.id);
  if (existingPhoto) {
    _addFormPhotoData = existingPhoto;
    const photoImg = document.getElementById('add-photo-img');
    const placeholder = document.getElementById('add-photo-placeholder');
    const removeBtn = document.getElementById('add-photo-remove');
    if (photoImg) { photoImg.src = existingPhoto; photoImg.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'block';
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
  document.getElementById('sm-profit').textContent = (item.profit >= 0 ? '+' : '') + fmt(item.profit);
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
  if (!requireOpenDay()) return;
  const item = await dbGet('items', currentSellItemId);
  const qty = Math.max(1, parseInt(document.getElementById('sm-qty').value) || 1);
  if (qty > item.qty) { toast('⚠️ Not enough stock!', 'err'); return; }
  const actualRaw = parseFloat(document.getElementById('sm-actual').value);
  const priceUsed = (!isNaN(actualRaw) && actualRaw > 0) ? actualRaw : item.sell;
  if (priceUsed <= 0) { toast('⚠️ No selling price set on this item', 'err'); return; }

  const sale = {
    itemId: item.id, itemName: item.name, itemCode: item.code,
    type: item.type, size: item.size || '',
    qty, buyPrice: item.buy, sellPrice: item.sell, actualPrice: priceUsed,
    revenue: qty * priceUsed,
    profit: qty * (priceUsed - item.buy),
    overridden: !isNaN(actualRaw) && actualRaw > 0 && actualRaw !== item.sell,
    business_date: activeDay ? activeDay.business_date : todayDateStr(),
    date: new Date().toISOString()
  };

  item.qty -= qty;
  await dbPut('items', item);
  await dbAdd('sales', sale);
  fbSyncItem(item);
  fbSyncSale(sale);
  updateLowStockBadge();
  scheduleSync();

  closeSellModal();
  document.getElementById('sell-search').value = '';
  document.getElementById('sell-results').innerHTML = '';

  toast('✅ Sale: ' + fmt(sale.revenue) + ' · Profit: ' + fmt(sale.profit), 'ok');
  renderSellPage();
  renderDashboard();
  renderList();
  updateHeader();
  if (activeDay) updateDayLiveStats();
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

// ===== FIREBASE SYNC =====
let fbApp = null, fbDb = null, fbUnsub = null;
let fbReady = false;
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
  const config = FIREBASE_CONFIG;
  localStorage.setItem('fb_config', JSON.stringify(config));
  try {
    setFbStatus('connecting');
    console.log('[FB] Waiting for Firebase SDK...');
    const { initializeApp, getApps, getApp, getFirestore, onSnapshot, collection } =
      await waitForFbImports();
    console.log('[FB] SDK ready. Initialising app...');

    // Reuse existing Firebase app instance to avoid "duplicate app" error
    const existingApps = getApps();
    const existing = existingApps.find(a => a.name === 'mandela');
    fbApp = existing ? getApp('mandela') : initializeApp(config, 'mandela');
    fbDb  = getFirestore(fbApp);
    fbReady = true;
    console.log('[FB] Firestore ready. Project:', config.projectId);

    // Tear down old listeners before attaching new ones
    if (fbUnsub) { fbUnsub(); fbUnsub = null; }
    if (window._fbUnsubSales) { window._fbUnsubSales(); window._fbUnsubSales = null; }

    // ── Live listener: items ──────────────────────────────────────
    const unsubItems = onSnapshot(
      collection(fbDb, 'items'),
      async snap => {
        const changes = snap.docChanges();
        if (!changes.length) return;
        let needsRender = false;
        for (const change of changes) {
          const data = { ...change.doc.data(), fbId: change.doc.id };
          if (change.type === 'removed') {
            const all = await dbAll('items');
            const local = all.find(i => i.fbId === change.doc.id);
            if (local) { await dbDelete('items', local.id); needsRender = true; }
          } else {
            const all = await dbAll('items');
            const existing = all.find(i => i.fbId === change.doc.id || i.code === data.code);
            if (existing) {
              data.id = existing.id;
              await dbPut('items', { ...data });
            } else {
              try { const d2 = { ...data }; delete d2.id; await dbAdd('items', d2); } catch(_) {}
            }
            needsRender = true;
          }
        }
        if (needsRender) {
          allItems = await dbAll('items');
          renderList(); renderDashboard(); updateHeader();
          setFbStatus('on');
        }
      },
      err => {
        console.error('[FB] Items listener error:', err.code, err.message);
        setFbStatus('error');
        toast('Firebase sync error: ' + err.message, 'err');
      }
    );

    // ── Live listener: sales ──────────────────────────────────────
    const unsubSales = onSnapshot(
      collection(fbDb, 'sales'),
      async snap => {
        const changes = snap.docChanges();
        if (!changes.length) return;
        for (const change of changes) {
          const data = { ...change.doc.data(), fbId: change.doc.id };
          if (change.type === 'removed') {
            const all = await dbAll('sales');
            const local = all.find(s => s.fbId === change.doc.id);
            if (local) await dbDelete('sales', local.id);
          } else {
            const all = await dbAll('sales');
            const existing = all.find(s => s.fbId === change.doc.id);
            if (existing) { data.id = existing.id; await dbPut('sales', data); }
            else { try { delete data.id; await dbAdd('sales', data); } catch(_) {} }
          }
        }
        try { renderSellPage(); } catch(_) {}
        try { renderDashboard(); } catch(_) {}
      },
      err => { console.error('[FB] Sales listener error:', err.code, err.message); }
    );

    fbUnsub = unsubItems;
    window._fbUnsubSales = unsubSales;

    setFbStatus('on');
    toast('☁️ Firebase connected!', 'ok');
    console.log('[FB] Listeners attached. Running initial sync...');

    // Push local → Firebase, then pull Firebase → local
    await forcePushToFirebase(true);
    await pullFromFirebase(true);
    console.log('[FB] Initial sync complete.');

  } catch (e) {
    setFbStatus('error');
    console.error('[FB] Init error:', e.message, e);
    toast('Firebase error: ' + e.message, 'err');
    fbReady = false;
  }
}

function waitForFbImports() {
  return new Promise((res, rej) => {
    const start = Date.now();
    const check = () => {
      if (window._fbImports === null) {
        // Module explicitly failed — signal caller
        rej(new Error('Firebase SDK failed to load. Check your internet connection.'));
        return;
      }
      if (window._fbImports) {
        res(window._fbImports);
        return;
      }
      if (Date.now() - start > 15000) {
        rej(new Error('Firebase SDK timed out after 15s. Check your internet connection.'));
        return;
      }
      setTimeout(check, 150);
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
    // Generate stable fbId if not set
    if (!item.fbId) {
      item.fbId = 'item_' + (item.code || 'x').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now();
      await dbPut('items', item);
    }
    const data = { ...item, updatedAt: new Date().toISOString() };
    await setDoc(doc(fbDb, 'items', item.fbId), sanitiseForFirestore(data));
    console.log('[SYNC] Pushed item:', item.fbId);
  } catch (e) { console.error('[SYNC] fbSyncItem error:', e); }
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
      sale.fbId = 'sale_' + (sale.date || '').replace(/[:.TZ-]/g,'').slice(0,17) +
                  '_' + Math.random().toString(36).slice(2,6);
      if (sale.id) await dbPut('sales', sale); // persist fbId locally
    }
    await setDoc(doc(fbDb, 'sales', sale.fbId), sanitiseForFirestore({ ...sale }));
  } catch (e) { console.error('[SYNC] fbSyncSale error:', e.message); }
}


// ── SANITISE FOR FIRESTORE ─────────────────────────────────────────────
// Firestore rejects: undefined values, the numeric 'id' IDB key.
// Convert undefined → null, drop the local 'id' field.
function sanitiseForFirestore(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id') continue;          // IDB auto-increment key — not needed in Firestore
    if (v === undefined) { out[k] = null; continue; }
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = sanitiseForFirestore(v); // recurse into nested objects
    } else {
      out[k] = v;
    }
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
      if (!item.fbId) {
        item.fbId = 'itm_' + (item.code || 'x').toLowerCase().replace(/[^a-z0-9]/g,'') +
                    '_' + (item.size || 'ns').toLowerCase().replace(/[^a-z0-9]/g,'');
        await dbPut('items', item);
      }
      // Strip IDB-only key and sanitise for Firestore (no undefined values)
      const itemData = sanitiseForFirestore({ ...item, updatedAt: new Date().toISOString() });
      batch.set(doc(fbDb, 'items', item.fbId), itemData);
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    for (const sale of sales) {
      if (!sale.fbId) {
        sale.fbId = 'sale_' + (sale.date || '').replace(/[:.TZ-]/g,'').slice(0,17) +
                    '_' + Math.random().toString(36).slice(2,6);
        await dbPut('sales', sale);
      }
      const saleData = sanitiseForFirestore({ ...sale });
      batch.set(doc(fbDb, 'sales', sale.fbId), saleData);
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    await batch.commit();
    setFbStatus('on');
    if (!silent) toast('⬆️ Pushed ' + items.length + ' items + ' + sales.length + ' sales', 'ok');
  } catch (e) {
    setFbStatus('error');
    if (!silent) toast('Push failed: ' + e.message, 'err');
    console.error('Push error:', e);
  }
}

async function pullFromFirebase(silent = false) {
  if (!fbReady || !fbDb) {
    if (!silent) toast('⚠️ Not connected to Firebase', 'err');
    return;
  }
  if (!silent) setFbStatus('syncing');
  try {
    const { collection, getDocs } = await waitForFbImports();

    // ── Items ─────────────────────────────────────────────────────
    const itemSnap = await getDocs(collection(fbDb, 'items'));
    // Load local items ONCE before the loop
    let localItems = await dbAll('items');
    let itemsAdded = 0, itemsUpdated = 0;

    for (const d of itemSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      delete data.id; // remove Firestore numeric key — IDB assigns its own
      const existing = localItems.find(i => i.fbId === d.id || i.code === data.code);
      if (existing) {
        data.id = existing.id;
        await dbPut('items', data);
        // Update local cache so subsequent finds are correct
        const idx = localItems.findIndex(i => i.id === existing.id);
        if (idx >= 0) localItems[idx] = data;
        itemsUpdated++;
      } else {
        const newId = await dbAdd('items', data);
        data.id = newId;
        localItems.push(data);
        itemsAdded++;
      }
    }
    console.log('[SYNC] Items pulled — added:', itemsAdded, 'updated:', itemsUpdated);

    // ── Sales ─────────────────────────────────────────────────────
    const saleSnap = await getDocs(collection(fbDb, 'sales'));
    let localSales = await dbAll('sales');
    let salesAdded = 0, salesUpdated = 0;

    for (const d of saleSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      delete data.id;
      const existing = localSales.find(s => s.fbId === d.id);
      if (existing) {
        data.id = existing.id;
        await dbPut('sales', data);
        salesUpdated++;
      } else {
        const newId = await dbAdd('sales', data);
        data.id = newId;
        localSales.push(data);
        salesAdded++;
      }
    }
    console.log('[SYNC] Sales pulled — added:', salesAdded, 'updated:', salesUpdated);

    // ── Re-render ─────────────────────────────────────────────────
    allItems = await dbAll('items');
    renderList(); renderDashboard(); updateHeader();
    try { renderSellPage(); } catch(_) {}
    setFbStatus('on');

    if (!silent || itemSnap.size > 0 || saleSnap.size > 0) {
      if (!silent) toast('⬇️ Pulled ' + itemSnap.size + ' items, ' + saleSnap.size + ' sales', 'ok');
    }

  } catch (e) {
    setFbStatus('error');
    console.error('[SYNC] Pull error:', e.code || '', e.message, e);
    if (!silent) toast('Pull failed: ' + (e.message || e), 'err');
  }
}

function disconnectFirebase() {
  if (fbUnsub) { fbUnsub(); fbUnsub = null; }
  fbApp = null; fbDb = null; fbReady = false;
  localStorage.removeItem('fb_config');
  const cfgEl = document.getElementById('fb-config-input'); if (cfgEl) cfgEl.value = '';
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
      if (pageId === 'add') _doShowPage('day');
      if (pageId === 'dash' && !dashOk) _doShowPage('day');
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
// States: CLOSED → OPEN → CLOSED (cycle freely same day)
//         Past days → LOCKED at midnight (read-only)
//
// Rules:
//   • User can open/close freely within same calendar date
//   • Page refresh does NOT affect day state
//   • Timer runs once — not restarted on refresh/tab-switch
//   • Past days locked automatically at midnight
// ===================================================================

let activeDay      = null;
let dayCheckTimer  = null;
let _warned1145    = null;
let _timerStarted  = false; // guard: timer starts once, resets on date change

// ── LOCAL DATE HELPER (timezone-safe) ────────────────────────────────
function todayDateStr() {
  const d = new Date();
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2,'0') + '-' +
    String(d.getDate()).padStart(2,'0');
}
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
}
function fmtFullDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday:'long', day:'2-digit', month:'long', year:'numeric'
  });
}

// ── STATE CHECKS ─────────────────────────────────────────────────────
function isDayOpen() {
  return activeDay && activeDay.status === 'OPEN';
}

function requireOpenDay() {
  if (!isDayOpen()) {
    const status = activeDay ? activeDay.status : 'NONE';
    const msgs = {
      CLOSED: '🌙 Day is closed — tap Open Day to continue.',
      LOCKED: '🔒 This is an archived day (read-only).',
    };
    toast(msgs[status] || '📅 Open the business day first.', 'err');
    showPage('day');
    return false;
  }
  return true;
}

// ── DB HELPERS ───────────────────────────────────────────────────────
async function getBusinessDay(dateStr) {
  const all = await dbAll('business_days');
  return all.find(d => d.business_date === dateStr) || null;
}

async function createDayRecord(dateStr) {
  const id = await dbAdd('business_days', {
    business_date: dateStr,
    status: 'CLOSED',
    opened_at: null, closed_at: null,
    last_opened_at: null,
    reopened_count: 0,
    auto_closed: false,
    final_locked_at: null,
    salesCount: 0, revenue: 0, profit: 0, itemsSold: 0,
    openingStockCost: 0, openingStockRetail: 0,
    closingStockCost: 0,
    notes: ''
  });
  return await dbGet('business_days', id);
}

// ── LOAD DAY ON APP START ─────────────────────────────────────────────
// Called ONCE at startup. Does NOT restart on refresh if day is intact.
async function loadActiveDay() {
  const today = todayDateStr();

  // Lock any past days that weren't locked (e.g. app offline overnight)
  const all = await dbAll('business_days');
  for (const d of all) {
    if (d.business_date < today && d.status !== 'LOCKED') {
      d.status = 'LOCKED';
      d.final_locked_at = new Date().toISOString();
      await dbPut('business_days', d);
    }
  }

  // Get or create today's record
  let bday = await getBusinessDay(today);
  if (!bday) bday = await createDayRecord(today);

  // If app was left open and day was OPEN — keep it OPEN (do not reset)
  activeDay = bday;
  applyDayState(); // update UI without touching state
  if (_timerStarted === false) {
    _timerStarted = true;
    startDayTimer();
    startBannerClock();
  }
}

// ── REFRESH DAY TAB ───────────────────────────────────────────────────
// Called when user navigates to Day tab. Reads current state from DB.
// Does NOT restart timers or modify state.
async function refreshDayTab() {
  const today = todayDateStr();
  const bday = await getBusinessDay(today);
  if (bday) activeDay = bday;
  applyDayState();
  renderDaySessionsList();
}

// ── APPLY STATE TO UI ─────────────────────────────────────────────────
// Single function that syncs UI to current activeDay.status.
// Never modifies state — only reads it.
function applyDayState() {
  if (!activeDay) return;
  const isOpen = activeDay.status === 'OPEN';
  setDayMode(isOpen);
  updateDayBanner();
  if (isOpen) updateDayLiveStats();
}

// ── OPEN DAY ─────────────────────────────────────────────────────────
async function openDay() {
  const today = todayDateStr();
  let bday = await getBusinessDay(today);
  if (!bday) bday = await createDayRecord(today);

  if (bday.status === 'OPEN')   { toast('Day is already open!', 'err'); return; }
  if (bday.status === 'LOCKED') { toast('🔒 This day is archived — cannot reopen.', 'err'); return; }

  const isFirstOpen = !bday.opened_at;
  const isReopen    = !isFirstOpen;

  if (isFirstOpen) {
    // Snapshot opening stock on first open only
    const items = await dbAll('items');
    bday.openingStockCost   = items.reduce((s, i) => s + (i.buy  || 0) * (i.qty || 0), 0);
    bday.openingStockRetail = items.reduce((s, i) => s + (i.sell || 0) * (i.qty || 0), 0);
  }

  bday.status         = 'OPEN';
  bday.opened_at      = bday.opened_at || new Date().toISOString();
  bday.last_opened_at = new Date().toISOString();
  if (isReopen) bday.reopened_count = (bday.reopened_count || 0) + 1;

  await dbPut('business_days', bday);
  activeDay = bday;
  applyDayState();
  renderDaySessionsList();
  toast(isReopen ? '🔓 Day reopened — continue recording.' : '🌅 Business day opened!', 'ok');
  scheduleSync();
}

// ── CLOSE DAY (shows summary sheet) ──────────────────────────────────
async function closeDay() {
  if (!isDayOpen()) { toast('No open day to close.', 'err'); return; }
  await _buildAndShowSummary();
}

// ── BUILD SUMMARY SHEET ───────────────────────────────────────────────
async function _buildAndShowSummary() {
  const todayStr   = activeDay.business_date;
  const sales      = await dbAll('sales');
  const daySales   = sales.filter(s => s.business_date === todayStr);
  const items      = await dbAll('items');
  const todayStart = todayStr + 'T00:00:00';
  const purchases  = items.filter(i => i.createdAt && i.createdAt >= todayStart);

  const revenue    = daySales.reduce((s, x) => s + x.revenue, 0);
  const profit     = daySales.reduce((s, x) => s + x.profit, 0);
  const itemsSold  = daySales.reduce((s, x) => s + x.qty, 0);
  const closingStockCost = items.reduce((s, i) => s + (i.buy||0) * (i.qty||0), 0);
  const margin     = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;
  const avgSale    = daySales.length > 0 ? revenue / daySales.length : 0;
  const openT      = fmtTime(activeDay.opened_at);
  const nowT       = fmtTime(new Date().toISOString());

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('ds-date',          fmtFullDate(todayStr));
  set('ds-time-range',    openT + ' → ' + nowT);
  set('ds-revenue',       fmt(revenue));
  set('ds-profit',        fmt(profit));
  set('ds-margin',        margin + '%');
  set('ds-avg-sale',      fmt(avgSale));
  set('ds-sales',         daySales.length);
  set('ds-items-sold',    itemsSold);
  set('ds-custom-price',  daySales.filter(s => s.overridden).length);
  set('ds-opening-stock', fmt(activeDay.openingStockCost || 0));
  set('ds-closing-stock', fmt(closingStockCost));
  set('ds-purchases',     purchases.length);
  set('ds-purchases-val', fmt(purchases.reduce((s, i) => s + (i.buy||0) * (i.qty||0), 0)));

  // Stock movement bar
  const opening = activeDay.openingStockCost || 0;
  const pct = opening > 0 ? Math.min(100, Math.round(((opening - closingStockCost) / opening) * 100)) : 0;
  const bar = document.getElementById('ds-stock-bar');
  const lbl = document.getElementById('ds-stock-pct-label');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = pct + '%';

  // Performance verdict
  const verdictEl = document.getElementById('ds-verdict');
  if (verdictEl) {
    let verdict = '😴 Quiet day — ' + daySales.length + ' sales.';
    let vBg = 'var(--surface2)', vColor = 'var(--muted)';
    if (daySales.length > 0) {
      const m = parseFloat(margin);
      if      (m >= 30) { verdict = '🔥 Excellent day! ' + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else if (m >= 15) { verdict = '✅ Good day! '       + margin + '% margin.'; vBg = 'var(--green-light)'; vColor = 'var(--green)'; }
      else              { verdict = '👍 Decent day. '     + margin + '% margin.'; vBg = '#fef9c3'; vColor = '#92400e'; }
    }
    verdictEl.style.cssText = 'background:' + vBg + ';color:' + vColor + ';border:1px solid ' + vColor + ';border-radius:var(--r);padding:14px 16px;margin-bottom:14px;text-align:center;';
    verdictEl.innerHTML = '<div style="font-size:16px;font-weight:800;">' + verdict + '</div>';
  }

  const notes = document.getElementById('ds-notes');
  if (notes) notes.value = activeDay.notes || '';

  const confirmBtn = document.getElementById('ds-confirm-btn');
  const pauseBtn   = document.getElementById('ds-pause-btn');
  if (confirmBtn) { confirmBtn.style.display = 'block'; confirmBtn.textContent = '🌙 Confirm Close Day'; }
  if (pauseBtn)   pauseBtn.style.display = 'none';

  document.getElementById('day-summary-sheet').classList.add('open');
}

// ── CONFIRM CLOSE ─────────────────────────────────────────────────────
async function confirmCloseDay() {
  const notes    = (document.getElementById('ds-notes') || {}).value || '';
  const todayStr = activeDay.business_date;
  const sales    = await dbAll('sales');
  const daySales = sales.filter(s => s.business_date === todayStr);
  const items    = await dbAll('items');
  const todayStart = todayStr + 'T00:00:00';
  const purchases  = items.filter(i => i.createdAt && i.createdAt >= todayStart);

  activeDay.status           = 'CLOSED';
  activeDay.closed_at        = new Date().toISOString();
  activeDay.notes            = notes;
  activeDay.salesCount       = daySales.length;
  activeDay.revenue          = daySales.reduce((s, x) => s + x.revenue, 0);
  activeDay.profit           = daySales.reduce((s, x) => s + x.profit, 0);
  activeDay.itemsSold        = daySales.reduce((s, x) => s + x.qty, 0);
  activeDay.purchasesCount   = purchases.length;
  activeDay.purchaseCost     = purchases.reduce((s, i) => s + (i.buy||0)*(i.qty||0), 0);
  activeDay.closingStockCost = items.reduce((s, i) => s + (i.buy||0)*(i.qty||0), 0);

  await dbPut('business_days', activeDay);
  document.getElementById('day-summary-sheet').classList.remove('open');
  applyDayState();
  renderDaySessionsList();
  renderDashboard();
  _doShowPage('day');
  toast('🌙 Day closed. Tap Open Day anytime to continue.', 'ok');
  scheduleSync();
}

function cancelCloseDay() {
  document.getElementById('day-summary-sheet').classList.remove('open');
}

// ── TAB MODE ─────────────────────────────────────────────────────────
function setDayMode(isOpen) {
  // Dashboard: accessible when day is OPEN
  const dashBtn = document.getElementById('tab-dash');
  if (dashBtn && dashBtn.style.display !== 'none') {
    dashBtn.classList.toggle('disabled', !isOpen);
    if (!isOpen) dashBtn.classList.remove('active');
  }
  // Add: only when OPEN
  const addBtn = document.getElementById('tab-add');
  if (addBtn && addBtn.style.display !== 'none') {
    addBtn.classList.toggle('disabled', !isOpen);
    if (!isOpen) addBtn.classList.remove('active');
  }
  // Stock list: grayed but accessible (view-only when closed)
  const listBtn = document.getElementById('tab-list');
  if (listBtn && listBtn.style.display !== 'none') {
    listBtn.classList.toggle('disabled', !isOpen);
    if (!isOpen) listBtn.classList.remove('active');
  }
  // If closing while on a restricted page, redirect to Day tab
  if (!isOpen) {
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pageId = activePage.id.replace('page-', '');
      if (pageId === 'add' || pageId === 'dash') _doShowPage('day');
      if (pageId === 'list') renderList(); // stay but refresh to hide action buttons
    }
  }
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

  const BTN = 'width:100%;padding:16px;border:none;border-radius:var(--r);font-size:16px;font-weight:800;cursor:pointer;font-family:var(--sans);margin-top:6px;';

  if (status === 'OPEN') {
    const mins = opened_at ? Math.floor((Date.now() - new Date(opened_at)) / 60000) : 0;
    const dur  = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h ' + (mins%60) + 'm';
    banner.style.cssText = 'background:var(--green-light);border:2px solid #a8d8b5;border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent    = '🌅';
    badge.textContent   = 'OPEN';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 14px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#dcfce7;color:#16a34a;';
    title.textContent   = 'Business Day Open';
    title.style.color   = 'var(--green)';
    sub.textContent     = 'Opened ' + fmtTime(opened_at)
      + ' · ' + dur + ' running'
      + (reopened_count > 0 ? ' · Reopened ' + reopened_count + 'x' : '');
    actionArea.innerHTML =
      '<button onclick="closeDay()" style="' + BTN + 'background:var(--red);color:white;">' +
      '<i class="fa-solid fa-moon"></i> Close Day</button>';
    if (liveSection) liveSection.style.display = 'block';

  } else if (status === 'CLOSED') {
    banner.style.cssText = 'background:#fef3c7;border:2px solid #f5d9a0;border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent    = '🌙';
    badge.textContent   = 'CLOSED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 14px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:#fef3c7;color:#92400e;';
    title.textContent   = 'Business Day Closed';
    title.style.color   = '#d97706';
    sub.textContent     = closed_at
      ? 'Closed ' + fmtTime(closed_at) + (auto_closed ? ' (auto)' : '')
        + (reopened_count > 0 ? ' · Opened ' + (reopened_count + 1) + 'x today' : '')
        + ' · Tap to reopen'
      : 'No session yet today — tap to open';
    actionArea.innerHTML =
      '<button onclick="openDay()" style="' + BTN + 'background:var(--accent);color:white;">' +
      '<i class="fa-solid fa-sun"></i> Open Day</button>';
    if (liveSection) liveSection.style.display = 'none';

  } else if (status === 'LOCKED') {
    banner.style.cssText = 'background:var(--surface2);border:2px solid var(--border);border-radius:var(--r-lg);padding:20px 18px;margin-bottom:14px;text-align:center;';
    icon.textContent    = '🔒';
    badge.textContent   = 'LOCKED';
    badge.style.cssText = 'display:inline-block;font-size:11px;font-weight:800;font-family:var(--mono);padding:4px 14px;border-radius:20px;margin-bottom:8px;letter-spacing:1px;background:var(--surface2);color:var(--muted);';
    title.textContent   = 'Previous Day — Archived';
    title.style.color   = 'var(--muted)';
    sub.textContent     = fmtFullDate(activeDay.business_date) + ' · Read only';
    actionArea.innerHTML =
      '<button onclick="openDay()" style="' + BTN + 'background:var(--accent);color:white;">' +
      '<i class="fa-solid fa-sun"></i> Open Today</button>';
    if (liveSection) liveSection.style.display = 'none';
  }
}

// ── BANNER LIVE CLOCK ─────────────────────────────────────────────────
let _bannerClockTimer = null;
function startBannerClock() {
  if (_bannerClockTimer) clearInterval(_bannerClockTimer);
  _bannerClockTimer = setInterval(() => {
    if (isDayOpen()) updateDayBanner();
  }, 60000); // update every minute to keep duration fresh
}

// ── AUTO SCHEDULER ───────────────────────────────────────────────────
// Runs every 30s. Handles auto-close at midnight and new-day creation.
function startDayTimer() {
  if (dayCheckTimer) clearInterval(dayCheckTimer);
  dayCheckTimer = setInterval(async () => {
    const now = new Date();
    const h   = now.getHours();
    const m   = now.getMinutes();
    const s   = now.getSeconds();
    const today = todayDateStr();
    const bday  = await getBusinessDay(today);
    if (!bday) return;

    // 11:45 PM — one-time warning
    if (bday.status === 'OPEN' && h === 23 && m === 45 && s < 30 && _warned1145 !== today) {
      _warned1145 = today;
      toast('⏰ 15 minutes to midnight — day will auto-close!', 'err');
    }

    // 11:59:55 PM — auto-close
    if (bday.status === 'OPEN' && h === 23 && m === 59 && s >= 55) {
      const sales   = await dbAll('sales');
      const ds      = sales.filter(s => s.business_date === today);
      const items   = await dbAll('items');
      bday.status          = 'CLOSED';
      bday.closed_at       = now.toISOString();
      bday.auto_closed     = true;
      bday.salesCount      = ds.length;
      bday.revenue         = ds.reduce((a, s) => a + s.revenue, 0);
      bday.profit          = ds.reduce((a, s) => a + s.profit, 0);
      bday.itemsSold       = ds.reduce((a, s) => a + s.qty, 0);
      bday.closingStockCost = items.reduce((a, i) => a + (i.buy||0)*(i.qty||0), 0);
      await dbPut('business_days', bday);
      activeDay = bday;
      applyDayState();
      renderDaySessionsList();
      toast('🌙 Day auto-closed at midnight.', '');
      scheduleSync();
    }

    // 00:00 — lock yesterday, create fresh CLOSED record for today
    if (h === 0 && m === 0 && s < 30) {
      // Lock yesterday
      const yDate  = new Date(now.getTime() - 864e5);
      const yDateStr = yDate.getFullYear() + '-' +
        String(yDate.getMonth()+1).padStart(2,'0') + '-' +
        String(yDate.getDate()).padStart(2,'0');
      const yBday  = await getBusinessDay(yDateStr);
      if (yBday && yBday.status !== 'LOCKED') {
        yBday.status = 'LOCKED';
        yBday.final_locked_at = now.toISOString();
        await dbPut('business_days', yBday);
      }
      // Ensure today record exists
      let todayBday = await getBusinessDay(today);
      if (!todayBday) todayBday = await createDayRecord(today);
      _warned1145    = null;
      _lastKnownDate = today;
      _timerStarted  = false; // allow fresh timer if needed
      activeDay      = todayBday;
      applyDayState();
      renderDaySessionsList();
    }
  }, 30000);
}

// ── VISIBILITY CHANGE (phone wake) ───────────────────────────────────
let _lastKnownDate = todayDateStr();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  const today = todayDateStr();
  if (today !== _lastKnownDate) {
    // Date changed while phone was sleeping — full reinit for new day
    _lastKnownDate = today;
    _warned1145    = null;
    _timerStarted  = false; // allow timer to restart for new day
    await loadActiveDay();
  } else {
    // Same day — just refresh display from DB, never touch state
    const bday = await getBusinessDay(today);
    if (bday) { activeDay = bday; applyDayState(); }
  }
});

// ── LIVE STATS ────────────────────────────────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay) return;
  const sales    = await dbAll('sales');
  const daySales = sales.filter(s => s.business_date === activeDay.business_date);
  const rev    = daySales.reduce((a, s) => a + s.revenue, 0);
  const profit = daySales.reduce((a, s) => a + s.profit, 0);
  const items  = await dbAll('items');
  const todayStart = activeDay.business_date + 'T00:00:00';
  const newItems   = items.filter(i => i.createdAt && i.createdAt >= todayStart);

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('day-sales-count', daySales.length);
  set('day-revenue',     fmt(rev));
  set('day-profit',      fmt(profit));
  set('day-purchases',   newItems.length);

  const sl = document.getElementById('day-sales-list');
  if (!sl) return;
  sl.innerHTML = daySales.length
    ? daySales.slice().reverse().slice(0, 20).map(s =>
        '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">' +
        '<div style="flex:1;">' +
          '<div style="font-size:13px;font-weight:700;">' + (s.itemName||s.itemCode||'Sale') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' +
            fmtTime(s.date) + ' · ' + (s.itemCode||'') +
            (s.paymentMethod && s.paymentMethod !== 'Cash' ? ' · ' + s.paymentMethod : '') +
          '</div>' +
        '</div>' +
        '<div style="text-align:right;flex-shrink:0;">' +
          '<div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(s.revenue) + '</div>' +
          '<div style="font-size:11px;color:var(--green);font-family:var(--mono);">+' + fmt(s.profit) + '</div>' +
        '</div>' +
        (isDayOpen()
          ? '<button onclick="voidSale(' + s.id + ')" ' +
            'style="font-size:10px;padding:3px 9px;background:var(--red-light);color:var(--red);' +
            'border:1px solid var(--red);border-radius:4px;cursor:pointer;font-weight:700;flex-shrink:0;">Void</button>'
          : '') +
        '</div>'
      ).join('')
    : '<div style="color:var(--muted);font-size:13px;padding:10px 0;">No sales recorded today</div>';
}

// ── PAST SESSIONS LIST ────────────────────────────────────────────────
async function renderDaySessionsList() {
  const all   = await dbAll('business_days');
  const today = todayDateStr();
  const past  = all
    .filter(d => d.business_date < today)
    .sort((a, b) => b.business_date.localeCompare(a.business_date));

  const list = document.getElementById('day-sessions-list');
  if (!list) return;

  if (!past.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:10px 0;">No past sessions yet</div>';
    return;
  }

  list.innerHTML = past.map(s => {
    const profitColor = (s.profit||0) >= 0 ? 'var(--green)' : 'var(--red)';
    const isLocked    = s.status === 'LOCKED';
    const badge = isLocked
      ? '<span style="font-size:10px;background:var(--surface2);color:var(--muted);padding:2px 8px;border-radius:20px;font-weight:700;">' +
        '<i class="fa-solid fa-lock" style="margin-right:3px;font-size:9px;"></i>Locked</span>'
      : '<span style="font-size:10px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:20px;font-weight:700;">' +
        '<i class="fa-solid fa-moon" style="margin-right:3px;font-size:9px;"></i>Closed</span>';

    return '<div class="card" style="margin-bottom:8px;padding:14px;cursor:pointer;" onclick="viewPastSession(' + s.id + ')">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:10px;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:14px;font-weight:800;color:var(--text);">' + fmtFullDate(s.business_date) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">' +
          fmtTime(s.opened_at) + ' → ' + (s.closed_at ? fmtTime(s.closed_at) : 'auto') +
          (s.reopened_count > 0 ? ' · Reopened ' + s.reopened_count + 'x' : '') +
          (s.auto_closed ? ' · auto-closed' : '') +
        '</div>' +
      '</div>' + badge +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">' +
        _statBox(fmt(s.revenue||0),  'Revenue',  'var(--accent2)') +
        _statBox(fmt(s.profit||0),   'Profit',   profitColor)      +
        _statBox(s.salesCount||0,    'Sales',    'var(--accent)')  +
      '</div>' +
      (s.notes ? '<div style="margin-top:8px;font-size:12px;color:var(--muted);font-style:italic;">"' + s.notes + '"</div>' : '') +
    '</div>';
  }).join('');
}

function _statBox(val, label, color) {
  return '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;">' +
    '<div style="font-size:14px;font-weight:800;font-family:var(--mono);color:' + color + ';">' + val + '</div>' +
    '<div style="font-size:10px;color:var(--muted);">' + label + '</div>' +
  '</div>';
}
// ═══════════════════════════════════════════════════════════
// RESTOCK
// ═══════════════════════════════════════════════════════════
function toggleRestock() {
  if (!isDayOpen()) { toast('⚠️ Open the business day to restock items.', 'err'); return; }
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
    // Listen for messages from SW (background sync trigger)
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'BACKGROUND_SYNC') {
        if (fbReady && fbDb && navigator.onLine) {
          forcePushToFirebase(true).then(() => pullFromFirebase(true));
        }
      }
    });
    // Check for SW updates
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          toast('🔄 App updated — reload to get latest version', '');
        }
      });
    });
  }).catch(() => {});
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
    name: 'Onchari',
    role: 'super',
    roleLabel: 'Super User',
    // Super: access to everything
    tabs: ['dash','list','add','day','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','list','add','day']
  },
  {
    username: 'trevor',
    pin: '3456',
    name: 'Trevor',
    role: 'clerk',
    roleLabel: 'Clerk',
    // Clerk: view stock + add stock
    tabs: ['list', 'add']
  }
];

let currentUser = null;



function applyRoleRestrictions(user) {
  // Show/hide nav tabs based on role
  const allTabs = ['dash','list','add','day','settings'];
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
  localStorage.removeItem('mg_session');
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



// _origShowPage: internal navigation — bypasses day guard, used by timers and state transitions
const _origShowPage = _doShowPage;


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
  localStorage.setItem('mg_session', JSON.stringify({ username: user.username, pin: user.pin }));

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
  const lastPage = localStorage.getItem('mg_last_page') || 'dash';
  const allowedPage = user.tabs.includes(lastPage) ? lastPage : user.tabs[0];

  // Check day status
  getBusinessDay(todayDateStr()).then(bday => {
    const dayOpen = bday && bday.status === 'OPEN';
    if (!dayOpen && user.tabs.includes('day')) {
      _doShowPage('day');
      setTimeout(() => toast('⚠️ Please open the business day first.', ''), 500);
    } else {
      _doShowPage(allowedPage);
    }
  });
  toast('Welcome, ' + user.name + '! 👋', 'ok');
}

function checkSession() {
  const saved = localStorage.getItem('mg_session');
  if (!saved) {
    document.getElementById('login-screen').style.display = 'flex';
    return false;
  }
  try {
    const { username, pin } = JSON.parse(saved);
    const user = USERS.find(u => u.username === username && u.pin === pin);
    if (user) {
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
      // Invalid credentials in saved session — clear and show login
      localStorage.removeItem('mg_session');
      document.getElementById('login-screen').style.display = 'flex';
      return false;
    }
  } catch(e) {
    // Corrupted session data — clear and show login
    localStorage.removeItem('mg_session');
    document.getElementById('login-screen').style.display = 'flex';
    return false;
  }
}


// ===== JQUERY ENHANCEMENTS =====


// ===== INIT =====
initDB();

// Wait for IndexedDB to be ready before initialising Firebase.
// Firebase listeners call dbAll() on first snapshot — DB must be open first.
function initFirebaseWhenReady() {
  const wait = () => {
    if (db) {
      initFirebase();
    } else {
      setTimeout(wait, 100);
    }
  };
  setTimeout(wait, 300); // small initial delay for module scripts
}
initFirebaseWhenReady();

// ===== AUTO SYNC =====
let autoSyncTimer = null;
let pendingSyncTimer = null;

// Debounced sync — runs 2s after last change, avoids hammering Firebase
// Retry sync when network comes back online
window.addEventListener('online', () => {
  if (fbReady && fbDb) {
    console.log('[SYNC] Back online — syncing...');
    scheduleSync();
  } else if (!fbReady) {
    // Try to reconnect Firebase if we lost it
    initFirebase().catch(e => console.warn('[SYNC] Reconnect failed:', e.message));
  }
});

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
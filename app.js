// ===== DB =====
let db;
const DB_NAME = 'InventoryApp';
const DB_VER  = 7;

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
    const d = e.target.result;
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
    if (!d.objectStoreNames.contains('shoe_sizes')) {
      const ss2 = d.createObjectStore('shoe_sizes', { keyPath: 'id', autoIncrement: true });
      ss2.createIndex('itemCode',  'itemCode',  { unique: false });
      ss2.createIndex('codeSize',  'codeSize',  { unique: true });
      ss2.createIndex('sizeGroup', 'sizeGroup', { unique: false });
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
      const lastPage = localStorage.getItem(KEY_LAST_PAGE) || 'dash';
      const today = todayDateStr();

      // Check if day needs opening
      const bday = await getBusinessDay(today);
      const dayOpen = bday && bday.status === 'OPEN';

      if (!dayOpen && lastPage !== 'day' && lastPage !== 'settings') {
        // Show a gentle reminder but stay on last page
        setTimeout(() => toast('⚠️ Business day not open yet', ''), 1000);
      }

      // Restore last page if user has access to it
      const allowedPage = currentUser && currentUser.tabs.includes(lastPage) ? lastPage : currentUser.tabs[0];
      _origShowPage(allowedPage);
    });
  };
  req.onerror = () => toast('Database error!', 'err');
}

function _dbReady(rej){if(!db){const e=new Error('Database not ready.');if(rej)rej(e);return false;}return true;}
function dbAll(store){return new Promise((res,rej)=>{if(!_dbReady(rej))return;try{const tx=db.transaction(store,'readonly');tx.objectStore(store).getAll().onsuccess=e=>res(e.target.result);tx.onerror=e=>rej(e.target.error);}catch(e){rej(e);}});}
function dbGet(store,id){return new Promise((res,rej)=>{if(!_dbReady(rej))return;try{const tx=db.transaction(store,'readonly');tx.objectStore(store).get(id).onsuccess=e=>res(e.target.result);tx.onerror=e=>rej(e.target.error);}catch(e){rej(e);}});}
function dbAdd(store,data){return new Promise((res,rej)=>{if(!_dbReady(rej))return;try{const tx=db.transaction(store,'readwrite');const r=tx.objectStore(store).add(data);r.onsuccess=e=>res(e.target.result);tx.onerror=e=>rej(e.target.error);}catch(e){rej(e);}});}
function dbPut(store,data){return new Promise((res,rej)=>{if(!_dbReady(rej))return;try{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(data).onsuccess=res;tx.onerror=e=>rej(e.target.error);}catch(e){rej(e);}});}
function dbDelete(store,id){return new Promise((res,rej)=>{if(!_dbReady(rej))return;try{const tx=db.transaction(store,'readwrite');tx.objectStore(store).delete(id).onsuccess=res;tx.onerror=e=>rej(e.target.error);}catch(e){rej(e);}});}

function escapeHtml(s){if(s==null)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function sanitiseCode(r){return(r||'').trim().toUpperCase().replace(/[^A-Z0-9\-.]/g,'');}
function fmt(n){const c=typeof currency!=='undefined'?currency:'KES';return c+' '+(parseFloat(n)||0).toLocaleString('en-KE',{minimumFractionDigits:0,maximumFractionDigits:2});}

// ===== STATE =====
let types = [];
let allItems = [];
let activeTypeFilter = 'all';
let selectedEmoji = '📦';
let currency = localStorage.getItem('inv_currency') || 'KES';
let currentDetailId = null;

// ===== HELPERS =====
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
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + id).classList.add('active');
  document.getElementById('tab-' + id).classList.add('active');
  if (id === 'dash') renderDashboard();
  if (id === 'list') renderList();
  if (id === 'sell') { renderSellPage(); setTimeout(()=>document.getElementById('sell-search').focus(),150); }
  // summary removed


  if (id === 'day') { refreshDayTab(); }
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
async function saveItem() {
  const editId = document.getElementById('edit-id').value;
  const type = document.getElementById('f-type').value;
  const code = document.getElementById('f-code').value.trim().toUpperCase();
  const size = document.getElementById('f-size').value.trim();
  const name = document.getElementById('f-name').value.trim() || (type + ' ' + code);
  const qtyRaw = document.getElementById('f-qty').value;
  const qty = parseInt(qtyRaw);
  const buy = parseFloat(document.getElementById('f-buy').value) || 0;
  const sell = parseFloat(document.getElementById('f-sell').value) || 0;

  if (!requireOpenDay()) return;
  if (!type)  { toast('⚠️ Select an item type', 'err'); return; }
  if (!code)  { toast('⚠️ Enter item code', 'err'); return; }
  if (!size)  { toast('⚠️ Enter a size (or type N/A)', 'err'); return; }
  if (qtyRaw === '' || isNaN(qty) || qty < 0) { toast('⚠️ Enter quantity stocked', 'err'); return; }
  if (buy <= 0)  { toast('⚠️ Enter buying price', 'err'); return; }
  if (sell <= 0) { toast('⚠️ Enter selling price', 'err'); return; }

  const profit = sell - buy;
  const item = { type, code, name, size, buy, sell, profit, qty, createdAt: new Date().toISOString() };

  try {
    if (editId) {
      item.id = parseInt(editId);
      await dbPut('items', item);
      fbSyncItem(item);
      toast('✅ Item updated!', 'ok');
      clearForm();
      allItems = await dbAll('items');
      renderList();
      renderDashboard();
      updateHeader();
      showPage('list');
    } else {
      const newId = await dbAdd('items', item);
      item.id = newId;
      // Save photo if one was selected
      if (_addFormPhotoData) { setItemPhoto(newId, _addFormPhotoData); }
      fbSyncItem(item);
      clearForm();
      clearAddFormPhoto();
      allItems = await dbAll('items');
      renderList();
      renderDashboard();
      updateHeader();
      showSplash(name, sell, profit);
      if (activeDay) updateDayLiveStats();
    }
  } catch (e) {
    if (e.name === 'ConstraintError') toast('Code "' + code + '" already exists!', 'err');
    else toast('Error saving: ' + e.message, 'err');
  }
}

function clearForm() {
  document.getElementById('edit-id').value = '';
  document.getElementById('f-type').value = '';
  document.getElementById('f-code').value = '';
  document.getElementById('f-name').value = '';
  document.getElementById('f-size').value = '';
  document.getElementById('f-qty').value = '';
  document.getElementById('f-buy').value = '';
  document.getElementById('f-sell').value = '';
  document.getElementById('profit-preview').style.display = 'none';
  document.getElementById('save-btn').textContent = '+ Add to Inventory';
  document.getElementById('form-mode-label').textContent = 'New Item';
  document.getElementById('cancel-edit-btn').style.display = 'none';
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


function toggleNotifPanel(){const p=document.getElementById('notif-panel');const b=document.getElementById('notif-backdrop');if(!p)return;const open=p.style.display!=='none';p.style.display=open?'none':'block';if(b)b.style.display=open?'none':'block';}
function clearNotifs(){const l=document.getElementById('notif-list');if(l)l.innerHTML='<div style="color:var(--muted);font-size:13px;padding:8px;">No events yet</div>';}
function addNotif(msg){const l=document.getElementById('notif-list');if(!l)return;const e=document.createElement('div');e.style.cssText='padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;';e.textContent=new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+' '+msg;l.insertBefore(e,l.firstChild);}
function closePastSessionSheet(){const s=document.getElementById('past-session-sheet');if(s)s.classList.remove('open');}

// ═══════════════════════════════════════════════════════════════
// FACTORY RESET — clears ALL local data and Firebase
// Only accessible to Super User in Settings
// ═══════════════════════════════════════════════════════════════
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
    const stores = ['items', 'sales', 'types', 'day_sessions', 'business_days', 'shoe_sizes'];
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
  const config = FIREBASE_CONFIG;
  localStorage.setItem('fb_config', JSON.stringify(config));
  const cfgInput = document.getElementById('fb-config-input');
  if (cfgInput) cfgInput.value = JSON.stringify(config, null, 2);
  try {
    setFbStatus('connecting');
    const { initializeApp, getFirestore, onSnapshot, collection, getApps, getApp } = await waitForFbImports();

    // Reuse existing app to avoid duplicate app errors
    const existingApps = getApps();
    fbApp = existingApps.find(a => a.name === 'mandela') || initializeApp(config, 'mandela');
    fbDb = getFirestore(fbApp);
    fbReady = true;

    // Unsub previous listeners
    if (fbUnsub) { fbUnsub(); fbUnsub = null; }
    if (window._fbUnsubSales) { window._fbUnsubSales(); window._fbUnsubSales = null; }

    // Live listener: items — processes all changes including initial load
    const unsubItems = onSnapshot(collection(fbDb, 'items'), async snap => {
      // Skip if we triggered this snapshot ourselves (echo prevention)
      if (_localWriting) return;
      const changes = snap.docChanges().filter(c => c.type !== 'modified' || !c.doc.metadata.hasPendingWrites);
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
          if (existing) { data.id = existing.id; await dbPut('items', data); }
          else { try { delete data.id; await dbAdd('items', data); } catch(_) {} }
          needsRender = true;
        }
      }
      if (needsRender) {
        allItems = await dbAll('items');
        renderList(); renderDashboard(); updateHeader();
        setFbStatus('on');
      }
    }, err => { setFbStatus('error'); console.error('Items listener error:', err); });

    // Live listener: sales
    const unsubSales = onSnapshot(collection(fbDb, 'sales'), async snap => {
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
    }, err => { console.error('Sales listener error:', err); });

    fbUnsub = unsubItems;
    window._fbUnsubSales = unsubSales;

    setFbStatus('on');
    toast('☁️ Firebase connected!', 'ok');

    // On connect: first push local data, then pull remote data
    // This ensures both devices are in sync
    console.log('[SYNC] Firebase connected — running initial push + pull');
    await forcePushToFirebase(true);
    await pullFromFirebase(true);

  } catch (e) {
    setFbStatus('error');
    toast('Firebase error: ' + e.message, 'err');
    console.error('Firebase init error:', e);
  }
}

function waitForFbImports() {
  return new Promise(res => {
    const check = () => window._fbImports ? res(window._fbImports) : setTimeout(check, 100);
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
    const fbId = 'sale_' + sale.date.replace(/[:.]/g, '-') + '_' + (sale.itemCode || '');
    await setDoc(doc(fbDb, 'sales', fbId), { ...sale, fbId });
  } catch (e) { console.error('fbSyncSale error', e); }
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
      batch.set(doc(fbDb, 'items', item.fbId), { ...item, updatedAt: new Date().toISOString() });
      count++;
      if (count % 400 === 0) { await batch.commit(); batch = writeBatch(fbDb); count = 0; }
    }

    for (const sale of sales) {
      if (!sale.fbId) {
        sale.fbId = 'sale_' + (sale.date || '').replace(/[:.TZ-]/g,'').slice(0,17) + '_' + Math.random().toString(36).slice(2,6);
        await dbPut('sales', sale);
      }
      batch.set(doc(fbDb, 'sales', sale.fbId), { ...sale });
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

    let itemsAdded = 0, itemsUpdated = 0;
    for (const d of itemSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      // Remove numeric id from Firebase data to avoid IndexedDB key conflicts
      delete data.id;
      const all = await dbAll('items');
      const existing = all.find(i => i.fbId === d.id || i.code === data.code);
      if (existing) {
        data.id = existing.id;
        await dbPut('items', data);
        itemsUpdated++;
      } else {
        await dbAdd('items', data);
        itemsAdded++;
      }
    }
    console.log('[SYNC] Items: added=' + itemsAdded + ' updated=' + itemsUpdated);

    // Pull sales
    console.log('[SYNC] Pulling sales from Firebase...');
    const saleSnap = await getDocs(collection(fbDb, 'sales'));
    console.log('[SYNC] Firebase has', saleSnap.size, 'sales');

    let salesAdded = 0, salesUpdated = 0;
    for (const d of saleSnap.docs) {
      const data = { ...d.data(), fbId: d.id };
      delete data.id;
      const all = await dbAll('sales');
      const existing = all.find(s => s.fbId === d.id);
      if (existing) {
        data.id = existing.id;
        await dbPut('sales', data);
        salesUpdated++;
      } else {
        await dbAdd('sales', data);
        salesAdded++;
      }
    }
    console.log('[SYNC] Sales: added=' + salesAdded + ' updated=' + salesUpdated);

    allItems = await dbAll('items');
    renderList(); renderDashboard(); updateHeader();
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
function isDayOpen() {
  return activeDay && activeDay.status === 'OPEN';
}

function requireOpenDay() {
  if (!isDayOpen()) {
    const status = activeDay ? activeDay.status : 'NONE';
    const msg = status === 'CLOSED'
      ? '🌙 Day is closed — tap Open Day to continue.'
      : status === 'LOCKED'
        ? '🔒 This day is archived and cannot be modified.'
        : '📅 Open the business day to record transactions.';
    toast(msg, 'err');
    showPage('day');
    return false;
  }
  return true;
}

// ── LOAD ACTIVE DAY ON APP START ─────────────────────────────────────
// Called once at startup. Finds or creates today's day record.
// Also locks any past days that were left OPEN or CLOSED overnight.
async function loadActiveDay() {
  const today = todayDateStr();

  // Lock any past days left open (e.g. app not opened since yesterday)
  const all = await dbAll('business_days');
  for (const d of all) {
    if (d.business_date !== today && d.status !== 'LOCKED') {
      d.status = 'LOCKED';
      d.final_locked_at = new Date().toISOString();
      await dbPut('business_days', d);
    }
  }

  // Find or create today's record
  let bday = await getBusinessDay(today);
  if (!bday) bday = await createDayRecord(today);

  activeDay = bday;
  updateDayBanner();
  if (isDayOpen()) updateDayLiveStats();
  startDayTimer();
  startBannerClock();
}

// ── REFRESH DAY TAB (no re-init) ─────────────────────────────────────
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
    business_date: dateStr,
    status: 'CLOSED',          // starts CLOSED, user opens it
    opened_at: null,
    closed_at: null,
    reopened_count: 0,
    final_locked_at: null,
    salesCount: 0, revenue: 0, profit: 0, itemsSold: 0,
    notes: ''
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
  const daySales = sales.filter(s => s.business_date === activeDay.business_date);
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
  set('ds-date',       fmtFullDate(activeDay.business_date));
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
  const daySales = sales.filter(s => s.business_date === activeDay.business_date);
  const items = await dbAll('items');
  const todayStart2 = activeDay.business_date + 'T00:00:00';
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
function startDayTimer() {
  if (dayCheckTimer) clearInterval(dayCheckTimer);
  dayCheckTimer = setInterval(async () => {
    const now   = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const today = todayDateStr();
    const bday  = await getBusinessDay(today);
    if (!bday) return;

    // 11:45 PM — warn once that auto-close is coming
    if (bday.status === 'OPEN' && h === 23 && m === 45 && s < 30 && _warned1145 !== today) {
      _warned1145 = today;
      toast('⏰ 15 minutes left — day auto-closes at midnight!', 'err');
    }

    // 11:59:55 PM — auto-close the open day
    if (bday.status === 'OPEN' && h === 23 && m === 59 && s >= 55) {
      const sales = await dbAll('sales');
      const ds = sales.filter(s => s.business_date === today);
      bday.status     = 'CLOSED';
      bday.closed_at  = now.toISOString();
      bday.auto_closed = true;
      bday.salesCount = ds.length;
      bday.revenue    = ds.reduce((a, s) => a + s.revenue, 0);
      bday.profit     = ds.reduce((a, s) => a + s.profit, 0);
      bday.itemsSold  = ds.reduce((a, s) => a + s.qty, 0);
      await dbPut('business_days', bday);
      activeDay = bday;
      setDayMode(false);
      updateDayBanner();
      renderDaySessionsList();
      toast('🌙 Day auto-closed at midnight.', '');
    }

    // 00:00 — lock yesterday, create today fresh
    if (h === 0 && m === 0 && s < 30) {
      const yesterday = new Date(now - 864e5).toISOString().split('T')[0];
      const yBday = await getBusinessDay(yesterday);
      if (yBday && yBday.status !== 'LOCKED') {
        yBday.status = 'LOCKED';
        yBday.final_locked_at = now.toISOString();
        await dbPut('business_days', yBday);
      }
      // Ensure today's record exists
      let todayBday = await getBusinessDay(today);
      if (!todayBday) todayBday = await createDayRecord(today);
      _warned1145 = null; // reset warning for new day
      _lastKnownDate = today;
      activeDay = todayBday;
      setDayMode(false);
      updateDayBanner();
      renderDaySessionsList();
      // Restart banner clock for new day
      startBannerClock();
    }
  }, 30000);
}

// ── VISIBILITY CHANGE — handle phone wake ────────────────────────────
let _lastKnownDate = todayDateStr();
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  const today = todayDateStr();
  if (today !== _lastKnownDate) {
    _lastKnownDate = today;
    _warned1145 = null;
    await loadActiveDay(); // date changed overnight — full reinit
  } else {
    await refreshDayTab(); // same day — just refresh display
  }
});

// ── LOCK OLD DAY ─────────────────────────────────────────────────────
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
    sub.textContent   = fmtFullDate(activeDay.business_date) + ' — read only';
    actionArea.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:10px 0;">This day is read-only. A new day will appear automatically tomorrow.</div>';
    if (liveSection) liveSection.style.display = 'none';
    setDayMode(false);
  }
}

// ── LIVE STATS ───────────────────────────────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay) return;
  const sales = await dbAll('sales');
  const daySales = sales.filter(s => s.business_date === activeDay.business_date);
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
    tabs: ['dash','list','add','day','settings']
  },
  {
    username: 'vanice',
    pin: '2345',
    pinHash: '38083c7ee9121e17401883566a148aa5c2e2d55dc53bc4a94a026517dbff3c6b',
    name: 'Vanice',
    role: 'user',
    roleLabel: 'User',
    // User: everything except Settings
    tabs: ['dash','list','add','day']
  },
  {
    username: 'trevor',
    pin: '3456',
    pinHash: 'ceaa28bba4caba687dc31b1bbe79eca3c70c33f871f1ce8f528cf9ab5cfd76dd',
    name: 'Trevor',
    role: 'clerk',
    roleLabel: 'Clerk',
    // Clerk: view stock + add stock
    tabs: ['list', 'add']
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
  // Block restricted tabs when day is not open (but NOT sheet popups)
  const dayOpen = activeDay && (activeDay.status === 'OPEN');
  if (['dash', 'add'].includes(id) && !dayOpen) {
    _origShowPage('day');
    setTimeout(() => showDayClosedOverlay(id), 100);
    return;
  }
  hideDayClosedOverlay();
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
  localStorage.setItem(KEY_SESSION, JSON.stringify({ username: user.username, pin: user.pin }));

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
  getBusinessDay(todayDateStr()).then(bday => {
    const dayOpen = bday && bday.status === 'OPEN';
    if (!dayOpen && user.tabs.includes('day')) {
      _origShowPage('day');
      setTimeout(() => toast('⚠️ Please open the business day first.', ''), 500);
    } else {
      _origShowPage(allowedPage);
    }
  });
  toast('Welcome, ' + user.name + '! 👋', 'ok');
}

function checkSession() {
  const saved = localStorage.getItem(KEY_SESSION);
  if (!saved) {
    // No session — show login screen
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
      return true; // session valid, let caller handle navigation
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
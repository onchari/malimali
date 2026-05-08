// ===== DB =====
let db;
const DB_NAME = 'InventoryApp';
const DB_VER = 4;

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
    if (!d.objectStoreNames.contains('day_sessions')) {
      d.createObjectStore('day_sessions', { keyPath: 'id', autoIncrement: true });
    }
    if (!d.objectStoreNames.contains('business_days')) {
      const bds = d.createObjectStore('business_days', { keyPath: 'id', autoIncrement: true });
      bds.createIndex('business_date', 'business_date', { unique: true });
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
      const lastPage = localStorage.getItem('mg_last_page') || 'dash';
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

function dbAll(store) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    tx.objectStore(store).getAll().onsuccess = e => res(e.target.result);
    tx.onerror = rej;
  });
}
function dbGet(store, id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    tx.objectStore(store).get(id).onsuccess = e => res(e.target.result);
    tx.onerror = rej;
  });
}
function dbAdd(store, data) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(data);
    req.onsuccess = e => res(e.target.result);
    tx.onerror = e => rej(e.target.error);
  });
}
function dbPut(store, data) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(data).onsuccess = res;
    tx.onerror = rej;
  });
}
function dbDelete(store, id) {
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id).onsuccess = res;
    tx.onerror = rej;
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
  const buy = parseFloat(document.getElementById('f-buy').value) || 0;
  const sell = parseFloat(document.getElementById('f-sell').value) || 0;
  const qty = parseInt(document.getElementById('f-qty').value) || 0;
  const preview = document.getElementById('profit-preview');

  if (buy > 0 && sell > 0) {
    const profit = sell - buy;
    const margin = ((profit / sell) * 100).toFixed(1);
    const profitColor = profit >= 0 ? 'var(--green)' : 'var(--red)';
    document.getElementById('pp-buy').textContent = fmt(buy);
    document.getElementById('pp-sell').textContent = fmt(sell);
    document.getElementById('pp-profit').textContent = (profit >= 0 ? '+' : '') + fmt(profit);
    document.getElementById('pp-profit').style.color = profitColor;
    document.getElementById('pp-margin').textContent = margin + '%';
    document.getElementById('pp-margin').style.color = profit >= 0 ? 'var(--accent3)' : 'var(--red)';
    // Show total profit if qty entered
    if (qty > 0) {
      document.getElementById('pp-qty-lbl').style.display = '';
      document.getElementById('pp-total').style.display = '';
      document.getElementById('pp-total').textContent = (profit >= 0 ? '+' : '') + fmt(profit * qty);
    } else {
      document.getElementById('pp-qty-lbl').style.display = 'none';
      document.getElementById('pp-total').style.display = 'none';
    }
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
          if (existing) { data.id = existing.id; await dbPut('items', data); }
          else { try { delete data.id; await dbAdd('items', data); } catch(_) {} }
          needsRender = true;
        }
      }
      if (needsRender) {
        allItems = await dbAll('items');
        renderList(); renderDashboard(); updateHeader();
        setFbStatus('on');
        toast('🔄 ' + changes.length + ' item(s) synced from cloud', 'ok');
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
    // Generate stable fbId if not set
    if (!item.fbId) {
      item.fbId = 'item_' + (item.code || 'x').replace(/[^a-zA-Z0-9_-]/g, '_') + '_' + Date.now();
      await dbPut('items', item);
    }
    const data = { ...item, updatedAt: new Date().toISOString() };
    await setDoc(doc(fbDb, 'items', item.fbId), data);
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
    const fbId = 'sale_' + sale.date.replace(/[:.]/g, '-') + '_' + (sale.itemCode || '');
    await setDoc(doc(fbDb, 'sales', fbId), { ...sale, fbId });
  } catch (e) { console.error('fbSyncSale error', e); }
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
const DAY_RESTRICTED_TABS = ['dash', 'add'];

function setDayMode(isOpen) {
  // isOpen: true = OPEN, false = PAUSED/CLOSED/PENDING/LOCKED
  DAY_RESTRICTED_TABS.forEach(tab => {
    const btn = document.getElementById('tab-' + tab);
    if (!btn) return;
    // Only affect visible tabs (respect role restrictions)
    if (btn.style.display === 'none') return;
    if (isOpen) {
      btn.classList.remove('disabled');
    } else {
      btn.classList.add('disabled');
      btn.classList.remove('active');
    }
  });

  // If day just closed and we're on a restricted page, show day page
  if (!isOpen) {
    const activePage = document.querySelector('.page.active');
    if (activePage) {
      const pageId = activePage.id.replace('page-', '');
      if (DAY_RESTRICTED_TABS.includes(pageId)) {
        _origShowPage('day');
      }
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
// Statuses: PENDING → OPEN → CLOSED → LOCKED
// ===================================================================
let activeDay = null;      // current business day object
let dayCheckTimer = null;  // timer for auto-open/close/lock

// ── HELPERS ─────────────────────────────────────────────────────────
function todayDateStr() {
  return new Date().toISOString().split('T')[0];
}
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function fmtFullDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });
}

// Find business day by date string
async function getBusinessDay(dateStr) {
  const all = await dbAll('business_days');
  return all.find(d => d.business_date === dateStr) || null;
}

// ── LOAD & INITIALIZE DAY ────────────────────────────────────────────
async function loadActiveDay() {
  const today = todayDateStr();

  // Get today's day record — create PENDING if doesn't exist yet
  let bday = await getBusinessDay(today);
  if (!bday) {
    const id = await dbAdd('business_days', {
      business_date: today,
      status: 'PENDING',
      opened_at: null, closed_at: null,
      auto_opened: false, auto_closed: false,
      reopened_count: 0, final_locked_at: null, notes: ''
    });
    bday = await dbGet('business_days', id);
  }

  // Only lock today's day if it's past midnight (past its date)
  // Never lock a day that is still "today"
  if ((bday.status === 'OPEN' || bday.status === 'CLOSED') && bday.business_date !== today) {
    await lockBusinessDay(bday);
    // This shouldn't happen (bday IS for today) but safety net
    bday = await getBusinessDay(today);
    if (!bday) {
      const id = await dbAdd('business_days', {
        business_date: today, status: 'PENDING',
        opened_at: null, closed_at: null,
        auto_opened: false, auto_closed: false,
        reopened_count: 0, final_locked_at: null, notes: ''
      });
      bday = await dbGet('business_days', id);
    }
  }

  activeDay = bday;
  updateDayBanner();
  if (activeDay && activeDay.status === 'OPEN') updateDayLiveStats();
  startDayTimer();
}

// ── AUTO SCHEDULER ───────────────────────────────────────────────────
function startDayTimer() {
  if (dayCheckTimer) clearInterval(dayCheckTimer);
  dayCheckTimer = setInterval(async () => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();
    const today = todayDateStr();
    const bday = await getBusinessDay(today);
    if (!bday) return;

    // Auto-open at exactly 9:00 AM if still PENDING
    if (bday.status === 'PENDING' && h === 9 && m === 0 && s < 30) {
      await autoOpenDay(bday);
    }

    // Auto-close at 11:59:55 PM if still OPEN
    if (bday.status === 'OPEN' && h === 23 && m === 59 && s >= 55) {
      await autoCloseDay(bday);
    }

    // At midnight (00:00): lock YESTERDAY's closed day and create today's PENDING
    if (h === 0 && m === 0 && s < 30) {
      const yesterday = new Date(now.getTime() - 24*60*60*1000).toISOString().split('T')[0];
      const yBday = await getBusinessDay(yesterday);
      if (yBday && (yBday.status === 'CLOSED' || yBday.status === 'OPEN')) {
        await lockBusinessDay(yBday);
      }
      // Ensure today has a PENDING day record
      const todayExists = await getBusinessDay(today);
      if (!todayExists) {
        await dbAdd('business_days', {
          business_date: today, status: 'PENDING',
          opened_at: null, closed_at: null,
          auto_opened: false, auto_closed: false,
          reopened_count: 0, final_locked_at: null, notes: ''
        });
      }
      // Refresh banner to show new day
      const newBday = await getBusinessDay(today);
      if (newBday) { activeDay = newBday; updateDayBanner(); }
    }
  }, 30000);
}

// ── STATUS TRANSITIONS ───────────────────────────────────────────────
async function autoOpenDay(bday) {
  bday.status = 'OPEN';
  bday.opened_at = new Date().toISOString();
  bday.auto_opened = true;
  await dbPut('business_days', bday);
  activeDay = bday;
  updateDayBanner();
  updateDayLiveStats();
  toast('🌅 Business day auto-opened at 9:00 AM', 'ok');
}

async function autoCloseDay(bday) {
  const sales = await dbAll('sales');
  const daySales = sales.filter(s => s.business_date === bday.business_date || s.date >= bday.opened_at);
  bday.status = 'CLOSED';   // auto permanent close at midnight
  bday.closed_at = new Date().toISOString();
  bday.auto_closed = true;
  bday.salesCount = daySales.length;
  bday.revenue = daySales.reduce((a, s) => a + s.revenue, 0);
  bday.profit  = daySales.reduce((a, s) => a + s.profit, 0);
  bday.itemsSold = daySales.reduce((a, s) => a + s.qty, 0);
  await dbPut('business_days', bday);
  activeDay = bday;
  updateDayBanner();
  renderDaySessionsList();
  toast('🌙 Business day auto-closed at midnight', '');
}

async function lockBusinessDay(bday) {
  bday.status = 'LOCKED';
  bday.final_locked_at = new Date().toISOString();
  await dbPut('business_days', bday);
}


// Open a brand new business day (used when previous day is LOCKED)
async function openNewDay() {
  const today = todayDateStr();
  let bday = await getBusinessDay(today);

  if (bday && bday.status === 'OPEN') {
    toast('Today is already open!', 'err');
    return;
  }

  if (!bday) {
    // Create fresh day for today
    const id = await dbAdd('business_days', {
      business_date: today,
      status: 'PENDING',
      opened_at: null,
      closed_at: null,
      auto_opened: false,
      auto_closed: false,
      reopened_count: 0,
      final_locked_at: null,
      notes: ''
    });
    bday = await dbGet('business_days', id);
  }

  // Now open it
  const items = await dbAll('items');
  bday.openingStockCost = items.reduce((s, i) => s + i.buy * i.qty, 0);
  bday.openingStockRetail = items.reduce((s, i) => s + i.sell * i.qty, 0);
  bday.status = 'OPEN';
  bday.opened_at = new Date().toISOString();
  bday.last_opened_at = new Date().toISOString();
  bday.date = fmtFullDate(today);
  bday.dateStr = today;
  await dbPut('business_days', bday);
  activeDay = bday;
  updateDayBanner();
  updateDayLiveStats();
  renderDaySessionsList();
  toast('🌅 New business day opened!', 'ok');
}

// ── MANUAL OPEN / REOPEN ─────────────────────────────────────────────
async function openDay() {
  const today = todayDateStr();
  let bday = await getBusinessDay(today);

  if (!bday) {
    const id = await dbAdd('business_days', {
      business_date: today, status: 'PENDING',
      opened_at: null, closed_at: null,
      auto_opened: false, auto_closed: false,
      pause_count: 0, final_locked_at: null, notes: ''
    });
    bday = await dbGet('business_days', id);
  }

  if (bday.status === 'OPEN') { toast('Day is already open!', 'err'); return; }
  // CLOSED = permanently closed — cannot reopen
  if (bday.status === 'CLOSED') { toast('🔒 Day is permanently closed.', 'err'); return; }
  // LOCKED = previous day — open a new day instead
  if (bday.status === 'LOCKED') { toast('🔒 This day is locked.', 'err'); return; }

  const isReopen = (bday.status === 'PAUSED');

  if (!bday.opened_at) {
    // First open — snapshot opening stock
    const items = await dbAll('items');
    bday.openingStockCost   = items.reduce((s, i) => s + i.buy * i.qty, 0);
    bday.openingStockRetail = items.reduce((s, i) => s + i.sell * i.qty, 0);
  }

  bday.status = 'OPEN';
  bday.opened_at      = bday.opened_at || new Date().toISOString();
  bday.last_opened_at = new Date().toISOString();
  bday.date    = fmtFullDate(today);
  bday.dateStr = today;
  if (isReopen) {
    bday.pause_count = (bday.pause_count || 0); // already incremented on pause
    toast('▶️ Day resumed! Continue where you left off.', 'ok');
  } else {
    toast('🌅 Business day opened!', 'ok');
  }
  await dbPut('business_days', bday);
  activeDay = bday;
  updateDayBanner();
  updateDayLiveStats();
  renderDaySessionsList();
}

// ── PAUSE DAY (temporary close — can reopen) ─────────────────────────
async function pauseDay() {
  if (!activeDay || activeDay.status !== 'OPEN') { toast('No open day to pause', 'err'); return; }
  await buildDaySummary('pause');
}

// ── PERMANENTLY CLOSE DAY ────────────────────────────────────────────
async function permanentCloseDay() {
  if (!activeDay || activeDay.status !== 'OPEN') { toast('No open day to close', 'err'); return; }
  await buildDaySummary('close');
}


// Refresh Day tab display without re-initializing
async function refreshDayTab() {
  // Reload from DB in case something changed
  const today = todayDateStr();
  const bday = await getBusinessDay(today);
  if (bday) {
    activeDay = bday;
    updateDayBanner();
    if (activeDay.status === 'OPEN') updateDayLiveStats();
  }
  renderDaySessionsList();
}

// ── GUARD: block transactions when day not OPEN ───────────────────────
function isDayOpen() {
  return activeDay && activeDay.status === 'OPEN';
}
function isDayPaused() {
  return activeDay && activeDay.status === 'PAUSED';
}
function isDayActiveToday() {
  // True if today's day can still have operations (OPEN or PAUSED)
  return activeDay && (activeDay.status === 'OPEN' || activeDay.status === 'PAUSED');
}

function requireOpenDay() {
  if (!isDayOpen()) {
    const status = activeDay ? activeDay.status : 'PENDING';
    if (status === 'LOCKED') {
      toast('🔒 Open today\'s business day first.', 'err');
    } else if (status === 'PAUSED') {
      toast('⏸ Day is paused. Reopen to continue.', 'err');
    } else if (status === 'CLOSED') {
      toast('🔒 Day is permanently closed. Start a new day tomorrow.', 'err');
    } else {
      toast('⚠️ Please open the business day first.', 'err');
    }
    showPage('day');
    return false;
  }
  return true;
}

// ── BUILD DAY SUMMARY (shared between pause + permanent close) ────────
// mode: 'pause' | 'close'
let _daySummaryMode = 'pause';

// Legacy alias — Close Day button in banner still works
async function closeDay() {
  await pauseDay();
}

async function buildDaySummary(mode) {
  _daySummaryMode = mode || 'pause';
  if (!activeDay || activeDay.status !== 'OPEN') { toast('No open day', 'err'); return; }

  const sales = await dbAll('sales');
  const daySales = sales.filter(s => (s.business_date === activeDay.business_date) || (activeDay.opened_at && s.date >= activeDay.opened_at));
  const revenue = daySales.reduce((s, x) => s + x.revenue, 0);
  const profit  = daySales.reduce((s, x) => s + x.profit, 0);
  const itemsSold = daySales.reduce((s, x) => s + x.qty, 0);
  const items = await dbAll('items');
  const purchases = items.filter(i => activeDay.opened_at && i.createdAt >= activeDay.opened_at);
  const purchaseCost = purchases.reduce((s, i) => s + i.buy * i.qty, 0);

  // ── Populate rich summary sheet ─────────────────────────────
  document.getElementById('ds-date').textContent = fmtFullDate(activeDay.business_date);
  const openT = activeDay.opened_at ? fmtTime(activeDay.opened_at) : '?';
  const nowT = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  document.getElementById('ds-time-range').textContent = openT + ' → ' + nowT;

  // Financials
  const margin2 = revenue > 0 ? ((profit / revenue) * 100).toFixed(1) : 0;
  const avgSale = daySales.length > 0 ? (revenue / daySales.length) : 0;
  const customPriceCount = daySales.filter(s => s.overridden).length;
  document.getElementById('ds-revenue').textContent = fmt(revenue);
  document.getElementById('ds-profit').textContent = fmt(profit);
  document.getElementById('ds-margin').textContent = margin2 + '%';
  document.getElementById('ds-avg-sale').textContent = fmt(Math.round(avgSale));

  // Sales
  document.getElementById('ds-sales').textContent = daySales.length;
  document.getElementById('ds-items-sold').textContent = itemsSold;
  document.getElementById('ds-custom-price').textContent = customPriceCount;

  // Stock
  const allItems = await dbAll('items');
  const closingStockCost = allItems.reduce((s, i) => s + i.buy * i.qty, 0);
  document.getElementById('ds-opening-stock').textContent = fmt(activeDay.openingStockCost || 0);
  document.getElementById('ds-closing-stock').textContent = fmt(closingStockCost);
  document.getElementById('ds-purchases').textContent = purchases.length + ' item' + (purchases.length !== 1 ? 's' : '');
  document.getElementById('ds-purchases-val').textContent = purchases.length ? fmt(purchaseCost) : 'KES 0';

  // Stock progress bar
  const totalPossibleSold = itemsSold + (allItems.reduce((s, i) => s + i.qty, 0));
  const soldPct = totalPossibleSold > 0 ? Math.min(100, (itemsSold / totalPossibleSold * 100)).toFixed(0) : 0;
  document.getElementById('ds-stock-bar').style.width = soldPct + '%';
  document.getElementById('ds-stock-pct-label').textContent = soldPct + '% of stock moved today';

  document.getElementById('ds-notes').value = activeDay.notes || '';

  // Verdict
  const verdictEl = document.getElementById('ds-verdict');
  let verdict, verdictBg, verdictColor;
  if (daySales.length === 0) {
    verdict = '😴 No sales today. Tomorrow is a new opportunity!';
    verdictBg = 'var(--surface2)'; verdictColor = 'var(--muted)';
  } else {
    const margin = revenue > 0 ? ((profit / revenue) * 100).toFixed(0) : 0;
    verdict = margin >= 30 ? '🔥 Excellent day! ' + margin + '% margin.'
            : margin >= 15 ? '✅ Good day! ' + margin + '% margin.'
            : '👍 Decent day. ' + margin + '% margin.';
    verdictBg = profit > 0 ? 'var(--green-light)' : 'var(--amber-light)';
    verdictColor = profit > 0 ? 'var(--green)' : 'var(--amber)';
  }
  verdictEl.style.cssText = 'background:' + verdictBg + ';color:' + verdictColor + ';border:1px solid ' + verdictColor + ';border-radius:var(--r);padding:14px 16px;margin-bottom:14px;text-align:center;';
  verdictEl.innerHTML = '<div style="font-size:16px;font-weight:800;">' + verdict + '</div>';
  if (activeDay.reopened_count > 0) {
    verdictEl.innerHTML += '<div style="font-size:11px;margin-top:4px;opacity:0.7;">Day was reopened ' + activeDay.reopened_count + ' time(s)</div>';
  }

  // Top seller
  const topSellerEl = document.getElementById('ds-top-seller');
  if (daySales.length > 0) {
    const grouped = {};
    daySales.forEach(s => { grouped[s.itemName] = (grouped[s.itemName] || 0) + s.revenue; });
    const topItems = Object.entries(grouped).sort((a, b) => b[1] - a[1]).slice(0, 3);
    topSellerEl.innerHTML = '<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">🏆 Top Sellers</div>' +
      topItems.map(([ name, rev ], i) =>
        '<div class="detail-box" style="padding:10px 12px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:18px;">' + ['🥇','🥈','🥉'][i] + '</span>' +
        '<div style="flex:1;"><div style="font-size:13px;font-weight:700;">' + name + '</div></div>' +
        '<div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(rev) + '</div></div>'
      ).join('');
  } else {
    topSellerEl.innerHTML = '';
  }

  // Sales by type breakdown
  const typeBreakEl = document.getElementById('ds-type-breakdown');
  if (daySales.length > 0) {
    const byType = {};
    daySales.forEach(s => {
      if (!byType[s.type]) byType[s.type] = { rev: 0, profit: 0, qty: 0 };
      byType[s.type].rev += s.revenue;
      byType[s.type].profit += s.profit;
      byType[s.type].qty += s.qty;
    });
    typeBreakEl.innerHTML = '<div style="font-size:11px;font-weight:700;color:var(--muted);letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">📂 Sales by Category</div>' +
      Object.entries(byType).sort((a,b) => b[1].rev - a[1].rev).map(([type, data]) => {
        const t = getTypeObj(type);
        return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border);">' +
          '<span style="font-size:20px;">' + t.emoji + '</span>' +
          '<div style="flex:1;"><div style="font-size:13px;font-weight:700;">' + type + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' + data.qty + ' pcs sold</div></div>' +
          '<div style="text-align:right;"><div style="font-size:13px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(data.rev) + '</div>' +
          '<div style="font-size:11px;color:var(--green);font-family:var(--mono);">+' + fmt(data.profit) + '</div></div></div>';
      }).join('');
  } else {
    typeBreakEl.innerHTML = '';
  }

  // Update footer buttons based on mode
  const confirmBtn = document.getElementById('ds-confirm-btn');
  const pauseBtn   = document.getElementById('ds-pause-btn');
  if (_daySummaryMode === 'pause') {
    if (confirmBtn) { confirmBtn.style.display = 'none'; }
    if (pauseBtn)   { pauseBtn.style.display = 'block'; pauseBtn.textContent = '⏸ Pause & View Summary'; }
  } else {
    if (confirmBtn) { confirmBtn.style.display = 'block'; }
    if (pauseBtn)   { pauseBtn.style.display = 'none'; }
  }
  document.getElementById('day-summary-sheet').classList.add('open');
}


// Called when user taps the confirm button on summary sheet
async function confirmCloseDay() {
  const notes = document.getElementById('ds-notes').value.trim();
  const now = new Date();
  const sales = await dbAll('sales');
  const daySales = sales.filter(s => (s.business_date === activeDay.business_date) || (activeDay.opened_at && s.date >= activeDay.opened_at));
  const items = await dbAll('items');
  const purchases = items.filter(i => activeDay.opened_at && i.createdAt >= activeDay.opened_at);

  // Shared stats
  const dayStats = {
    notes,
    salesCount: daySales.length,
    revenue: daySales.reduce((s, x) => s + x.revenue, 0),
    profit:  daySales.reduce((s, x) => s + x.profit, 0),
    itemsSold: daySales.reduce((s, x) => s + x.qty, 0),
    purchasesCount: purchases.length,
    purchaseCost: purchases.reduce((s, i) => s + i.buy * i.qty, 0),
    closingStockCost: items.reduce((s, i) => s + i.buy * i.qty, 0),
  };

  if (_daySummaryMode === 'pause') {
    // ── PAUSE: temporary close, can reopen ───────────────────────
    activeDay.status = 'PAUSED';
    activeDay.paused_at = now.toISOString();
    activeDay.pause_count = (activeDay.pause_count || 0) + 1;
    Object.assign(activeDay, dayStats);
    await dbPut('business_days', activeDay);
    document.getElementById('day-summary-sheet').classList.remove('open');
    updateDayBanner();
    renderDaySessionsList();
    renderDashboard();
    _origShowPage('day');
    toast('⏸ Day paused. You can reopen at any time.', 'ok');

  } else {
    // ── PERMANENT CLOSE: read-only, cannot reopen ─────────────────
    activeDay.status = 'CLOSED';
    activeDay.closed_at = now.toISOString();
    Object.assign(activeDay, dayStats);
    await dbPut('business_days', activeDay);
    document.getElementById('day-summary-sheet').classList.remove('open');
    updateDayBanner();
    renderDaySessionsList();
    renderDashboard();
    _origShowPage('day');
    toast('🌙 Day permanently closed. Cannot be reopened.', 'ok');
  }
  scheduleSync();
}

function cancelCloseDay() {
  document.getElementById('day-summary-sheet').classList.remove('open');
}

// ── BANNER UPDATE ─────────────────────────────────────────────────────
function updateDayBanner() {
  if (!activeDay) return;
  const banner = document.getElementById('day-banner');
  const icon = document.getElementById('day-banner-icon');
  const badge = document.getElementById('day-status-badge');
  const title = document.getElementById('day-banner-title');
  const sub = document.getElementById('day-banner-sub');
  const actionArea = document.getElementById('day-action-area');
  const liveSection = document.getElementById('day-live');
  const status = activeDay.status;

  const BTN = 'width:100%;padding:16px;background:';
  const BTN2 = ';color:white;border:none;border-radius:var(--r);font-size:16px;font-weight:800;cursor:pointer;font-family:var(--sans);';
  const pauseCount = activeDay.pause_count || 0;
  const configs = {
    PENDING: {
      bg: 'var(--surface2)', border: 'var(--border)', icon: '📅',
      badgeBg: '#e5e7eb', badgeColor: '#6b7280',
      title: 'Business Day Not Started', titleColor: 'var(--text)',
      sub: 'Auto-opens at 9:00 AM · Or tap to open now',
      action: '<button onclick="openDay()" style="' + BTN + 'var(--accent)' + BTN2 + '"><i class="fa-solid fa-sun"></i> Open Day Now</button>'
    },
    OPEN: {
      bg: 'var(--green-light)', border: '#a8d8b5', icon: '🌅',
      badgeBg: '#dcfce7', badgeColor: '#16a34a',
      title: 'Business Day is Open', titleColor: 'var(--green)',
      sub: 'Opened at ' + (activeDay.last_opened_at ? fmtTime(activeDay.last_opened_at) : fmtTime(activeDay.opened_at)) + (pauseCount > 0 ? ' · Resumed ' + pauseCount + 'x' : ''),
      action:
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
        '<button onclick="pauseDay()" style="' + BTN + '#d97706' + BTN2 + '"><i class="fa-solid fa-pause"></i> Pause Day</button>' +
        '<button onclick="permanentCloseDay()" style="' + BTN + 'var(--red)' + BTN2 + '"><i class="fa-solid fa-lock"></i> Close Day</button>' +
        '</div>'
    },
    PAUSED: {
      bg: '#fef3c7', border: '#f5d9a0', icon: '⏸',
      badgeBg: '#fef3c7', badgeColor: '#92400e',
      title: 'Day is Paused', titleColor: '#d97706',
      sub: 'Paused at ' + (activeDay.paused_at ? fmtTime(activeDay.paused_at) : '—') + ' · Tap to resume operations',
      action: '<button onclick="openDay()" style="' + BTN + '#d97706' + BTN2 + '"><i class="fa-solid fa-play"></i> Resume Day</button>'
    },
    CLOSED: {
      bg: '#fee2e2', border: 'rgba(192,57,43,0.25)', icon: '🔒',
      badgeBg: '#fee2e2', badgeColor: 'var(--red)',
      title: 'Day Permanently Closed', titleColor: 'var(--red)',
      sub: 'Closed at ' + (activeDay.closed_at ? fmtTime(activeDay.closed_at) : '—') + ' · Read-only — cannot be reopened',
      action: '<div style="padding:12px;background:var(--red-light);border-radius:var(--r);color:var(--red);font-size:13px;font-weight:600;text-align:center;">🔒 This day is permanently closed</div>'
    },
    LOCKED: {
      bg: 'var(--surface2)', border: 'var(--border)', icon: '📅',
      badgeBg: '#e5e7eb', badgeColor: '#6b7280',
      title: 'Ready for a New Day', titleColor: 'var(--text)',
      sub: 'Previous day is locked. Open today now',
      action: '<button onclick="openNewDay()" style="' + BTN + 'var(--accent)' + BTN2 + '">🌅 Open Today</button>'
    }
  };

  const cfg = configs[status] || configs.PENDING;
  banner.style.background = cfg.bg;
  banner.style.borderColor = cfg.border;
  icon.textContent = cfg.icon;
  badge.textContent = status;
  badge.style.background = cfg.badgeBg;
  badge.style.color = cfg.badgeColor;
  title.textContent = cfg.title;
  title.style.color = cfg.titleColor;
  sub.textContent = cfg.sub;
  actionArea.innerHTML = cfg.action;
  if (liveSection) liveSection.style.display = status === 'OPEN' ? 'block' : 'none';
  setDayMode(status === 'OPEN');
  if (status === 'OPEN') hideDayClosedOverlay();
}

// ── LIVE STATS ────────────────────────────────────────────────────────
async function updateDayLiveStats() {
  if (!activeDay || activeDay.status !== 'OPEN') return;
  const sales = await dbAll('sales');
  const daySales = sales.filter(s => (s.business_date === activeDay.business_date) || (activeDay.opened_at && s.date >= activeDay.opened_at));
  const items = await dbAll('items');
  const purchases = items.filter(i => activeDay.opened_at && i.createdAt >= activeDay.opened_at);

  const revenue = daySales.reduce((s, x) => s + x.revenue, 0);
  const profit  = daySales.reduce((s, x) => s + x.profit, 0);

  document.getElementById('day-sales-count').textContent = daySales.length;
  document.getElementById('day-revenue').textContent = fmt(revenue);
  document.getElementById('day-profit').textContent = fmt(profit);
  document.getElementById('day-purchases').textContent = purchases.length;

  const salesList = document.getElementById('day-sales-list');
  if (!daySales.length) {
    salesList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0 12px;">No sales yet today — tap 💸 Sell to record one</div>';
  } else {
    salesList.innerHTML = [...daySales].sort((a,b) => new Date(b.date)-new Date(a.date)).map(s => {
      const t = getTypeObj(s.type);
      const time = new Date(s.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">' +
        '<span style="font-size:20px;">' + t.emoji + '</span>' +
        '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;">' + s.itemName + ' × ' + s.qty + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' + time + '</div></div>' +
        '<div style="text-align:right;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(s.revenue) + '</div>' +
        '<div style="font-size:11px;color:var(--green);font-family:var(--mono);">+' + fmt(s.profit) + '</div></div></div>';
    }).join('');
  }

  const purchList = document.getElementById('day-purchases-list');
  if (!purchases.length) {
    purchList.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0 12px;">No new stock added today — tap ➕ Add to record</div>';
  } else {
    purchList.innerHTML = purchases.map(item => {
      const t = getTypeObj(item.type);
      return '<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border);">' +
        '<span style="font-size:20px;">' + t.emoji + '</span>' +
        '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:700;">' + item.name + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' + item.code + ' · ' + item.qty + ' pcs</div></div>' +
        '<div style="text-align:right;"><div style="font-size:14px;font-weight:800;font-family:var(--mono);color:var(--text2);">' + fmt(item.buy * item.qty) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);">' + fmt(item.buy) + '/pc</div></div></div>';
    }).join('');
  }
}

// ── PAST SESSIONS LIST ────────────────────────────────────────────────
async function renderDaySessionsList() {
  const sessions = await dbAll('business_days');
  const done = sessions.filter(s => s.status === 'CLOSED' || s.status === 'LOCKED')
                       .sort((a, b) => new Date(b.business_date) - new Date(a.business_date));
  const list = document.getElementById('day-sessions-list');
  if (!done.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">No closed sessions yet</div>';
    return;
  }
  list.innerHTML = done.map(s => {
    const profitColor = (s.profit||0) > 0 ? 'var(--green)' : (s.profit||0) < 0 ? 'var(--red)' : 'var(--muted)';
    const isLocked = s.status === 'LOCKED';
    const statusLabel = isLocked
      ? '<span style="font-size:11px;background:var(--red-light);color:var(--red);padding:3px 8px;border-radius:20px;font-weight:700;">🔒 LOCKED</span>'
      : '<span style="font-size:11px;background:var(--green-light);color:var(--green);padding:3px 8px;border-radius:20px;font-weight:700;">CLOSED</span>';
    const openedStr = s.opened_at ? fmtTime(s.opened_at) : '—';
    const closedStr = s.closed_at ? fmtTime(s.closed_at) : 'Auto-closed';
    const autoFlag = s.auto_opened || s.auto_closed
      ? '<span style="font-size:10px;color:var(--muted);margin-left:6px;">' + (s.auto_opened ? '⚡auto-opened ' : '') + (s.auto_closed ? '⚡auto-closed' : '') + '</span>'
      : '';
    return '<div class="card" style="margin-bottom:8px;padding:14px;cursor:pointer;" onclick="viewPastSession(' + s.id + ')">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
      '<div><div style="font-size:14px;font-weight:800;color:var(--text);">' + fmtFullDate(s.business_date) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);font-family:var(--mono);margin-top:2px;">' + openedStr + ' → ' + closedStr + autoFlag + '</div></div>' +
      statusLabel + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:15px;font-weight:800;font-family:var(--mono);color:var(--accent2);">' + fmt(s.revenue||0) + '</div><div style="font-size:10px;color:var(--muted);">Revenue</div></div>' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:15px;font-weight:800;font-family:var(--mono);color:' + profitColor + ';">' + fmt(s.profit||0) + '</div><div style="font-size:10px;color:var(--muted);">Profit</div></div>' +
      '<div style="text-align:center;background:var(--surface2);border-radius:8px;padding:8px 4px;"><div style="font-size:15px;font-weight:800;font-family:var(--mono);color:var(--accent);">' + (s.salesCount||0) + '</div><div style="font-size:10px;color:var(--muted);">Sales</div></div>' +
      '</div>' +
      (s.notes ? '<div style="margin-top:8px;font-size:12px;color:var(--muted);font-style:italic;">"' + s.notes + '"</div>' : '') +
      (s.reopened_count > 0 ? '<div style="margin-top:6px;font-size:11px;color:var(--muted);">↩️ Reopened ' + s.reopened_count + ' time(s)</div>' : '') +
      '</div>';
  }).join('');
}

// ── PAST SESSION DETAIL ───────────────────────────────────────────────
async function viewPastSession(sessionId) {
  const s = await dbGet('business_days', sessionId);
  const profitColor = (s.profit||0) > 0 ? 'var(--green)' : (s.profit||0) < 0 ? 'var(--red)' : 'var(--muted)';
  const margin = s.revenue > 0 ? ((s.profit / s.revenue) * 100).toFixed(1) : 0;
  const statusIcon = s.status === 'LOCKED' ? '🔒' : '🌙';

  document.getElementById('past-session-content').innerHTML =
    '<div style="text-align:center;margin-bottom:18px;">' +
    '<div style="font-size:36px;margin-bottom:6px;">' + statusIcon + '</div>' +
    '<div style="font-size:18px;font-weight:800;">' + fmtFullDate(s.business_date) + '</div>' +
    '<div style="font-size:12px;color:var(--muted);font-family:var(--mono);margin-top:4px;">' +
    (s.opened_at ? fmtTime(s.opened_at) : '—') + ' → ' + (s.closed_at ? fmtTime(s.closed_at) : 'auto') +
    ' · Status: <strong>' + s.status + '</strong></div></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">' +
    '<div class="detail-box" style="padding:12px;text-align:center;"><div class="detail-key">SALES</div><div class="detail-val" style="font-size:22px;color:var(--green);">' + (s.salesCount||0) + '</div></div>' +
    '<div class="detail-box" style="padding:12px;text-align:center;"><div class="detail-key">ITEMS SOLD</div><div class="detail-val" style="font-size:22px;color:var(--accent);">' + (s.itemsSold||0) + '</div></div>' +
    '<div class="detail-box" style="padding:12px;text-align:center;"><div class="detail-key">REVENUE</div><div class="detail-val" style="font-size:18px;color:var(--accent2);">' + fmt(s.revenue||0) + '</div></div>' +
    '<div class="detail-box" style="padding:12px;text-align:center;"><div class="detail-key">PROFIT</div><div class="detail-val" style="font-size:18px;color:' + profitColor + ';">' + fmt(s.profit||0) + '</div></div>' +
    '</div>' +
    '<div class="detail-box" style="padding:12px;margin-bottom:10px;"><div class="detail-key">PROFIT MARGIN</div><div class="detail-val" style="font-size:20px;color:var(--accent3);">' + margin + '%</div></div>' +
    '<div class="detail-box" style="padding:12px;margin-bottom:10px;"><div class="detail-key">PURCHASES ADDED</div><div class="detail-val" style="font-size:16px;color:var(--accent3);">' + (s.purchasesCount||0) + ' items · ' + fmt(s.purchaseCost||0) + '</div></div>' +
    (s.auto_opened || s.auto_closed ? '<div class="detail-box" style="padding:12px;margin-bottom:10px;"><div class="detail-key">AUTO FLAGS</div><div style="font-size:13px;color:var(--muted);margin-top:4px;">' + (s.auto_opened ? '⚡ Auto-opened at 9:00 AM<br>' : '') + (s.auto_closed ? '⚡ Auto-closed at 11:59 PM' : '') + '</div></div>' : '') +
    (s.reopened_count > 0 ? '<div class="detail-box" style="padding:12px;margin-bottom:10px;"><div class="detail-key">REOPENED</div><div class="detail-val" style="font-size:16px;color:var(--muted);">' + s.reopened_count + ' time(s)</div></div>' : '') +
    (s.notes ? '<div class="detail-box" style="padding:12px;margin-bottom:10px;"><div class="detail-key">NOTES</div><div style="font-size:14px;color:var(--text);margin-top:6px;font-style:italic;">"' + s.notes + '"</div></div>' : '');

  document.getElementById('past-session-sheet').classList.add('open');
}


function closePastSessionSheet() {
  document.getElementById('past-session-sheet').classList.remove('open');
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



// Guard showPage - block access to restricted tabs
const _origShowPage = showPage;
showPage = function(id) {
  if (currentUser && !currentUser.tabs.includes(id)) {
    toast('⛔ Access denied', 'err');
    return;
  }
  // Block restricted tabs when day is not open (but NOT sheet popups)
  const dayOpen = activeDay && (activeDay.status === 'OPEN');
  if (DAY_RESTRICTED_TABS.includes(id) && !dayOpen) {
    _origShowPage('day');
    setTimeout(() => showDayClosedOverlay(id), 100);
    return;
  }
  hideDayClosedOverlay();
  if (currentUser) localStorage.setItem('mg_last_page', id);
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
      _origShowPage('day');
      setTimeout(() => toast('⚠️ Please open the business day first.', ''), 500);
    } else {
      _origShowPage(allowedPage);
    }
  });
  toast('Welcome, ' + user.name + '! 👋', 'ok');
}

function checkSession() {
  const saved = localStorage.getItem('mg_session');
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
      localStorage.removeItem('mg_session');
      document.getElementById('login-screen').style.display = 'flex';
      return false;
    }
  } catch(e) {
    localStorage.removeItem('mg_session');
    document.getElementById('login-screen').style.display = 'flex';
    return false;
  }
}


// ===== JQUERY ENHANCEMENTS =====


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
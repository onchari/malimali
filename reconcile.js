#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function toNumber(value, fallback = 0) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const arr = Object.values(value);
    return Array.isArray(arr) ? arr.flatMap((entry) =>
      Array.isArray(entry) ? entry : [entry],
    ) : [];
  }
  return [];
}

function computeDrift(data) {
  const items = normalizeArray(data.items);
  const sales = normalizeArray(data.sales);
  const shoeSizes = normalizeArray(data.shoe_sizes || data.shoeSizes);

  const soldByItem = new Map();
  for (const sale of sales) {
    const itemIdRaw = sale.itemId ?? sale.item_id ?? sale.itemCode ?? sale.item_code;
    const itemKey = String(itemIdRaw ?? 'unknown');
    soldByItem.set(itemKey, (soldByItem.get(itemKey) || 0) + toNumber(sale.qty, 0));
  }

  const shoeQtyByItem = new Map();
  for (const size of shoeSizes) {
    const itemIdRaw = size.itemId ?? size.item_id ?? size.itemCode ?? size.item_code;
    const itemKey = String(itemIdRaw ?? 'unknown');
    shoeQtyByItem.set(itemKey, (shoeQtyByItem.get(itemKey) || 0) + toNumber(size.qty, 0));
  }

  const rows = [];
  for (const item of items) {
    const itemIdRaw = item.id ?? item.itemId ?? item.code;
    const itemKey = String(itemIdRaw ?? 'unknown');
    const soldQty = soldByItem.get(itemKey) || 0;
    const currentQty = item.isShoe
      ? shoeQtyByItem.get(itemKey) || toNumber(item.qty, 0)
      : toNumber(item.qty, 0);
    const delta = soldQty - currentQty;
    rows.push({
      itemId: item.id ?? item.itemId ?? item.code ?? itemKey,
      code: item.code || item.name || itemKey,
      name: item.name || item.code || itemKey,
      isShoe: !!item.isShoe,
      soldQty,
      currentQty,
      delta,
    });
  }

  const totalDrift = rows.reduce((sum, row) => sum + row.delta, 0);
  return { rows, totalDrift };
}

function loadDataFromFile(filePath) {
  const abs = path.resolve(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  return JSON.parse(raw);
}

function printUsage() {
  console.log('Usage: node reconcile.js <firestore-export.json>');
  console.log('If you pass no file, a small demo dataset is used so the script can be validated.');
}

function main() {
  const target = process.argv[2];
  const sample = {
    items: [
      { id: 'i1', code: 'A100', name: 'Alpha', qty: 12 },
      { id: 'i2', code: 'B200', name: 'Beta', qty: 9, isShoe: true },
    ],
    shoe_sizes: [
      { itemId: 'i2', size: 39, qty: 5 },
      { itemId: 'i2', size: 40, qty: 4 },
    ],
    sales: [
      { itemId: 'i1', qty: 3 },
      { itemId: 'i1', qty: 2 },
      { itemId: 'i2', qty: 2 },
      { itemId: 'i2', qty: 1 },
    ],
  };

  const data = target ? loadDataFromFile(target) : sample;
  const result = computeDrift(data);

  console.log('Stock drift report');
  console.log('Total drift:', result.totalDrift);
  console.log('Rows:');

  if (!result.rows.length) {
    console.log('No item rows found.');
    return;
  }

  for (const row of result.rows) {
    console.log(
      `${row.code} | sold=${row.soldQty} | current=${row.currentQty} | delta=${row.delta} | shoe=${row.isShoe ? 'yes' : 'no'}`,
    );
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('reconcile.js failed:', error.message);
    printUsage();
    process.exitCode = 1;
  }
}

module.exports = { computeDrift, normalizeArray, toNumber };

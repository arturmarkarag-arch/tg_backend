'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const products = fs.readFileSync(path.join(root, 'routes/products.js'), 'utf8');
const model = fs.readFileSync(path.join(root, 'utils/warehouseStockEstimate.js'), 'utf8');
const orders = fs.readFileSync(path.join(root, 'routes/orders.js'), 'utf8');
const supplements = fs.readFileSync(path.join(root, 'services/supplementOffers.js'), 'utf8');
const { buildWarehouseStockEstimate } = require('../utils/warehouseStockEstimate');

function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`);
  if (!condition) process.exitCode = 1;
}

check(products.includes("router.get('/warehouse-stats', staffOnly"), 'warehouse stats endpoint is staff-only');
check(products.includes("orderType: { $ne: 'direct_allocation' }"), 'mandatory/direct allocation is not counted as seller ordering');
check(products.includes('SupplementRequest.aggregate'), 'supplement package requests are included');
check(products.includes('ReceiptItem.find') && products.includes('totalQty'), 'received quantity comes from ReceiptItem reference data');
check(model.includes('informationalOnly: true'), 'calculator is explicitly informational-only');
check(orders.includes('quantityPerPackage: Number(product?.quantityPerPackage || 0)'), 'current-order API exposes pack size for package-aware seller UI');
check(supplements.includes('quantityPerPackage: Number(product.quantityPerPackage || 0)') && supplements.includes('price quantityPerPackage imageUrls'), 'supplement offers expose current pack size');

const positive = buildWarehouseStockEstimate({ receivedQty: 1000, regularOrderedPackages: 6, supplementOrderedPackages: 2, quantityPerPackage: 50 });
assert.equal(positive.orderedPackages, 8);
assert.equal(positive.orderedUnits, 400);
assert.equal(positive.estimatedRemaining, 600);
check(true, 'package multiplier: 8 × 50 = 400 units; 1000 - 400 = 600');

const negative = buildWarehouseStockEstimate({ receivedQty: 100, regularOrderedPackages: 3, quantityPerPackage: 50 });
assert.equal(negative.estimatedRemaining, -50);
check(true, 'estimate is allowed to go negative');

const unknownPack = buildWarehouseStockEstimate({ receivedQty: 100, regularOrderedPackages: 3, quantityPerPackage: 0 });
assert.equal(unknownPack.estimatedRemaining, null);
check(true, 'no fake estimate is produced without pack size');

const legacyWithoutReceiptData = buildWarehouseStockEstimate({ receivedQty: null, regularOrderedPackages: 3, quantityPerPackage: 50 });
assert.equal(legacyWithoutReceiptData.receivedQty, null);
assert.equal(legacyWithoutReceiptData.estimatedRemaining, null);
check(true, 'legacy product without receiving data stays unknown instead of becoming a fake zero/negative balance');

if (!process.exitCode) console.log('V47.5 warehouse estimate checks: PASS');

'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const model = read('models/ReceiptItem.js');
const permissions = read('utils/receiptPermissions.js');
const routes = read('routes/receipts.js');
const errors = read('utils/errors.js');

// Stage 1 does not make an untouched product look commercially ready.
assert.match(model, /price:\s*\{ type: Number, default: null \}/);
assert.match(model, /qtyPerPackage:\s*\{ type: Number, default: null \}/);

// Stage 2 is a server contract, not only a UI convention.
assert.match(permissions, /function preparationMissingFields\(item\)/);
assert.match(permissions, /Number\(item\?\.price\) > 0/);
assert.match(permissions, /Number\(item\?\.qtyPerPackage\) >= 1/);
assert.match(permissions, /function assertItemReadyForRouting\(item\)/);
assert.match(errors, /receipt_item_not_prepared/);

// Current routing endpoint checks readiness and re-checks it in the atomic CAS.
// Modern routingVersion>=1 rows deliberately do NOT require received quantity;
// legacy rows keep that stock-bearing guard.
assert.match(routes, /assertItemReadyForRouting\(authItem\)/);
assert.match(routes, /status:\s*'draft',[\s\S]*photoUrl:\s*\{ \$nin: \['', null\] \},[\s\S]*routingVersion[\s\S]*price:\s*\{ \$gt: 0 \},[\s\S]*qtyPerPackage:\s*\{ \$gte: 1 \}/);
assert.match(routes, /Number\(authItem\.routingVersion \|\| 0\) >= 1 \? \{\} : \{ totalQty: \{ \$gte: 1 \} \}/);
assert.match(routes, /if \(currentItem\.status === 'draft'\) assertItemReadyForRouting\(currentItem\)/);
assert.match(permissions, /!isModernReceiptItem\(item\)[\s\S]*Number\.isInteger\(Number\(item\?\.totalQty\)\)[\s\S]*Number\(item\?\.totalQty\) >= 1/);

// Batch routing is not allowed to bypass the same preparation gate.
assert.match(routes, /router\.patch\('\/items\/routing-batch'[\s\S]*assertItemReadyForRouting\(item\)/);

// Modern mass intake creates completed technical receipts with draft items and
// unknown received quantity, instead of forcing a fake zero.
assert.match(routes, /router\.post\('\/bulk-intake'[\s\S]*intakeMode:\s*'bulk'[\s\S]*status:\s*'draft'[\s\S]*routingVersion:\s*1[\s\S]*totalQty:\s*null/);

// Cached legacy create cannot smuggle a destination through before preparation.
assert.match(routes, /else if \(parsed\.fields\.destination !== undefined\)[\s\S]*assertItemReadyForRouting\(\{[\s\S]*price: initialPrice,[\s\S]*qtyPerPackage: initialQtyPerPackage/);

// Confirm follows the staged order: preparation missing fields are reported
// before route completeness is evaluated.
const confirmStart = permissions.indexOf('function assertItemReadyToConfirm');
const confirmBody = permissions.slice(confirmStart, permissions.indexOf('module.exports'));
assert.ok(confirmBody.indexOf("throw appError('receipt_item_incomplete'") < confirmBody.indexOf('validateReceiptItemRouting'));

console.log('V47.10 server staged receipt pipeline checks: PASS');

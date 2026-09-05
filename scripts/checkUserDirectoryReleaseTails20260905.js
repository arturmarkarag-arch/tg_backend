'use strict';

// Static release-tail contract for the 2026-09-05 user-directory patch.
// No DB connection, no writes, no project dependencies required.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const failures = [];
const ok = (condition, message) => {
  if (condition) console.log(`PASS ${message}`);
  else { console.error(`FAIL ${message}`); failures.push(message); }
};

function objectBody(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  return match ? match[1] : '';
}

const retiredCartKeys = ['orderItems', 'orderItemIds', 'lastOrderPositions', 'lastViewedOrderNumber', 'currentPage'];
for (const rel of ['scripts/wipeOrderCycle.js', 'scripts/preprodWipe.js']) {
  const source = read(rel);
  const cartDefault = objectBody(source, 'CART_DEFAULT');
  ok(Boolean(cartDefault), `${rel}: CART_DEFAULT found`);
  for (const key of ['navigationSessionId', 'lastViewedProductId', 'currentIndex', 'updatedAt']) {
    ok(new RegExp(`\\b${key}\\s*:`).test(cartDefault), `${rel}: CART_DEFAULT keeps ${key}`);
  }
  for (const key of retiredCartKeys) {
    ok(!new RegExp(`\\b${key}\\s*:`).test(cartDefault), `${rel}: CART_DEFAULT does not recreate ${key}`);
  }
  ok(source.includes('$set: { cartState: CART_DEFAULT, miniAppState: MINIAPP_DEFAULT, history: [] }'), `${rel}: reset replaces cartState with canonical object`);
}

const live = read('scripts/liveOrderPickingE2E.js');
ok(live.includes('await User.collection.updateOne('), 'live E2E seeds legacy raw fields through native Mongo collection');
ok(live.includes("old-client currentPage is accepted but not persisted"), 'live E2E verifies old currentPage is ignored');
ok(live.includes("legacy orderItems are not returned by canonical cartState"), 'live E2E verifies legacy items are not exposed');
ok(live.includes("navigation save does not erase pre-existing legacy cartState.orderItems"), 'live E2E verifies navigation save is not hidden cleanup');

const warehouse = read('routes/warehouseTest.js');
for (const key of ['targetSellerCartHasItems', 'targetSellerCartItemCount', 'cartHasItems:', 'cartItemCount:', 'crossGroup: true']) {
  ok(!warehouse.includes(key), `warehouse test no longer writes retired transfer field ${key}`);
}

const errors = read('utils/errors.js');
ok(!errors.includes('transfer_cart_decision_required'), 'dead transfer_cart_decision_required error removed');

const user = read('models/User.js');
const userCart = user.match(/cartState:\s*\{([\s\S]*?)\n\s*\},\n\s*history:/)?.[1] || '';
for (const key of ['navigationSessionId', 'lastViewedProductId', 'currentIndex', 'updatedAt']) {
  ok(new RegExp(`\\b${key}\\s*:`).test(userCart), `User.cartState keeps ${key}`);
}
for (const key of retiredCartKeys) {
  ok(!new RegExp(`\\b${key}\\s*:`).test(userCart), `User.cartState does not define ${key}`);
}

const leftovers = read('scripts/checkOrderCycleLeftovers.js');
ok(leftovers.includes('legacy cartState.currentPage (має бути 0)'), 'leftover checker labels currentPage as legacy residue');
ok(leftovers.includes('legacy cartState.orderItems (має бути 0)'), 'leftover checker detects legacy orderItems residue');
ok(leftovers.includes('legacy cartState.orderItemIds (має бути 0)'), 'leftover checker detects legacy orderItemIds residue');

if (failures.length) {
  console.error(`\n${failures.length} release-tail contract check(s) failed.`);
  process.exit(1);
}
console.log('\nUser-directory release tails: PASS');

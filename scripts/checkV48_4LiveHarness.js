'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let failed = 0;
const check = (cond, msg) => {
  if (!cond) { failed += 1; console.error(`FAIL: ${msg}`); }
  else console.log(`PASS: ${msg}`);
};

for (const rel of ['scripts/liveOrderPickingE2E.js', 'scripts/liveOrderPickingMassE2E.js']) {
  const src = read(rel);
  check(src.includes('getOrderingWindowOpenAt'), `${rel} derives the synthetic cycle boundary`);
  check(src.includes('firstBlockPlacedAt: availableBeforeOpen'), `${rel} marks synthetic products available before opening`);
  check(src.includes('getOrderingWindowOpenAt(openSchedule).getTime() - 60_000'), `${rel} backdates only the synthetic placement marker`);
}

const orders = read('routes/orders.js');
check(orders.includes('product.firstBlockPlacedAt || product.shelvedAt || product.createdAt'), 'production availability cutoff is unchanged');
check(orders.includes('new Date(availableStamp) > new Date(orderingCycleOpenAt)'), 'production cycle cutoff remains enforced');

if (failed) process.exit(1);
console.log('V48.4 live E2E harness availability: PASS');

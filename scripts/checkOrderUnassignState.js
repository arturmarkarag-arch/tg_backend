'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    if (!fn()) throw new Error('assertion returned false');
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

const status = require('../utils/orderStatus');
const orderModel = read('models/Order.js');
const unassign = read('services/unassignSeller.js');
const migrate = read('services/migrateSellerShop.js');
const closure = read('services/sessionClosure.js');
const summary = read('utils/sessionSummaryMath.js');
const migration = read('services/orderUnassignStateMigration.js');
const boot = read('index.js');

check('existing order-status recomputation API is preserved', () =>
  typeof status.resolveOrderStatusAfterCancel === 'function');

check('new_unassign exists in canonical status vocabulary', () =>
  status.ORDER_STATUS.NEW_UNASSIGN === 'new_unassign' &&
  status.ORDER_STATUS_VALUES.includes('new_unassign'));

check('new_unassign is not active operational work', () =>
  !status.ACTIVE_ORDER_STATUSES.includes('new_unassign') &&
  status.isParkedOrderStatus('new_unassign') &&
  !status.isOperationalOrderStatus('new_unassign'));

check('Order schema imports canonical status vocabulary', () =>
  orderModel.includes("require('../utils/orderStatus')") &&
  orderModel.includes('enum: ORDER_STATUS_VALUES'));

check('unassign parks by status without destroying ownership', () =>
  unassign.includes('ord.status = ORDER_STATUS.NEW_UNASSIGN') &&
  !unassign.includes('ord.shopId = null') &&
  !unassign.includes('ord.buyerSnapshot.shopId = null') &&
  !unassign.includes("ord.buyerSnapshot.deliveryGroupId = ''"));

check('assignment finds explicit parked state', () =>
  migrate.includes('status: ORDER_STATUS.NEW_UNASSIGN'));

check('assignment restores parked mutable order to new', () =>
  migrate.includes('if (restoredFromUnassign) activeOrder.status = ORDER_STATUS.NEW'));

check('session closure recognizes explicit parked state', () =>
  closure.includes('isParkedOrderStatus(o?.status)'));

check('session summary excludes parked state from operational denominator', () =>
  summary.includes('isOperationalOrderStatus(o.status)'));

check('legacy parked rows are migrated idempotently without guessing ownership', () =>
  migration.includes('status: { $in: ACTIVE_ORDER_STATUSES }') &&
  migration.includes("orderingSessionId: { $gt: '' }") &&
  migration.includes('status: ORDER_STATUS.NEW_UNASSIGN') &&
  !migration.includes('buyerSnapshot.shopId:') &&
  !migration.includes('buyerSnapshot.deliveryGroupId:'));

check('legacy parked migration runs before critical Order index sync', () =>
  boot.indexOf('migrateLegacyParkedOrders()') > -1 &&
  boot.indexOf('migrateLegacyParkedOrders()') < boot.indexOf("key: 'orders'"));

console.log(`\nORDER UNASSIGN STATE: ${failed ? 'FAIL' : 'PASS'} (${passed}/${passed + failed})`);
if (failed) process.exit(1);

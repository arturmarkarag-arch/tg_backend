'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let failed = 0;
function check(label, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
  if (!ok) failed += 1;
}

const receipts = read('routes/receipts.js');
const receiptModel = read('models/Receipt.js');
const itemModel = read('models/ReceiptItem.js');
const permissions = read('utils/receiptPermissions.js');
const telegram = read('services/receiptNewProductTelegram.js');
const orderLane = read('services/productOrderNumber.js');
const index = read('index.js');
const products = read('routes/products.js');
const archive = read('routes/archive.js');
const correction = read('services/receiptRoutingCorrectionCommand.js');
const warehouseTest = read('routes/warehouseTest.js');
const artifacts = read('services/receiptRoutingArtifacts.js');

check('bulk-intake command exists and caps one selection at 100 items',
  receipts.includes("router.post('/bulk-intake'") && receipts.includes('incoming.length > 100'));
check('bulk-intake creates one completed technical receipt',
  receipts.includes("status: 'completed'") && receipts.includes("intakeMode: 'bulk'") && receipts.includes('intakeBatchId: batchId'));
check('bulk-intake creates modern draft items with nullable received quantity',
  receipts.includes("status: 'draft'") && receipts.includes('routingVersion: 1') && receipts.includes('totalQty: null'));
check('bulk command identity has DB unique backstops',
  receiptModel.includes('{ intakeBatchId: 1 }') && receiptModel.includes("partialFilterExpression: { intakeBatchId: { $type: 'string' } }")
  && itemModel.includes('{ receiptId: 1, intakeClientItemId: 1 }') && itemModel.includes("partialFilterExpression: { intakeClientItemId: { $type: 'string' } }"));
check('bulk identity indexes are startup-critical',
  index.includes("key: 'receipt_bulk_intake_identity'") && index.includes('models: [Receipt, ReceiptItem]'));

check('received quantity is an optional positive integer end-to-end',
  receipts.includes('function parseOptionalPositiveInt')
  && receipts.includes('Number.isInteger(n) || n < 1')
  && !receipts.includes('parseOptionalPositiveNumber'));
check('price parser keeps decimal comma support',
  receipts.includes('function parseNumberField') && receipts.includes("replace(',', '.')"));
check('totalQty is nullable positive-integer metadata in schema',
  /totalQty:\s*\{[\s\S]*type:\s*Number,[\s\S]*default:\s*null,[\s\S]*Number\.isInteger\(value\)[\s\S]*value >= 1[\s\S]*\}/.test(itemModel));
check('modern readiness omits totalQty while legacy still requires it',
  permissions.includes('isModernReceiptItem') && permissions.includes('if (!isModernReceiptItem(item)')
  && permissions.includes("missing.push('кількість що приїхала')"));
check('single and batch routing share Stage-2 readiness',
  (receipts.match(/assertItemReadyForRouting\(item\);/g) || []).length >= 2);
check('Telegram route copy is Буде на лайках',
  telegram.includes("'Буде на лайках'") && !telegram.includes("'На лайки'"));
check('Telegram package quantity includes шт unit',
  telegram.includes('`Кількість: ${displayNumber(snapshot.qtyPerPackage)} шт`'));
check('Product order allocation owns one re-entrant global lane through commit',
  orderLane.includes('AsyncLocalStorage') && orderLane.includes('lockContext.getStore()?.held === true')
  && orderLane.includes("const LOCK_NAME = 'product-order-number'"));
check('all Product creation/correction lanes participate in the global order lock',
  (products.match(/withProductOrderNumberLock/g) || []).length >= 4
  && archive.includes('withProductOrderNumberLock')
  && correction.includes('withProductOrderNumberLock')
  && warehouseTest.includes('withProductOrderNumberLock')
  && artifacts.includes('allocateProductOrderNumber'));

const productOrderSources = [receipts, products, archive, correction, warehouseTest, artifacts].join('\n');
check('legacy direct Product max-order allocator is absent',
  !/Product\.findOne\([\s\S]{0,220}?sort\(\{\s*orderNumber:\s*-1/i.test(productOrderSources));

if (failed) {
  console.error(`Receipt mass-intake contract: FAIL (${failed}/15)`);
  process.exit(1);
}
console.log('Receipt mass-intake contract: PASS (15/15)');

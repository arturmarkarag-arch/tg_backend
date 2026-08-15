'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const check = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('PASS:', msg);
};

const receipts = read('routes/receipts.js');
const permissions = read('utils/receiptPermissions.js');
const offers = read('services/supplementOffers.js');
const model = read('models/ReceiptItem.js');

check(model.includes('Version 2 = current flow') && model.includes('unassigned until batch publication'),
  'ReceiptItem documents batch-v2 unassigned supplement semantics');
check(permissions.includes('allowSupplementWithoutGroup: currentBatchSupplement'),
  'Current regular supplement items may confirm before a group is chosen');
check(receipts.includes('routing.supplementDeliveryGroupId ? 1 : 2'),
  'Routing marks unassigned supplement items as batch v2');
check(receipts.includes("withLock('supplement-batch:publish'"),
  'A global publish lock protects the shared unassigned ready pool');
check(receipts.includes("'routing.supplementDeliveryGroupId': null") && receipts.includes("'routing.supplementDeliveryGroupId': deliveryGroupId"),
  'Publish accepts unassigned rows and assigns the selected group server-side');
check(receipts.includes('readyCount') && receipts.includes('targets: targets.groups || []'),
  'Pending batch API returns ready unassigned count and group choices');
check(offers.includes("if (!routing.supplement || !item.createdProductId || !routing.supplementDeliveryGroupId) continue;"),
  'No SupplementOffer can exist before batch group assignment');
check(receipts.includes("notifyOffers(notificationOffers, 'opened')") && receipts.includes('if (!result.failed)'),
  'Batch still sends one grouped notification only after complete offer creation');

if (process.exitCode) process.exit(process.exitCode);

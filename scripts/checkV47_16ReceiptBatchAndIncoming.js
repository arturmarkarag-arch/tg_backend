'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const check = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('PASS:', msg);
};

const itemModel = read('models/ReceiptItem.js');
const blocks = read('routes/blocks.js');
const badges = read('routes/navBadges.js');
const receipts = read('routes/receipts.js');
const offers = read('services/supplementOffers.js');
const scheduler = read('services/supplementScheduler.js');
const notify = read('services/supplementNotify.js');
const waves = read('services/supplementWaveService.js');

check(blocks.includes("orderingEnabled: { $ne: false }") && blocks.includes("router.get('/incoming/products'"),
  'Incoming still excludes legacy technical Products; new Wave rows need none');
check(badges.includes("orderingEnabled: { $ne: false }") && badges.includes("{ source: 'receipt' }"),
  'Incoming nav badge mirrors placement semantics including receipt qty=0');
check(itemModel.includes('supplementBatchVersion') && itemModel.includes('supplementPublishRequestedAt'),
  'ReceiptItem stores migration-free supplement batch state');
check(receipts.includes("router.get('/supplement-batches/pending'") && receipts.includes("router.post('/supplement-batches/:deliveryGroupId/publish'"),
  'Batch list and publish endpoints exist');
check(receipts.includes('readyCount') && receipts.includes("withLock('supplement-batch:publish'"),
  'Current batch exposes unassigned ready items and serializes group assignment globally');
check(receipts.includes('existingPublications') && receipts.includes('blockedItemIds'),
  'Publishing pins one exact target and consumes the item-global READY lifecycle');
check(receipts.includes('routing.supplementDeliveryGroupId ? 1 : 2') && receipts.includes('supplementPublishRequestedAt: null'),
  'New unassigned supplements enter current batch-v2 state while grouped legacy rows stay v1');
check(receipts.includes('item.supplementBatchVersion = currentRouting.supplementDeliveryGroupId ? 1 : 2') && receipts.includes('item.supplementPublishRequestedAt = null'),
  'Confirm keeps unassigned current supplement drafts in batch v2');
check(offers.includes('if (Number(item.supplementBatchVersion || 0) >= 1) continue'),
  'Legacy offer creation cannot steal current Wave/batch items');
check(receipts.includes('createWaveWithItems({') && waves.includes('ensureContainer') && waves.includes('SupplementOffer.bulkWrite') && waves.includes('revision: nextRevision(current)') && waves.includes("require('../utils/supplementState')"),
  'Explicit publication reuses one group-session container and bulk-applies item revisions');
check(receipts.includes("notifyWaves([result.wave], 'opened')") && receipts.indexOf('notifyWaves([result.wave]') > receipts.indexOf('await mongoSession.endSession'),
  'Immediate batch sends one Wave notification only after transaction completion');
check(!offers.includes("await notifyOffers(openedThisTick, 'opened')") && scheduler.includes('findDueReminders'),
  'Deferred reconciliation leaves notification batching to scheduler-wide unnotified pass');
check(offers.includes('.limit(500)'), 'Deferred reconciliation capacity covers large multi-receipt batches');
check(notify.includes('offersCount') && notify.includes('byGroup'), 'Notification text/count is grouped by delivery group');
check(receipts.includes('receipt_supplement_batch_changed'), 'Receipt lifecycle emits live batch-cache invalidation event');

if (process.exitCode) process.exit(process.exitCode);

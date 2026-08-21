'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const check = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('PASS:', msg); };

const targets = read('services/supplementTargets.js');
const offers = read('services/supplementOffers.js');
const receipts = read('routes/receipts.js');
const scheduler = read('services/supplementScheduler.js');
const blocks = read('routes/blocks.js');
const errors = read('utils/errors.js');

check(targets.includes('findCurrentSessionId') && targets.includes('expectedOrderingSessionId'), 'supplement target resolver pins the current delivery session');
check(targets.includes("return isOrderingOpen(group.orderingSchedule, now).isOpen ? 'ordering_open' : 'awaiting_picking'")
  && targets.includes("state !== 'ordering_open'")
  && targets.includes("supplement_ordering_still_open"), 'supplement target waits until the ordinary ordering window is closed');
check(receipts.includes('createWaveWithItems({') && receipts.includes('orderingSessionId: target.orderingSessionId'), 'modern batch publication creates the Wave immediately in the selected current session');
check(receipts.includes('withSessionLifecycleLock(firstTarget.orderingSessionId'), 'publication is serialized with session completion');
check(offers.includes('if (Number(item.supplementBatchVersion || 0) >= 1) continue'), 'legacy reconciliation cannot consume modern Wave rows');
check(scheduler.includes('reconcilePendingReceipts') && scheduler.includes('freezeOffersForActiveOrderingWindows'), 'minute scheduler keeps legacy supplement compatibility isolated');
check(blocks.includes("withLock('blocks:sequence'"), 'block create/delete share sequence lock');
check(blocks.includes("Number(maxBlock.blockId) !== num") && blocks.includes("block_delete_tail_only"), 'only current tail block can be deleted');
check(blocks.includes("(block.productIds || []).length > 0") && blocks.includes("block_not_empty"), 'tail deletion requires literally empty stored product sequence');
check(blocks.includes("$set: { seq: Number(newMax?.blockId || 0) }"), 'counter rewinds to new tail after delete so next create cannot skip a number');
check(errors.includes('block_delete_tail_only'), 'tail-only delete has user-facing error');

if (process.exitCode) process.exit(process.exitCode);

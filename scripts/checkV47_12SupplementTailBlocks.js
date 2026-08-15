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

check(targets.includes('allowDeferred = false'), 'supplement target resolver supports deferred preparation');
check(targets.includes("state: 'ordering_open'") && targets.includes('Дозамовлення можна підготувати зараз'), 'open ordinary session is informational, not a UI prohibition');
check(offers.includes('if (target.deferred)') && offers.includes("supplementStatus: 'pending'"), 'offer creation defers while ordinary ordering is open');
check(offers.includes('deferred === 0'), 'receipt remains pending until every deferred offer can open');
check(receipts.match(/allowDeferred:\s*true/g)?.length >= 3, 'routing/confirm/commit all allow deferred supplement preparation');
check(scheduler.includes('reconcilePendingReceipts') && scheduler.includes('60 * 1000'), 'minute scheduler retries deferred supplement receipts automatically');
check(blocks.includes("withLock('blocks:sequence'"), 'block create/delete share sequence lock');
check(blocks.includes("Number(maxBlock.blockId) !== num") && blocks.includes("block_delete_tail_only"), 'only current tail block can be deleted');
check(blocks.includes("(block.productIds || []).length > 0") && blocks.includes("block_not_empty"), 'tail deletion requires literally empty stored product sequence');
check(blocks.includes("$set: { seq: Number(newMax?.blockId || 0) }"), 'counter rewinds to new tail after delete so next create cannot skip a number');
check(errors.includes('block_delete_tail_only'), 'tail-only delete has user-facing error');

if (process.exitCode) process.exit(process.exitCode);

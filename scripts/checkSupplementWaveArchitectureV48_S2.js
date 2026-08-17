'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}
const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

const waveModel = read('models/SupplementWave.js');
const offerModel = read('models/SupplementOffer.js');
const requestModel = read('models/SupplementRequest.js');
const waveService = read('services/supplementWaveService.js');
const targets = read('services/supplementTargets.js');
const supplement = read('routes/supplement.js');
const receipts = read('routes/receipts.js');
const correction = read('services/receiptRoutingCorrectionCommand.js');
const artifacts = read('services/receiptRoutingArtifacts.js');
const routing = read('utils/receiptRouting.js');
const status = read('utils/sessionStatus.js');
const closure = read('services/sessionClosure.js');
const topology = read('services/shopTopologyCommand.js');
const products = read('routes/products.js');
const orders = read('routes/orders.js');
const exclusion = read('services/supplementSessionExclusion.js');
const notify = read('services/supplementNotify.js');
const scheduler = read('services/supplementScheduler.js');
const picking = read('routes/picking.js');
const shiftProjection = read('services/readModels/supplementShiftActivityReadModel.js');
const docs = read('docs/supplement/readme.md');
const indexRuntime = read('index.js');

console.log('V48.S2 SUPPLEMENT WAVE ARCHITECTURE — SERVER');
console.log('---------------------------------------------');

check('Wave owns one delivery group and one OrderingSession',
  waveModel.includes('deliveryGroupId')
  && waveModel.includes('orderingSessionId')
  && /status:[\s\S]*open[\s\S]*frozen[\s\S]*completed[\s\S]*cancelled/.test(waveModel));
const warehouseProductFn = stripComments(functionSlice(routing, 'needsWarehouseProduct'));
check('new supplement item can be standalone without fake Product',
  /productId:\s*\{[^}]*default:\s*null/.test(offerModel)
  && /return\s+!!(?:r|routing)\.warehouse/.test(warehouseProductFn)
  && !/supplement/.test(warehouseProductFn));
const targetRuntime = stripComments(targets);
check('target resolver uses current session identity rather than time heuristics',
  targetRuntime.includes('findCurrentSessionId')
  && targetRuntime.includes('expectedOrderingSessionId')
  && !/closed.{0,30}(minutes|min|хв)/i.test(targetRuntime)
  && !/morning|ранок/i.test(targetRuntime));
check('target resolver rejects upcoming and completed sessions',
  targets.includes('supplement_target_session_not_started')
  && targets.includes('supplement_target_session_completed')
  && targets.includes('new Date(session.openAt).getTime() > now.getTime()'));
check('batch publication pins and revalidates exact session',
  receipts.includes('expectedOrderingSessionId')
  && receipts.includes('withSessionLifecycleLock(firstTarget.orderingSessionId')
  && receipts.includes('orderingSessionId: target.orderingSessionId'));

check('one ReceiptItem may publish independently to multiple current sessions/groups',
  receipts.includes('published at least once')
  && receipts.includes("orderingSessionId: target.orderingSessionId")
  && receipts.includes("existingTargetItems")
  && receipts.includes("readyCount: readyCountForTarget")
  && !/supplementPublishRequestedAt:\s*null,[\s\S]{0,500}createWaveWithItems/.test(receipts));
check('active Wave child follows warehouse/standalone routing correction',
  correction.includes("SupplementOffer.updateMany")
  && correction.includes("productId: item.createdProductId || null")
  && correction.includes("sourceSnapshotFromReceiptItem(item)"));
check('obsolete supplement-session drop script is a safe tombstone',
  read('scripts/dropSupplementSessionField.js').includes('retired by V48.S2')
  && !read('scripts/dropSupplementSessionField.js').includes('mongoose.connect'));
check('one publication creates Wave then child items in one transaction',
  receipts.includes('createWaveWithItems({')
  && waveService.includes('SupplementWave.create')
  && waveService.includes('SupplementOffer.bulkWrite'));
check('seller new-Wave access is exact-session scoped',
  supplement.includes('str(wave.orderingSessionId) !== ctx.orderingSessionId')
  && supplement.includes('orderingSessionId: ctx.orderingSessionId'));
check('OPEN allows seller request writes and FROZEN blocks them',
  supplement.includes("effective !== 'open'")
  && supplement.includes("throw appError('supplement_closed')"));
check('packing is impossible before Wave freeze',
  waveService.includes("wave.status !== 'frozen'")
  && supplement.includes("effective !== 'frozen'")
  && supplement.includes("supplement_pack_before_freeze"));
check('packed flag is not the normal Wave seller lifecycle authority',
  docs.includes('`packed` не є seller lock')
  && supplement.includes('corruption guard'));
check('Wave freeze updates item compatibility status and emits lifecycle event',
  waveService.includes("status: 'frozen'")
  && waveService.includes("supplement_wave_frozen"));
check('Wave freeze/cancel aggregate transitions are transaction-atomic',
  (waveService.match(/withTransaction/g) || []).length >= 2
  && waveService.includes("await existing.save({ session: mongoSession })")
  && waveService.includes("await wave.save({ session: mongoSession })"));
check('target list disables future/current-empty groups and publish revalidates shops',
  targets.includes("!['completed', 'upcoming_not_started'].includes(state)")
  && targets.includes('shopCount > 0')
  && targets.includes('Shop.exists({ deliveryGroupId: gid, isActive: true })'));
check('Wave completion waits for all active child items',
  waveService.includes("activeItems.some((item) => item.status !== 'completed')")
  && waveService.includes("status: 'completed'"));
check('OrderingSession completion blocks exact-session active Waves',
  status.includes('SupplementWave.countDocuments')
  && status.includes('orderingSessionId: String(orderingSessionId)')
  && closure.includes("active_supplement_waves"));
check('Shop group move guard respects active Wave ownership',
  topology.includes('SupplementWave')
  && topology.includes('orderingSessionId')
  && topology.includes('активне дозамовлення'));
check('ordinary seller catalog uses shared same-session Wave exclusion',
  products.includes('getSupplementExcludedProductIds')
  && exclusion.includes('orderingSessionId')
  && exclusion.includes("itemStatus: 'active'")
  && exclusion.includes("waveId: { $ne: null }"));
check('ordinary order write boundary rejects same-session Wave Product',
  orders.includes('assertProductOrdinaryOrderable')
  && (orders.match(/assertProductOrdinaryOrderable/g) || []).length >= 3
  && read('utils/errors.js').includes('product_supplement_session_only'));
check('modern notifications are Wave-level and legacy queries exclude Wave rows',
  notify.includes('notifyWaves')
  && notify.includes('SupplementWave')
  && (notify.match(/waveId: null/g) || []).length >= 2);
check('scheduler keeps automatic ordinary-window freeze legacy-only',
  scheduler.includes('freezeOffersForActiveOrderingWindows')
  && read('services/supplementOffers.js').includes("status: 'open', waveId: null"));
check('route correction is compensating, not unconfirm/delete/recreate',
  correction.includes('withdrawReceiptItemFromActiveWaves')
  && correction.includes('archiveProductInSession')
  && correction.includes('publishArchiveProductOutcome')
  && correction.includes('maybeCompleteSession')
  && receipts.includes("routing-correction"));
check('route correction archives obsolete warehouse Product inside the correction transaction',
  correction.includes('withTransaction')
  && correction.includes('archiveProductInSession')
  && !correction.includes('await archiveProduct(')
  && read('services/archiveProduct.js').includes('archiveProductInSession'));
check('route correction preserves already packed shop facts',
  correction.includes('alreadyFulfilledShopIds')
  && waveService.includes('const packed = requests.filter((r) => r.packed)')
  && waveService.includes('const unpacked = requests.filter((r) => !r.packed)'));
check('completed Wave history is not rewritten by routing correction',
  waveService.includes("status: { $in: ACTIVE_WAVE_STATUSES }")
  && docs.includes('Completed Wave history не переписується'));
check('warehouse Product creation is controlled only by warehouse routing',
  artifacts.includes('if (!needsWarehouseProduct(routing)) return null')
  && docs.includes('`productId=null` є нормальним станом'));
check('active supplement counters can be exact-session scoped',
  read('services/supplementOffers.js').includes('orderingSessionId = null')
  && picking.includes('countActiveOffersForGroup(groupId, { orderingSessionId: sessionId })'));
check('Shift board keeps supplement and ordinary units separate',
  shiftProjection.includes('supplementPackedCount')
  && picking.includes('totalSupplementPacked')
  && picking.includes('supplementPackedCount'));
check('Shift worker history reuses existing board through a read projection',
  picking.includes('getSupplementWorkerHistory')
  && shiftProjection.includes("kind: 'supplement'")
  && !/PickingTask\.(?:create|update|findOneAndUpdate)/.test(shiftProjection));
check('server startup syncs the new Wave critical index with supplement child indexes',
  indexRuntime.includes("require('./models/SupplementWave')")
  && indexRuntime.includes("require('./models/SupplementOffer')")
  && indexRuntime.includes("require('./models/SupplementRequest')")
  && indexRuntime.includes('SupplementWave.publicationKey'));
check('canonical supplement docs describe Wave/session/current routing boundary',
  docs.includes('ReceiptItem.routing')
  && docs.includes('OrderingSession')
  && docs.includes('SupplementWave')
  && docs.includes('Зміна'));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.S2 SUPPLEMENT WAVE SERVER: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

'use strict';

/**
 * V48.S2 compatibility guarantees after the V48.S3 container/revision redesign.
 *
 * This checker intentionally does NOT require the obsolete S2 rule
 * "Wave.status is the global lifecycle lock". It verifies the durable S2
 * business guarantees at their stronger S3 boundaries instead.
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

const wave = read('models/SupplementWave.js');
const offer = read('models/SupplementOffer.js');
const targets = read('services/supplementTargets.js');
const receipts = read('routes/receipts.js');
const supplement = read('routes/supplement.js');
const state = read('utils/supplementState.js');
const service = read('services/supplementWaveService.js');
const correction = read('services/receiptRoutingCorrectionCommand.js');
const artifacts = read('services/receiptRoutingArtifacts.js');
const sessionStatus = read('utils/sessionStatus.js');
const closure = read('services/sessionClosure.js');
const notify = read('services/supplementNotify.js');
const archive = read('services/archiveProduct.js');
const primitive = read('services/archiveProductPrimitives.js');
const indexRuntime = read('index.js');
const picking = read('routes/picking.js');
const shiftProjection = read('services/readModels/supplementShiftActivityReadModel.js');
const products = read('routes/products.js');
const orders = read('routes/orders.js');
const exclusion = read('services/supplementSessionExclusion.js');
const offers = read('services/supplementOffers.js');
const tombstone = read('scripts/dropSupplementSessionField.js');
const executableTargets = targets.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

console.log('V48.S2 GUARANTEES PRESERVED BY V48.S3 — SERVER');
console.log('------------------------------------------------');

check('supplement remains pinned to one DeliveryGroup + exact OrderingSession',
  wave.includes('deliveryGroupId')
  && wave.includes('orderingSessionId')
  && wave.includes('containerKey')
  && targets.includes('findCurrentSessionId')
  && targets.includes('expectedOrderingSessionId')
  && receipts.includes('withSessionLifecycleLock(firstTarget.orderingSessionId'));

check('target selection remains server-authoritative and heuristic-free',
  targets.includes('findCurrentSessionId')
  && targets.includes('new Date(session.openAt).getTime() > now.getTime()')
  && !/closed.{0,30}(minutes|min|хв)/i.test(executableTargets)
  && !/morning|ранок/i.test(executableTargets));

check('future and normal completed targets stay closed; only persisted exact-current cancellation may recover',
  targets.includes('supplement_target_session_not_started')
  && targets.includes('supplement_target_session_completed')
  && targets.includes('hasReopenableSupplementCancellation')
  && targets.includes('status: ITEM_STATUS.CANCELLED')
  && targets.includes("session.pickingStatus === 'completed' && !reopenableSupplement"));

check('publication pins and transactionally revalidates the exact session',
  receipts.includes('expectedOrderingSessionId')
  && receipts.includes('withSessionLifecycleLock(firstTarget.orderingSessionId')
  && receipts.includes('orderingSessionId: target.orderingSessionId')
  && receipts.includes('sessionDoc.pickingStatus'));

check('ReceiptItem publication fence is item-global lifecycle history, not a target-local marker',
  receipts.includes('existingPublications')
  && receipts.includes('blockedItemIds')
  && receipts.includes('blocksGenericRepublish')
  && receipts.includes('readyCount: readyCountForTarget'));

check('supplement-only item still requires no fake warehouse Product',
  /productId:[\s\S]*default:\s*null/.test(offer)
  && artifacts.includes('if (!needsWarehouseProduct(routing)) return null'));

check('OPEN seller editing and FROZEN warehouse packing remain hard server rules at item revision level',
  state.includes('function isSellerEditable')
  && state.includes('function isPackable')
  && service.includes('status: ITEM_STATUS.OPEN')
  && service.includes('status: ITEM_STATUS.FROZEN')
  && supplement.includes('effective !== ITEM_STATUS.FROZEN')
  && supplement.includes('supplement_pack_before_freeze'));

check('exact-session current supplement item remains a session-completion blocker',
  sessionStatus.includes('SupplementOffer.countDocuments')
  && sessionStatus.includes('orderingSessionId: String(orderingSessionId)')
  && sessionStatus.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && closure.includes('SupplementOffer.find')
  && closure.includes('active_supplement_waves'));

check('routing correction blocks OPEN seller input and annuls the whole FROZEN current revision when supplement is removed',
  correction.includes('withdrawReceiptItemFromActiveWaves')
  && correction.includes('RECEIPT_ITEM_SUPPLEMENT_STATE.OPEN')
  && service.includes('status: REQUEST_STATUS.ACTIVE')
  && service.includes('alreadyFulfilledShopIds: []')
  && !service.includes('const unpacked = requests.filter((r) => !r.packed)'));

check('route correction only rewrites current active item revision',
  correction.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && correction.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && correction.includes('productId: item.createdProductId || null')
  && correction.includes('sourceSnapshotFromReceiptItem(item)'));

check('route correction never archives a Product; archive stays a separate physical command',
  !correction.includes('archiveProductInSession')
  && !correction.includes('receipt_routing_correction')
  && correction.includes("mode: 'warehouse_detach'")
  && archive.includes('archiveProductInSession')
  && primitive.includes('detachProductFromAllBlocks'));

check('same-session supplement exclusion remains enforced at catalogue and write boundaries',
  products.includes('getSupplementExcludedProductIds')
  && orders.includes('assertProductOrdinaryOrderable')
  && exclusion.includes('orderingSessionId')
  && exclusion.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && exclusion.includes('ITEM_STATUS.COMPLETED')
  && exclusion.includes('ITEM_STATUS.CANCELLED'));

check('modern lifecycle notifications remain container-scoped; legacy offer notifications isolated',
  notify.includes('notifyWaves')
  && notify.includes('SupplementWave')
  && wave.includes('activityRevision')
  && (notify.match(/waveId: null/g) || []).length >= 2);

check('legacy scheduler auto-freeze remains isolated from modern container lifecycle',
  offers.includes('status: ITEM_STATUS.OPEN, waveId: null')
  && offers.includes('waveId: null'));

check('supplement work still projects into existing Shift history with separate counters and revision snapshot',
  picking.includes('totalSupplementPacked')
  && picking.includes('supplementPackedCount')
  && picking.includes('getSupplementWorkerHistory')
  && shiftProjection.includes("kind: 'supplement'")
  && shiftProjection.includes('offerSnapshotForRequestRevision'));

check('supplement models remain startup-critical and S3 identities are enforced',
  indexRuntime.includes("key: 'supplements'")
  && indexRuntime.includes("require('./models/SupplementWave')")
  && indexRuntime.includes('SupplementWave.containerKey')
  && indexRuntime.includes('SupplementRequest = offerId+revision+shopId'));

check('modern transitions are transactional while legacy waveId=null stays readable',
  (service.match(/withTransaction/g) || []).length >= 3
  && service.includes('ensureContainer')
  && service.includes('recomputeWaveSummaryInSession')
  && offers.includes('waveId: null'));

check('obsolete destructive supplement-session migration stays retired',
  tombstone.includes('retired by V48.S2')
  && !tombstone.includes('mongoose.connect'));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.S2 COMPATIBILITY: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

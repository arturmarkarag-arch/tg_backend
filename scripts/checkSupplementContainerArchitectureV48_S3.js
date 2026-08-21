'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); console.log(`${ok ? '✅' : '❌'} ${name}`); }

const wave = read('models/SupplementWave.js');
const offer = read('models/SupplementOffer.js');
const request = read('models/SupplementRequest.js');
const migration = read('services/supplementV3Migration.js');
const service = read('services/supplementWaveService.js');
const commands = read('services/supplementRequestCommand.js');
const supplement = read('routes/supplement.js');
const receipts = read('routes/receipts.js');
const receiptSync = read('services/receiptSync.js');
const correction = read('services/receiptRoutingCorrectionCommand.js');
const sessionStatus = read('utils/sessionStatus.js');
const closure = read('services/sessionClosure.js');
const topology = read('services/shopTopologyCommand.js');
const groups = read('routes/deliveryGroups.js');
const picking = read('routes/picking.js');
const products = read('routes/products.js');
const notify = read('services/supplementNotify.js');
const docs = read('docs/supplement/readme.md');
const indexRuntime = read('index.js');
const statePolicy = read('utils/supplementState.js');
const exclusion = read('services/supplementSessionExclusion.js');
const revisionProjection = read('services/supplementRevisionProjection.js');
const shiftProjection = read('services/readModels/supplementShiftActivityReadModel.js');
const targets = read('services/supplementTargets.js');
const crossHttp = read('tests/receiptLifecycleCrossHttp.test.js');

console.log('V48.S3 SUPPLEMENT CONTAINER + ITEM REVISION ARCHITECTURE — SERVER');
console.log('----------------------------------------------------------------');

check('one stable container identity is DeliveryGroup + exact OrderingSession',
  wave.includes('architectureVersion')
  && wave.includes('containerKey')
  && wave.includes("partialFilterExpression: { containerKey: { $type: 'string' } }")
  && migration.includes('containerKeyFor(deliveryGroupId, orderingSessionId)'));
check('Wave status is explicitly derived summary, not seller authority',
  wave.includes('Derived operational summary')
  && wave.includes('It is NOT the seller')
  && docs.includes('не є seller lock'));
check('one stable item slot is unique inside the container',
  offer.includes('{ waveId: 1, receiptItemId: 1 }')
  && offer.includes('unique: true')
  && offer.includes('revisionHistory'));
check('modern item publication has unbounded numeric revision identity',
  offer.includes('revision: { type: Number')
  && request.includes('revision: { type: Number')
  && request.includes('{ offerId: 1, revision: 1, shopId: 1 }'));
check('old lifetime receiptItem+group uniqueness is legacy-only',
  offer.includes("partialFilterExpression: { waveId: null }")
  && docs.includes('lifetime `receiptItemId + deliveryGroupId` uniqueness'));
check('models and commands share one canonical item/request status vocabulary',
  offer.includes("require('../utils/supplementState')")
  && request.includes("require('../utils/supplementState')")
  && wave.includes("require('../utils/supplementState')")
  && statePolicy.includes('const REQUEST_STATUS')
  && commands.includes('REQUEST_STATUS.ACTIVE')
  && commands.includes('REQUEST_STATUS.CANCELLED'));
check('boot migration backfills revision and deterministically merges duplicate S2 containers',
  indexRuntime.includes('migrateSupplementV3')
  && migration.includes('revision: 1')
  && migration.includes('mergedIntoWaveId')
  && migration.includes('groupWaves[0]'));
check('S2->S3 migration commits before supplement index replacement and preserves tombstones',
  indexRuntime.indexOf('migrateSupplementV3') >= 0
  && indexRuntime.indexOf("key: 'supplements'") > indexRuntime.indexOf('migrateSupplementV3')
  && migration.includes('withTransaction')
  && migration.includes('secondaryDoc.mergedIntoWaveId = canonicalDoc._id')
  && !/\b(deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete)\s*\(/.test(migration));
check('critical startup indexes enforce container/item/request identities',
  indexRuntime.includes('SupplementWave.containerKey')
  && indexRuntime.includes('modern SupplementOffer = waveId+receiptItemId')
  && indexRuntime.includes('SupplementRequest = offerId+revision+shopId'));
check('publication reuses the stable container instead of creating one Wave per batch',
  service.includes('ensureContainer')
  && service.includes("SupplementWave.findOne({ containerKey: key })")
  && service.includes('createWaveWithItems'));
check('cancelled/withdrawn item can restart as revision+1 with fresh Receipt snapshot',
  service.includes('$push: { revisionHistory: revisionArchiveOf(current, now) }')
  && service.includes('revision: nextRevision(current)')
  && service.includes('sourceSnapshot: sourceSnapshotFromReceiptItem(item)')
  && service.includes('status: ITEM_STATUS.OPEN'));
check('active FROZEN blocks duplicates but CANCELLED releases the item',
  statePolicy.includes("if (status === ITEM_STATUS.CANCELLED) return false")
  && statePolicy.includes('hasCompletedLifecycle(offer)')
  && receipts.includes('existingPublications')
  && receipts.includes('blockedItemIds')
  && docs.includes('Активний `FROZEN` блокує паралельний дубль'));
check('open/frozen/completed current item cannot be implicitly duplicated',
  service.includes('blocksGenericRepublish(current)')
  && statePolicy.includes('ITEM_STATUS.OPEN')
  && statePolicy.includes('ITEM_STATUS.FROZEN')
  && statePolicy.includes('ITEM_STATUS.COMPLETED')
  && statePolicy.includes('function blocksGenericRepublish')
  && service.includes('revision: nextRevision(current)'));
check('repeat publication never restores old requests because request identity includes revision',
  request.includes('{ offerId: 1, revision: 1, shopId: 1 }')
  && supplement.includes('requestByOfferRevision'));
check('seller publication view uses frozen sourceSnapshot instead of mutable Product metadata',
  read('services/supplementOffers.js').includes("if (offer?.waveId && offer?.sourceSnapshot)"));
check('modern cancelled/completed history does not freeze future Receipt metadata forever',
  receiptSync.includes('activeModernOffers')
  && receiptSync.includes('modernOffers.filter(isActiveItemRevision)')
  && receiptSync.includes('revision: revisionOf(offer)')
  && receiptSync.includes("mode === 'destructive' && modernOffers.length > 0")
  && receipts.includes("mode: 'edit'"));
check('seller CRUD has distinct CREATE UPDATE DELETE commands',
  supplement.includes("router.post('/offers/:offerId/requests'")
  && supplement.includes("router.patch('/requests/:requestId'")
  && supplement.includes("router.delete('/requests/:requestId'")
  && commands.includes('createSellerRequest')
  && commands.includes('updateSellerRequest')
  && commands.includes('cancelSellerRequest'));
check('concurrent CREATE cannot silently become UPDATE',
  commands.includes("supplement_request_exists")
  && read('utils/errors.js').includes('supplement_request_exists'));
check('seller writes are fenced by current item revision and OPEN status',
  commands.includes('const revision = revisionOf(offer)')
  && commands.includes('offer.status !== ITEM_STATUS.OPEN')
  && commands.includes('revision, shopId')
  && commands.includes("require('../utils/supplementState')"));
check('freeze touches only OPEN item revisions and leaves other items independent',
  service.includes('{ waveId: wave._id, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN }')
  && service.includes('$set: { status: ITEM_STATUS.FROZEN')
  && service.includes("require('../utils/supplementState')"));
check('packing requires the item itself to be FROZEN and exact request revision',
  supplement.includes('effective !== ITEM_STATUS.FROZEN')
  && supplement.includes('revisionOf(fresh)')
  && supplement.includes('revisionOf(head) !== revision')
  && supplement.includes('{ _id: req.params.requestId, revision, status: REQUEST_STATUS.ACTIVE'));
check('cancel one item annuls every current-revision request, including packed audit rows',
  service.includes('async function cancelOfferRevision')
  && service.includes('revision, status: REQUEST_STATUS.ACTIVE')
  && !/cancelOfferRevision[\s\S]{0,2600}status:\s*REQUEST_STATUS.ACTIVE,\s*packed:\s*false/.test(service)
  && service.includes('offer.status = ITEM_STATUS.CANCELLED'));
check('staff cancellation of last FROZEN request immediately repairs empty item lifecycle',
  supplement.includes('result.offer.status === ITEM_STATUS.FROZEN')
  && supplement.includes('releaseEmptyOffers(new Date())')
  && supplement.includes('maybeCompleteSession'));
check('cancel one item preserves packed fields only as audit, never as fulfilment',
  service.includes('Packed fields remain as audit facts')
  && !/cancelOfferRevision[\s\S]{0,3500}\$set:\s*\{[^}]*packed:\s*false/.test(service));
check('cancel all touches only current OPEN/FROZEN item revisions and leaves container reusable',
  service.includes('async function cancelWave')
  && service.includes("status: { $in: ACTIVE_ITEM_STATUSES }")
  && docs.includes('Сам `SupplementWave` container не видаляється'));
check('route correction is separate from ordinary item cancellation',
  correction.includes('withdrawReceiptItemFromActiveWaves')
  && service.includes('cancelOfferRevision')
  && docs.includes('`Cancel supplement item` і `CorrectReceiptItemRouting` — різні команди'));
check('route correction recomputes container summary inside the same Mongo transaction',
  service.includes('for (const waveId of waveIds) await recomputeWaveSummaryInSession(waveId, { session, actor, now })')
  && !correction.includes('completeAffectedWaves(...).catch'));
check('historical cancelled/completed item snapshot is not rewritten by correction',
  correction.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && correction.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && correction.includes("require('../utils/supplementState')"));
check('session completion uses exact-session active item revisions, never container summary',
  sessionStatus.includes('SupplementOffer.countDocuments')
  && sessionStatus.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && sessionStatus.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && closure.includes('SupplementOffer.find')
  && closure.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && closure.includes('active_supplement_waves')
  && sessionStatus.includes("require('./supplementState')")
  && closure.includes("require('../utils/supplementState')"));
check('completed CURRENT session reopens only from persisted cancelled supplement state and only for a real publication',
  targets.includes('hasReopenableSupplementCancellation')
  && targets.includes('status: ITEM_STATUS.CANCELLED')
  && targets.includes("session.pickingStatus === 'completed' && !reopenableSupplement")
  && targets.includes('supplement_target_session_completed')
  && receipts.includes('if (!selectedRows.length) return')
  && receipts.indexOf('if (!selectedRows.length) return') < receipts.indexOf("'supplement_republished_after_cancel'")
  && receipts.includes("'supplement_republished_after_cancel'")
  && receipts.includes('allowReopen: true')
  && crossHttp.includes('cancel -> complete-by-cancellation -> edit -> republish reopens only the exact current session and starts clean'));
check('successful completed session has an explicit non-reopen regression contract',
  crossHttp.includes('successful completed supplement state cannot reopen the delivery session'));
check('Shop topology guard uses exact-session current item authority',
  topology.includes('SupplementOffer.find')
  && topology.includes('orderingSessionId: String(currentSession._id)')
  && topology.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && topology.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && topology.includes("require('../utils/supplementState')"));
check('Shop deactivation cannot hide exact current ordinary/supplement demand',
  topology.includes('const deactivating =')
  && topology.includes('shopActiveSupplementRequest')
  && topology.includes('SupplementRequest.exists')
  && topology.includes('revision: revisionOf(offer)')
  && topology.includes('status: REQUEST_STATUS.ACTIVE')
  && topology.includes("throw appError('shop_deactivate_session_active'")
  && read('utils/errors.js').includes('shop_deactivate_session_active'));
check('DeliveryGroup schedule mutation blocks current supplement item work',
  groups.includes('sessionSupplement')
  && groups.includes('SupplementOffer.exists')
  && groups.includes('orderingSessionId: { $in: protectedSessionIds }'));
check('picking box numbering is exact-session and exact current revision',
  picking.includes('orderingSessionId: String(currentSessionId)')
  && picking.includes('requestPairs')
  && picking.includes('revision: revisionOf(offer)')
  && picking.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && picking.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && picking.includes("require('../utils/supplementState')"));
check('warehouse estimate excludes cancelled historical demand while preserving packed active facts',
  products.includes('status: REQUEST_STATUS.ACTIVE')
  && products.includes("require('../utils/supplementState')")
  && products.includes('Cancelled/unpacked results from old publication revisions'));
check('current warehouse cards fetch requests by exact current revision',
  supplement.includes('currentRequestsForOffers')
  && supplement.includes('revision: revisionOf(offer)')
  && supplement.includes("require('../utils/supplementState')"));
check('same-session ordinary exclusion survives terminal work only inside the exact session',
  exclusion.includes('orderingSessionId')
  && exclusion.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && exclusion.includes('ITEM_STATUS.COMPLETED')
  && exclusion.includes('ITEM_STATUS.CANCELLED')
  && exclusion.includes("frozenAt: { $type: 'date' }")
  && exclusion.includes("require('../utils/supplementState')"));
check('critical supplement consumers share one canonical state policy instead of local status literals',
  statePolicy.includes('const ACTIVE_ITEM_STATUSES')
  && statePolicy.includes('function isSellerEditable')
  && statePolicy.includes('function isPackable')
  && statePolicy.includes('function blocksGenericRepublish')
  && service.includes("require('../utils/supplementState')")
  && commands.includes("require('../utils/supplementState')")
  && sessionStatus.includes("require('./supplementState')")
  && closure.includes("require('../utils/supplementState')")
  && topology.includes("require('../utils/supplementState')")
  && groups.includes("require('../utils/supplementState')")
  && exclusion.includes("require('../utils/supplementState')"));
check('historical request readers resolve immutable snapshot by exact publication revision',
  revisionProjection.includes('function offerSnapshotForRequestRevision')
  && revisionProjection.includes('revisionSnapshotMissing')
  && revisionProjection.includes('status: ITEM_STATUS.CANCELLED')
  && supplement.includes("require('../services/supplementRevisionProjection')")
  && shiftProjection.includes("require('../supplementRevisionProjection')")
  && shiftProjection.includes("'offerId revision shopId")
  && shiftProjection.includes('offerSnapshotForRequestRevision(currentOffer, request)'));
check('container notifications are activity-revision based and survive 100+ reopen cycles',
  wave.includes('activityRevision')
  && wave.includes('openedNotifiedRevision')
  && notify.includes('openedNotifiedRevision')
  && notify.includes('frozenNotifiedRevision')
  && notify.includes('cancelledNotifiedRevision'));
check('operator notifications do not expose obsolete supplement package/batch UX',
  !notify.toLowerCase().includes('пачк')
  && notify.includes('Відкриті позиції дозамовлення передано в роботу')
  && notify.includes('Відкритих товарів у дозамовленні'));
check('modern scheduler automatic freeze remains legacy-only',
  read('services/supplementOffers.js').includes('status: ITEM_STATUS.OPEN, waveId: null')
  && read('services/supplementOffers.js').includes('waveId: null'));
check('canonical docs explicitly prohibit second modern Wave and current request reads without revision',
  docs.includes('створення другої modern Wave')
  && docs.includes('current request query без revision fence')
  && docs.includes('100+'));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.S3 SUPPLEMENT SERVER: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

const crypto = require('crypto');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { getBaseLinkerAccount } = require('./baseLinkerAccounts');
const { orderKey, resolveSourceName } = require('./baseLinkerIdentity');
const { withLock } = require('../utils/lock');
const { withBaseLinkerAccountLifecycleLock } = require('./baseLinkerAccountLifecycle');
const { appError } = require('../utils/errors');
const { compactOrders } = require('./baseLinkerPublicDto');
const { setBaseLinkerOrderStatus } = require('./baseLinkerOrderCommands');
const { getQueueScope, classifyUpstreamOrder } = require('./baseLinkerQueueScope');
const { getIO } = require('../socket');

const {
  ORDER_STATUS,
  WORKING_STATUSES,
  TERMINAL_STATUSES,
  ISSUE_STATES,
  WRITABLE_ITEM_STATES,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
  WORKFLOW_STAGE,
  workflowStageFor,
  workflowStageAfterWorkingStatus,
} = require('../domain/baseLinkerPickingState');
const {
  isProductionEligibleDisposition,
  hasLocalWarehouseSent,
} = require('../domain/baseLinkerProductionLifecycle');

const CLAIM_STALE_MS = Math.max(2 * 60 * 1000, Number(process.env.BASELINKER_PICKING_CLAIM_STALE_MS) || (10 * 60 * 1000));
const UPSTREAM_VERIFICATION_TTL_MS = Math.min(
  60_000,
  Math.max(5_000, Number(process.env.BASELINKER_PICKING_UPSTREAM_VERIFY_MS) || 15_000),
);
const MAX_HISTORY = 200;

function actorOf(user) {
  return {
    by: String(user?.telegramId || ''),
    byName: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || String(user?.telegramId || ''),
    byRole: String(user?.role || ''),
  };
}

async function requireAccountEnabled(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  return getBaseLinkerAccount(id, { requireEnabled: true, lean: true });
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}



function sourceLineBaseKey(product) {
  const orderProductId = text(product?.order_product_id).trim();
  if (orderProductId) return `op:${orderProductId}`;
  return [
    'src',
    text(product?.product_id),
    text(product?.variant_id),
    text(product?.sku),
    text(product?.ean),
    text(product?.auction_id),
    text(product?.name),
  ].join(':');
}

function buildSourceItems(order) {
  const products = Array.isArray(order?.products) ? order.products : [];
  const seen = new Map();
  return products.map((product) => {
    const sourceOrderId = text(order?.order_id).trim();
    const rawBase = sourceLineBaseKey(product);
    const base = rawBase;
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    const lineKey = occurrence === 1 ? base : `${base}#${occurrence}`;
    const sourceSnapshot = {
      lineKey,
      sourceOrderId,
      orderProductId: text(product?.order_product_id),
      storage: text(product?.storage),
      storageId: text(product?.storage_id),
      productId: text(product?.product_id),
      variantId: text(product?.variant_id),
      auctionId: text(product?.auction_id),
      sku: text(product?.sku),
      ean: text(product?.ean),
      name: text(product?.name),
      attributes: text(product?.attributes),
      requestedQty: qty(product?.quantity),
    };
    return {
      ...sourceSnapshot,
      sourceFingerprint: sha(JSON.stringify(sourceSnapshot)),
    };
  });
}

function orderFingerprint(sourceItems) {
  return sha(JSON.stringify(sourceItems.map((item) => ({
    lineKey: item.lineKey,
    sourceFingerprint: item.sourceFingerprint,
  }))));
}

function appendHistory(doc, action, actor, meta = {}) {
  if (!Array.isArray(doc.history)) doc.history = [];
  doc.history.push({
    at: new Date(),
    by: actor?.by || '',
    byName: actor?.byName || '',
    byRole: actor?.byRole || '',
    action,
    meta,
  });
  if (doc.history.length > MAX_HISTORY) doc.history = doc.history.slice(-MAX_HISTORY);
}


async function savePickingDoc(doc) {
  try {
    await doc.save();
    return doc;
  } catch (error) {
    if (error?.name === 'VersionError') {
      let currentRevision = 0;
      try {
        const current = await BaseLinkerPickingOrder.findById(doc?._id).select('revision').lean();
        currentRevision = Number(current?.revision || 0);
      } catch (_) { /* preserve original optimistic conflict */ }
      throw appError('baselinker_picking_stale', { currentRevision });
    }
    throw error;
  }
}

function publicState(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const lastActivityMs = plain.lastActivityAt ? new Date(plain.lastActivityAt).getTime() : 0;
  const takeoverAt = plain.ownerTelegramId && lastActivityMs
    ? new Date(lastActivityMs + CLAIM_STALE_MS).toISOString()
    : null;
  const items = (Array.isArray(plain.items) ? plain.items : []).map((item) => ({
    lineKey: String(item?.lineKey || ''),
    name: String(item?.name || ''),
    requestedQty: Number(item?.requestedQty || 0),
    state: String(item?.state || 'pending'),
    pickedQty: Number(item?.pickedQty || 0),
    issueNote: String(item?.issueNote || ''),
  }));

  // Public worker state is intentionally a DTO, not a Mongo document dump.
  // Audit/history/fingerprints/actor metadata stay server-side and can be
  // exposed later through a dedicated diagnostic endpoint if ever needed.
  return {
    baseLinkerAccountId: String(plain.baseLinkerAccountId || ''),
    baseLinkerAccountName: String(plain.baseLinkerAccountNameSnapshot || ''),
    orderKey: orderKey(plain.baseLinkerAccountId, plain.orderId),
    orderId: String(plain.orderId || ''),
    sourceType: String(plain.sourceType || ''),
    sourceId: String(plain.sourceId || ''),
    sourceName: String(plain.sourceNameLastKnown || plain.sourceNameSnapshot || ''),
    status: String(plain.status || 'new'),
    workflowStage: workflowStageFor(plain),
    revision: Number(plain.revision || 0),
    ownerTelegramId: String(plain.ownerTelegramId || ''),
    ownerName: String(plain.ownerName || ''),
    progress: progressFor(plain.items || []),
    items,
    claimTakeoverAvailableAt: takeoverAt,
    lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
    lastUpstreamVerifiedAt: plain.lastUpstreamVerifiedAt || null,
    lastUpstreamStatusId: Number.isSafeInteger(Number(plain.lastUpstreamStatusId)) ? Number(plain.lastUpstreamStatusId) : null,
    upstreamDisposition: String(plain.upstreamDisposition || ''),
    productionEligible: isProductionEligibleDisposition(plain.upstreamDisposition),
    upstreamBlocked: !isProductionEligibleDisposition(plain.upstreamDisposition),
    warehouseFulfillment: String(plain.status || '') === ORDER_STATUS.SENT || String(plain.workflowStage || '') === WORKFLOW_STAGE.SENT
      ? 'sent'
      : (String(plain.status || '') === ORDER_STATUS.PACKED || String(plain.workflowStage || '') === WORKFLOW_STAGE.PACKED ? 'packed' : ''),
    upstreamReviewRequired: plain.upstreamReviewRequired === true,
    upstreamReviewedAt: plain.upstreamReviewedAt || null,
    lastUpstreamChangeSummary: {
      added: Number(plain.lastUpstreamChangeSummary?.added || 0),
      removed: Number(plain.lastUpstreamChangeSummary?.removed || 0),
      changed: Number(plain.lastUpstreamChangeSummary?.changed || 0),
    },
    lastUpstreamChangeDetails: (Array.isArray(plain.lastUpstreamChangeDetails) ? plain.lastUpstreamChangeDetails : []).slice(0, 12).map((detail) => ({
      kind: String(detail?.kind || ''),
      lineKey: String(detail?.lineKey || ''),
      name: String(detail?.name || ''),
      field: String(detail?.field || ''),
      fromValue: String(detail?.fromValue ?? ''),
      toValue: String(detail?.toValue ?? ''),
      qty: Number(detail?.qty || 0),
    })),
  };
}

function emitPickingUpdate(doc, clientMutationId = '') {
  try {
    const io = getIO();
    if (!io) return;
    const state = publicState(doc);
    const baseLinkerAccountId = String(doc.baseLinkerAccountId || '');
    const orderIds = [String(doc.orderId)];
    io.to('baselinker_staff').emit('baselinker_picking_updated', {
      baseLinkerAccountId,
      orderKey: orderKey(baseLinkerAccountId, doc.orderId),
      orderId: String(doc.orderId),
      orderIds,
      state,
      ...(text(clientMutationId).trim() ? { clientMutationId: text(clientMutationId).trim().slice(0, 160) } : {}),
    });
  } catch (_) { /* best-effort realtime only */ }
}

async function fetchExactOrder(baseLinkerAccountId, orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) throw appError('baselinker_order_id_invalid');

  // Warehouse admission is controlled by the configured Intake status.
  // BaseLinker recommends confirmed-only reads: unconfirmed orders can contain
  // incomplete/changing product lists and are not safe for warehouse admission.
  const result = await fetchBaseLinkerOrders({
    orderId: id,
    includeUnconfirmed: false,
    maxPages: 1,
  }, makeBaseLinkerAccountCaller(baseLinkerAccountId, { usageStage: 'picking_exact_verify' }));
  const order = (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id));
  if (!order) throw appError('baselinker_order_not_returned', { orderId: id, upstreamMethod: 'getOrders' });
  if (!Array.isArray(order.products) || order.products.length === 0) throw appError('baselinker_order_has_no_products', { orderId: id });
  return order;
}


function hasPhysicalWarehouseSnapshot(doc) {
  const status = String(doc?.status || '');
  const stage = String(doc?.workflowStage || '');
  return Boolean(doc?.packedAt || doc?.sentAt || status === ORDER_STATUS.PACKED || status === ORDER_STATUS.SENT || stage === WORKFLOW_STAGE.PACKED || stage === WORKFLOW_STAGE.SENT);
}

function productionDispositionBlocked(disposition) {
  return !isProductionEligibleDisposition(disposition);
}

function assertOrderActionable(order, scope) {
  const disposition = classifyUpstreamOrder(order, scope);
  const id = String(order?.order_id || '');
  const currentStatusId = Number.isSafeInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null;
  if (disposition === 'intake') return disposition;
  if (disposition === 'cancelled') throw appError('baselinker_order_cancelled', { orderId: id, currentStatusId });
  if (disposition === 'sent') throw appError('baselinker_order_already_sent', { orderId: id, currentStatusId });
  throw appError('baselinker_order_not_in_intake', {
    orderId: id,
    currentStatusId,
    intakeStatusId: Number(scope?.intakeStatusId) || null,
  });
}

function applyUpstreamDisposition(doc, order, scope, actor, {
  materializeSent = true,
  releaseOwnerOnSent = true,
} = {}) {
  const nextDisposition = order ? classifyUpstreamOrder(order, scope) : 'missing';
  const nextStatusId = order && Number.isSafeInteger(Number(order?.order_status_id))
    ? Number(order.order_status_id)
    : null;
  const previousDisposition = String(doc.upstreamDisposition || '');
  const previousStatusId = Number.isSafeInteger(Number(doc.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null;
  const changed = previousDisposition !== nextDisposition || previousStatusId !== nextStatusId;
  let releasedOwner = false;
  let materializedSent = false;

  doc.upstreamDisposition = nextDisposition;
  doc.lastUpstreamStatusId = nextStatusId;
  doc.lastUpstreamVerifiedAt = new Date();

  // The configured BaseLinker statuses are business outcomes:
  // Intake = production allowed, Sent = shipped/finished, Cancelled = cancelled.
  // Therefore an exact configured Sent observation must materialize our terminal
  // Sent state even when the status was changed outside this UI. A later
  // Cancelled/Other transition may create an exception, but it never erases the
  // fact that Sent had already been observed.
  if (materializeSent && nextDisposition === 'sent'
      && String(doc.status || '') !== ORDER_STATUS.SENT
      && String(doc.workflowStage || '') !== WORKFLOW_STAGE.SENT) {
    const observedAt = new Date();
    doc.status = ORDER_STATUS.SENT;
    doc.workflowStage = WORKFLOW_STAGE.SENT;
    doc.sentAt = doc.sentAt || observedAt;
    doc.sentBy = doc.sentBy || 'system:baselinker';
    doc.sentByName = doc.sentByName || 'BaseLinker';
    doc.lastActivityAt = observedAt;
    materializedSent = true;
    appendHistory(doc, 'upstream_sent_materialized', {
      by: 'system:baselinker', byName: 'BaseLinker', byRole: 'system',
    }, { statusId: nextStatusId });
  }

  // Production eligibility is strict: Intake is the only status in which a
  // worker may keep ownership. Any exact non-Intake observation releases the
  // worker immediately, while preserving picked quantities/issues/history.
  if (productionDispositionBlocked(nextDisposition)
      && doc.ownerTelegramId
      && !(nextDisposition === 'sent' && releaseOwnerOnSent === false)) {
    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    releasedOwner = true;
    appendHistory(doc, 'upstream_ineligible_released_owner', actor, {
      disposition: nextDisposition,
      previousOwnerTelegramId,
      previousOwnerName,
      statusId: nextStatusId,
    });
  }

  if (changed) {
    appendHistory(doc, 'upstream_status_observed', actor, {
      fromDisposition: previousDisposition,
      toDisposition: nextDisposition,
      fromStatusId: previousStatusId,
      toStatusId: nextStatusId,
    });
  }
  return { changed, releasedOwner, materializedSent, disposition: nextDisposition };
}

function upstreamLineChangeDetails(oldItem, sourceItem) {
  const details = [];
  const common = {
    kind: 'changed',
    lineKey: String(sourceItem?.lineKey || oldItem?.lineKey || ''),
    name: String(sourceItem?.name || oldItem?.name || ''),
  };
  const fields = [
    ['requestedQty', 'quantity'],
    ['name', 'name'],
    ['variantId', 'variant'],
    ['sku', 'sku'],
    ['ean', 'ean'],
    ['attributes', 'attributes'],
    ['productId', 'product'],
  ];
  for (const [key, field] of fields) {
    const before = key === 'requestedQty' ? Number(oldItem?.[key] || 0) : String(oldItem?.[key] ?? '');
    const after = key === 'requestedQty' ? Number(sourceItem?.[key] || 0) : String(sourceItem?.[key] ?? '');
    if (String(before) === String(after)) continue;
    details.push({
      ...common,
      field,
      fromValue: String(before),
      toValue: String(after),
      qty: field === 'quantity' ? Number(after || 0) : 0,
    });
  }
  if (!details.length) {
    details.push({ ...common, field: 'product', fromValue: '', toValue: '', qty: Number(sourceItem?.requestedQty || 0) });
  }
  return details;
}

function syncDocWithOrder(doc, order, actor) {
  // Persist only the minimal source metadata needed by our own local workflow.
  // Full BaseLinker orders are never mirrored into Mongo.
  const nextSourceMeta = {
    sourceShopOrderId: text(order?.shop_order_id),
    sourceExternalOrderId: text(order?.external_order_id),
    sourceType: text(order?.order_source).toLowerCase(),
    sourceId: text(order?.order_source_id),
    sourceDateAdd: Number(order?.date_add || 0) || 0,
    sourceDateConfirmed: Number(order?.date_confirmed || 0) || 0,
    sourceDeliveryMethod: text(order?.delivery_method),
    sourceDeliveryPackageModule: text(order?.delivery_package_module),
    sourceDeliveryPackageNr: text(order?.delivery_package_nr),
  };
  const metadataChanged = Object.entries(nextSourceMeta).some(([key, value]) => String(doc?.[key] ?? '') !== String(value ?? ''));
  Object.assign(doc, nextSourceMeta);
  const resolvedSourceName = text(order?.sourceName);
  if (resolvedSourceName) {
    if (!doc.sourceNameSnapshot) doc.sourceNameSnapshot = resolvedSourceName;
    doc.sourceNameLastKnown = resolvedSourceName;
    doc.sourceResolvedAt = new Date();
  }

  const wasInitialized = Boolean(doc.orderFingerprint);
  const sourceItems = buildSourceItems(order);
  const nextFingerprint = orderFingerprint(sourceItems);
  const physicalSnapshotLocked = hasPhysicalWarehouseSnapshot(doc);

  if (!doc.orderFingerprint) {
    doc.items = sourceItems.map((source) => ({
      ...source,
      state: 'pending',
      pickedQty: 0,
      issueNote: '',
      updatedBy: '',
      updatedByName: '',
      updatedAt: null,
    }));
    doc.orderFingerprint = nextFingerprint;
    doc.lastUpstreamOrderFingerprint = nextFingerprint;
    doc.lastUpstreamChangeDetails = [];
    return { changed: false, metadataChanged, summary: { added: 0, removed: 0, changed: 0 }, initialized: true };
  }

  const observedFingerprint = String(doc.lastUpstreamOrderFingerprint || doc.orderFingerprint || '');
  if (observedFingerprint === nextFingerprint) {
    doc.lastUpstreamOrderFingerprint = nextFingerprint;
    return { changed: false, metadataChanged, summary: { added: 0, removed: 0, changed: 0 } };
  }

  const oldByKey = new Map((doc.items || []).map((item) => [String(item.lineKey), item]));
  const nextItems = [];
  const details = [];
  let added = 0;
  let changed = 0;

  for (const source of sourceItems) {
    const old = oldByKey.get(source.lineKey);
    if (!old) {
      added += 1;
      details.push({
        kind: 'added',
        lineKey: String(source.lineKey || ''),
        name: String(source.name || ''),
        field: 'product',
        fromValue: '',
        toValue: '',
        qty: Number(source.requestedQty || 0),
      });
      nextItems.push({
        ...source,
        state: 'pending',
        pickedQty: 0,
        issueNote: '',
        updatedBy: '',
        updatedByName: '',
        updatedAt: null,
      });
      continue;
    }
    oldByKey.delete(source.lineKey);
    if (String(old.sourceFingerprint || '') !== source.sourceFingerprint) {
      changed += 1;
      details.push(...upstreamLineChangeDetails(old, source));
      nextItems.push({
        ...source,
        state: 'pending',
        pickedQty: 0,
        issueNote: '',
        updatedBy: '',
        updatedByName: '',
        updatedAt: null,
      });
    } else {
      nextItems.push({
        ...source,
        state: old.state,
        pickedQty: old.pickedQty,
        issueNote: old.issueNote,
        updatedBy: old.updatedBy,
        updatedByName: old.updatedByName,
        updatedAt: old.updatedAt,
      });
    }
  }

  const removed = oldByKey.size;
  for (const removedItem of oldByKey.values()) {
    details.push({
      kind: 'removed',
      lineKey: String(removedItem?.lineKey || ''),
      name: String(removedItem?.name || ''),
      field: 'product',
      fromValue: '',
      toValue: '',
      qty: Number(removedItem?.requestedQty || 0),
    });
  }

  const summary = { added, removed, changed };
  // Before physical fulfilment, BaseLinker remains the editable source for the
  // product list and changed lines are reset for warehouse re-check. Once the
  // warehouse has Packed/Sent, items/orderFingerprint become an immutable
  // historical snapshot. Later BaseLinker edits are recorded only as a problem.
  if (!physicalSnapshotLocked) {
    doc.items = nextItems;
    doc.orderFingerprint = nextFingerprint;
  }
  doc.lastUpstreamOrderFingerprint = nextFingerprint;
  doc.lastUpstreamChangeAt = new Date();
  doc.lastUpstreamChangeSummary = summary;
  doc.lastUpstreamChangeDetails = details.slice(0, 12);
  if (wasInitialized) {
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
  }
  if (!physicalSnapshotLocked && !TERMINAL_STATUSES.includes(doc.status)) {
    const previousWorkflowStage = workflowStageFor(doc);
    doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
    doc.workflowStage = workflowStageAfterWorkingStatus(previousWorkflowStage, doc.status);
  }
  appendHistory(doc, physicalSnapshotLocked ? 'upstream_order_changed_after_fulfillment' : 'upstream_order_changed', actor, {
    ...summary,
    warehouseSnapshotPreserved: physicalSnapshotLocked,
  });
  return { changed: true, metadataChanged, summary, warehouseSnapshotPreserved: physicalSnapshotLocked };
}

function hasWarehouseHandling(doc) {
  if (hasPhysicalWarehouseSnapshot(doc)) return true;
  return Array.isArray(doc?.items) && doc.items.some((item) => (
    Number(item?.pickedQty || 0) > 0 || String(item?.state || 'pending') !== 'pending'
  ));
}

function upstreamReviewAlreadyAcknowledged(doc) {
  const changedAt = doc?.lastUpstreamChangeAt ? new Date(doc.lastUpstreamChangeAt).getTime() : 0;
  const reviewedAt = doc?.upstreamReviewedAt ? new Date(doc.upstreamReviewedAt).getTime() : 0;
  return changedAt > 0 && reviewedAt >= changedAt;
}

function shouldRequireUpstreamReview(doc, disposition, { orderChanged = false, statusChanged = false } = {}) {
  // Review belongs to a concrete upstream EVENT, not to a persistent status.
  // After the operator acknowledges the current event, observing the same
  // status and the same order fingerprint again must not resurrect the review.
  if (!orderChanged && !statusChanged) {
    return doc?.upstreamReviewRequired === true && !upstreamReviewAlreadyAcknowledged(doc);
  }
  if (orderChanged) return true;
  if (['other', 'missing', 'unverified'].includes(String(disposition || ''))) return true;
  if (disposition === 'cancelled') return hasWarehouseHandling(doc);
  // A parcel already known as Sent must never silently become production-eligible
  // again. Sent -> Intake is a conflict even though Intake is normally actionable.
  if (disposition === 'intake' && hasLocalWarehouseSent(doc)) return true;
  return false;
}

function assertRevision(doc, expectedRevision) {
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) throw appError('baselinker_picking_revision_required');
  if (Number(doc.revision || 0) !== expected) {
    throw appError('baselinker_picking_stale', { currentRevision: Number(doc.revision || 0) });
  }
}

function assertNotUpstreamBlocked(doc) {
  const disposition = String(doc?.upstreamDisposition || '');
  if (disposition === 'intake') return;
  if (disposition === 'cancelled') throw appError('baselinker_order_cancelled');
  if (disposition === 'sent') throw appError('baselinker_order_already_sent');
  if (disposition === 'missing') throw appError('baselinker_order_not_returned', { orderId: String(doc?.orderId || '') });
  if (disposition === 'other') {
    throw appError('baselinker_order_not_in_intake', {
      orderId: String(doc?.orderId || ''),
      currentStatusId: Number.isSafeInteger(Number(doc?.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null,
    });
  }
  throw appError('baselinker_order_status_unverified');
}

function assertOwner(doc, actor) {
  assertNotUpstreamBlocked(doc);
  if (!doc.ownerTelegramId || String(doc.ownerTelegramId) !== String(actor.by)) {
    throw appError('baselinker_picking_not_owner', { ownerName: doc.ownerName || '' });
  }
  if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');
}

function upstreamVerificationIsFresh(doc, nowMs = Date.now()) {
  const verifiedAtMs = doc?.lastUpstreamVerifiedAt ? new Date(doc.lastUpstreamVerifiedAt).getTime() : 0;
  return verifiedAtMs > 0 && (nowMs - verifiedAtMs) <= UPSTREAM_VERIFICATION_TTL_MS;
}

async function verifyTrackedPickingOrderUpstream(doc, actor, {
  force = false,
  allowBlocked = false,
  clientMutationId = '',
  exactOrder = undefined,
  materializeSent = true,
  releaseOwnerOnSent = true,
} = {}) {
  if (!doc) throw appError('baselinker_picking_not_started');
  if (!force && upstreamVerificationIsFresh(doc)) {
    if (!allowBlocked) assertNotUpstreamBlocked(doc);
    return { order: null, disposition: String(doc.upstreamDisposition || ''), changed: false };
  }

  const accountId = String(doc.baseLinkerAccountId || '');
  const scope = await getQueueScope(accountId);
  if (!scope.configured) throw appError('baselinker_queue_not_configured');
  const id = String(doc.orderId || '');
  const order = exactOrder === undefined ? await fetchOptionalExactOrder(accountId, id) : exactOrder;
  const now = new Date();

  if (!order) {
    const previousDisposition = String(doc.upstreamDisposition || '');
    const previousReview = doc.upstreamReviewRequired === true;
    const hadOwner = Boolean(doc.ownerTelegramId);
    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.upstreamDisposition = 'missing';
    doc.lastUpstreamStatusId = null;
    doc.lastUpstreamVerifiedAt = now;
    if (previousDisposition !== 'missing') {
      doc.upstreamReviewRequired = true;
      doc.upstreamReviewedAt = null;
      doc.lastUpstreamChangeAt = now;
    }
    if (hadOwner) {
      doc.ownerTelegramId = '';
      doc.ownerName = '';
      doc.claimedAt = null;
      appendHistory(doc, 'upstream_ineligible_released_owner', actor, {
        disposition: 'missing', previousOwnerTelegramId, previousOwnerName, statusId: null,
      });
    }
    if (!hasPhysicalWarehouseSnapshot(doc)) {
      doc.status = deriveWorkingStatus(doc.items, false);
      doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
    }
    const changed = previousDisposition !== 'missing' || previousReview !== (doc.upstreamReviewRequired === true) || hadOwner;
    if (changed) {
      doc.revision = Number(doc.revision || 0) + 1;
      appendHistory(doc, 'upstream_order_missing', actor, {
        orderId: id,
        previousDisposition,
        releasedOwner: hadOwner,
        source: 'interactive_exact_verification',
      });
      await savePickingDoc(doc);
      emitPickingUpdate(doc, clientMutationId);
    } else {
      await BaseLinkerPickingOrder.updateOne(
        { _id: doc._id, revision: Number(doc.revision || 0) },
        { $set: { lastUpstreamVerifiedAt: now } },
      );
      doc.lastUpstreamVerifiedAt = now;
    }
    if (!allowBlocked) throw appError('baselinker_order_not_returned', { orderId: id });
    return { order: null, disposition: 'missing', changed };
  }

  const previousDisposition = String(doc.upstreamDisposition || '');
  const previousReview = doc.upstreamReviewRequired === true;
  const previousStatus = String(doc.status || '');
  const previousStage = workflowStageFor(doc);
  const physicalSnapshotLocked = hasPhysicalWarehouseSnapshot(doc);
  const upstreamState = applyUpstreamDisposition(doc, order, scope, actor, { materializeSent, releaseOwnerOnSent });
  const sync = syncDocWithOrder(doc, order, actor);
  const disposition = classifyUpstreamOrder(order, scope);
  let localTransitionChanged = false;

  // Sent is a terminal configured business outcome, not a generic non-Intake
  // blocker. applyUpstreamDisposition() already materializes the local Sent fact.
  // Other/Cancelled remain blocked; Intake restores ordinary production only when
  // there is no immutable Sent fact to protect.
  if (disposition !== 'sent' && !physicalSnapshotLocked) {
    if (disposition === 'intake') {
      if (previousDisposition && previousDisposition !== 'intake') {
        doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
        doc.workflowStage = doc.ownerTelegramId ? WORKFLOW_STAGE.PROCESSING : WORKFLOW_STAGE.DEFERRED;
        appendHistory(doc, 'upstream_actionability_restored', actor, {
          orderId: id,
          fromDisposition: previousDisposition,
          statusId: Number(order?.order_status_id) || null,
          source: 'interactive_exact_verification',
        });
        localTransitionChanged = previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
      }
    } else {
      doc.status = deriveWorkingStatus(doc.items, false);
      doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
      localTransitionChanged = previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
    }
  } else if (disposition === 'sent') {
    localTransitionChanged = previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
  }

  const dispositionChanged = previousDisposition !== String(doc.upstreamDisposition || '');
  const requiresReview = shouldRequireUpstreamReview(doc, disposition, {
    orderChanged: sync.changed === true,
    statusChanged: upstreamState.changed === true,
  });
  doc.upstreamReviewRequired = requiresReview;
  if (requiresReview) {
    doc.upstreamReviewedAt = null;
  } else if (upstreamState.changed || sync.changed) {
    doc.upstreamReviewedAt = now;
  }
  if (dispositionChanged || sync.changed || sync.metadataChanged) doc.lastUpstreamChangeAt = now;

  const reviewChanged = previousReview !== (doc.upstreamReviewRequired === true);
  const stateChanged = sync.changed || sync.metadataChanged || upstreamState.changed || upstreamState.releasedOwner
    || upstreamState.materializedSent || localTransitionChanged || dispositionChanged || reviewChanged;

  if (stateChanged) {
    doc.revision = Number(doc.revision || 0) + 1;
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
  } else {
    // Freshness proof only; no optimistic-concurrency revision bump.
    await BaseLinkerPickingOrder.updateOne(
      { _id: doc._id, revision: Number(doc.revision || 0) },
      { $set: { lastUpstreamVerifiedAt: now } },
    );
    doc.lastUpstreamVerifiedAt = now;
  }

  if (sync.changed && !allowBlocked) {
    throw appError('baselinker_order_changed', {
      currentRevision: doc.revision,
      changeSummary: sync.summary,
    });
  }
  if (!allowBlocked) assertOrderActionable(order, scope);
  return { order, disposition, changed: stateChanged, syncChanged: sync.changed };
}

async function getPickingStates(orderRefs = [], defaultAccountId = '') {
  const refs = [];
  for (const entry of orderRefs || []) {
    const accountId = String(entry && typeof entry === 'object' ? entry.baseLinkerAccountId : defaultAccountId || '').trim();
    const id = String(entry && typeof entry === 'object' ? entry.orderId : entry || '').trim();
    if (accountId && id) refs.push({ accountId, id, key: orderKey(accountId, id) });
  }
  if (!refs.length) return {};
  const byAccount = new Map();
  for (const ref of refs) {
    if (!byAccount.has(ref.accountId)) byAccount.set(ref.accountId, []);
    byAccount.get(ref.accountId).push(ref.id);
  }
  const docs = [];
  for (const [accountId, ids] of byAccount) {
    docs.push(...await BaseLinkerPickingOrder.find({ baseLinkerAccountId: accountId, orderId: { $in: [...new Set(ids)] } }).lean());
  }
  const requested = new Set(refs.map((ref) => ref.key));
  const result = {};
  for (const doc of docs) {
    const key = orderKey(doc.baseLinkerAccountId, doc.orderId);
    if (requested.has(key)) result[key] = publicState(doc);
  }
  return result;
}

async function getMyActivePicking(user) {
  const actor = actorOf(user);
  if (!actor.by) return null;
  const doc = await BaseLinkerPickingOrder.findOne({
    ownerTelegramId: actor.by,
    status: { $in: WORKING_STATUSES },
  }).sort({ lastActivityAt: -1 });
  return publicState(doc);
}

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000;
}

let claimIndexReadyPromise = null;

async function ensureClaimIndexReady() {
  if (!claimIndexReadyPromise) {
    claimIndexReadyPromise = BaseLinkerPickingOrder.createIndexes().catch((error) => {
      claimIndexReadyPromise = null;
      throw error;
    });
  }
  return claimIndexReadyPromise;
}

function claimAvailabilityFilter(actor, now, adminForce) {
  if (adminForce) return {};
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  return {
    $or: [
      { ownerTelegramId: actor.by },
      { ownerTelegramId: '' },
      { ownerTelegramId: { $exists: false } },
      { ownerTelegramId: { $nin: ['', actor.by] }, lastActivityAt: { $lte: staleBefore } },
    ],
  };
}

function claimConflictFromDoc(doc) {
  if (!doc) return appError('baselinker_picking_stale');
  if (TERMINAL_STATUSES.includes(doc.status)) return appError('baselinker_picking_terminal');
  const lastActivityMs = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
  return appError('baselinker_picking_taken', {
    ownerName: doc.ownerName || '',
    takeoverAvailableAt: lastActivityMs ? new Date(lastActivityMs + CLAIM_STALE_MS).toISOString() : null,
  });
}

function buildNewClaimedDoc({ baseLinkerAccountId, account, requestedId, order, scope, actor, now }) {
  const doc = new BaseLinkerPickingOrder({
    baseLinkerAccountId,
    baseLinkerAccountNameSnapshot: String(account?.name || ''),
    orderId: requestedId,
    status: 'in_progress',
    workflowStage: WORKFLOW_STAGE.PROCESSING,
    revision: 1,
    upstreamDisposition: 'intake',
    lastUpstreamStatusId: Number(order?.order_status_id) || null,
    lastUpstreamVerifiedAt: now,
  });
  const sync = syncDocWithOrder(doc, order, actor);
  const currentSourceName = resolveSourceName(account?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
  if (currentSourceName) {
    doc.sourceNameSnapshot = currentSourceName;
    doc.sourceNameLastKnown = currentSourceName;
    doc.sourceResolvedAt = now;
  }
  doc.ownerTelegramId = actor.by;
  doc.ownerName = actor.byName;
  doc.claimedAt = now;
  doc.lastActivityAt = now;
  doc.status = deriveWorkingStatus(doc.items, true);
  doc.revision = Number(doc.revision || 0) + 1;
  appendHistory(doc, 'order_claimed', actor, {
    orderId: requestedId,
    ...(sync.changed ? { upstreamSync: sync.summary } : {}),
  });
  return { doc, sync };
}

function buildExistingClaimUpdate({ doc, order, scope, actor, now, adminForce }) {
  const draft = new BaseLinkerPickingOrder(doc.toObject());
  const previousOwnerTelegramId = String(doc.ownerTelegramId || '');
  const previousOwnerName = String(doc.ownerName || '');
  const wasDifferentOwner = previousOwnerTelegramId !== actor.by;
  const ownerOther = Boolean(previousOwnerTelegramId) && wasDifferentOwner;
  const preservedWorkflowStage = workflowStageFor(doc);

  if (ownerOther) {
    appendHistory(draft, 'claim_taken_over', actor, {
      previousOwnerTelegramId,
      previousOwnerName,
      reason: adminForce ? 'admin_force' : 'stale_claim',
    });
  }

  applyUpstreamDisposition(draft, order, scope, actor);
  const sync = syncDocWithOrder(draft, order, actor);
  draft.ownerTelegramId = actor.by;
  draft.ownerName = actor.byName;
  if (wasDifferentOwner || !draft.claimedAt) draft.claimedAt = now;
  draft.lastActivityAt = now;
  draft.status = deriveWorkingStatus(draft.items, true);
  draft.workflowStage = preservedWorkflowStage;
  appendHistory(draft, wasDifferentOwner ? 'order_claimed' : 'order_reopened_by_owner', actor, {
    orderId: String(order?.order_id || ''),
    ...(sync.changed ? { upstreamSync: sync.summary } : {}),
  });

  const plain = draft.toObject();
  return {
    sync,
    set: {
      baseLinkerAccountNameSnapshot: plain.baseLinkerAccountNameSnapshot || '',
      sourceType: plain.sourceType || '',
      sourceId: plain.sourceId || '',
      sourceNameSnapshot: plain.sourceNameSnapshot || '',
      sourceNameLastKnown: plain.sourceNameLastKnown || '',
      sourceResolvedAt: plain.sourceResolvedAt || null,
      orderFingerprint: plain.orderFingerprint || '',
      sourceShopOrderId: plain.sourceShopOrderId || '',
      sourceExternalOrderId: plain.sourceExternalOrderId || '',
      sourceDateAdd: Number(plain.sourceDateAdd || 0),
      sourceDateConfirmed: Number(plain.sourceDateConfirmed || 0),
      sourceDeliveryPackageModule: plain.sourceDeliveryPackageModule || '',
      sourceDeliveryPackageNr: plain.sourceDeliveryPackageNr || '',
      ownerTelegramId: actor.by,
      ownerName: actor.byName,
      claimedAt: plain.claimedAt || now,
      lastActivityAt: now,
      status: plain.status,
      workflowStage: plain.workflowStage,
      items: plain.items || [],
      lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
      lastUpstreamVerifiedAt: plain.lastUpstreamVerifiedAt || now,
      lastUpstreamStatusId: plain.lastUpstreamStatusId ?? null,
      upstreamDisposition: plain.upstreamDisposition || 'intake',
      upstreamReviewRequired: plain.upstreamReviewRequired === true,
      upstreamReviewedAt: plain.upstreamReviewedAt || null,
      lastUpstreamChangeSummary: plain.lastUpstreamChangeSummary || { added: 0, removed: 0, changed: 0 },
      history: (plain.history || []).slice(-MAX_HISTORY),
    },
  };
}

async function claimPickingOrder({ baseLinkerAccountId, orderId, user, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  const requestedId = String(orderId || '').trim();
  await ensureClaimIndexReady();

  // Worker exclusivity + account lifecycle lock + concrete order lock form one
  // ordering: disable/status-config changes cannot race a new ownership claim.
  return withLock(`baselinker-worker:${actor.by}`, () => (
    withBaseLinkerAccountLifecycleLock(accountId, async () => {
      const [order, scope, account] = await Promise.all([
        fetchExactOrder(accountId, requestedId),
        getQueueScope(accountId),
        getBaseLinkerAccount(accountId, { requireEnabled: true, lean: true }),
      ]);
      if (!scope.configured) throw appError('baselinker_queue_not_configured');
      order.baseLinkerAccountId = accountId;
      order.baseLinkerAccountName = String(account?.name || '');
      order.baseLinkerAccountColor = String(account?.color || '');
      order.sourceName = resolveSourceName(account?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
      order.orderKey = orderKey(accountId, order?.order_id);
      assertOrderActionable(order, scope);

      return withLock(`baselinker-order:${accountId}:${requestedId}`, async () => {
        // Re-check enabled after the lifecycle lock was acquired. This is the
        // durable boundary against disable ↔ claim races.
        await requireAccountEnabled(accountId);
        let candidate = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId });

        const activeOther = await BaseLinkerPickingOrder.findOne({
          ownerTelegramId: actor.by,
          ...(candidate?._id ? { _id: { $ne: candidate._id } } : {}),
          status: { $in: WORKING_STATUSES },
        }).lean();
        if (activeOther) throw appError('baselinker_worker_has_active_order', { orderId: activeOther.orderId });

        const now = new Date();
        const adminForce = user?.role === 'admin' && force === true;

        if (!candidate) {
          const created = buildNewClaimedDoc({ baseLinkerAccountId: accountId, account, requestedId, order, scope, actor, now });
          try {
            await savePickingDoc(created.doc);
            emitPickingUpdate(created.doc, clientMutationId);
            return {
              state: publicState(created.doc),
              orders: compactOrders([order]),
              syncChanged: created.sync.changed === true,
            };
          } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            candidate = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId });
            if (!candidate) throw error;
          }
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          await verifyTrackedPickingOrderUpstream(candidate, actor, {
            force: true,
            allowBlocked: true,
            clientMutationId,
            exactOrder: order,
          });
          candidate = await BaseLinkerPickingOrder.findOne({ _id: candidate._id });
          if (!candidate) throw appError('baselinker_picking_stale');
          if (TERMINAL_STATUSES.includes(candidate.status)) throw appError('baselinker_picking_terminal');
          assertNotUpstreamBlocked(candidate);

          candidate.baseLinkerAccountNameSnapshot = String(account?.name || candidate.baseLinkerAccountNameSnapshot || '');
          const currentSourceName = resolveSourceName(account?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
          if (currentSourceName) {
            candidate.sourceNameLastKnown = currentSourceName;
            candidate.sourceNameSnapshot = candidate.sourceNameSnapshot || currentSourceName;
            candidate.sourceResolvedAt = new Date();
          }
          const update = buildExistingClaimUpdate({
            doc: candidate,
            order,
            scope,
            actor,
            now: new Date(),
            adminForce,
          });
          const availability = claimAvailabilityFilter(actor, new Date(), adminForce);
          const claimed = await BaseLinkerPickingOrder.findOneAndUpdate(
            {
              _id: candidate._id,
              revision: Number(candidate.revision || 0),
              status: { $nin: TERMINAL_STATUSES },
              ...availability,
            },
            { $set: update.set, $inc: { revision: 1 } },
            { new: true, runValidators: true },
          );

          if (claimed) {
            emitPickingUpdate(claimed, clientMutationId);
            return {
              state: publicState(claimed),
              orders: compactOrders([order]),
              syncChanged: update.sync.changed === true,
            };
          }

          const latest = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId });
          if (!latest) throw appError('baselinker_picking_stale');
          const latestOwner = String(latest.ownerTelegramId || '');
          const latestActivityMs = latest.lastActivityAt ? new Date(latest.lastActivityAt).getTime() : 0;
          const latestIsStale = latestOwner && latestOwner !== actor.by && latestActivityMs > 0
            && (Date.now() - latestActivityMs) >= CLAIM_STALE_MS;
          if (latestOwner && latestOwner !== actor.by && !adminForce && !latestIsStale) throw claimConflictFromDoc(latest);
          if (TERMINAL_STATUSES.includes(latest.status)) throw appError('baselinker_picking_terminal');
          candidate = latest;
        }

        throw claimConflictFromDoc(await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId }).lean());
      }, { ttlMs: 30_000, waitMs: 10_000 });
    })
  ), { ttlMs: 45_000, waitMs: 12_000 });
}

async function heartbeatPickingOrder({ baseLinkerAccountId, orderId, user }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId);
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const current = await BaseLinkerPickingOrder.findOne({
      baseLinkerAccountId: accountId,
      orderId: id,
      ownerTelegramId: actor.by,
      status: { $in: WORKING_STATUSES },
    });
    if (!current) throw appError('baselinker_picking_not_owner');
    await verifyTrackedPickingOrderUpstream(current, actor, { force: true });

    const now = new Date();
    const updated = await BaseLinkerPickingOrder.findOneAndUpdate(
      {
        _id: current._id,
        baseLinkerAccountId: accountId,
        orderId: id,
        ownerTelegramId: actor.by,
        status: { $in: WORKING_STATUSES },
      },
      { $set: { lastActivityAt: now } },
      { new: true },
    ).lean();
    if (!updated) throw appError('baselinker_picking_not_owner');
    emitPickingUpdate(updated);
    return { ok: true, lastActivityAt: updated.lastActivityAt, state: publicState(updated) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function updatePickingItem({ baseLinkerAccountId, orderId, lineKey, user, expectedRevision, state, pickedQty, issueNote, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId);
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    await verifyTrackedPickingOrderUpstream(doc, actor, { clientMutationId });
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const item = (doc.items || []).find((candidate) => String(candidate.lineKey) === String(lineKey));
    if (!item) throw appError('baselinker_picking_item_not_found');
    const nextState = String(state || '').trim();
    if (!WRITABLE_ITEM_STATES.has(nextState)) throw appError('baselinker_picking_item_state_invalid');

    const requested = Number(item.requestedQty || 0);
    let nextPickedQty = Number(pickedQty);
    if (nextState === 'pending') nextPickedQty = 0;
    if (nextState === 'picked') nextPickedQty = requested;
    if (nextState === 'not_found') nextPickedQty = 0;
    if (!Number.isFinite(nextPickedQty) || nextPickedQty < 0 || nextPickedQty > requested) {
      throw appError('baselinker_picking_quantity_invalid', { requestedQty: requested });
    }
    if (nextState === 'shortage' && !(nextPickedQty < requested)) {
      throw appError('baselinker_picking_quantity_invalid', { requestedQty: requested });
    }

    item.state = nextState;
    item.pickedQty = nextPickedQty;
    item.issueNote = ISSUE_STATES.has(nextState) ? text(issueNote).trim().slice(0, 500) : '';
    item.updatedBy = actor.by;
    item.updatedByName = actor.byName;
    item.updatedAt = new Date();

    const previousWorkflowStage = workflowStageFor(doc);
    doc.status = deriveWorkingStatus(doc.items, true);
    doc.workflowStage = workflowStageAfterWorkingStatus(previousWorkflowStage, doc.status);
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'item_updated', actor, {
      lineKey: item.lineKey,
      sourceOrderId: item.sourceOrderId || '',
      itemName: item.name,
      state: item.state,
      pickedQty: item.pickedQty,
      requestedQty: item.requestedQty,
      issueNote: item.issueNote,
    });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function releasePickingOrder({ baseLinkerAccountId, orderId, user, expectedRevision, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  const id = String(orderId);
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');
    const owns = String(doc.ownerTelegramId || '') === actor.by;
    if (!owns && !(user?.role === 'admin' && force === true)) {
      throw appError('baselinker_picking_not_owner', { ownerName: doc.ownerName || '' });
    }
    assertRevision(doc, expectedRevision);

    // Release is deliberately local. It must remain available when BaseLinker
    // is down, the token was rotated, or the order has just left Intake; its
    // purpose is only to free worker ownership without advancing production.
    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
    doc.status = deriveWorkingStatus(doc.items, false);
    doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_released', actor, {
      previousOwnerTelegramId,
      previousOwnerName,
      force: !owns,
      upstreamDisposition: String(doc.upstreamDisposition || ''),
    });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function assertBaseLinkerPrintAllowedCached({
  baseLinkerAccountId,
  orderId,
  confirmTerminalTtn = false,
  confirmedDisposition = '',
} = {}) {
  const accountId = String(baseLinkerAccountId || '').trim();
  const id = String(orderId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const scope = await getQueueScope(accountId);
  if (!scope.configured) throw appError('baselinker_queue_not_configured');

  const [doc, indexRow] = await Promise.all([
    BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id }).lean(),
    BaseLinkerOrderIndex.findOne({ baseLinkerAccountId: accountId, orderId: id }).select('preview').lean(),
  ]);

  let disposition = String(doc?.upstreamDisposition || '').trim().toLowerCase();
  if (!disposition && indexRow?.preview) disposition = classifyUpstreamOrder(indexRow.preview, scope);
  // Membership in BaseLinkerOrderIndex is authoritative cached proof of Intake.
  if (!disposition && indexRow?.preview) disposition = 'intake';

  if (disposition === 'sent' || disposition === 'cancelled') {
    const confirmationMatches = confirmTerminalTtn === true
      && String(confirmedDisposition || '').trim().toLowerCase() === disposition;
    if (!confirmationMatches) throw appError('baselinker_terminal_ttn_confirmation_required', { orderId: id, disposition });
    return { mode: `terminal_${disposition}`, disposition };
  }
  if (disposition === 'intake') return { mode: 'intake_cached', disposition };
  if (doc && hasLocalWarehouseSent(doc)) return { mode: 'warehouse_sent_history_cached', disposition };
  throw appError('baselinker_order_status_unverified', { orderId: id });
}

async function assertBaseLinkerPrintAllowed({
  baseLinkerAccountId,
  orderId,
  confirmTerminalTtn = false,
  confirmedDisposition = '',
} = {}) {
  const accountId = String(baseLinkerAccountId || '').trim();
  const id = String(orderId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);

  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    const scope = await getQueueScope(accountId);
    if (!scope.configured) throw appError('baselinker_queue_not_configured');

    const order = await fetchOptionalExactOrder(accountId, id);
    if (!order) {
      if (doc) {
        await verifyTrackedPickingOrderUpstream(doc, { by: 'system:ttn', byName: 'TTN', byRole: 'system' }, {
          force: true,
          allowBlocked: true,
          exactOrder: null,
        });
      }
      throw appError('baselinker_order_status_unverified', { orderId: id });
    }

    const disposition = classifyUpstreamOrder(order, scope);
    if (doc) {
      await verifyTrackedPickingOrderUpstream(doc, { by: 'system:ttn', byName: 'TTN', byRole: 'system' }, {
        force: true,
        allowBlocked: true,
        exactOrder: order,
      });
    }

    if (disposition === 'sent' || disposition === 'cancelled') {
      const confirmationMatches = confirmTerminalTtn === true
        && String(confirmedDisposition || '').trim().toLowerCase() === disposition;
      if (!confirmationMatches) {
        throw appError('baselinker_terminal_ttn_confirmation_required', {
          orderId: id,
          disposition,
          currentStatusId: Number(order?.order_status_id) || null,
        });
      }
      return { mode: `terminal_${disposition}`, disposition };
    }

    if (disposition === 'intake') return { mode: 'intake', disposition };

    // Operational reprint remains possible for a parcel the warehouse had
    // already sent even if the upstream order later moved to a non-terminal
    // custom status. This never re-enables production actions.
    if (doc && hasLocalWarehouseSent(doc)) return { mode: 'warehouse_sent_history', disposition };

    assertOrderActionable(order, scope);
    return { mode: 'intake', disposition };
  }, { ttlMs: 20_000, waitMs: 6_000 });
}

async function markPickingOrderPacked({ baseLinkerAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId || '').trim();

  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const order = await fetchExactOrder(accountId, id);
    const accountMeta = await getBaseLinkerAccount(accountId, { lean: true });
    order.baseLinkerAccountId = accountId;
    order.baseLinkerAccountName = String(accountMeta?.name || '');
    order.baseLinkerAccountColor = String(accountMeta?.color || '');
    order.sourceName = resolveSourceName(accountMeta?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
    order.orderKey = orderKey(accountId, order?.order_id);

    // Critical boundary: exact status is persisted first. If the order left
    // Intake, verifyTrackedPickingOrderUpstream releases ownership, emits the
    // blocked state, and only then rejects this Packed transition.
    await verifyTrackedPickingOrderUpstream(doc, actor, {
      force: true,
      clientMutationId,
      exactOrder: order,
    });

    if (doc.upstreamReviewRequired) {
      throw appError('baselinker_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });
    }

    const readiness = packingReadiness(doc.items);
    if (!readiness.allHandled) {
      throw appError('baselinker_picking_items_unhandled', {
        pendingLines: readiness.pendingLines,
        totalLines: readiness.totalLines,
      });
    }
    if (readiness.hasIssues) {
      throw appError('baselinker_picking_has_unresolved_issues', {
        problemLines: readiness.problemLines,
        missingQty: readiness.missingQty,
      });
    }
    if (!readiness.allPicked) {
      throw appError('baselinker_picking_not_ready_after_upstream_change', {
        pendingLines: readiness.pendingLines,
        problemLines: readiness.problemLines,
        missingQty: readiness.missingQty,
      });
    }

    const now = new Date();
    doc.status = ORDER_STATUS.PACKED;
    doc.workflowStage = WORKFLOW_STAGE.PACKED;
    doc.lastUpstreamStatusId = Number(order?.order_status_id) || null;
    doc.lastUpstreamOrderFingerprint = doc.lastUpstreamOrderFingerprint || doc.orderFingerprint;
    doc.packingMode = 'full';
    doc.packedSummary = {
      requestedQty: readiness.totalQty,
      packedQty: readiness.pickedQty,
      missingQty: readiness.missingQty,
      problemLines: readiness.problemLines,
    };
    doc.packedAt = now;
    doc.packedBy = actor.by;
    doc.packedByName = actor.byName;
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = now;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_packed', actor, {
      orderId: id,
      packingMode: 'full',
      requestedQty: readiness.totalQty,
      packedQty: readiness.pickedQty,
      missingQty: readiness.missingQty,
      problemLines: readiness.problemLines,
      warehouseSnapshotFingerprint: doc.orderFingerprint || '',
    });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return { state: publicState(doc), orders: compactOrders([order]) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function markPickingOrderSent({ baseLinkerAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId || '').trim();
  const scope = await getQueueScope(accountId);
  if (!scope.configured || !Number.isSafeInteger(Number(scope.sentStatusId))) throw appError('baselinker_queue_not_configured');

  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');

    const startingStatus = String(doc.status || '');
    const startingStage = workflowStageFor(doc);
    const legacyPacked = startingStatus === ORDER_STATUS.PACKED || startingStage === WORKFLOW_STAGE.PACKED;

    // New flow: the worker sends directly from Ready. Ownership is still the
    // authority boundary, so another operator cannot finalize somebody else's
    // in-progress order. Legacy Packed rows remain sendable after the UI shelf
    // is removed and intentionally have no owner.
    if (!legacyPacked) assertOwner(doc, actor);
    // Validate the user's observed revision before an exact upstream read can
    // legitimately advance our reconciliation revision.
    assertRevision(doc, expectedRevision);

    let order = await fetchExactOrder(accountId, id);
    const accountMeta = await getBaseLinkerAccount(accountId, { lean: true });
    const decorate = (row) => {
      row.baseLinkerAccountId = accountId;
      row.baseLinkerAccountName = String(accountMeta?.name || '');
      row.baseLinkerAccountColor = String(accountMeta?.color || '');
      row.sourceName = resolveSourceName(accountMeta?.metadataSnapshot?.sources, row?.order_source, row?.order_source_id);
      row.orderKey = orderKey(accountId, row?.order_id);
      return row;
    };
    decorate(order);

    const reviewWasAlreadyRequired = doc.upstreamReviewRequired === true;
    const verification = await verifyTrackedPickingOrderUpstream(doc, actor, {
      force: true,
      allowBlocked: true,
      clientMutationId,
      exactOrder: order,
      // During this explicit physical Send click, an already-Sent upstream
      // status is an input to this operation, not a reason to pre-materialize
      // system:baselinker as the warehouse actor or release the worker first.
      materializeSent: false,
      releaseOwnerOnSent: false,
    });
    let disposition = verification.disposition || classifyUpstreamOrder(order, scope);

    // Local Sent is a physical warehouse fact. Repeating the action is
    // idempotent even if BaseLinker was subsequently moved elsewhere; the exact
    // verification above still records that mismatch as Updated/problem.
    if (doc.status === ORDER_STATUS.SENT || workflowStageFor(doc) === WORKFLOW_STAGE.SENT) {
      return { state: publicState(doc), orders: compactOrders([order]) };
    }

    if (verification.syncChanged) {
      throw appError('baselinker_order_changed', {
        currentRevision: doc.revision,
        changeSummary: doc.lastUpstreamChangeSummary || {},
      });
    }
    if (!['intake', 'sent'].includes(disposition)) {
      if (disposition === 'cancelled') throw appError('baselinker_order_cancelled', { orderId: id });
      if (disposition === 'missing') throw appError('baselinker_order_not_returned', { orderId: id });
      throw appError('baselinker_order_not_in_intake', {
        orderId: id,
        currentStatusId: Number(order?.order_status_id) || null,
        intakeStatusId: Number(scope.intakeStatusId) || null,
      });
    }
    // A review that already existed before this Send attempt must be resolved
    // explicitly. A pure status transition Intake -> Sent observed by this same
    // click is not a blocker: the worker's click is the physical confirmation.
    if (reviewWasAlreadyRequired) {
      throw appError('baselinker_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });
    }

    const readiness = packingReadiness(doc.items);
    if (!readiness.allHandled || readiness.hasIssues || !readiness.allPicked) {
      throw appError('baselinker_picking_not_ready_after_upstream_change', {
        pendingLines: readiness.pendingLines,
        problemLines: readiness.problemLines,
        missingQty: readiness.missingQty,
      });
    }

    if (!legacyPacked && String(doc.status || '') !== ORDER_STATUS.READY) {
      throw appError('baselinker_picking_not_ready_after_upstream_change', { status: String(doc.status || '') });
    }

    // If BaseLinker is still Intake, move exactly this order to configured Sent.
    // If a manager already put it in Sent, do not rewrite anything upstream;
    // the warehouse click below is what creates our local physical Sent fact.
    if (disposition === 'intake') {
      await setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId }, makeBaseLinkerAccountCaller(accountId, { usageStage: 'picking_status_write' }));
      order = decorate(await fetchExactOrder(accountId, id));
      disposition = classifyUpstreamOrder(order, scope);
    }
    if (disposition !== 'sent' || Number(order?.order_status_id) !== Number(scope.sentStatusId)) {
      throw appError('baselinker_order_status_write_unverified', { orderId: id, statusId: scope.sentStatusId });
    }

    // Packed snapshot is immutable as a physical fact, but no longer a
    // separate UI/business shelf. A direct Send records the packed audit at
    // the same click. Legacy rows preserve their original packer/timestamp.
    const postWriteSync = syncDocWithOrder(doc, order, actor);
    const now = new Date();
    if (!doc.packedAt) {
      doc.packingMode = 'full';
      doc.packedSummary = {
        requestedQty: readiness.totalQty,
        packedQty: readiness.pickedQty,
        missingQty: readiness.missingQty,
        problemLines: readiness.problemLines,
      };
      doc.packedAt = now;
      doc.packedBy = actor.by;
      doc.packedByName = actor.byName;
      doc.lastUpstreamOrderFingerprint = doc.lastUpstreamOrderFingerprint || doc.orderFingerprint;
      appendHistory(doc, 'order_packed', actor, {
        orderId: id,
        packingMode: 'full',
        requestedQty: readiness.totalQty,
        packedQty: readiness.pickedQty,
        missingQty: readiness.missingQty,
        problemLines: readiness.problemLines,
        warehouseSnapshotFingerprint: doc.orderFingerprint || '',
        combinedWithSend: true,
      });
    }
    doc.status = ORDER_STATUS.SENT;
    doc.workflowStage = WORKFLOW_STAGE.SENT;
    doc.upstreamDisposition = 'sent';
    doc.lastUpstreamStatusId = Number(scope.sentStatusId);
    doc.lastUpstreamVerifiedAt = now;
    doc.sentAt = now;
    doc.sentBy = actor.by;
    doc.sentByName = actor.byName;
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = now;
    if (!postWriteSync.changed) {
      doc.upstreamReviewRequired = false;
      doc.upstreamReviewedAt = now;
    }
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_sent_upstream_verified', actor, {
      orderId: id,
      statusId: Number(scope.sentStatusId),
      postWriteOrderChanged: postWriteSync.changed === true,
      warehouseSnapshotFingerprint: doc.orderFingerprint || '',
    });
    await savePickingDoc(doc);

    try {
      const { removeIndexedOrders } = require('./baseLinkerOrderIndex');
      await removeIndexedOrders(accountId, [id]);
    } catch (error) {
      console.error('[baselinker] sent index removal failed', error);
    }

    emitPickingUpdate(doc, clientMutationId);
    return { state: publicState(doc), orders: compactOrders([order]) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function reopenPickingOrder({ baseLinkerAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  if (user?.role !== 'admin') throw appError('forbidden');
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId);
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    if (hasPhysicalWarehouseSnapshot(doc)) throw appError('baselinker_physical_fulfillment_immutable');
    await verifyTrackedPickingOrderUpstream(doc, actor, { force: true, clientMutationId });
    assertNotUpstreamBlocked(doc);
    assertRevision(doc, expectedRevision);
    doc.status = deriveWorkingStatus(doc.items, false);
    doc.workflowStage = workflowStageAfterWorkingStatus(WORKFLOW_STAGE.PROCESSING, doc.status);
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.packingMode = '';
    doc.packedSummary = { requestedQty: 0, packedQty: 0, missingQty: 0, problemLines: 0 };
    doc.packedAt = null;
    doc.packedBy = '';
    doc.packedByName = '';
    doc.sentAt = null;
    doc.sentBy = '';
    doc.sentByName = '';
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_reopened_by_admin', actor, {});
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}


async function fetchOptionalExactOrder(baseLinkerAccountId, orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const result = await fetchBaseLinkerOrders({
    orderId: id,
    includeUnconfirmed: false,
    maxPages: 1,
  }, makeBaseLinkerAccountCaller(baseLinkerAccountId, { usageStage: 'picking_exact_verify' }));
  const order = (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id)) || null;
  return order;
}

async function markPickingOrdersUpstreamUpdated({
  baseLinkerAccountId,
  orderIds = [],
  orders = [],
  knownAdmittedOrderIds = [],
} = {}) {
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  const ids = [...new Set((orderIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!ids.length) return { marked: 0, materializedCancelled: 0, materializedUpdated: 0 };
  const actor = { by: 'system:baselinker-queue', byName: 'BaseLinker', byRole: 'system' };
  const scope = await getQueueScope(accountId);
  const known = new Set((knownAdmittedOrderIds || []).map(String));
  const exactById = new Map((orders || []).map((order) => [String(order?.order_id || ''), order]).filter(([id]) => id));

  let marked = 0;
  let materializedCancelled = 0;
  let materializedUpdated = 0;

  // Background upstream observations mutate the same PickingOrder documents as
  // worker actions. They therefore share the exact same per-order lock namespace.
  // Never let queue reconciliation race item/pack/sent mutations.
  for (const id of ids) {
    await withLock(`baselinker-order:${accountId}:${id}`, async () => {
      let doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
      const order = exactById.get(id) || null;
      let newlyMaterialized = false;

      if (!doc && known.has(id)) {
        const disposition = order ? classifyUpstreamOrder(order, scope) : 'missing';
        if (disposition !== 'intake') {
          const account = await getBaseLinkerAccount(accountId, { lean: true }).catch(() => null);
          const now = new Date();
          const isSent = disposition === 'sent';
          doc = new BaseLinkerPickingOrder({
            baseLinkerAccountId: accountId,
            baseLinkerAccountNameSnapshot: String(account?.name || ''),
            orderId: id,
            status: isSent ? ORDER_STATUS.SENT : ORDER_STATUS.PAUSED,
            workflowStage: isSent ? WORKFLOW_STAGE.SENT : WORKFLOW_STAGE.DEFERRED,
            revision: 1,
            upstreamDisposition: disposition,
            lastUpstreamStatusId: order && Number.isSafeInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
            lastUpstreamVerifiedAt: now,
            sentAt: isSent ? now : null,
            sentBy: isSent ? 'system:baselinker' : '',
            sentByName: isSent ? 'BaseLinker' : '',
          });
          if (order) {
            const sourceName = resolveSourceName(account?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
            if (sourceName) order.sourceName = sourceName;
            syncDocWithOrder(doc, order, actor);
          }
          const requiresReview = ['other', 'missing', 'unverified'].includes(disposition);
          doc.upstreamReviewRequired = requiresReview;
          doc.upstreamReviewedAt = requiresReview ? null : now;
          doc.lastUpstreamChangeAt = now;
          const action = disposition === 'cancelled'
            ? 'upstream_cancelled_before_claim'
            : disposition === 'sent'
              ? 'upstream_sent_before_claim'
              : 'upstream_updated_before_claim';
          appendHistory(doc, action, actor, {
            orderId: id,
            disposition,
            statusId: doc.lastUpstreamStatusId,
          });
          try {
            await savePickingDoc(doc);
            emitPickingUpdate(doc);
            if (requiresReview) materializedUpdated += 1;
            if (disposition === 'cancelled') materializedCancelled += 1;
            newlyMaterialized = true;
          } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
          }
        }
      }

      if (!doc || newlyMaterialized) return;
      doc.upstreamReviewRequired = true;
      doc.upstreamReviewedAt = null;
      doc.lastUpstreamChangeAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      appendHistory(doc, 'upstream_review_required', actor, { orderIds: [id] });
      await savePickingDoc(doc);
      emitPickingUpdate(doc);
      marked += 1;
    }, { ttlMs: 30_000, waitMs: 10_000 });
  }

  return { marked, materializedCancelled, materializedUpdated };
}

async function acknowledgeUpstreamReview({ baseLinkerAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  await requireAccountEnabled(accountId);
  const id = String(orderId || '');
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    const beforeRevision = Number(doc.revision || 0);
    await verifyTrackedPickingOrderUpstream(doc, actor, {
      force: true,
      allowBlocked: true,
      clientMutationId,
    });
    // If the exact BaseLinker reread changed our canonical state, the caller's
    // old revision is intentionally stale. Return the new state and require the
    // operator to review what actually changed before acknowledging it.
    if (Number(doc.revision || 0) !== beforeRevision) return publicState(doc);
    assertRevision(doc, expectedRevision);
    if (!doc.upstreamReviewRequired) return publicState(doc);
    doc.upstreamReviewRequired = false;
    doc.upstreamReviewedAt = new Date();
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_change_reviewed', actor, {
      lastUpstreamChangeAt: doc.lastUpstreamChangeAt || null,
    });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function reconcilePickingFromUpstreamChanges({ baseLinkerAccountId, orders = [], removedOrderIds = [] } = {}) {
  const accountId = String(baseLinkerAccountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');
  const changedOrders = Array.isArray(orders) ? orders.filter(Boolean) : [];
  const changedById = new Map(changedOrders
    .map((order) => [String(order?.order_id || ''), order])
    .filter(([id]) => id));
  const removed = new Set((removedOrderIds || []).map((id) => String(id || '')).filter(Boolean));
  const affectedIds = [...new Set([...changedById.keys(), ...removed])];
  if (!affectedIds.length) return { reconciled: 0, changed: 0, released: 0 };

  const docs = await BaseLinkerPickingOrder.find({ baseLinkerAccountId: accountId, orderId: { $in: affectedIds } }).lean();
  const systemActor = { by: 'system:baselinker-queue', byName: 'BaseLinker', byRole: 'system' };
  const scope = await getQueueScope(accountId);
  let reconciled = 0;
  let changed = 0;
  let released = 0;

  for (const row of docs) {
    const localOrderId = String(row.orderId || '');
    if (!localOrderId) continue;

    await withLock(`baselinker-order:${accountId}:${localOrderId}`, async () => {
      const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: localOrderId });
      if (!doc) return;
      const exactOrder = removed.has(localOrderId)
        ? null
        : (changedById.get(localOrderId) || await fetchOptionalExactOrder(accountId, localOrderId));
      const now = new Date();

      if (!exactOrder) {
        const previousDisposition = String(doc.upstreamDisposition || '');
        const previousStatus = String(doc.status || '');
        const previousStage = workflowStageFor(doc);
        const hadOwner = Boolean(doc.ownerTelegramId);
        const previousOwnerTelegramId = doc.ownerTelegramId || '';
        const previousOwnerName = doc.ownerName || '';
        doc.upstreamDisposition = 'missing';
        doc.lastUpstreamStatusId = null;
        doc.lastUpstreamVerifiedAt = now;
        if (previousDisposition !== 'missing') {
          doc.upstreamReviewRequired = true;
          doc.upstreamReviewedAt = null;
          doc.lastUpstreamChangeAt = now;
        }
        if (hadOwner) {
          doc.ownerTelegramId = '';
          doc.ownerName = '';
          doc.claimedAt = null;
          appendHistory(doc, 'upstream_ineligible_released_owner', systemActor, {
            disposition: 'missing', previousOwnerTelegramId, previousOwnerName, statusId: null,
          });
        }
        if (!hasPhysicalWarehouseSnapshot(doc)) {
          doc.status = deriveWorkingStatus(doc.items, false);
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
        }
        const stateChanged = previousDisposition !== 'missing' || hadOwner
          || previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
        if (stateChanged) {
          doc.revision = Number(doc.revision || 0) + 1;
          appendHistory(doc, 'upstream_order_missing', systemActor, {
            orderId: localOrderId,
            previousDisposition,
            releasedOwner: hadOwner,
          });
          await savePickingDoc(doc);
          emitPickingUpdate(doc);
          changed += 1;
          if (hadOwner) released += 1;
        }
        reconciled += 1;
        return;
      }

      const previousDisposition = String(doc.upstreamDisposition || '');
      const previousReview = doc.upstreamReviewRequired === true;
      const previousStatus = String(doc.status || '');
      const previousStage = workflowStageFor(doc);
      const physicalSnapshotLocked = hasPhysicalWarehouseSnapshot(doc);
      const upstreamState = applyUpstreamDisposition(doc, exactOrder, scope, systemActor);
      const sync = syncDocWithOrder(doc, exactOrder, systemActor);
      const disposition = classifyUpstreamOrder(exactOrder, scope);
      let localTransitionChanged = false;

      if (disposition !== 'sent' && !physicalSnapshotLocked) {
        if (disposition === 'intake') {
          if (previousDisposition && previousDisposition !== 'intake') {
            doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
            doc.workflowStage = doc.ownerTelegramId ? WORKFLOW_STAGE.PROCESSING : WORKFLOW_STAGE.DEFERRED;
            appendHistory(doc, 'upstream_actionability_restored', systemActor, {
              orderId: localOrderId,
              fromDisposition: previousDisposition,
              statusId: Number(exactOrder?.order_status_id) || null,
            });
          }
        } else {
          doc.status = deriveWorkingStatus(doc.items, false);
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
        }
        localTransitionChanged = previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
      } else if (disposition === 'sent') {
        localTransitionChanged = previousStatus !== String(doc.status || '') || previousStage !== workflowStageFor(doc);
      }

      const dispositionChanged = previousDisposition !== String(doc.upstreamDisposition || '');
      const requiresReview = shouldRequireUpstreamReview(doc, disposition, {
    orderChanged: sync.changed === true,
    statusChanged: upstreamState.changed === true,
  });
      doc.upstreamReviewRequired = requiresReview;
      if (requiresReview) {
        doc.upstreamReviewedAt = null;
      } else if (upstreamState.changed || sync.changed) {
        doc.upstreamReviewedAt = now;
      }
      if (dispositionChanged || sync.changed || sync.metadataChanged) doc.lastUpstreamChangeAt = now;
      const reviewChanged = previousReview !== (doc.upstreamReviewRequired === true);
      const stateChanged = sync.changed || sync.metadataChanged || upstreamState.changed || upstreamState.releasedOwner
        || upstreamState.materializedSent || localTransitionChanged || dispositionChanged || reviewChanged;
      if (stateChanged) {
        doc.revision = Number(doc.revision || 0) + 1;
        await savePickingDoc(doc);
        emitPickingUpdate(doc);
        changed += 1;
        if (upstreamState.releasedOwner) released += 1;
      }
      reconciled += 1;
    }, { ttlMs: 20_000, waitMs: 5_000 });
  }

  return { reconciled, changed, released };
}

module.exports = {
  ensurePickingIndexesReady: ensureClaimIndexReady,
  CLAIM_STALE_MS,
  buildSourceItems,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
  getPickingStates,
  getMyActivePicking,
  claimPickingOrder,
  heartbeatPickingOrder,
  updatePickingItem,
  releasePickingOrder,
  assertBaseLinkerPrintAllowed,
  assertBaseLinkerPrintAllowedCached,
  markPickingOrderPacked,
  markPickingOrderSent,
  reopenPickingOrder,
  publicState,
  markPickingOrdersUpstreamUpdated,
  acknowledgeUpstreamReview,
  reconcilePickingFromUpstreamChanges,
};

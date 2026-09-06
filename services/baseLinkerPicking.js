const crypto = require('crypto');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { getBaseLinkerAccount } = require('./baseLinkerAccounts');
const { orderKey, resolveSourceName } = require('./baseLinkerIdentity');
const { withLock } = require('../utils/lock');
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
    upstreamBlocked: ['cancelled', 'sent'].includes(String(plain.upstreamDisposition || '')),
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
  // Include unconfirmed orders as well because BaseLinker confirmed is not our business-ready gate.
  const result = await fetchBaseLinkerOrders({
    orderId: id,
    includeUnconfirmed: true,
    maxPages: 1,
  }, makeBaseLinkerAccountCaller(baseLinkerAccountId));
  const order = (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id));
  if (!order) throw appError('baselinker_order_not_returned', { orderId: id, upstreamMethod: 'getOrders' });
  if (!Array.isArray(order.products) || order.products.length === 0) throw appError('baselinker_order_has_no_products', { orderId: id });
  return order;
}


function assertOrderActionable(order, scope) {
  const disposition = classifyUpstreamOrder(order, scope);
  const id = String(order?.order_id || '');
  // Intake is only the admission status for new queue rows. Once an order is
  // already tracked locally, ordinary BaseLinker status changes are surfaced
  // through Updated and our local workflow keeps running. Only explicit
  // business-terminal BaseLinker states block warehouse mutations.
  if (disposition === 'cancelled') throw appError('baselinker_order_cancelled', { orderId: id });
  if (disposition === 'sent') throw appError('baselinker_order_already_sent', { orderId: id });
  return disposition;
}

function applyUpstreamDisposition(doc, order, scope, actor) {
  const nextDisposition = order ? classifyUpstreamOrder(order, scope) : 'missing';
  const nextStatusId = order && Number.isSafeInteger(Number(order?.order_status_id))
    ? Number(order.order_status_id)
    : null;
  const previousDisposition = String(doc.upstreamDisposition || '');
  const previousStatusId = Number.isSafeInteger(Number(doc.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null;
  const changed = previousDisposition !== nextDisposition || previousStatusId !== nextStatusId;
  let releasedOwner = false;

  doc.upstreamDisposition = nextDisposition;
  doc.lastUpstreamStatusId = nextStatusId;
  doc.lastUpstreamVerifiedAt = new Date();

  // BaseLinker status is metadata for an already-admitted order. Do not steal
  // ownership merely because it moved to another ordinary BaseLinker status.
  // Only explicit terminal business states release warehouse ownership.
  if (['cancelled', 'sent'].includes(nextDisposition) && doc.ownerTelegramId) {
    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    releasedOwner = true;
    appendHistory(doc, 'upstream_terminal_released_owner', actor, {
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
  return { changed, releasedOwner, disposition: nextDisposition };
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
    doc.lastUpstreamChangeDetails = [];
    return { changed: false, metadataChanged, summary: { added: 0, removed: 0, changed: 0 }, initialized: true };
  }
  if (doc.orderFingerprint === nextFingerprint) return { changed: false, metadataChanged, summary: { added: 0, removed: 0, changed: 0 } };

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
  doc.items = nextItems;
  doc.orderFingerprint = nextFingerprint;
  doc.lastUpstreamChangeAt = new Date();
  doc.lastUpstreamChangeSummary = summary;
  doc.lastUpstreamChangeDetails = details.slice(0, 12);
  // Once a local picking document exists, any later BaseLinker line change
  // needs explicit review. It does not matter whether the worker had already
  // ticked one item or had only just claimed the order.
  if (wasInitialized) {
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
  }
  if (!TERMINAL_STATUSES.includes(doc.status)) {
    const previousWorkflowStage = workflowStageFor(doc);
    doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
    doc.workflowStage = workflowStageAfterWorkingStatus(previousWorkflowStage, doc.status);
  }
  appendHistory(doc, 'upstream_order_changed', actor, summary);
  return { changed: true, metadataChanged, summary };
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
  if (disposition === 'cancelled') throw appError('baselinker_order_cancelled');
  if (disposition === 'sent') throw appError('baselinker_order_already_sent');
  // Missing is not an ordinary upstream status. An exact getOrders(order_id)
  // failed to return the tracked order, so continuing warehouse mutations would
  // mean working without an upstream order to verify against.
  if (disposition === 'missing') throw appError('baselinker_order_not_returned', { orderId: String(doc?.orderId || '') });
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
    doc.upstreamDisposition = 'missing';
    doc.lastUpstreamStatusId = null;
    doc.lastUpstreamVerifiedAt = now;
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
    doc.lastUpstreamChangeAt = now;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_order_missing', actor, {
      orderId: id,
      previousDisposition,
      releasedOwner: false,
      source: 'interactive_exact_verification',
    });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return { order: null, disposition: 'missing', changed: true };
  }

  const previousDisposition = String(doc.upstreamDisposition || '');
  const previousLocalStatus = String(doc.status || '');
  const upstreamState = applyUpstreamDisposition(doc, order, scope, actor);
  const sync = syncDocWithOrder(doc, order, actor);
  const disposition = classifyUpstreamOrder(order, scope);
  let localTransitionChanged = false;

  if (disposition === 'sent') {
    if (doc.status !== ORDER_STATUS.SENT || workflowStageFor(doc) !== WORKFLOW_STAGE.SENT) {
      doc.status = ORDER_STATUS.SENT;
      doc.workflowStage = WORKFLOW_STAGE.SENT;
      doc.sentAt = doc.sentAt || now;
      doc.sentBy = doc.sentBy || 'system:baselinker';
      doc.sentByName = doc.sentByName || 'BaseLinker';
      doc.ownerTelegramId = '';
      doc.ownerName = '';
      doc.claimedAt = null;
      appendHistory(doc, 'upstream_sent_materialized', actor, {
        orderId: id,
        statusId: Number(order?.order_status_id) || null,
        source: 'interactive_exact_verification',
      });
      localTransitionChanged = true;
    }
  } else if (disposition === 'intake' && previousDisposition && previousDisposition !== 'intake') {
    // If BaseLinker moves a blocked/sent order back to Intake, derive the
    // current local workflow from durable picking facts. Never keep an old
    // upstream terminal marker as the active local state.
    const readiness = packingReadiness(doc.items);
    if (doc.packedAt && readiness.allHandled && readiness.allPicked && !readiness.hasIssues) {
      doc.status = ORDER_STATUS.PACKED;
      doc.workflowStage = WORKFLOW_STAGE.PACKED;
    } else {
      doc.status = deriveWorkingStatus(doc.items, false);
      doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
    }
    if (previousDisposition === 'sent' || previousLocalStatus === ORDER_STATUS.SENT) {
      doc.sentAt = null;
      doc.sentBy = '';
      doc.sentByName = '';
    }
    appendHistory(doc, 'upstream_actionability_restored', actor, {
      orderId: id,
      fromDisposition: previousDisposition,
      statusId: Number(order?.order_status_id) || null,
      source: 'interactive_exact_verification',
    });
    localTransitionChanged = true;
  } else if (disposition === 'cancelled') {
    // Cancelled is an explicit business-terminal BaseLinker state and belongs
    // to the Cancelled shelf. Ordinary non-Intake statuses stay in our local
    // workflow and are surfaced through Updated instead of being force-paused.
    if (doc.status !== ORDER_STATUS.PAUSED || workflowStageFor(doc) !== WORKFLOW_STAGE.DEFERRED) {
      doc.status = ORDER_STATUS.PAUSED;
      doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
      localTransitionChanged = true;
    }
  }

  const dispositionChanged = previousDisposition !== String(doc.upstreamDisposition || '');
  const stateChanged = sync.changed || sync.metadataChanged || upstreamState.changed || upstreamState.releasedOwner
    || localTransitionChanged || dispositionChanged;

  if (stateChanged) {
    if (disposition !== 'intake' || sync.changed || dispositionChanged) {
      doc.upstreamReviewRequired = true;
      doc.upstreamReviewedAt = null;
      doc.lastUpstreamChangeAt = now;
    }
    doc.revision = Number(doc.revision || 0) + 1;
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
  } else {
    // Persist only the freshness proof. This is not a business-state mutation,
    // so it must not bump the optimistic concurrency revision.
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
  await ensureClaimIndexReady();

  // Locks reduce contention; the composite accountId + orderId unique index plus
  // revision CAS is the durable correctness boundary across processes.
  return withLock(`baselinker-worker:${actor.by}`, () => (
    withLock(`baselinker-order:${accountId}:${requestedId}`, async () => {
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
        // The exact BaseLinker read above is newer than the local picking
        // projection. Reconcile it first, otherwise a stale local Sent/Cancelled
        // marker could incorrectly block an order that BaseLinker returned to
        // the configured Intake status.
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
        if (currentSourceName) { candidate.sourceNameLastKnown = currentSourceName; candidate.sourceNameSnapshot = candidate.sourceNameSnapshot || currentSourceName; candidate.sourceResolvedAt = new Date(); }
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
        if (latestOwner && latestOwner !== actor.by && !adminForce && !latestIsStale) {
          throw claimConflictFromDoc(latest);
        }
        if (TERMINAL_STATUSES.includes(latest.status)) throw appError('baselinker_picking_terminal');
        candidate = latest;
      }

      throw claimConflictFromDoc(await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId }).lean());
    }, { ttlMs: 30_000, waitMs: 10_000 })
  ), { ttlMs: 30_000, waitMs: 10_000 });
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
  await requireAccountEnabled(accountId);
  const id = String(orderId);
  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    await verifyTrackedPickingOrderUpstream(doc, actor, { clientMutationId });
    assertNotUpstreamBlocked(doc);
    if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');
    const owns = String(doc.ownerTelegramId || '') === actor.by;
    if (!owns && !(user?.role === 'admin' && force === true)) {
      throw appError('baselinker_picking_not_owner', { ownerName: doc.ownerName || '' });
    }
    assertRevision(doc, expectedRevision);

    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
    doc.status = deriveWorkingStatus(doc.items, false);
    doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_released', actor, { previousOwnerTelegramId, previousOwnerName, force: !owns });
    await savePickingDoc(doc);
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
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
    const scope = await getQueueScope(accountId);
    assertOrderActionable(order, scope);
    applyUpstreamDisposition(doc, order, scope, actor);

    const sync = syncDocWithOrder(doc, order, actor);
    if (sync.changed) {
      doc.lastActivityAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      await savePickingDoc(doc);
      emitPickingUpdate(doc, clientMutationId);
      throw appError('baselinker_order_changed', { currentRevision: doc.revision, changeSummary: sync.summary });
    }

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
    const packingMode = 'full';
    doc.status = 'packed';
    doc.workflowStage = WORKFLOW_STAGE.PACKED;
    doc.lastUpstreamStatusId = Number(order?.order_status_id) || null;
    doc.packingMode = packingMode;
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
      packingMode,
      requestedQty: readiness.totalQty,
      packedQty: readiness.pickedQty,
      missingQty: readiness.missingQty,
      problemLines: readiness.problemLines,
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
  if (!scope.configured || !Number.isSafeInteger(Number(scope.sentStatusId))) {
    throw appError('baselinker_queue_not_configured');
  }

  return withLock(`baselinker-order:${accountId}:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');

    let order = await fetchExactOrder(accountId, id);
    const accountMeta = await getBaseLinkerAccount(accountId, { lean: true });
    order.baseLinkerAccountId = accountId;
    order.baseLinkerAccountName = String(accountMeta?.name || '');
    order.baseLinkerAccountColor = String(accountMeta?.color || '');
    order.sourceName = resolveSourceName(accountMeta?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
    order.orderKey = orderKey(accountId, order?.order_id);
    let disposition = classifyUpstreamOrder(order, scope);

    // Idempotent recovery: if local Sent already exists, it is valid only while
    // exact BaseLinker truth still says the configured Sent status.
    if (doc.status === 'sent') {
      if (disposition !== 'sent' || Number(order?.order_status_id) !== Number(scope.sentStatusId)) {
        throw appError('baselinker_order_status_write_unverified', { orderId: id, statusId: scope.sentStatusId });
      }
      return { state: publicState(doc), orders: compactOrders([order]) };
    }

    assertRevision(doc, expectedRevision);
    if (doc.status !== 'packed') throw appError('baselinker_picking_not_packed');
    if (disposition === 'cancelled') throw appError('baselinker_order_cancelled', { orderId: id });

    applyUpstreamDisposition(doc, order, scope, actor);
    const sync = syncDocWithOrder(doc, order, actor);
    if (sync.changed) {
      doc.lastActivityAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      await savePickingDoc(doc);
      emitPickingUpdate(doc, clientMutationId);
      throw appError('baselinker_order_changed', { currentRevision: doc.revision, changeSummary: sync.summary });
    }
    if (doc.upstreamReviewRequired) throw appError('baselinker_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });

    const readiness = packingReadiness(doc.items);
    if (!readiness.allHandled || readiness.hasIssues || !readiness.allPicked) {
      throw appError('baselinker_picking_not_ready_after_upstream_change', {
        pendingLines: readiness.pendingLines,
        problemLines: readiness.problemLines,
        missingQty: readiness.missingQty,
      });
    }

    // The only BaseLinker mutation in the picking module. Upstream goes first;
    // local Sent is never allowed to claim success while BaseLinker says otherwise.
    if (disposition !== 'sent') {
      await setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId }, makeBaseLinkerAccountCaller(accountId));
      order = await fetchExactOrder(accountId, id);
      disposition = classifyUpstreamOrder(order, scope);
    }
    if (disposition !== 'sent' || Number(order?.order_status_id) !== Number(scope.sentStatusId)) {
      throw appError('baselinker_order_status_write_unverified', { orderId: id, statusId: scope.sentStatusId });
    }

    // Reconcile the exact post-write payload too. If product data changed in the
    // narrow race between the preflight read and setOrderStatus, preserve that
    // fact and require review instead of silently keeping stale local lines.
    const postWriteSync = syncDocWithOrder(doc, order, actor);

    const now = new Date();
    doc.status = 'sent';
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
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_sent_upstream_verified', actor, {
      orderId: id,
      statusId: Number(scope.sentStatusId),
      postWriteOrderChanged: postWriteSync.changed === true,
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
    includeUnconfirmed: true,
    maxPages: 1,
  }, makeBaseLinkerAccountCaller(baseLinkerAccountId));
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
        if (!['intake', 'sent'].includes(disposition)) {
          const account = await getBaseLinkerAccount(accountId, { lean: true }).catch(() => null);
          doc = new BaseLinkerPickingOrder({
            baseLinkerAccountId: accountId,
            baseLinkerAccountNameSnapshot: String(account?.name || ''),
            orderId: id,
            status: ORDER_STATUS.PAUSED,
            workflowStage: WORKFLOW_STAGE.DEFERRED,
            revision: 1,
            upstreamDisposition: disposition,
            lastUpstreamStatusId: order && Number.isSafeInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
            lastUpstreamVerifiedAt: new Date(),
          });
          if (order) {
            const sourceName = resolveSourceName(account?.metadataSnapshot?.sources, order?.order_source, order?.order_source_id);
            if (sourceName) order.sourceName = sourceName;
            syncDocWithOrder(doc, order, actor);
          }
          doc.upstreamReviewRequired = true;
          doc.upstreamReviewedAt = null;
          doc.lastUpstreamChangeAt = new Date();
          const action = disposition === 'cancelled' ? 'upstream_cancelled_before_claim' : 'upstream_updated_before_claim';
          appendHistory(doc, action, actor, {
            orderId: id,
            disposition,
            statusId: doc.lastUpstreamStatusId,
          });
          try {
            await savePickingDoc(doc);
            emitPickingUpdate(doc);
            materializedUpdated += 1;
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

      if (!exactOrder) {
        const previousDisposition = String(doc.upstreamDisposition || '');
        doc.upstreamDisposition = 'missing';
        doc.lastUpstreamStatusId = null;
        doc.lastUpstreamVerifiedAt = new Date();
        doc.upstreamReviewRequired = true;
        doc.upstreamReviewedAt = null;
        doc.lastUpstreamChangeAt = new Date();
        doc.lastUpstreamChangeSummary = { added: 0, removed: 0, changed: 0 };
        doc.lastUpstreamChangeDetails = [];
        doc.revision = Number(doc.revision || 0) + 1;
        appendHistory(doc, 'upstream_order_missing', systemActor, {
          orderId: localOrderId,
          previousDisposition,
          releasedOwner: false,
        });
        await savePickingDoc(doc);
        emitPickingUpdate(doc);
        reconciled += 1;
        changed += 1;
        return;
      }

      const previousLocalStatus = String(doc.status || '');
      const previousWorkflowStage = workflowStageFor(doc);
      const previousDisposition = String(doc.upstreamDisposition || '');
      const upstreamState = applyUpstreamDisposition(doc, exactOrder, scope, systemActor);
      const sync = syncDocWithOrder(doc, exactOrder, systemActor);
      const disposition = classifyUpstreamOrder(exactOrder, scope);
      let localTransitionChanged = false;

      if (disposition === 'sent') {
        if (doc.status !== ORDER_STATUS.SENT || workflowStageFor(doc) !== WORKFLOW_STAGE.SENT) {
          doc.status = ORDER_STATUS.SENT;
          doc.workflowStage = WORKFLOW_STAGE.SENT;
          doc.sentAt = doc.sentAt || new Date();
          doc.sentBy = doc.sentBy || 'system:baselinker';
          doc.sentByName = doc.sentByName || 'BaseLinker';
          doc.ownerTelegramId = '';
          doc.ownerName = '';
          doc.claimedAt = null;
          appendHistory(doc, 'upstream_sent_materialized', systemActor, {
            orderId: localOrderId,
            statusId: Number(exactOrder?.order_status_id) || null,
          });
          localTransitionChanged = true;
        }
      } else if (disposition === 'intake' && previousDisposition && previousDisposition !== 'intake') {
        const readiness = packingReadiness(doc.items);
        if (doc.packedAt && readiness.allHandled && readiness.allPicked && !readiness.hasIssues) {
          doc.status = ORDER_STATUS.PACKED;
          doc.workflowStage = WORKFLOW_STAGE.PACKED;
        } else {
          doc.status = deriveWorkingStatus(doc.items, false);
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
        }
        if (previousDisposition === 'sent' || previousLocalStatus === ORDER_STATUS.SENT) {
          doc.sentAt = null;
          doc.sentBy = '';
          doc.sentByName = '';
        }
        appendHistory(doc, 'upstream_actionability_restored', systemActor, {
          orderId: localOrderId,
          fromDisposition: previousDisposition,
          statusId: Number(exactOrder?.order_status_id) || null,
        });
        localTransitionChanged = true;
      } else if (disposition === 'cancelled') {
        if (doc.status !== ORDER_STATUS.PAUSED || workflowStageFor(doc) !== WORKFLOW_STAGE.DEFERRED) {
          doc.status = ORDER_STATUS.PAUSED;
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
          localTransitionChanged = true;
        }
      }

      const dispositionChanged = previousDisposition !== String(doc.upstreamDisposition || '');
      if (sync.changed || sync.metadataChanged || upstreamState.changed || upstreamState.releasedOwner || localTransitionChanged || dispositionChanged) {
        if (disposition !== 'intake' || sync.changed || dispositionChanged) {
          doc.upstreamReviewRequired = true;
          doc.upstreamReviewedAt = null;
          doc.lastUpstreamChangeAt = new Date();
        }
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
  markPickingOrderPacked,
  markPickingOrderSent,
  reopenPickingOrder,
  publicState,
  markPickingOrdersUpstreamUpdated,
  acknowledgeUpstreamReview,
  reconcilePickingFromUpstreamChanges,
};

const crypto = require('crypto');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { compactOrders } = require('./baseLinkerPublicDto');
const { recordBaseLinkerOrderSnapshots } = require('./baseLinkerOrderSnapshots');
const { setBaseLinkerOrderStatus } = require('./baseLinkerOrderCommands');
const { getQueueScope, classifyUpstreamOrder } = require('./baseLinkerQueueScope');
const { getBaseLinkerAccountScope, scopedLockKey } = require('./baseLinkerAccount');
const { getIO } = require('../socket');

const {
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
const MAX_HISTORY = 200;

function actorOf(user) {
  return {
    by: String(user?.telegramId || ''),
    byName: [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || String(user?.telegramId || ''),
    byRole: String(user?.role || ''),
  };
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
      productId: text(product?.product_id),
      variantId: text(product?.variant_id),
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

function hasExplicitDeferredAction(doc) {
  // Deferred is an explicit order-level shelf. History lets a mixed/buggy
  // deployment distinguish a real worker "Відкласти" from the old bug where
  // saving one problem line auto-moved the card to Deferred. Admin reopen resets
  // that explicit decision; a later release sets it again.
  let explicitlyDeferred = false;
  for (const entry of Array.isArray(doc?.history) ? doc.history : []) {
    const action = String(entry?.action || '');
    if (action === 'order_released') explicitlyDeferred = true;
    if (action === 'order_reopened_by_admin') explicitlyDeferred = false;
  }
  return explicitlyDeferred;
}

function shouldRepairImplicitAutoDeferred(doc) {
  if (!doc || !doc.ownerTelegramId) return false;
  if (workflowStageFor(doc) !== WORKFLOW_STAGE.DEFERRED) return false;
  if (![ORDER_STATUS.PROBLEM, ORDER_STATUS.READY_WITH_ISSUE].includes(String(doc.status || ''))) return false;
  return !hasExplicitDeferredAction(doc);
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
    orderId: String(plain.orderId || ''),
    status: String(plain.status || 'new'),
    workflowStage: workflowStageFor(plain),
    revision: Number(plain.revision || 0),
    ownerTelegramId: String(plain.ownerTelegramId || ''),
    ownerName: String(plain.ownerName || ''),
    progress: progressFor(plain.items || []),
    items,
    claimTakeoverAvailableAt: takeoverAt,
    lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
    lastUpstreamStatusId: Number.isSafeInteger(Number(plain.lastUpstreamStatusId)) ? Number(plain.lastUpstreamStatusId) : null,
    upstreamDisposition: String(plain.upstreamDisposition || ''),
    upstreamBlocked: ['cancelled', 'sent', 'other', 'missing', 'unverified'].includes(String(plain.upstreamDisposition || '')),
    upstreamReviewRequired: plain.upstreamReviewRequired === true,
    upstreamReviewedAt: plain.upstreamReviewedAt || null,
    lastUpstreamJournalTypes: (Array.isArray(plain.lastUpstreamJournalTypes) ? plain.lastUpstreamJournalTypes : []).map(Number).filter(Number.isFinite),
    lastUpstreamChangeSummary: {
      added: Number(plain.lastUpstreamChangeSummary?.added || 0),
      removed: Number(plain.lastUpstreamChangeSummary?.removed || 0),
      changed: Number(plain.lastUpstreamChangeSummary?.changed || 0),
    },
  };
}

function emitPickingUpdate(doc, clientMutationId = '') {
  try {
    const io = getIO();
    if (!io) return;
    const state = publicState(doc);
    const orderIds = [String(doc.orderId)];
    io.to('baselinker_staff').emit('baselinker_picking_updated', {
      accountScope: getBaseLinkerAccountScope(),
      orderId: String(doc.orderId),
      orderIds,
      state,
      ...(text(clientMutationId).trim() ? { clientMutationId: text(clientMutationId).trim().slice(0, 160) } : {}),
    });
  } catch (_) { /* best-effort realtime only */ }
}

async function fetchExactOrder(orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) throw appError('baselinker_order_id_invalid');

  // Exact lookups used by claim/pack must include unconfirmed orders too. The list
  // UI can show them when the operator opts in, and a second server-side read must
  // not turn the same valid order into a fake 404 merely because getOrders defaults
  // get_unconfirmed_orders=false.
  const result = await fetchBaseLinkerOrders({
    orderId: id,
    includeUnconfirmed: true,
    maxPages: 1,
  });
  const order = (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id));
  if (!order) throw appError('baselinker_order_not_returned', { orderId: id, upstreamMethod: 'getOrders' });
  if (!Array.isArray(order.products) || order.products.length === 0) throw appError('baselinker_order_has_no_products', { orderId: id });
  await recordBaseLinkerOrderSnapshots([order], { source: 'exact_order_read' });
  return order;
}


function assertOrderActionable(order, scope) {
  const disposition = classifyUpstreamOrder(order, scope);
  const id = String(order?.order_id || '');
  if (disposition === 'cancelled') throw appError('baselinker_order_cancelled', { orderId: id });
  if (disposition === 'sent') throw appError('baselinker_order_already_sent', { orderId: id });
  if (disposition !== 'intake') {
    throw appError('baselinker_order_not_actionable', {
      orderId: id,
      statusId: Number.isSafeInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
    });
  }
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

  // Only the configured Intake status is actionable. Any other upstream state
  // releases warehouse ownership and must be explicitly reviewed.
  if (nextDisposition !== 'intake' && doc.ownerTelegramId) {
    const previousOwnerTelegramId = doc.ownerTelegramId || '';
    const previousOwnerName = doc.ownerName || '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    releasedOwner = true;
    appendHistory(doc, 'upstream_non_intake_released_owner', actor, {
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

function syncDocWithOrder(doc, order, actor) {
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
    return { changed: false, summary: { added: 0, removed: 0, changed: 0 }, initialized: true };
  }
  if (doc.orderFingerprint === nextFingerprint) return { changed: false, summary: { added: 0, removed: 0, changed: 0 } };

  const oldByKey = new Map((doc.items || []).map((item) => [String(item.lineKey), item]));
  const nextItems = [];
  let added = 0;
  let changed = 0;

  for (const source of sourceItems) {
    const old = oldByKey.get(source.lineKey);
    if (!old) {
      added += 1;
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
  const summary = { added, removed, changed };
  doc.items = nextItems;
  doc.orderFingerprint = nextFingerprint;
  doc.lastUpstreamChangeAt = new Date();
  doc.lastUpstreamChangeSummary = summary;
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
  return { changed: true, summary };
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
  if (['other', 'missing', 'unverified'].includes(disposition)) {
    throw appError('baselinker_order_not_actionable', {
      orderId: String(doc?.orderId || ''),
      statusId: Number.isSafeInteger(Number(doc?.lastUpstreamStatusId)) ? Number(doc.lastUpstreamStatusId) : null,
    });
  }
}

function assertOwner(doc, actor) {
  assertNotUpstreamBlocked(doc);
  if (!doc.ownerTelegramId || String(doc.ownerTelegramId) !== String(actor.by)) {
    throw appError('baselinker_picking_not_owner', { ownerName: doc.ownerName || '' });
  }
  if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');
}

async function getPickingStates(orderIds = []) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return {};
  const docs = await BaseLinkerPickingOrder.find({
    orderId: { $in: ids },
  }).lean();
  const requested = new Set(ids);
  const result = {};
  for (const doc of docs) {
    const state = publicState(doc);
    const id = String(doc.orderId);
    if (requested.has(id)) result[id] = state;
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

const claimIndexReadyByScope = new Map();

async function ensureClaimIndexReady() {
  const accountScope = getBaseLinkerAccountScope();
  if (!claimIndexReadyByScope.has(accountScope)) {
    const promise = (async () => {
      // Rows produced by the retired local-only Sent contract never proved that
      // BaseLinker changed status. Invalidate them once and require exact
      // upstream reconciliation before they can be trusted again.
      const migratedAt = new Date();
      await BaseLinkerPickingOrder.collection.updateMany({
        accountScope,
        status: 'sent',
        history: { $elemMatch: { action: 'order_sent_local' } },
        'history.action': { $ne: 'legacy_local_sent_invalidated' },
      }, {
        $set: {
          status: 'packed',
          workflowStage: WORKFLOW_STAGE.PACKED,
          upstreamDisposition: 'unverified',
          lastUpstreamStatusId: null,
          upstreamReviewRequired: true,
          upstreamReviewedAt: null,
          lastUpstreamChangeAt: migratedAt,
          sentAt: null,
          sentBy: '',
          sentByName: '',
          lastActivityAt: migratedAt,
        },
        $inc: { revision: 1 },
        $push: {
          history: {
            at: migratedAt,
            action: 'legacy_local_sent_invalidated',
            by: 'system',
            byName: 'BaseLinker integrity migration',
            byRole: 'system',
            meta: { reason: 'legacy_sent_was_not_upstream_verified' },
          },
        },
      });

      // Remove every persisted field from the retired logical/multi-order
      // abstraction. accountScope + orderId is the only local order identity.
      await BaseLinkerPickingOrder.collection.updateMany(
        { accountScope },
        { $unset: { claimKey: '', groupKey: '', externalOrderId: '', memberOrderIds: '' } },
      );
      return BaseLinkerPickingOrder.syncIndexes();
    })().catch((error) => {
      claimIndexReadyByScope.delete(accountScope);
      throw error;
    });
    claimIndexReadyByScope.set(accountScope, promise);
  }
  return claimIndexReadyByScope.get(accountScope);
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

function buildNewClaimedDoc({ requestedId, order, scope, actor, now }) {
  const doc = new BaseLinkerPickingOrder({
    orderId: requestedId,
    status: 'in_progress',
    workflowStage: WORKFLOW_STAGE.PROCESSING,
    revision: 1,
    upstreamDisposition: 'intake',
    lastUpstreamStatusId: Number(order?.order_status_id) || null,
  });
  const sync = syncDocWithOrder(doc, order, actor);
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
      orderFingerprint: plain.orderFingerprint || '',
      ownerTelegramId: actor.by,
      ownerName: actor.byName,
      claimedAt: plain.claimedAt || now,
      lastActivityAt: now,
      status: plain.status,
      workflowStage: plain.workflowStage,
      items: plain.items || [],
      lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
      lastUpstreamStatusId: plain.lastUpstreamStatusId ?? null,
      upstreamDisposition: plain.upstreamDisposition || 'intake',
      upstreamReviewRequired: plain.upstreamReviewRequired === true,
      upstreamReviewedAt: plain.upstreamReviewedAt || null,
      lastUpstreamChangeSummary: plain.lastUpstreamChangeSummary || { added: 0, removed: 0, changed: 0 },
      history: (plain.history || []).slice(-MAX_HISTORY),
    },
  };
}

async function claimPickingOrder({ orderId, user, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const requestedId = String(orderId || '').trim();
  const order = await fetchExactOrder(requestedId);
  const scope = await getQueueScope();
  if (!scope.configured) throw appError('baselinker_queue_not_configured');
  assertOrderActionable(order, scope);
  const accountScope = getBaseLinkerAccountScope();

  await ensureClaimIndexReady();

  // Locks reduce contention; accountScope+orderId unique index + revision CAS
  // is the durable correctness boundary across processes.
  return withLock(scopedLockKey(`baselinker-worker:${actor.by}`, accountScope), () => (
    withLock(scopedLockKey(`baselinker-order:${requestedId}`, accountScope), async () => {
      let candidate = await BaseLinkerPickingOrder.findOne({ orderId: requestedId });

      const activeOther = await BaseLinkerPickingOrder.findOne({
        ownerTelegramId: actor.by,
        ...(candidate?._id ? { _id: { $ne: candidate._id } } : {}),
        status: { $in: WORKING_STATUSES },
      }).lean();
      if (activeOther) throw appError('baselinker_worker_has_active_order', { orderId: activeOther.orderId });

      const now = new Date();
      const adminForce = user?.role === 'admin' && force === true;

      if (!candidate) {
        const created = buildNewClaimedDoc({ requestedId, order, scope, actor, now });
        try {
          await created.doc.save();
          emitPickingUpdate(created.doc, clientMutationId);
          return {
            state: publicState(created.doc),
            orders: compactOrders([order]),
            syncChanged: created.sync.changed === true,
          };
        } catch (error) {
          if (!isDuplicateKeyError(error)) throw error;
          candidate = await BaseLinkerPickingOrder.findOne({ orderId: requestedId });
          if (!candidate) throw error;
        }
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (TERMINAL_STATUSES.includes(candidate.status)) throw appError('baselinker_picking_terminal');
        assertNotUpstreamBlocked(candidate);

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

        const latest = await BaseLinkerPickingOrder.findOne({ orderId: requestedId });
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

      throw claimConflictFromDoc(await BaseLinkerPickingOrder.findOne({ orderId: requestedId }).lean());
    }, { ttlMs: 30_000, waitMs: 10_000 })
  ), { ttlMs: 30_000, waitMs: 10_000 });
}

async function heartbeatPickingOrder({ orderId, user }) {
  const actor = actorOf(user);
  const id = String(orderId);
  const current = await BaseLinkerPickingOrder.findOne({
    orderId: id,
    ownerTelegramId: actor.by,
    status: { $in: WORKING_STATUSES },
  }).lean();
  if (!current) throw appError('baselinker_picking_not_owner');

  const now = new Date();
  const repairImplicitDeferred = shouldRepairImplicitAutoDeferred(current);
  const update = repairImplicitDeferred
    ? {
      $set: { lastActivityAt: now, workflowStage: WORKFLOW_STAGE.PROCESSING },
      $inc: { revision: 1 },
      $push: {
        history: {
          $each: [{
            at: now,
            by: actor.by,
            byName: actor.byName,
            byRole: actor.byRole,
            action: 'implicit_problem_autodefer_repaired',
            meta: {},
          }],
          $slice: -MAX_HISTORY,
        },
      },
    }
    : { $set: { lastActivityAt: now } };

  let updated = await BaseLinkerPickingOrder.findOneAndUpdate(
    {
      _id: current._id,
      ownerTelegramId: actor.by,
      status: { $in: WORKING_STATUSES },
      ...(repairImplicitDeferred ? { revision: Number(current.revision || 0) } : {}),
    },
    update,
    { new: true },
  ).lean();

  // A concurrent item save may legitimately win the revision CAS. In that case
  // heartbeat must not fail ownership; return the current authoritative state.
  if (!updated && repairImplicitDeferred) {
    updated = await BaseLinkerPickingOrder.findOne({
      orderId: id,
      ownerTelegramId: actor.by,
      status: { $in: WORKING_STATUSES },
    }).lean();
  }
  if (!updated) throw appError('baselinker_picking_not_owner');
  emitPickingUpdate(updated);
  return { ok: true, lastActivityAt: updated.lastActivityAt, state: publicState(updated) };
}

async function updatePickingItem({ orderId, lineKey, user, expectedRevision, state, pickedQty, issueNote, clientMutationId = '' }) {
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(scopedLockKey(`baselinker-picking:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
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
    await doc.save();
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function releasePickingOrder({ orderId, user, expectedRevision, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(scopedLockKey(`baselinker-picking:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
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
    await doc.save();
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function markPickingOrderPacked({ orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const id = String(orderId || '').trim();

  return withLock(scopedLockKey(`baselinker-order:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const order = await fetchExactOrder(id);
    const scope = await getQueueScope();
    assertOrderActionable(order, scope);
    applyUpstreamDisposition(doc, order, scope, actor);

    const sync = syncDocWithOrder(doc, order, actor);
    if (sync.changed) {
      doc.lastActivityAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      await doc.save();
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
    doc.upstreamDisposition = 'intake';
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
    await doc.save();
    emitPickingUpdate(doc, clientMutationId);
    return { state: publicState(doc), orders: compactOrders([order]) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function markPickingOrderSent({ orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const id = String(orderId || '').trim();
  const scope = await getQueueScope();
  if (!scope.configured || !Number.isSafeInteger(Number(scope.sentStatusId))) {
    throw appError('baselinker_queue_not_configured');
  }

  return withLock(scopedLockKey(`baselinker-order:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');

    let order = await fetchExactOrder(id);
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
    if (!['intake', 'sent'].includes(disposition)) {
      throw appError('baselinker_order_not_actionable', {
        orderId: id,
        statusId: Number.isSafeInteger(Number(order?.order_status_id)) ? Number(order.order_status_id) : null,
      });
    }

    applyUpstreamDisposition(doc, order, scope, actor);
    const sync = syncDocWithOrder(doc, order, actor);
    if (sync.changed) {
      doc.lastActivityAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      await doc.save();
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
      await setBaseLinkerOrderStatus({ orderId: id, statusId: scope.sentStatusId });
      order = await fetchExactOrder(id);
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
    await doc.save();

    try {
      const { refreshBaseLinkerOrderCache } = require('./baseLinkerOrderCache');
      await refreshBaseLinkerOrderCache({ orders: [order], source: 'sent_transition' });
    } catch (error) {
      console.error('[baselinker] sent cache refresh failed', error);
    }

    emitPickingUpdate(doc, clientMutationId);
    return { state: publicState(doc), orders: compactOrders([order]) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function reopenPickingOrder({ orderId, user, expectedRevision, clientMutationId = '' }) {
  if (user?.role !== 'admin') throw appError('forbidden');
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(scopedLockKey(`baselinker-picking:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
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
    await doc.save();
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}


async function fetchOptionalExactOrder(orderId) {
  const id = Number(orderId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const result = await fetchBaseLinkerOrders({
    orderId: id,
    includeUnconfirmed: true,
    maxPages: 1,
  });
  const order = (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id)) || null;
  if (order) await recordBaseLinkerOrderSnapshots([order], { source: 'optional_exact_order_read' });
  return order;
}

async function markPickingOrdersUpstreamUpdated({
  orderIds = [],
  journalTypesByOrderId = {},
  orders = [],
  knownCachedOrderIds = [],
} = {}) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '')).filter(Boolean))];
  if (!ids.length) return { marked: 0, materializedCancelled: 0 };
  const actor = { by: 'system:baselinker-journal', byName: 'BaseLinker', byRole: 'system' };
  const scope = await getQueueScope();
  const known = new Set((knownCachedOrderIds || []).map(String));
  const exactById = new Map((orders || []).map((order) => [String(order?.order_id || ''), order]).filter(([id]) => id));

  let docs = await BaseLinkerPickingOrder.find({ orderId: { $in: ids } });

  // Cancellation is special. An order that was already visible in our intake
  // queue must not silently disappear just because nobody claimed it yet.
  // Materialise a minimal local attention row so it can appear in Updated,
  // blocked, until the operator presses "Прийнято".
  const coveredIds = new Set(docs.map((doc) => String(doc.orderId || '')).filter(Boolean));
  let materializedCancelled = 0;
  for (const id of ids) {
    const order = exactById.get(id);
    if (!order || !known.has(id) || coveredIds.has(id) || classifyUpstreamOrder(order, scope) !== 'cancelled') continue;
    const doc = new BaseLinkerPickingOrder({
      orderId: id,
      status: 'in_progress',
      workflowStage: WORKFLOW_STAGE.PROCESSING,
      revision: 1,
      upstreamDisposition: 'cancelled',
      lastUpstreamStatusId: Number(order?.order_status_id) || null,
    });
    syncDocWithOrder(doc, order, actor);
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
    doc.lastUpstreamChangeAt = new Date();
    doc.lastUpstreamJournalTypes = [...new Set((journalTypesByOrderId[id] || []).map(Number).filter(Number.isFinite))];
    appendHistory(doc, 'upstream_cancelled_before_claim', actor, {
      orderId: id,
      statusId: doc.lastUpstreamStatusId,
      journalTypes: doc.lastUpstreamJournalTypes,
    });
    try {
      await doc.save();
      emitPickingUpdate(doc);
      docs.push(doc);
      coveredIds.add(id);
      materializedCancelled += 1;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const raced = await BaseLinkerPickingOrder.findOne({ orderId: id });
      if (raced) docs.push(raced);
    }
  }

  let marked = 0;
  const seenDocs = new Set();
  for (const doc of docs) {
    const docKey = String(doc?._id || doc?.orderId || '');
    if (docKey && seenDocs.has(docKey)) continue;
    if (docKey) seenDocs.add(docKey);
    const touchedId = String(doc.orderId || '');
    if (!ids.includes(touchedId)) continue;
    const types = [...new Set((journalTypesByOrderId[touchedId] || []).map(Number).filter(Number.isFinite))];
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
    doc.lastUpstreamChangeAt = new Date();
    doc.lastUpstreamJournalTypes = types;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_review_required', actor, { orderIds: [touchedId], journalTypes: types });
    await doc.save();
    emitPickingUpdate(doc);
    marked += 1;
  }
  return { marked, materializedCancelled };
}

async function acknowledgeUpstreamReview({ orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const id = String(orderId || '');
  return withLock(scopedLockKey(`baselinker-picking:${id}`), async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    assertRevision(doc, expectedRevision);
    if (!doc.upstreamReviewRequired) return publicState(doc);
    doc.upstreamReviewRequired = false;
    doc.upstreamReviewedAt = new Date();
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_change_reviewed', actor, {
      lastUpstreamChangeAt: doc.lastUpstreamChangeAt || null,
      journalTypes: doc.lastUpstreamJournalTypes || [],
    });
    await doc.save();
    emitPickingUpdate(doc, clientMutationId);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function reconcilePickingFromUpstreamChanges({ orders = [], removedOrderIds = [] } = {}) {
  const changedOrders = Array.isArray(orders) ? orders.filter(Boolean) : [];
  if (changedOrders.length) {
    await recordBaseLinkerOrderSnapshots(changedOrders, { source: 'picking_reconcile' });
  }
  const changedById = new Map(changedOrders
    .map((order) => [String(order?.order_id || ''), order])
    .filter(([id]) => id));
  const removed = new Set((removedOrderIds || []).map((id) => String(id || '')).filter(Boolean));
  const affectedIds = [...new Set([...changedById.keys(), ...removed])];
  if (!affectedIds.length) return { reconciled: 0, changed: 0, released: 0 };

  const docs = await BaseLinkerPickingOrder.find({ orderId: { $in: affectedIds } }).lean();
  const systemActor = { by: 'system:baselinker-journal', byName: 'BaseLinker', byRole: 'system' };
  const scope = await getQueueScope();
  let reconciled = 0;
  let changed = 0;
  let released = 0;

  for (const snapshot of docs) {
    const localOrderId = String(snapshot.orderId || '');
    if (!localOrderId) continue;

    await withLock(scopedLockKey(`baselinker-order:${localOrderId}`), async () => {
      const doc = await BaseLinkerPickingOrder.findOne({ orderId: localOrderId });
      if (!doc) return;

      const exactOrder = removed.has(localOrderId)
        ? null
        : (changedById.get(localOrderId) || await fetchOptionalExactOrder(localOrderId));

      if (!exactOrder) {
        const previousDisposition = String(doc.upstreamDisposition || '');
        const hadOwner = Boolean(doc.ownerTelegramId);
        doc.ownerTelegramId = '';
        doc.ownerName = '';
        doc.claimedAt = null;
        doc.upstreamDisposition = 'missing';
        doc.lastUpstreamStatusId = null;
        doc.upstreamReviewRequired = true;
        doc.upstreamReviewedAt = null;
        doc.lastUpstreamChangeAt = new Date();
        doc.lastUpstreamChangeSummary = { added: 0, removed: 0, changed: 0 };
        if (!TERMINAL_STATUSES.includes(String(doc.status || ''))) {
          doc.status = 'paused';
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
        }
        doc.revision = Number(doc.revision || 0) + 1;
        appendHistory(doc, 'upstream_order_missing', systemActor, {
          orderId: localOrderId,
          previousDisposition,
          releasedOwner: hadOwner,
        });
        await doc.save();
        emitPickingUpdate(doc);
        reconciled += 1;
        changed += 1;
        if (hadOwner) released += 1;
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
        if (doc.status !== 'sent' || workflowStageFor(doc) !== WORKFLOW_STAGE.SENT) {
          doc.status = 'sent';
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
      } else if (disposition === 'intake' && previousLocalStatus === 'sent') {
        // BaseLinker is source of truth for upstream status. If an externally
        // sent order is moved back to Intake, local Sent cannot remain eternal.
        const readiness = packingReadiness(doc.items);
        if (doc.packedAt && readiness.allHandled && readiness.allPicked && !readiness.hasIssues) {
          doc.status = 'packed';
          doc.workflowStage = WORKFLOW_STAGE.PACKED;
        } else {
          doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
          doc.workflowStage = workflowStageAfterWorkingStatus(
            previousWorkflowStage === WORKFLOW_STAGE.SENT ? WORKFLOW_STAGE.PROCESSING : previousWorkflowStage,
            doc.status,
          );
        }
        doc.sentAt = null;
        doc.sentBy = '';
        doc.sentByName = '';
        appendHistory(doc, 'upstream_sent_reverted', systemActor, {
          orderId: localOrderId,
          statusId: Number(exactOrder?.order_status_id) || null,
        });
        localTransitionChanged = true;
      } else if (disposition !== 'intake' && !TERMINAL_STATUSES.includes(String(doc.status || ''))) {
        if (workflowStageFor(doc) !== WORKFLOW_STAGE.DEFERRED) {
          doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
          localTransitionChanged = true;
        }
      }

      const dispositionChanged = previousDisposition !== String(doc.upstreamDisposition || '');
      if (sync.changed || upstreamState.changed || upstreamState.releasedOwner || localTransitionChanged || dispositionChanged) {
        if (disposition !== 'intake' || sync.changed || dispositionChanged) {
          doc.upstreamReviewRequired = true;
          doc.upstreamReviewedAt = null;
          doc.lastUpstreamChangeAt = new Date();
        }
        doc.revision = Number(doc.revision || 0) + 1;
        await doc.save();
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

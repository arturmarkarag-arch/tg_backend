const crypto = require('crypto');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { compactOrders } = require('./baseLinkerPublicDto');
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


function groupToken(value) {
  return text(value).trim();
}

function baseLinkerFulfilmentGroupKey(order) {
  const source = groupToken(order?.order_source).toLowerCase();
  const sourceId = groupToken(order?.order_source_id);
  const external = groupToken(order?.external_order_id);
  if (external) return `external:${source}:${sourceId}:${external}`;
  const shopOrder = groupToken(order?.shop_order_id);
  if (shopOrder) return `shop:${source}:${sourceId}:${shopOrder}`;
  return `order:${groupToken(order?.order_id)}`;
}

function mergeOrderGroup(orders, preferredOrderId) {
  const list = Array.isArray(orders) ? orders.filter(Boolean) : [];
  if (!list.length) throw appError('baselinker_picking_group_empty');
  const preferred = list.find((order) => String(order?.order_id) === String(preferredOrderId)) || list[0];
  const memberOrderIds = list.map((order) => String(order.order_id));
  const keys = new Set(list.map(baseLinkerFulfilmentGroupKey));
  if (keys.size !== 1) throw appError('baselinker_picking_group_mismatch');
  return {
    ...preferred,
    order_id: preferred.order_id,
    confirmed: list.every((order) => Boolean(order?.confirmed)),
    products: list.flatMap((order) => (Array.isArray(order?.products) ? order.products : []).map((product) => ({
      ...product,
      _source_order_id: String(order.order_id),
    }))),
    _member_order_ids: memberOrderIds,
    _group_key: keys.values().next().value,
  };
}

async function fetchExactOrderGroup(orderIds, preferredOrderId) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) throw appError('baselinker_picking_group_empty');
  if (ids.length > 20) throw appError('baselinker_picking_group_too_large', { count: ids.length });
  const orders = await Promise.all(ids.map((id) => fetchExactOrder(id)));
  const mergedOrder = mergeOrderGroup(orders, preferredOrderId || ids[0]);
  return {
    orders,
    mergedOrder,
    memberOrderIds: orders.map((order) => String(order.order_id)),
    groupKey: baseLinkerFulfilmentGroupKey(mergedOrder),
    externalOrderId: groupToken(mergedOrder?.external_order_id || mergedOrder?.shop_order_id),
  };
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
    const sourceOrderId = text(product?._source_order_id).trim();
    const primaryOrderId = text(order?.order_id).trim();
    const rawBase = sourceLineBaseKey(product);
    const base = sourceOrderId && sourceOrderId !== primaryOrderId ? `bl:${sourceOrderId}:${rawBase}` : rawBase;
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
    groupKey: String(plain.groupKey || ''),
    memberOrderIds: (Array.isArray(plain.memberOrderIds) ? plain.memberOrderIds : []).map(String),
    status: String(plain.status || 'new'),
    workflowStage: workflowStageFor(plain),
    revision: Number(plain.revision || 0),
    ownerTelegramId: String(plain.ownerTelegramId || ''),
    ownerName: String(plain.ownerName || ''),
    progress: progressFor(plain.items || []),
    items,
    claimTakeoverAvailableAt: takeoverAt,
    lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
    lastUpstreamChangeSummary: {
      added: Number(plain.lastUpstreamChangeSummary?.added || 0),
      removed: Number(plain.lastUpstreamChangeSummary?.removed || 0),
      changed: Number(plain.lastUpstreamChangeSummary?.changed || 0),
    },
  };
}

function emitPickingUpdate(doc) {
  try {
    const io = getIO();
    if (!io) return;
    const state = publicState(doc);
    const orderIds = [...new Set([String(doc.orderId), ...((doc.memberOrderIds || []).map(String))])];
    io.to('baselinker_staff').emit('baselinker_picking_updated', {
      orderId: String(doc.orderId),
      orderIds,
      state,
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
  return order;
}

function syncDocWithOrder(doc, order, actor) {
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

function assertOwner(doc, actor) {
  if (!doc.ownerTelegramId || String(doc.ownerTelegramId) !== String(actor.by)) {
    throw appError('baselinker_picking_not_owner', { ownerName: doc.ownerName || '' });
  }
  if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');
}

async function getPickingStates(orderIds = []) {
  const ids = [...new Set((orderIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) return {};
  const docs = await BaseLinkerPickingOrder.find({
    $or: [
      { orderId: { $in: ids } },
      { memberOrderIds: { $in: ids } },
    ],
  }).lean();
  const requested = new Set(ids);
  const result = {};
  for (const doc of docs) {
    const state = publicState(doc);
    for (const id of [...new Set([String(doc.orderId), ...((doc.memberOrderIds || []).map(String))])]) {
      if (requested.has(id)) result[id] = state;
    }
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

function claimKeyForGroup(groupKey) {
  return `group:${sha(groupKey)}`;
}

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000;
}

let claimIndexReadyPromise = null;

async function ensureClaimIndexReady() {
  if (!claimIndexReadyPromise) {
    // Do not trust background/autoIndex timing for a concurrency invariant.
    // The first claim waits until Mongo has the unique claimKey index.
    claimIndexReadyPromise = BaseLinkerPickingOrder.collection
      .createIndex({ claimKey: 1 }, { unique: true, sparse: true })
      .catch((error) => {
        claimIndexReadyPromise = null;
        throw error;
      });
  }
  return claimIndexReadyPromise;
}

async function findClaimCandidates(group) {
  return BaseLinkerPickingOrder.find({
    $or: [
      { orderId: { $in: group.memberOrderIds } },
      { groupKey: group.groupKey },
      { memberOrderIds: { $in: group.memberOrderIds } },
      { claimKey: claimKeyForGroup(group.groupKey) },
    ],
  }).sort({ updatedAt: -1 });
}

function assertSingleClaimCandidate(candidates, group) {
  if (candidates.length > 1) {
    throw appError('baselinker_picking_group_conflict', { orderIds: group.memberOrderIds.join(', ') });
  }
  return candidates[0] || null;
}

function claimAvailabilityFilter(actor, now, adminForce) {
  if (adminForce) return {};
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  return {
    $or: [
      { ownerTelegramId: actor.by },
      { ownerTelegramId: '' },
      { ownerTelegramId: { $exists: false } },
      {
        ownerTelegramId: { $nin: ['', actor.by] },
        lastActivityAt: { $lte: staleBefore },
      },
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

function buildNewClaimedDoc({ requestedId, group, actor, now, claimKey }) {
  const doc = new BaseLinkerPickingOrder({
    orderId: requestedId,
    claimKey,
    groupKey: group.groupKey,
    externalOrderId: group.externalOrderId,
    memberOrderIds: group.memberOrderIds,
    status: 'in_progress',
    workflowStage: WORKFLOW_STAGE.PROCESSING,
    revision: 1,
  });
  const sync = syncDocWithOrder(doc, group.mergedOrder, actor);
  doc.ownerTelegramId = actor.by;
  doc.ownerName = actor.byName;
  doc.claimedAt = now;
  doc.lastActivityAt = now;
  doc.status = deriveWorkingStatus(doc.items, true);
  // Preserve the historical contract: the first successful claim advances the
  // initial revision once, so new claimed rows start at revision 2.
  doc.revision = Number(doc.revision || 0) + 1;
  appendHistory(doc, 'order_claimed', actor, {
    memberOrderIds: group.memberOrderIds,
    ...(sync.changed ? { upstreamSync: sync.summary } : {}),
  });
  return { doc, sync };
}

function buildExistingClaimUpdate({ doc, group, actor, now, adminForce, claimKey }) {
  // Work on an isolated in-memory copy. Nothing is persisted until the final
  // findOneAndUpdate CAS succeeds against the exact revision + owner predicate.
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

  draft.claimKey = claimKey;
  draft.groupKey = group.groupKey;
  draft.externalOrderId = group.externalOrderId;
  draft.memberOrderIds = group.memberOrderIds;
  const sync = syncDocWithOrder(draft, group.mergedOrder, actor);
  draft.ownerTelegramId = actor.by;
  draft.ownerName = actor.byName;
  if (wasDifferentOwner || !draft.claimedAt) draft.claimedAt = now;
  draft.lastActivityAt = now;
  draft.status = deriveWorkingStatus(draft.items, true);
  // Claim is ownership only. It must never move a card between operational
  // shelves. In particular, Deferred stays Deferred while somebody resumes it.
  draft.workflowStage = preservedWorkflowStage;
  appendHistory(draft, wasDifferentOwner ? 'order_claimed' : 'order_reopened_by_owner', actor, {
    memberOrderIds: group.memberOrderIds,
    ...(sync.changed ? { upstreamSync: sync.summary } : {}),
  });

  const plain = draft.toObject();
  return {
    sync,
    set: {
      claimKey,
      groupKey: group.groupKey,
      externalOrderId: group.externalOrderId,
      memberOrderIds: group.memberOrderIds,
      orderFingerprint: plain.orderFingerprint || '',
      ownerTelegramId: actor.by,
      ownerName: actor.byName,
      claimedAt: plain.claimedAt || now,
      lastActivityAt: now,
      status: plain.status,
      workflowStage: plain.workflowStage,
      items: plain.items || [],
      lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
      lastUpstreamChangeSummary: plain.lastUpstreamChangeSummary || { added: 0, removed: 0, changed: 0 },
      history: (plain.history || []).slice(-MAX_HISTORY),
    },
  };
}

async function claimPickingOrder({ orderId, memberOrderIds = [], user, force = false }) {
  const actor = actorOf(user);
  const requestedIds = [...new Set([String(orderId), ...(memberOrderIds || []).map(String)].filter(Boolean))];
  const group = await fetchExactOrderGroup(requestedIds, orderId);
  const requestedId = String(orderId);
  const claimKey = claimKeyForGroup(group.groupKey);
  const groupLock = `baselinker-group:${sha(group.groupKey).slice(0, 24)}`;

  await ensureClaimIndexReady();

  // Redis/process locks remain useful for reducing contention, but MongoDB is
  // now the final authority. Correctness no longer depends on both requests
  // landing in the same Node process or on the Redis lock surviving its TTL.
  return withLock(`baselinker-worker:${actor.by}`, () => withLock(groupLock, async () => {
    let candidate = assertSingleClaimCandidate(await findClaimCandidates(group), group);

    const activeOther = await BaseLinkerPickingOrder.findOne({
      ownerTelegramId: actor.by,
      ...(candidate?._id ? { _id: { $ne: candidate._id } } : {}),
      status: { $in: WORKING_STATUSES },
    }).lean();
    if (activeOther) {
      throw appError('baselinker_worker_has_active_order', { orderId: activeOther.orderId });
    }

    const now = new Date();
    const adminForce = user?.role === 'admin' && force === true;

    // First ever claim: one atomic insert owns the logical order. If two
    // workers race here, unique(orderId) and unique(sparse claimKey) guarantee
    // exactly one insert. The loser reloads and goes through the CAS path below.
    if (!candidate) {
      const created = buildNewClaimedDoc({ requestedId, group, actor, now, claimKey });
      try {
        await created.doc.save();
        emitPickingUpdate(created.doc);
        return {
          state: publicState(created.doc),
          orders: compactOrders(group.orders),
          syncChanged: created.sync.changed === true,
        };
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        candidate = assertSingleClaimCandidate(await findClaimCandidates(group), group);
        if (!candidate) throw error;
      }
    }

    // Existing state: ownership + upstream sync + revision advance happen in
    // ONE Mongo compare-and-swap. Two workers may both read the old document,
    // but only the first write can match its revision/owner predicate.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (TERMINAL_STATUSES.includes(candidate.status)) throw appError('baselinker_picking_terminal');

      const update = buildExistingClaimUpdate({
        doc: candidate,
        group,
        actor,
        now: new Date(),
        adminForce,
        claimKey,
      });
      const availability = claimAvailabilityFilter(actor, new Date(), adminForce);
      let claimed = null;
      try {
        claimed = await BaseLinkerPickingOrder.findOneAndUpdate(
          {
            _id: candidate._id,
            revision: Number(candidate.revision || 0),
            status: { $nin: TERMINAL_STATUSES },
            ...availability,
          },
          {
            $set: update.set,
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true },
        );
      } catch (error) {
        // A concurrent process may have materialised the same logical claimKey
        // between our read and CAS. Treat that exactly like a lost claim race,
        // never as HTTP 500.
        if (!isDuplicateKeyError(error)) throw error;
      }

      if (claimed) {
        emitPickingUpdate(claimed);
        return {
          state: publicState(claimed),
          orders: compactOrders(group.orders),
          syncChanged: update.sync.changed === true,
        };
      }

      const latest = await BaseLinkerPickingOrder.findOne({
        $or: [
          { _id: candidate._id },
          { claimKey },
          { groupKey: group.groupKey },
          { orderId: { $in: group.memberOrderIds } },
          { memberOrderIds: { $in: group.memberOrderIds } },
        ],
      }).sort({ updatedAt: -1 });

      if (!latest) throw appError('baselinker_picking_stale');
      const latestOwner = String(latest.ownerTelegramId || '');
      const latestActivityMs = latest.lastActivityAt ? new Date(latest.lastActivityAt).getTime() : 0;
      const latestIsStale = latestOwner && latestOwner !== actor.by && latestActivityMs > 0
        && (Date.now() - latestActivityMs) >= CLAIM_STALE_MS;

      if (latestOwner && latestOwner !== actor.by && !adminForce && !latestIsStale) {
        throw claimConflictFromDoc(latest);
      }
      if (TERMINAL_STATUSES.includes(latest.status)) throw appError('baselinker_picking_terminal');

      // Same worker / stale takeover can legitimately lose a CAS to a concurrent
      // revision update. Retry from the current row instead of overwriting it.
      candidate = latest;
    }

    const latest = await BaseLinkerPickingOrder.findOne({ claimKey }).lean();
    throw claimConflictFromDoc(latest);
  }, { ttlMs: 30_000, waitMs: 10_000 }), { ttlMs: 30_000, waitMs: 10_000 });
}

async function heartbeatPickingOrder({ orderId, user }) {
  const actor = actorOf(user);
  const updated = await BaseLinkerPickingOrder.findOneAndUpdate(
    {
      orderId: String(orderId),
      ownerTelegramId: actor.by,
      status: { $in: WORKING_STATUSES },
    },
    { $set: { lastActivityAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw appError('baselinker_picking_not_owner');
  emitPickingUpdate(updated);
  return { ok: true, lastActivityAt: updated.lastActivityAt, state: publicState(updated) };
}

async function updatePickingItem({ orderId, lineKey, user, expectedRevision, state, pickedQty, issueNote }) {
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(`baselinker-picking:${id}`, async () => {
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
    emitPickingUpdate(doc);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function releasePickingOrder({ orderId, user, expectedRevision, force = false }) {
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(`baselinker-picking:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
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
    emitPickingUpdate(doc);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function markPickingOrderPacked({ orderId, user, expectedRevision, allowIssues = false }) {
  const actor = actorOf(user);
  const id = String(orderId);
  const before = await BaseLinkerPickingOrder.findOne({ orderId: id }).lean();
  if (!before) throw appError('baselinker_picking_not_started');
  const group = await fetchExactOrderGroup(
    (before.memberOrderIds && before.memberOrderIds.length) ? before.memberOrderIds : [id],
    id,
  );

  return withLock(`baselinker-group:${sha(group.groupKey).slice(0, 24)}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const sync = syncDocWithOrder(doc, group.mergedOrder, actor);
    if (sync.changed) {
      doc.lastActivityAt = new Date();
      doc.revision = Number(doc.revision || 0) + 1;
      await doc.save();
      emitPickingUpdate(doc);
      throw appError('baselinker_order_changed', { currentRevision: doc.revision, changeSummary: sync.summary });
    }

    const readiness = packingReadiness(doc.items);
    if (!readiness.allHandled) {
      throw appError('baselinker_picking_items_unhandled', {
        pendingLines: readiness.pendingLines,
        totalLines: readiness.totalLines,
      });
    }

    if (readiness.hasIssues && allowIssues !== true) {
      throw appError('baselinker_picking_issue_confirmation_required', {
        problemLines: readiness.problemLines,
        missingQty: readiness.missingQty,
      });
    }

    const now = new Date();
    const packingMode = !readiness.hasIssues
      ? 'full'
      : readiness.missingQty > 0
        ? 'partial'
        : 'with_issue';

    doc.status = 'packed';
    doc.workflowStage = WORKFLOW_STAGE.PACKED;
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
    appendHistory(doc, readiness.hasIssues ? 'order_packed_with_issues' : 'order_packed', actor, {
      packingMode,
      requestedQty: readiness.totalQty,
      packedQty: readiness.pickedQty,
      missingQty: readiness.missingQty,
      problemLines: readiness.problemLines,
      issues: readiness.hasIssues
        ? (doc.items || []).filter((item) => ISSUE_STATES.has(String(item?.state || ''))).map((item) => ({
          lineKey: item.lineKey,
          sourceOrderId: item.sourceOrderId || '',
          itemName: item.name,
          state: item.state,
          requestedQty: item.requestedQty,
          pickedQty: item.pickedQty,
          issueNote: item.issueNote,
        }))
        : [],
    });
    await doc.save();
    emitPickingUpdate(doc);
    return { state: publicState(doc), orders: compactOrders(group.orders) };
  }, { ttlMs: 30_000, waitMs: 10_000 });
}

async function markPickingOrderSent({ orderId, user, expectedRevision }) {
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(`baselinker-picking:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    // Idempotent retry: once the local operation is already marked sent, a
    // repeated click/network retry must not fail only because the revision has
    // advanced with that successful write.
    if (doc.status === 'sent') return publicState(doc);
    assertRevision(doc, expectedRevision);
    if (doc.status !== 'packed') {
      throw appError('baselinker_picking_not_packed');
    }
    const now = new Date();
    doc.status = 'sent';
    doc.workflowStage = WORKFLOW_STAGE.SENT;
    doc.sentAt = now;
    doc.sentBy = actor.by;
    doc.sentByName = actor.byName;
    doc.lastActivityAt = now;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_sent_local', actor, { readOnlyBaseLinker: true });
    await doc.save();
    emitPickingUpdate(doc);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function reopenPickingOrder({ orderId, user, expectedRevision }) {
  if (user?.role !== 'admin') throw appError('forbidden');
  const actor = actorOf(user);
  const id = String(orderId);
  return withLock(`baselinker-picking:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
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
    emitPickingUpdate(doc);
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
  return (result.orders || []).find((candidate) => String(candidate?.order_id) === String(id)) || null;
}

async function reconcilePickingFromUpstreamChanges({ orders = [], removedOrderIds = [] } = {}) {
  const changedOrders = Array.isArray(orders) ? orders.filter(Boolean) : [];
  const changedById = new Map(changedOrders.map((order) => [String(order?.order_id || ''), order]).filter(([id]) => id));
  const removed = new Set((removedOrderIds || []).map((id) => String(id || '')).filter(Boolean));
  const affectedIds = [...new Set([...changedById.keys(), ...removed])];
  const changedGroupKeys = [...new Set(changedOrders.map(baseLinkerFulfilmentGroupKey).filter(Boolean))];
  if (!affectedIds.length && !changedGroupKeys.length) return { reconciled: 0, changed: 0, released: 0 };

  const ors = [];
  if (affectedIds.length) {
    ors.push({ orderId: { $in: affectedIds } });
    ors.push({ memberOrderIds: { $in: affectedIds } });
  }
  if (changedGroupKeys.length) ors.push({ groupKey: { $in: changedGroupKeys } });

  const docs = await BaseLinkerPickingOrder.find({
    status: { $in: [...WORKING_STATUSES, 'paused'] },
    $or: ors,
  }).lean();

  const systemActor = { by: 'system:baselinker-journal', byName: 'BaseLinker', byRole: 'system' };
  let reconciled = 0;
  let changed = 0;
  let released = 0;

  for (const snapshot of docs) {
    const localOrderId = String(snapshot.orderId || '');
    if (!localOrderId) continue;

    await withLock(`baselinker-picking:${localOrderId}`, async () => {
      const doc = await BaseLinkerPickingOrder.findOne({ orderId: localOrderId });
      if (!doc || TERMINAL_STATUSES.includes(doc.status)) return;

      const currentIds = [...new Set([
        String(doc.orderId || ''),
        ...((doc.memberOrderIds || []).map((id) => String(id || ''))),
      ].filter(Boolean))];

      // If BaseLinker created a new split/copy member with the same logical
      // external identity, add it to the local group immediately.
      const groupKeysForDoc = new Set([String(doc.groupKey || '')].filter(Boolean));
      for (const id of currentIds) {
        const changedOrder = changedById.get(id);
        if (changedOrder) groupKeysForDoc.add(baseLinkerFulfilmentGroupKey(changedOrder));
      }
      const relatedChangedOrders = changedOrders.filter((order) => {
        const id = String(order?.order_id || '');
        const key = baseLinkerFulfilmentGroupKey(order);
        return currentIds.includes(id) || groupKeysForDoc.has(key);
      });

      const candidateIds = new Set(currentIds.filter((id) => !removed.has(id)));
      for (const order of relatedChangedOrders) candidateIds.add(String(order.order_id));

      const availableById = new Map();
      for (const order of relatedChangedOrders) availableById.set(String(order.order_id), order);

      // Re-read untouched members so syncDocWithOrder sees the complete grouped
      // order rather than only the line that generated this journal event.
      for (const id of candidateIds) {
        if (availableById.has(id)) continue;
        const fresh = await fetchOptionalExactOrder(id);
        if (fresh) availableById.set(id, fresh);
        else removed.add(id);
      }

      const availableOrders = [...availableById.values()];
      if (!availableOrders.length) {
        const hadOwner = Boolean(doc.ownerTelegramId);
        doc.ownerTelegramId = '';
        doc.ownerName = '';
        doc.claimedAt = null;
        doc.status = 'paused';
        doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
        doc.memberOrderIds = [];
        doc.lastUpstreamChangeAt = new Date();
        doc.lastUpstreamChangeSummary = { added: 0, removed: (doc.items || []).length, changed: 0 };
        doc.revision = Number(doc.revision || 0) + 1;
        appendHistory(doc, 'upstream_order_removed', systemActor, {
          removedOrderIds: currentIds,
          releasedOwner: hadOwner,
        });
        await doc.save();
        emitPickingUpdate(doc);
        reconciled += 1;
        changed += 1;
        if (hadOwner) released += 1;
        return;
      }

      // Prefer the group identity of an explicitly changed current member. If an
      // order edit changed the external grouping key, stale former members are
      // dropped instead of being silently mixed with the new logical order.
      const changedCurrent = relatedChangedOrders.find((order) => currentIds.includes(String(order.order_id)));
      const targetGroupKey = changedCurrent
        ? baseLinkerFulfilmentGroupKey(changedCurrent)
        : (doc.groupKey || baseLinkerFulfilmentGroupKey(availableOrders[0]));
      const sameGroupOrders = availableOrders.filter((order) => baseLinkerFulfilmentGroupKey(order) === targetGroupKey);
      if (!sameGroupOrders.length) return;

      const beforeMemberIds = [...new Set((doc.memberOrderIds || []).map(String))].sort();
      const nextMemberIds = sameGroupOrders.map((order) => String(order.order_id));
      const afterMemberIds = [...new Set(nextMemberIds)].sort();
      const membersChanged = JSON.stringify(beforeMemberIds) !== JSON.stringify(afterMemberIds);

      const merged = mergeOrderGroup(sameGroupOrders, localOrderId);
      const sync = syncDocWithOrder(doc, merged, systemActor);
      doc.groupKey = targetGroupKey;
      doc.externalOrderId = groupToken(merged?.external_order_id || merged?.shop_order_id);
      doc.memberOrderIds = afterMemberIds;

      if (membersChanged && !sync.changed) {
        doc.lastUpstreamChangeAt = new Date();
        appendHistory(doc, 'upstream_group_members_changed', systemActor, {
          beforeMemberOrderIds: beforeMemberIds,
          afterMemberOrderIds: afterMemberIds,
        });
      }

      if (sync.changed || membersChanged) {
        doc.revision = Number(doc.revision || 0) + 1;
        await doc.save();
        emitPickingUpdate(doc);
        changed += 1;
      }
      reconciled += 1;
    }, { ttlMs: 20_000, waitMs: 5_000 });
  }

  return { reconciled, changed, released };
}

module.exports = {
  CLAIM_STALE_MS,
  buildSourceItems,
  baseLinkerFulfilmentGroupKey,
  mergeOrderGroup,
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
  reconcilePickingFromUpstreamChanges,
};

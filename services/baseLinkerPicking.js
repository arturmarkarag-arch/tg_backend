const crypto = require('crypto');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { getIO } = require('../socket');

const CLAIM_STALE_MS = Math.max(2 * 60 * 1000, Number(process.env.BASELINKER_PICKING_CLAIM_STALE_MS) || (10 * 60 * 1000));
const WORKING_STATUSES = ['in_progress', 'problem', 'ready_to_pack', 'ready_to_pack_with_issue'];
const TERMINAL_STATUSES = ['packed', 'sent'];
const ISSUE_STATES = new Set(['shortage', 'not_found', 'damaged', 'other']);
const ITEM_STATES = new Set(['pending', 'picked', ...ISSUE_STATES]);
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
    const base = sourceLineBaseKey(product);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    const lineKey = occurrence === 1 ? base : `${base}#${occurrence}`;
    const sourceSnapshot = {
      lineKey,
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

function hasIssues(items = []) {
  return items.some((item) => ISSUE_STATES.has(String(item?.state || '')));
}

function allPicked(items = []) {
  return items.length > 0 && items.every((item) => (
    item?.state === 'picked' && Number(item?.pickedQty || 0) >= Number(item?.requestedQty || 0)
  ));
}

function allHandled(items = []) {
  return items.length > 0 && items.every((item) => String(item?.state || 'pending') !== 'pending');
}

function progressFor(items = []) {
  const totalLines = items.length;
  const pickedLines = items.filter((item) => item?.state === 'picked').length;
  const handledLines = items.filter((item) => String(item?.state || 'pending') !== 'pending').length;
  const problemLines = items.filter((item) => ISSUE_STATES.has(String(item?.state || ''))).length;
  const totalQty = items.reduce((sum, item) => sum + Number(item?.requestedQty || 0), 0);
  const pickedQty = items.reduce((sum, item) => sum + Math.min(Number(item?.requestedQty || 0), Number(item?.pickedQty || 0)), 0);
  const missingQty = Math.max(0, totalQty - pickedQty);
  return { totalLines, handledLines, pickedLines, problemLines, totalQty, pickedQty, missingQty };
}

function packingReadiness(items = []) {
  const progress = progressFor(items);
  return {
    ...progress,
    allHandled: allHandled(items),
    allPicked: allPicked(items),
    hasIssues: hasIssues(items),
    pendingLines: Math.max(0, progress.totalLines - progress.handledLines),
  };
}

function deriveWorkingStatus(items, hasOwner) {
  if (allPicked(items)) return hasOwner ? 'ready_to_pack' : 'paused';
  if (hasIssues(items) && allHandled(items)) return hasOwner ? 'ready_to_pack_with_issue' : 'problem';
  if (hasIssues(items)) return 'problem';
  return hasOwner ? 'in_progress' : 'paused';
}

function publicState(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const lastActivityMs = plain.lastActivityAt ? new Date(plain.lastActivityAt).getTime() : 0;
  const takeoverAt = plain.ownerTelegramId && lastActivityMs
    ? new Date(lastActivityMs + CLAIM_STALE_MS).toISOString()
    : null;
  return {
    ...plain,
    _id: plain._id ? String(plain._id) : undefined,
    progress: progressFor(plain.items || []),
    claimTakeoverAvailableAt: takeoverAt,
    claimStaleMs: CLAIM_STALE_MS,
    history: Array.isArray(plain.history) ? plain.history.slice(-40) : [],
  };
}

function emitPickingUpdate(doc) {
  try {
    const io = getIO();
    if (!io) return;
    io.to('baselinker_staff').emit('baselinker_picking_updated', {
      orderId: String(doc.orderId),
      state: publicState(doc),
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
    doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
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
  const docs = await BaseLinkerPickingOrder.find({ orderId: { $in: ids } }).lean();
  return Object.fromEntries(docs.map((doc) => [String(doc.orderId), publicState(doc)]));
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

async function claimPickingOrder({ orderId, user, force = false }) {
  const actor = actorOf(user);
  const order = await fetchExactOrder(orderId);
  const id = String(order.order_id);

  return withLock(`baselinker-worker:${actor.by}`, () => withLock(`baselinker-picking:${id}`, async () => {
    const activeOther = await BaseLinkerPickingOrder.findOne({
      ownerTelegramId: actor.by,
      orderId: { $ne: id },
      status: { $in: WORKING_STATUSES },
    }).lean();
    if (activeOther) {
      throw appError('baselinker_worker_has_active_order', { orderId: activeOther.orderId });
    }

    let doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) {
      doc = new BaseLinkerPickingOrder({ orderId: id, status: 'in_progress', revision: 1 });
    }
    if (TERMINAL_STATUSES.includes(doc.status)) throw appError('baselinker_picking_terminal');

    const now = new Date();
    const ownerOther = doc.ownerTelegramId && String(doc.ownerTelegramId) !== actor.by;
    if (ownerOther) {
      const lastActivityMs = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
      const stale = lastActivityMs > 0 && (Date.now() - lastActivityMs) >= CLAIM_STALE_MS;
      const adminForce = user?.role === 'admin' && force === true;
      if (!stale && !adminForce) {
        throw appError('baselinker_picking_taken', {
          ownerName: doc.ownerName || '',
          takeoverAvailableAt: lastActivityMs ? new Date(lastActivityMs + CLAIM_STALE_MS).toISOString() : null,
        });
      }
      appendHistory(doc, 'claim_taken_over', actor, {
        previousOwnerTelegramId: doc.ownerTelegramId,
        previousOwnerName: doc.ownerName || '',
        reason: adminForce ? 'admin_force' : 'stale_claim',
      });
    }

    const sync = syncDocWithOrder(doc, order, actor);
    const wasDifferentOwner = String(doc.ownerTelegramId || '') !== actor.by;
    doc.ownerTelegramId = actor.by;
    doc.ownerName = actor.byName;
    if (wasDifferentOwner || !doc.claimedAt) doc.claimedAt = now;
    doc.lastActivityAt = now;
    doc.status = deriveWorkingStatus(doc.items, true);
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, wasDifferentOwner ? 'order_claimed' : 'order_reopened_by_owner', actor, sync.changed ? { upstreamSync: sync.summary } : {});
    await doc.save();
    emitPickingUpdate(doc);
    return { state: publicState(doc), order, syncChanged: sync.changed === true };
  }, { ttlMs: 25_000, waitMs: 8_000 }), { ttlMs: 25_000, waitMs: 8_000 });
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
    if (!ITEM_STATES.has(nextState)) throw appError('baselinker_picking_item_state_invalid');

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

    doc.status = deriveWorkingStatus(doc.items, true);
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'item_updated', actor, {
      lineKey: item.lineKey,
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
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_released', actor, { previousOwnerTelegramId, previousOwnerName, force: !owns });
    await doc.save();
    emitPickingUpdate(doc);
    return publicState(doc);
  }, { ttlMs: 15_000, waitMs: 6_000 });
}

async function markPickingOrderPacked({ orderId, user, expectedRevision, allowIssues = false }) {
  const actor = actorOf(user);
  const order = await fetchExactOrder(orderId);
  const id = String(order.order_id);

  return withLock(`baselinker-picking:${id}`, async () => {
    const doc = await BaseLinkerPickingOrder.findOne({ orderId: id });
    if (!doc) throw appError('baselinker_picking_not_started');
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const sync = syncDocWithOrder(doc, order, actor);
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
    return { state: publicState(doc), order };
  }, { ttlMs: 25_000, waitMs: 8_000 });
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

module.exports = {
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
};

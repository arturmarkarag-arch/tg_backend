'use strict';

const crypto = require('crypto');
const AllegroPickingOrder = require('../models/AllegroPickingOrder');
const AllegroOrderIndex = require('../models/AllegroOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const { getAllegroAccount } = require('./allegroAccounts');
const { allegroRequest } = require('./allegroHttpClient');
const { withLock } = require('../utils/lock');
const { appError } = require('../utils/errors');
const { ALLEGRO_SCOPE, capabilityMatrix } = require('./allegroCapabilities');
const { getIO } = require('../socket');
const {
  ORDER_STATUS,
  WORKFLOW_STAGE,
  WORKING_STATUSES,
  TERMINAL_STATUSES,
  WRITABLE_ITEM_STATES,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
  workflowStageFor,
  workflowStageAfterWorkingStatus,
} = require('../domain/warehousePickingState');

const CLAIM_STALE_MS = Math.max(2 * 60 * 1000, Number(process.env.ALLEGRO_PICKING_CLAIM_STALE_MS) || (10 * 60 * 1000));
const MAX_HISTORY = 200;
const ACTIVE_FULFILLMENT = new Set(['NEW', 'PROCESSING', 'READY_FOR_SHIPMENT', 'READY_FOR_PICKUP']);

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function actorOf(user) {
  return {
    by: clean(user?.telegramId, 128),
    byName: clean([user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() || user?.telegramId, 240),
    byRole: clean(user?.role, 80),
  };
}

function orderKey(accountId, orderId) {
  const aid = clean(accountId, 64);
  const oid = clean(orderId, 128);
  return aid && oid ? `${aid}:${oid}` : '';
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

function classifyUpstream(order) {
  if (!order) return 'missing';
  const provider = clean(order?.fulfillment?.provider?.id, 80).toUpperCase();
  const status = clean(order?.status, 80).toUpperCase();
  const fulfillment = clean(order?.fulfillment?.status, 80).toUpperCase();
  if (provider !== 'SELLER') return 'other';
  if (status === 'CANCELLED' || fulfillment === 'CANCELLED') return 'cancelled';
  if (fulfillment === 'RETURNED') return 'returned';
  if (['SENT', 'PICKED_UP'].includes(fulfillment)) return 'sent';
  if (fulfillment === 'SUSPENDED') return 'suspended';
  if (status === 'READY_FOR_PROCESSING' && ACTIVE_FULFILLMENT.has(fulfillment)) return 'active';
  return 'other';
}

function isActionableDisposition(disposition) {
  return disposition === 'active';
}

function assertActionable(order) {
  const disposition = classifyUpstream(order);
  const id = clean(order?.id, 128);
  if (disposition === 'active') return disposition;
  if (disposition === 'cancelled') throw appError('allegro_order_cancelled', { orderId: id });
  if (disposition === 'returned') throw appError('allegro_order_returned', { orderId: id });
  if (disposition === 'sent') throw appError('allegro_order_already_sent', { orderId: id });
  if (disposition === 'suspended') throw appError('allegro_order_suspended', { orderId: id });
  throw appError('allegro_order_not_actionable', { orderId: id });
}

function sourceLineBaseKey(item) {
  const orderProductId = clean(item?.id, 128);
  if (orderProductId) return `op:${orderProductId}`;
  return ['src', clean(item?.offer?.id, 128), clean(item?.offer?.external?.id, 300), clean(item?.offer?.name, 1000)].join(':');
}

function buildSourceItems(order) {
  const rows = Array.isArray(order?.lineItems) ? order.lineItems : [];
  const seen = new Map();
  return rows.map((item) => {
    const base = sourceLineBaseKey(item);
    const occurrence = (seen.get(base) || 0) + 1;
    seen.set(base, occurrence);
    const lineKey = occurrence === 1 ? base : `${base}#${occurrence}`;
    const source = {
      lineKey,
      sourceOrderId: clean(order?.id, 128),
      orderProductId: clean(item?.id, 128),
      auctionId: clean(item?.offer?.id, 128),
      sku: clean(item?.offer?.external?.id, 300),
      ean: '',
      name: clean(item?.offer?.name, 1000),
      requestedQty: qty(item?.quantity),
    };
    source.sourceFingerprint = sha(JSON.stringify(source));
    return source;
  });
}

function orderFingerprint(items) {
  return sha(JSON.stringify((items || []).map((item) => ({
    lineKey: item.lineKey,
    sourceFingerprint: item.sourceFingerprint,
  }))));
}

function publicState(doc) {
  if (!doc) return null;
  const plain = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const lastActivityMs = plain.lastActivityAt ? new Date(plain.lastActivityAt).getTime() : 0;
  const takeoverAt = plain.ownerTelegramId && lastActivityMs
    ? new Date(lastActivityMs + CLAIM_STALE_MS).toISOString()
    : null;
  return {
    provider: 'allegro',
    allegroAccountId: clean(plain.allegroAccountId, 64),
    allegroAccountName: clean(plain.allegroAccountNameSnapshot, 160),
    orderKey: orderKey(plain.allegroAccountId, plain.orderId),
    orderId: clean(plain.orderId, 128),
    status: clean(plain.status, 80),
    workflowStage: workflowStageFor(plain),
    revision: Number(plain.revision || 0),
    ownerTelegramId: clean(plain.ownerTelegramId, 128),
    ownerName: clean(plain.ownerName, 240),
    progress: progressFor(plain.items || []),
    items: (Array.isArray(plain.items) ? plain.items : []).map((item) => ({
      lineKey: clean(item?.lineKey, 800),
      name: clean(item?.name, 1000),
      requestedQty: qty(item?.requestedQty),
      state: clean(item?.state, 40) || 'pending',
      pickedQty: qty(item?.pickedQty),
      issueNote: clean(item?.issueNote, 1500),
    })),
    claimTakeoverAvailableAt: takeoverAt,
    lastUpstreamChangeAt: plain.lastUpstreamChangeAt || null,
    lastUpstreamVerifiedAt: plain.lastUpstreamVerifiedAt || null,
    lastUpstreamRevision: clean(plain.lastUpstreamRevision, 128),
    lastUpstreamOrderStatus: clean(plain.lastUpstreamOrderStatus, 80),
    lastUpstreamFulfillmentStatus: clean(plain.lastUpstreamFulfillmentStatus, 80),
    upstreamDisposition: clean(plain.upstreamDisposition, 80),
    upstreamBlocked: !isActionableDisposition(clean(plain.upstreamDisposition, 80)) && workflowStageFor(plain) !== WORKFLOW_STAGE.SENT,
    warehouseFulfillment: workflowStageFor(plain) === WORKFLOW_STAGE.SENT || plain.status === ORDER_STATUS.SENT
      ? 'sent'
      : (workflowStageFor(plain) === WORKFLOW_STAGE.PACKED || plain.status === ORDER_STATUS.PACKED ? 'packed' : ''),
    upstreamReviewRequired: plain.upstreamReviewRequired === true,
    upstreamReviewedAt: plain.upstreamReviewedAt || null,
    lastUpstreamChangeSummary: {
      added: Number(plain.lastUpstreamChangeSummary?.added || 0),
      removed: Number(plain.lastUpstreamChangeSummary?.removed || 0),
      changed: Number(plain.lastUpstreamChangeSummary?.changed || 0),
    },
    lastUpstreamChangeDetails: (Array.isArray(plain.lastUpstreamChangeDetails) ? plain.lastUpstreamChangeDetails : []).slice(0, 12).map((detail) => ({
      kind: clean(detail?.kind, 32),
      lineKey: clean(detail?.lineKey, 800),
      name: clean(detail?.name, 1000),
      field: clean(detail?.field, 80),
      fromValue: clean(detail?.fromValue, 500),
      toValue: clean(detail?.toValue, 500),
      qty: qty(detail?.qty),
    })),
  };
}

function emitPickingUpdate(doc, clientMutationId = '') {
  try {
    const state = publicState(doc);
    getIO()?.to('marketplace_staff').emit('allegro_picking_updated', {
      allegroAccountId: clean(doc.allegroAccountId, 64),
      orderId: clean(doc.orderId, 128),
      orderKey: orderKey(doc.allegroAccountId, doc.orderId),
      state,
      ...(clean(clientMutationId, 160) ? { clientMutationId: clean(clientMutationId, 160) } : {}),
    });
  } catch (_) { /* realtime is best effort */ }
}

function emitOrdersChanged(accountId, orderIds = []) {
  try {
    getIO()?.to('marketplace_staff').emit('allegro_orders_changed', {
      allegroAccountId: clean(accountId, 64),
      orderIds: [...new Set(orderIds.map((value) => clean(value, 128)).filter(Boolean))],
      localWorkflowChanged: true,
    });
  } catch (_) { /* best effort */ }
}

async function savePickingDoc(doc) {
  try {
    await doc.save();
    return doc;
  } catch (error) {
    if (error?.name === 'VersionError') throw appError('allegro_picking_stale', { currentRevision: Number(doc?.revision || 0) });
    throw error;
  }
}

async function fetchExactOrder(accountId, orderId) {
  const id = clean(orderId, 128);
  try {
    const result = await allegroRequest(accountId, {
      method: 'GET',
      path: `/order/checkout-forms/${encodeURIComponent(id)}`,
      stage: 'picking_exact_verify',
      retryPolicy: 'safe',
      maxAttempts: 3,
    });
    const order = result.payload || {};
    if (clean(order?.id, 128) !== id || !Array.isArray(order?.lineItems) || !order.lineItems.length) {
      throw appError('allegro_order_response_invalid');
    }
    return order;
  } catch (error) {
    if (Number(error?.status) === 404) throw appError('allegro_order_not_found_upstream', { orderId: id });
    throw error;
  }
}

function changeDetails(previousItems, nextItems) {
  const prev = new Map((previousItems || []).map((item) => [clean(item?.lineKey, 800), item]));
  const next = new Map((nextItems || []).map((item) => [clean(item?.lineKey, 800), item]));
  const details = [];
  for (const [key, item] of next) {
    const before = prev.get(key);
    if (!before) {
      details.push({ kind: 'added', lineKey: key, name: item.name, qty: item.requestedQty });
      continue;
    }
    if (clean(before.sourceFingerprint, 128) === clean(item.sourceFingerprint, 128)) continue;
    if (Number(before.requestedQty || 0) !== Number(item.requestedQty || 0)) {
      details.push({ kind: 'changed', lineKey: key, name: item.name, field: 'quantity', fromValue: String(before.requestedQty || 0), toValue: String(item.requestedQty || 0) });
    } else if (clean(before.name, 1000) !== clean(item.name, 1000)) {
      details.push({ kind: 'changed', lineKey: key, name: item.name, field: 'name', fromValue: clean(before.name, 500), toValue: clean(item.name, 500) });
    } else if (clean(before.sku, 300) !== clean(item.sku, 300)) {
      details.push({ kind: 'changed', lineKey: key, name: item.name, field: 'sku', fromValue: clean(before.sku, 300), toValue: clean(item.sku, 300) });
    } else {
      details.push({ kind: 'changed', lineKey: key, name: item.name, field: 'product' });
    }
  }
  for (const [key, item] of prev) {
    if (!next.has(key)) details.push({ kind: 'removed', lineKey: key, name: clean(item?.name, 1000), qty: qty(item?.requestedQty) });
  }
  return details.slice(0, 50);
}

function synchronizeItems(doc, sourceItems, actor, { firstMaterialization = false } = {}) {
  const previous = Array.isArray(doc.items) ? doc.items.map((item) => (typeof item.toObject === 'function' ? item.toObject() : { ...item })) : [];
  const previousByKey = new Map(previous.map((item) => [clean(item.lineKey, 800), item]));
  const nextFingerprint = orderFingerprint(sourceItems);
  const previousFingerprint = clean(doc.lastUpstreamOrderFingerprint || doc.orderFingerprint, 128);
  if (previous.length && previousFingerprint === nextFingerprint) return { changed: false, details: [], summary: { added: 0, removed: 0, changed: 0 } };

  const details = previous.length ? changeDetails(previous, sourceItems) : [];
  const changedKeys = new Set(details.filter((d) => d.kind !== 'removed').map((d) => d.lineKey));
  const nextItems = sourceItems.map((source) => {
    const old = previousByKey.get(source.lineKey);
    const unchanged = old && clean(old.sourceFingerprint, 128) === clean(source.sourceFingerprint, 128);
    return {
      ...source,
      state: unchanged ? clean(old.state, 40) || 'pending' : 'pending',
      pickedQty: unchanged ? Math.min(qty(old.pickedQty), qty(source.requestedQty)) : 0,
      issueNote: unchanged ? clean(old.issueNote, 1500) : '',
      updatedBy: unchanged ? clean(old.updatedBy, 128) : '',
      updatedByName: unchanged ? clean(old.updatedByName, 240) : '',
      updatedAt: unchanged ? old.updatedAt || null : null,
    };
  });

  doc.items = nextItems;
  doc.lastUpstreamOrderFingerprint = nextFingerprint;
  if (!doc.orderFingerprint || firstMaterialization) doc.orderFingerprint = nextFingerprint;

  const summary = details.reduce((acc, detail) => {
    if (detail.kind === 'added') acc.added += 1;
    if (detail.kind === 'removed') acc.removed += 1;
    if (detail.kind === 'changed') acc.changed += 1;
    return acc;
  }, { added: 0, removed: 0, changed: 0 });

  if (previous.length && details.length) {
    doc.lastUpstreamChangeAt = new Date();
    doc.upstreamReviewRequired = true;
    doc.upstreamReviewedAt = null;
    doc.lastUpstreamChangeSummary = summary;
    doc.lastUpstreamChangeDetails = details;
    doc.status = deriveWorkingStatus(doc.items, Boolean(doc.ownerTelegramId));
    appendHistory(doc, 'upstream_order_changed', actor, { summary, changedLineKeys: [...changedKeys].slice(0, 30) });
  }
  return { changed: previous.length > 0 && details.length > 0, details, summary };
}

function applyUpstreamState(doc, order, actor) {
  const disposition = classifyUpstream(order);
  doc.lastUpstreamVerifiedAt = new Date();
  doc.lastUpstreamRevision = clean(order?.revision, 128);
  doc.lastUpstreamOrderStatus = clean(order?.status, 80).toUpperCase();
  doc.lastUpstreamFulfillmentStatus = clean(order?.fulfillment?.status, 80).toUpperCase();
  const prior = clean(doc.upstreamDisposition, 80);
  doc.upstreamDisposition = disposition;

  if (['cancelled', 'returned', 'suspended', 'other', 'missing'].includes(disposition)) {
    if (doc.ownerTelegramId) appendHistory(doc, 'ownership_released_upstream_block', actor, { disposition });
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
  }

  if (disposition === 'sent' && workflowStageFor(doc) !== WORKFLOW_STAGE.SENT) {
    doc.status = ORDER_STATUS.SENT;
    doc.workflowStage = WORKFLOW_STAGE.SENT;
    doc.sentAt = doc.sentAt || new Date();
    doc.sentBy = doc.sentBy || 'system:allegro';
    doc.sentByName = doc.sentByName || 'Allegro';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    appendHistory(doc, 'upstream_marked_sent', actor, {});
  }
  return prior !== disposition;
}

function indexStageFor(doc, disposition) {
  if (['cancelled', 'returned'].includes(disposition)) return 'cancelled';
  if (disposition === 'sent') return 'sent';
  if (disposition === 'suspended' && (!doc || workflowStageFor(doc) !== WORKFLOW_STAGE.SENT)) return 'deferred';
  if (!doc) return 'processing';
  const stage = workflowStageFor(doc);
  if (stage === WORKFLOW_STAGE.SENT) return 'sent';
  if (stage === WORKFLOW_STAGE.DEFERRED) return 'deferred';
  return 'processing';
}

async function mirrorStateToIndex(doc, disposition = null) {
  if (!doc) return;
  const resolvedDisposition = disposition || clean(doc.upstreamDisposition, 80) || 'unverified';
  await AllegroOrderIndex.updateOne(
    { accountId: doc.allegroAccountId, checkoutFormId: doc.orderId },
    { $set: {
      workflowStage: indexStageFor(doc, resolvedDisposition),
      upstreamReviewRequired: doc.upstreamReviewRequired === true,
      warehouseStatus: clean(doc.status, 80),
      sentBy: clean(doc.sentBy, 128),
      sentByName: clean(doc.sentByName, 240),
    } },
  );
}

async function reconcileAllegroPickingFromUpstream({ accountId, order, actor = null } = {}) {
  const aid = clean(accountId, 64);
  const oid = clean(order?.id, 128);
  if (!aid || !oid) return null;
  const systemActor = actor || { by: 'system:allegro-sync', byName: 'Allegro sync', byRole: 'system' };
  const disposition = classifyUpstream(order);
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) {
      await AllegroOrderIndex.updateOne(
        { accountId: aid, checkoutFormId: oid },
        { $set: { workflowStage: indexStageFor(null, disposition), upstreamReviewRequired: false, warehouseStatus: '', sentBy: '', sentByName: '' } },
      );
      return null;
    }
    const terminal = TERMINAL_STATUSES.includes(clean(doc.status, 80));
    let changed = false;
    if (!terminal) {
      const sync = synchronizeItems(doc, buildSourceItems(order), systemActor);
      changed = sync.changed;
    }
    const upstreamChanged = applyUpstreamState(doc, order, systemActor);
    if (changed || upstreamChanged) doc.revision = Number(doc.revision || 0) + 1;
    if (changed || upstreamChanged) await savePickingDoc(doc);
    await mirrorStateToIndex(doc, disposition);
    if (changed || upstreamChanged) emitPickingUpdate(doc);
    return publicState(doc);
  }, { ttlMs: 20_000, waitMs: 5_000 });
}

async function markAllegroPickingMissing({ accountId, orderId } = {}) {
  const aid = clean(accountId, 64);
  const oid = clean(orderId, 128);
  if (!aid || !oid) return;
  await withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc || TERMINAL_STATUSES.includes(clean(doc.status, 80))) return;
    doc.upstreamDisposition = 'missing';
    doc.lastUpstreamVerifiedAt = new Date();
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_order_missing', { by: 'system:allegro-sync', byName: 'Allegro sync', byRole: 'system' });
    await savePickingDoc(doc);
    emitPickingUpdate(doc);
  }, { ttlMs: 20_000, waitMs: 5_000 });
}

async function requireEnabledAccount(accountId) {
  return getAllegroAccount(clean(accountId, 64), { requireEnabled: true, lean: true });
}

function assertRevision(doc, expectedRevision) {
  const expected = Number(expectedRevision);
  if (!Number.isInteger(expected) || expected < 0 || Number(doc.revision || 0) !== expected) {
    throw appError('allegro_picking_stale', { currentRevision: Number(doc.revision || 0) });
  }
}

function assertOwner(doc, actor) {
  if (!actor.by || clean(doc.ownerTelegramId, 128) !== actor.by) throw appError('allegro_picking_not_owner');
}

function claimConflict(doc) {
  return appError('allegro_picking_taken', {
    ownerName: clean(doc?.ownerName, 240),
    claimTakeoverAvailableAt: publicState(doc)?.claimTakeoverAvailableAt || null,
  });
}

async function getPickingStates(orderRefs = []) {
  const refs = (orderRefs || []).map((entry) => ({
    accountId: clean(entry?.allegroAccountId || entry?.accountId, 64),
    orderId: clean(entry?.orderId, 128),
  })).filter((entry) => entry.accountId && entry.orderId);
  if (!refs.length) return {};
  const byAccount = new Map();
  for (const ref of refs) {
    if (!byAccount.has(ref.accountId)) byAccount.set(ref.accountId, []);
    byAccount.get(ref.accountId).push(ref.orderId);
  }
  const docs = [];
  for (const [accountId, ids] of byAccount) {
    docs.push(...await AllegroPickingOrder.find({ allegroAccountId: accountId, orderId: { $in: [...new Set(ids)] } }).lean());
  }
  return Object.fromEntries(docs.map((doc) => [orderKey(doc.allegroAccountId, doc.orderId), publicState(doc)]));
}

async function getMyActivePicking(user) {
  const actor = actorOf(user);
  if (!actor.by) return null;
  const doc = await AllegroPickingOrder.findOne({ ownerTelegramId: actor.by, status: { $in: WORKING_STATUSES } }).sort({ lastActivityAt: -1 });
  return publicState(doc);
}

async function claimPickingOrder({ allegroAccountId, orderId, user, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  if (!aid) throw appError('allegro_account_id_required');
  if (!oid) throw appError('allegro_order_id_required');
  await requireEnabledAccount(aid);

  return withLock(`marketplace-worker:${actor.by}`, async () => {
    const [activeAllegro, activeBaseLinker] = await Promise.all([
      AllegroPickingOrder.findOne({ ownerTelegramId: actor.by, status: { $in: WORKING_STATUSES }, $or: [{ allegroAccountId: { $ne: aid } }, { orderId: { $ne: oid } }] }).lean(),
      BaseLinkerPickingOrder.findOne({ ownerTelegramId: actor.by, status: { $in: WORKING_STATUSES } }).lean(),
    ]);
    if (activeBaseLinker) throw appError('marketplace_worker_has_active_order', { provider: 'BaseLinker', orderId: activeBaseLinker.orderId });
    if (activeAllegro) throw appError('marketplace_worker_has_active_order', { provider: 'Allegro', orderId: activeAllegro.orderId });

    const [order, account] = await Promise.all([fetchExactOrder(aid, oid), requireEnabledAccount(aid)]);
    assertActionable(order);

    return withLock(`allegro-order:${aid}:${oid}`, async () => {
      let doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
      const now = new Date();
      if (!doc) {
        const items = buildSourceItems(order).map((item) => ({ ...item, state: 'pending', pickedQty: 0, issueNote: '' }));
        doc = new AllegroPickingOrder({
          allegroAccountId: aid,
          allegroAccountNameSnapshot: clean(account?.name, 160),
          orderId: oid,
          orderFingerprint: orderFingerprint(items),
          lastUpstreamOrderFingerprint: orderFingerprint(items),
          status: deriveWorkingStatus(items, true),
          workflowStage: WORKFLOW_STAGE.PROCESSING,
          ownerTelegramId: actor.by,
          ownerName: actor.byName,
          claimedAt: now,
          lastActivityAt: now,
          items,
          lastUpstreamVerifiedAt: now,
          lastUpstreamRevision: clean(order?.revision, 128),
          lastUpstreamOrderStatus: clean(order?.status, 80).toUpperCase(),
          lastUpstreamFulfillmentStatus: clean(order?.fulfillment?.status, 80).toUpperCase(),
          upstreamDisposition: 'active',
          history: [],
        });
        appendHistory(doc, 'order_claimed', actor, { orderId: oid });
        await savePickingDoc(doc);
      } else {
        if (TERMINAL_STATUSES.includes(clean(doc.status, 80))) throw appError('allegro_picking_terminal');
        const owner = clean(doc.ownerTelegramId, 128);
        const activityMs = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
        const stale = owner && owner !== actor.by && activityMs > 0 && (Date.now() - activityMs) >= CLAIM_STALE_MS;
        const adminForce = user?.role === 'admin' && force === true;
        if (owner && owner !== actor.by && !stale && !adminForce) throw claimConflict(doc);
        const itemSync = synchronizeItems(doc, buildSourceItems(order), actor);
        const upstreamChanged = applyUpstreamState(doc, order, actor);
        if (itemSync.changed || upstreamChanged) {
          doc.revision = Number(doc.revision || 0) + 1;
          await savePickingDoc(doc);
          await mirrorStateToIndex(doc);
          emitPickingUpdate(doc, clientMutationId);
          emitOrdersChanged(aid, [oid]);
        }
        if (!isActionableDisposition(doc.upstreamDisposition)) assertActionable(order);
        if (doc.upstreamReviewRequired) throw appError('allegro_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });
        doc.allegroAccountNameSnapshot = clean(account?.name || doc.allegroAccountNameSnapshot, 160);
        doc.ownerTelegramId = actor.by;
        doc.ownerName = actor.byName;
        if (!doc.claimedAt || owner !== actor.by) doc.claimedAt = now;
        doc.lastActivityAt = now;
        doc.status = deriveWorkingStatus(doc.items, true);
        doc.workflowStage = workflowStageFor(doc) === WORKFLOW_STAGE.DEFERRED ? WORKFLOW_STAGE.DEFERRED : WORKFLOW_STAGE.PROCESSING;
        doc.revision = Number(doc.revision || 0) + 1;
        appendHistory(doc, owner && owner !== actor.by ? 'order_taken_over' : 'order_claimed', actor, { orderId: oid });
        await savePickingDoc(doc);
      }
      await mirrorStateToIndex(doc, 'active');
      emitPickingUpdate(doc, clientMutationId);
      emitOrdersChanged(aid, [oid]);
      const indexRow = await AllegroOrderIndex.findOne({ accountId: aid, checkoutFormId: oid }).lean();
      return { state: publicState(doc), order: indexRow?.preview || null };
    }, { ttlMs: 30_000, waitMs: 10_000 });
  }, { ttlMs: 45_000, waitMs: 12_000 });
}

async function heartbeatPickingOrder({ allegroAccountId, orderId, user }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  await requireEnabledAccount(aid);
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    assertOwner(doc, actor);
    if (TERMINAL_STATUSES.includes(clean(doc.status, 80))) throw appError('allegro_picking_terminal');
    doc.lastActivityAt = new Date();
    await doc.save();
    return { state: publicState(doc) };
  }, { ttlMs: 10_000, waitMs: 3_000 });
}

async function updatePickingItem({ allegroAccountId, orderId, lineKey, user, expectedRevision, state, pickedQty, issueNote, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  const key = clean(lineKey, 800);
  await requireEnabledAccount(aid);
  if (!WRITABLE_ITEM_STATES.has(clean(state, 40))) throw appError('allegro_picking_item_state_invalid');

  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);
    if (TERMINAL_STATUSES.includes(clean(doc.status, 80))) throw appError('allegro_picking_terminal');
    if (!isActionableDisposition(clean(doc.upstreamDisposition, 80))) throw appError('allegro_order_not_actionable', { orderId: oid });
    if (doc.upstreamReviewRequired) throw appError('allegro_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });
    const item = doc.items.find((entry) => clean(entry.lineKey, 800) === key);
    if (!item) throw appError('allegro_picking_item_not_found');
    const requested = qty(item.requestedQty);
    let found = Math.max(0, Math.min(requested, qty(pickedQty)));
    const nextState = clean(state, 40);
    if (nextState === 'picked') found = requested;
    if (nextState === 'pending' || nextState === 'not_found') found = 0;
    if (nextState === 'shortage' && found >= requested) throw appError('allegro_picking_shortage_invalid');
    item.state = nextState;
    item.pickedQty = found;
    item.issueNote = nextState === 'pending' || nextState === 'picked' ? '' : clean(issueNote, 1500);
    item.updatedBy = actor.by;
    item.updatedByName = actor.byName;
    item.updatedAt = new Date();
    doc.status = deriveWorkingStatus(doc.items, true);
    doc.workflowStage = workflowStageAfterWorkingStatus(workflowStageFor(doc), doc.status);
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'item_updated', actor, { lineKey: key, state: nextState, pickedQty: found });
    await savePickingDoc(doc);
    await mirrorStateToIndex(doc);
    emitPickingUpdate(doc, clientMutationId);
    emitOrdersChanged(aid, [oid]);
    return { state: publicState(doc) };
  }, { ttlMs: 20_000, waitMs: 7_000 });
}

async function releasePickingOrder({ allegroAccountId, orderId, user, expectedRevision, force = false, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  await requireEnabledAccount(aid);
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    const adminForce = user?.role === 'admin' && force === true;
    if (!adminForce) assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);
    if (TERMINAL_STATUSES.includes(clean(doc.status, 80))) throw appError('allegro_picking_terminal');
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
    doc.status = deriveWorkingStatus(doc.items, false);
    doc.workflowStage = WORKFLOW_STAGE.DEFERRED;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_deferred', actor, { force: adminForce });
    await savePickingDoc(doc);
    await mirrorStateToIndex(doc);
    emitPickingUpdate(doc, clientMutationId);
    emitOrdersChanged(aid, [oid]);
    return { state: publicState(doc) };
  }, { ttlMs: 20_000, waitMs: 7_000 });
}

async function markPickingOrderSent({ allegroAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  const account = await requireEnabledAccount(aid);
  const scopeState = capabilityMatrix(account?.scopes);
  if (scopeState.scopesKnown && scopeState.capabilities.ordersWrite !== true) {
    throw appError('allegro_account_missing_required_scopes', { missingScopes: [ALLEGRO_SCOPE.ORDERS_WRITE] });
  }
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    if (workflowStageFor(doc) === WORKFLOW_STAGE.SENT || doc.status === ORDER_STATUS.SENT) return { state: publicState(doc) };
    assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);

    const order = await fetchExactOrder(aid, oid);
    const itemSync = synchronizeItems(doc, buildSourceItems(order), actor);
    const upstreamChanged = applyUpstreamState(doc, order, actor);
    if (itemSync.changed || upstreamChanged) {
      doc.revision = Number(doc.revision || 0) + 1;
      await savePickingDoc(doc);
      await mirrorStateToIndex(doc, doc.upstreamDisposition);
      emitPickingUpdate(doc, clientMutationId);
      emitOrdersChanged(aid, [oid]);
    }
    if (doc.upstreamDisposition === 'sent') {
      return { state: publicState(doc), upstreamAlreadySent: true };
    }
    assertActionable(order);
    if (doc.upstreamReviewRequired) throw appError('allegro_upstream_review_required', { lastUpstreamChangeAt: doc.lastUpstreamChangeAt });
    const readiness = packingReadiness(doc.items);
    if (!readiness.allHandled) throw appError('allegro_picking_items_unhandled', { pendingLines: readiness.pendingLines });
    if (readiness.hasIssues) throw appError('allegro_picking_has_unresolved_issues', { problemLines: readiness.problemLines, missingQty: readiness.missingQty });
    if (!readiness.allPicked) throw appError('allegro_picking_not_ready');

    await allegroRequest(aid, {
      method: 'PUT',
      path: `/order/checkout-forms/${encodeURIComponent(oid)}/fulfillment`,
      body: { status: 'SENT' },
      stage: 'warehouse_mark_sent',
      retryPolicy: 'idempotent',
      maxAttempts: 3,
    });

    const now = new Date();
    doc.status = ORDER_STATUS.SENT;
    doc.workflowStage = WORKFLOW_STAGE.SENT;
    doc.upstreamDisposition = 'sent';
    doc.lastUpstreamFulfillmentStatus = 'SENT';
    doc.lastUpstreamVerifiedAt = now;
    doc.sentAt = now;
    doc.sentBy = actor.by;
    doc.sentByName = actor.byName;
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = now;
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_sent', actor, { upstreamFulfillment: 'SENT' });
    await savePickingDoc(doc);
    await AllegroOrderIndex.updateOne(
      { accountId: aid, checkoutFormId: oid },
      { $set: {
        workflowStage: 'sent',
        upstreamStage: 'sent',
        fulfillmentStatus: 'SENT',
        'preview.fulfillment_status': 'SENT',
        'preview.workflowStage': 'sent',
        upstreamReviewRequired: false,
        warehouseStatus: ORDER_STATUS.SENT,
        sentBy: actor.by,
        sentByName: actor.byName,
      } },
    );
    emitPickingUpdate(doc, clientMutationId);
    emitOrdersChanged(aid, [oid]);
    return { state: publicState(doc) };
  }, { ttlMs: 35_000, waitMs: 10_000 });
}

async function acknowledgeUpstreamReview({ allegroAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    if (user?.role !== 'admin') assertOwner(doc, actor);
    assertRevision(doc, expectedRevision);
    doc.upstreamReviewRequired = false;
    doc.upstreamReviewedAt = new Date();
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'upstream_change_reviewed', actor, {});
    await savePickingDoc(doc);
    await mirrorStateToIndex(doc);
    emitPickingUpdate(doc, clientMutationId);
    emitOrdersChanged(aid, [oid]);
    return { state: publicState(doc) };
  }, { ttlMs: 20_000, waitMs: 7_000 });
}

async function reopenPickingOrder({ allegroAccountId, orderId, user, expectedRevision, clientMutationId = '' }) {
  const actor = actorOf(user);
  const aid = clean(allegroAccountId, 64);
  const oid = clean(orderId, 128);
  if (user?.role !== 'admin') throw appError('auth_role_required', { allowed: ['admin'] });
  await requireEnabledAccount(aid);
  return withLock(`allegro-order:${aid}:${oid}`, async () => {
    const doc = await AllegroPickingOrder.findOne({ allegroAccountId: aid, orderId: oid });
    if (!doc) throw appError('allegro_picking_not_started');
    assertRevision(doc, expectedRevision);
    const order = await fetchExactOrder(aid, oid);
    assertActionable(order);
    synchronizeItems(doc, buildSourceItems(order), actor);
    applyUpstreamState(doc, order, actor);
    doc.status = deriveWorkingStatus(doc.items, false);
    doc.workflowStage = WORKFLOW_STAGE.PROCESSING;
    doc.sentAt = null;
    doc.sentBy = '';
    doc.sentByName = '';
    doc.ownerTelegramId = '';
    doc.ownerName = '';
    doc.claimedAt = null;
    doc.lastActivityAt = new Date();
    doc.revision = Number(doc.revision || 0) + 1;
    appendHistory(doc, 'order_reopened', actor, {});
    await savePickingDoc(doc);
    await mirrorStateToIndex(doc, 'active');
    emitPickingUpdate(doc, clientMutationId);
    emitOrdersChanged(aid, [oid]);
    return { state: publicState(doc) };
  }, { ttlMs: 25_000, waitMs: 8_000 });
}

module.exports = {
  CLAIM_STALE_MS,
  classifyUpstream,
  publicState,
  getPickingStates,
  getMyActivePicking,
  claimPickingOrder,
  heartbeatPickingOrder,
  updatePickingItem,
  releasePickingOrder,
  markPickingOrderSent,
  acknowledgeUpstreamReview,
  reopenPickingOrder,
  reconcileAllegroPickingFromUpstream,
  markAllegroPickingMissing,
};

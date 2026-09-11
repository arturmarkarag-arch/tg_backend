'use strict';

const crypto = require('crypto');
const AllegroShipmentBinding = require('../models/AllegroShipmentBinding');
const AllegroPickingOrder = require('../models/AllegroPickingOrder');
const { getAllegroAccount } = require('./allegroAccounts');
const { capabilityMatrix } = require('./allegroCapabilities');
const { allegroRequest } = require('./allegroHttpClient');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { ORDER_STATUS } = require('../domain/warehousePickingState');
const { classifyUpstream, reconcileAllegroPickingFromUpstream } = require('./allegroPicking');

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function uniq(values, max = 128) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => clean(value, max)).filter(Boolean))];
}

function publicBinding(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : (row || {});
  return {
    accountId: clean(value.accountId, 64),
    orderId: clean(value.orderId, 128),
    commandId: clean(value.commandId, 96),
    shipmentId: clean(value.shipmentId, 128),
    status: clean(value.status, 32) || 'idle',
    labelFormat: clean(value.labelFormat, 24),
    carrierId: clean(value.carrierId, 80),
    waybills: uniq(value.waybills, 128),
    lastError: clean(value.lastError, 1500),
    lastTraceId: clean(value.lastTraceId, 256),
    lastCommandCheckAt: value.lastCommandCheckAt || null,
    nextCommandCheckAt: value.nextCommandCheckAt || null,
    updatedAt: value.updatedAt || null,
  };
}

function sanitizeTracking(payload) {
  return (Array.isArray(payload?.shipments) ? payload.shipments : []).slice(0, 20).map((shipment) => ({
    id: clean(shipment?.id, 256),
    waybill: clean(shipment?.waybill, 128),
    carrierId: clean(shipment?.carrierId, 80),
    carrierName: clean(shipment?.carrierName, 160),
    lineItemIds: (Array.isArray(shipment?.lineItems) ? shipment.lineItems : []).map((item) => clean(item?.id, 128)).filter(Boolean).slice(0, 100),
    createdAt: shipment?.createdAt || null,
  }));
}

function shipmentDetailSummary(payload) {
  const waybills = [];
  const carrierIds = [];
  for (const pkg of Array.isArray(payload?.packages) ? payload.packages : []) {
    for (const info of Array.isArray(pkg?.transportingInfo) ? pkg.transportingInfo : []) {
      const waybill = clean(info?.carrierWaybill, 128);
      const carrierId = clean(info?.carrierId, 80);
      if (waybill) waybills.push(waybill);
      if (carrierId) carrierIds.push(carrierId);
    }
  }
  return {
    labelFormat: clean(payload?.labelFormat, 24).toUpperCase(),
    carrierId: clean(payload?.carrier, 80) || uniq(carrierIds, 80)[0] || '',
    waybills: uniq(waybills, 128),
  };
}

async function assertShipmentCreationReady(accountId, orderId, user) {
  const actorId = clean(user?.telegramId, 128);
  if (!actorId) throw appError('allegro_picking_not_owner');
  const picking = await AllegroPickingOrder.findOne({ allegroAccountId: accountId, orderId });
  if (!picking) throw appError('allegro_picking_not_started');
  if (clean(picking.ownerTelegramId, 128) !== actorId) throw appError('allegro_picking_not_owner');
  if (picking.upstreamReviewRequired === true) throw appError('allegro_upstream_review_required');
  const pickingStatus = clean(picking.status, 80);
  if (pickingStatus === ORDER_STATUS.READY_WITH_ISSUE) throw appError('allegro_picking_has_unresolved_issues');
  if (pickingStatus !== ORDER_STATUS.READY) throw appError('allegro_picking_items_unhandled');

  const current = await allegroRequest(accountId, {
    method: 'GET',
    path: `/order/checkout-forms/${encodeURIComponent(orderId)}`,
    stage: 'shipment_order_revalidate',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  const disposition = classifyUpstream(current.payload);
  if (clean(current.payload?.id, 128) !== orderId || !Array.isArray(current.payload?.lineItems)) throw appError('allegro_order_response_invalid');
  await reconcileAllegroPickingFromUpstream({ accountId, order: current.payload });
  if (disposition === 'cancelled') throw appError('allegro_order_cancelled', { orderId });
  if (disposition === 'returned') throw appError('allegro_order_returned', { orderId });
  if (disposition === 'sent') throw appError('allegro_order_already_sent', { orderId });
  if (disposition === 'suspended') throw appError('allegro_order_suspended', { orderId });
  if (disposition !== 'active') throw appError('allegro_order_not_actionable', { orderId });
  const verified = await AllegroPickingOrder.findOne({ allegroAccountId: accountId, orderId });
  if (verified?.upstreamReviewRequired) throw appError('allegro_upstream_review_required');
  if (clean(verified?.ownerTelegramId, 128) !== actorId) throw appError('allegro_picking_not_owner');
  if (verified?.status !== ORDER_STATUS.READY) throw appError('allegro_picking_items_unhandled');
  return verified;
}

async function requireShipmentAccount(accountId, { write = false } = {}) {
  const account = await getAllegroAccount(accountId, { requireEnabled: true, lean: true });
  const scopeState = capabilityMatrix(account?.scopes);
  if (scopeState.scopesKnown) {
    const allowed = write ? scopeState.capabilities.shipmentsWrite : scopeState.capabilities.shipmentsRead;
    if (allowed !== true) {
      throw appError('allegro_shipment_scope_required', {
        scope: write ? 'allegro:api:shipments:write' : 'allegro:api:shipments:read',
      });
    }
  }
  return account;
}

async function fetchOrderTracking(accountId, orderId) {
  await requireShipmentAccount(accountId, { write: false });
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/order/checkout-forms/${encodeURIComponent(clean(orderId, 128))}/shipments`,
    stage: 'shipment_tracking_read',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  return { shipments: sanitizeTracking(result.payload), traceId: result.traceId || '' };
}

async function refreshShipmentDetails(accountId, binding) {
  if (!clean(binding?.shipmentId, 128)) return binding;
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/shipment-management/shipments/${encodeURIComponent(binding.shipmentId)}`,
    stage: 'shipment_detail_read',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  const summary = shipmentDetailSummary(result.payload || {});
  binding.labelFormat = summary.labelFormat;
  binding.carrierId = summary.carrierId;
  binding.waybills = summary.waybills;
  binding.lastTraceId = result.traceId || '';
  binding.lastError = '';
  await binding.save();
  return binding;
}

async function checkCreateCommand(accountId, binding) {
  if (!clean(binding?.commandId, 96)) return binding;
  if (binding.nextCommandCheckAt && new Date(binding.nextCommandCheckAt).getTime() > Date.now()) return binding;
  const result = await allegroRequest(accountId, {
    method: 'GET',
    path: `/shipment-management/shipments/create-commands/${encodeURIComponent(binding.commandId)}`,
    stage: 'shipment_create_status',
    retryPolicy: 'safe',
    maxAttempts: 3,
  });
  const status = clean(result.payload?.status, 32).toUpperCase();
  binding.lastCommandCheckAt = new Date();
  binding.nextCommandCheckAt = new Date(Date.now() + Math.max(1000, Number(result.retryAfterMs) || 1000));
  binding.lastTraceId = result.traceId || '';
  if (status === 'SUCCESS') {
    if (!clean(result.payload?.shipmentId, 128)) throw appError('allegro_order_response_invalid');
    binding.status = 'success';
    binding.nextCommandCheckAt = null;
    binding.shipmentId = clean(result.payload?.shipmentId, 128);
    binding.lastError = '';
    await binding.save();
    if (binding.shipmentId) await refreshShipmentDetails(accountId, binding);
    return binding;
  }
  if (['ERROR', 'FAILED', 'FAILURE'].includes(status)) {
    const errors = Array.isArray(result.payload?.errors) ? result.payload.errors : [];
    binding.status = 'error';
    binding.nextCommandCheckAt = null;
    binding.lastError = clean(errors.map((item) => item?.userMessage || item?.message || item?.details).filter(Boolean).join(' | ') || 'Allegro не створив відправлення.', 1500);
    await binding.save();
    return binding;
  }
  binding.status = 'pending';
  await binding.save();
  return binding;
}

async function getShipmentSummary(accountId, orderId) {
  const aid = clean(accountId, 64);
  const oid = clean(orderId, 128);
  if (!aid) throw appError('allegro_account_id_required');
  if (!oid) throw appError('allegro_order_id_required');
  await requireShipmentAccount(aid, { write: false });
  return withLock(`allegro-shipment:${aid}:${oid}`, async () => {
    let binding = await AllegroShipmentBinding.findOne({ accountId: aid, orderId: oid });
    if (binding?.status === 'pending') binding = await checkCreateCommand(aid, binding);
    if (binding?.status === 'error') throw appError('allegro_shipment_create_failed', { detail: binding.lastError });
    const pending = binding?.status === 'pending';
    const tracking = pending ? { shipments: [] } : await fetchOrderTracking(aid, oid);
    return {
      ready: Boolean(binding?.shipmentId), pending,
      binding: publicBinding(binding),
      tracking: tracking.shipments,
      externalTrackingOnly: !pending && tracking.shipments.length > 0 && !clean(binding?.shipmentId, 128),
    };
  }, { ttlMs: 180_000, waitMs: 8_000 });
}

async function prepareShipment(accountId, orderId, { user = null } = {}) {
  const aid = clean(accountId, 64);
  const oid = clean(orderId, 128);
  if (!aid) throw appError('allegro_account_id_required');
  if (!oid) throw appError('allegro_order_id_required');
  await requireShipmentAccount(aid, { write: true });

  return withLock(`allegro-shipment:${aid}:${oid}`, async () => {
    let binding = await AllegroShipmentBinding.findOne({ accountId: aid, orderId: oid });
    if (binding?.shipmentId) {
      await refreshShipmentDetails(aid, binding).catch(() => {});
      const tracking = await fetchOrderTracking(aid, oid).catch(() => ({ shipments: [] }));
      return { ready: true, pending: false, binding: publicBinding(binding), tracking: tracking.shipments || [] };
    }

    if (binding?.commandId && binding.status === 'pending') {
      binding = await checkCreateCommand(aid, binding);
      if (binding.status === 'success' && binding.shipmentId) {
        const tracking = await fetchOrderTracking(aid, oid).catch(() => ({ shipments: [] }));
        return { ready: true, pending: false, binding: publicBinding(binding), tracking: tracking.shipments || [] };
      }
      if (binding.status === 'error') throw appError('allegro_shipment_create_failed', { detail: binding.lastError });
      // The existing command is still processing. Poll it on the next request;
      // never submit a fresh proposal while its outcome is unresolved.
      return { ready: false, pending: true, binding: publicBinding(binding), tracking: [] };
    }

    if (binding?.status === 'error') throw appError('allegro_shipment_create_failed', { detail: binding.lastError });
    await assertShipmentCreationReady(aid, oid, user);
    const trackingBefore = await fetchOrderTracking(aid, oid);
    if (trackingBefore.shipments.length && !binding?.shipmentId) {
      return {
        ready: false,
        pending: false,
        externalTrackingOnly: true,
        binding: publicBinding(binding),
        tracking: trackingBefore.shipments,
      };
    }

    const proposal = await allegroRequest(aid, {
      method: 'GET',
      path: `/shipment-management/delivery-proposals/${encodeURIComponent(oid)}`,
      stage: 'shipment_delivery_proposal',
      retryPolicy: 'safe',
      maxAttempts: 3,
    });
    const suggestedInput = proposal.payload?.suggestedInput;
    if (!suggestedInput || typeof suggestedInput !== 'object' || !Array.isArray(suggestedInput.packages) || !suggestedInput.packages.length) {
      throw appError('allegro_shipment_proposal_invalid');
    }

    const commandId = binding?.commandId || crypto.randomUUID();
    binding = await AllegroShipmentBinding.findOneAndUpdate(
      { accountId: aid, orderId: oid },
      {
        $set: {
          commandId,
          status: 'pending',
          lastError: '',
          lastTraceId: proposal.traceId || '',
          lastCommandCheckAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    const submitted = await allegroRequest(aid, {
      method: 'POST',
      path: '/shipment-management/shipments/create-commands',
      stage: 'shipment_create',
      retryPolicy: 'idempotent',
      maxAttempts: 3,
      body: { commandId, input: suggestedInput },
    });

    binding.nextCommandCheckAt = new Date(Date.now() + Math.max(1000, Number(submitted.retryAfterMs) || 1000));
    await binding.save();

    return { ready: false, pending: true, binding: publicBinding(binding), tracking: [] };
  }, { ttlMs: 600_000, waitMs: 8_000 });
}

async function getShipmentLabel(accountId, orderId) {
  const aid = clean(accountId, 64);
  const oid = clean(orderId, 128);
  await requireShipmentAccount(aid, { write: false });
  let binding = await AllegroShipmentBinding.findOne({ accountId: aid, orderId: oid });
  if (!binding?.shipmentId) throw appError('allegro_shipment_not_ready');
  if (!binding.labelFormat || !binding.waybills?.length) {
    binding = await refreshShipmentDetails(aid, binding);
  }
  const result = await allegroRequest(aid, {
    method: 'POST',
    path: '/shipment-management/label',
    stage: 'shipment_label_read',
    retryPolicy: 'idempotent',
    maxAttempts: 2,
    accept: 'application/octet-stream',
    responseType: 'buffer',
    body: { shipmentIds: [binding.shipmentId] },
  });
  if (!Buffer.isBuffer(result.payload) || result.payload.length === 0) throw appError('allegro_shipment_label_empty');
  const format = clean(binding.labelFormat, 24).toLowerCase();
  const extension = ['pdf', 'zpl', 'epl', 'png', 'gif'].includes(format) ? format : 'bin';
  return {
    buffer: result.payload,
    contentType: clean(result.contentType, 200) || (extension === 'pdf' ? 'application/pdf' : 'application/octet-stream'),
    extension,
    waybills: uniq(binding.waybills, 128),
    shipmentId: clean(binding.shipmentId, 128),
  };
}

module.exports = {
  getShipmentSummary,
  prepareShipment,
  getShipmentLabel,
};

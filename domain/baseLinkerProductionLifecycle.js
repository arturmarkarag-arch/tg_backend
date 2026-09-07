'use strict';

function dispositionOf(value) {
  return String(value || '').trim();
}

function isProductionEligibleDisposition(value) {
  return dispositionOf(value) === 'intake';
}

function hasLocalWarehouseSent(snapshot = {}) {
  return Boolean(
    snapshot.sentAt
    || String(snapshot.status || '') === 'sent'
    || String(snapshot.workflowStage || '') === 'sent'
  );
}

function hasLocalWarehousePacked(snapshot = {}) {
  return Boolean(
    snapshot.packedAt
    || String(snapshot.status || '') === 'packed'
    || String(snapshot.workflowStage || '') === 'packed'
    || hasLocalWarehouseSent(snapshot)
  );
}

function lifecycleTerminalReason(snapshot = {}) {
  if (snapshot.upstreamReviewRequired === true) return '';
  if (String(snapshot.ownerTelegramId || '').trim()) return '';
  if (hasLocalWarehouseSent(snapshot)) return 'warehouse_sent';
  if (dispositionOf(snapshot.upstreamDisposition) === 'cancelled') return 'upstream_cancelled_reviewed';
  return '';
}

function isLifecycleTerminalSnapshot(snapshot = {}) {
  return Boolean(lifecycleTerminalReason(snapshot));
}

module.exports = {
  dispositionOf,
  isProductionEligibleDisposition,
  hasLocalWarehouseSent,
  hasLocalWarehousePacked,
  lifecycleTerminalReason,
  isLifecycleTerminalSnapshot,
};

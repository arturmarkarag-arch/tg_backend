'use strict';

const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { getQueueScope, classifyUpstreamOrder, HISTORY_LOOKBACK_DAYS } = require('./baseLinkerQueueScope');
const { withLock } = require('../utils/lock');

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINKER_HISTORY_RETENTION_DAYS = HISTORY_LOOKBACK_DAYS;
const BASELINKER_HISTORY_RETENTION_MS = BASELINKER_HISTORY_RETENTION_DAYS * DAY_MS;
const PICKING_PURGE_VERIFY_LIMIT = Math.min(250, Math.max(1, Number(process.env.BASELINKER_RETENTION_VERIFY_LIMIT) || 100));

function terminalPickingCandidateFilter(cutoffDate) {
  return {
    ownerTelegramId: { $in: ['', null] },
    $or: [
      { status: 'sent', sentAt: { $lt: cutoffDate } },
      { upstreamDisposition: 'sent', lastUpstreamChangeAt: { $lt: cutoffDate } },
      { upstreamDisposition: 'cancelled', lastUpstreamChangeAt: { $lt: cutoffDate } },
    ],
  };
}

async function purgeVerifiedTerminalPicking(scope, cutoffDate, cutoffSeconds) {
  if (!scope.configured) return { deleted: 0, checked: 0, pending: 0, verifyFailed: 0 };
  const filter = terminalPickingCandidateFilter(cutoffDate);
  const total = await BaseLinkerPickingOrder.countDocuments(filter);
  const candidates = await BaseLinkerPickingOrder.find(filter)
    .select('_id orderId revision')
    .sort({ lastUpstreamChangeAt: 1, sentAt: 1, _id: 1 })
    .limit(PICKING_PURGE_VERIFY_LIMIT)
    .lean();

  let deleted = 0;
  let checked = 0;
  let verifyFailed = 0;
  for (const candidate of candidates) {
    const orderId = String(candidate?.orderId || '');
    if (!orderId) continue;
    try {
      await withLock(`baselinker-order:${orderId}`, async () => {
        const current = await BaseLinkerPickingOrder.findOne({
          _id: candidate._id,
          orderId,
          revision: candidate.revision,
          ...terminalPickingCandidateFilter(cutoffDate),
        }).lean();
        if (!current) return;

        const exact = await fetchBaseLinkerOrders({ orderId, includeUnconfirmed: false, maxPages: 1 });
        const order = (exact.orders || []).find((row) => String(row?.order_id || '') === orderId) || null;
        checked += 1;
        if (order) {
          if (classifyUpstreamOrder(order, scope) === 'intake') return;
          const changedAt = Number(order?.date_in_status || 0);
          if (!Number.isFinite(changedAt) || changedAt <= 0 || changedAt >= cutoffSeconds) return;
        }
        const result = await BaseLinkerPickingOrder.deleteOne({ _id: candidate._id, orderId, revision: candidate.revision });
        deleted += Number(result?.deletedCount || 0);
      }, { ttlMs: 20_000, waitMs: 5_000 });
    } catch (_) {
      verifyFailed += 1;
    }
  }
  return { deleted, checked, pending: Math.max(0, total - candidates.length), verifyFailed };
}

async function purgeExpiredBaseLinkerData(now = Date.now()) {
  const cutoffDate = new Date(now - BASELINKER_HISTORY_RETENTION_MS);
  const cutoffSeconds = Math.floor(cutoffDate.getTime() / 1000);
  const scope = await getQueueScope();
  const [printAgentResult, picking] = await Promise.all([
    BaseLinkerPrintAgent.deleteMany({ lastSeenAt: { $lt: cutoffDate } }),
    purgeVerifiedTerminalPicking(scope, cutoffDate, cutoffSeconds),
  ]);
  return {
    retentionDays: BASELINKER_HISTORY_RETENTION_DAYS,
    pickingDeleted: picking.deleted,
    pickingChecked: picking.checked,
    pickingPending: picking.pending,
    pickingVerifyFailed: picking.verifyFailed,
    printAgentsDeleted: Number(printAgentResult?.deletedCount || 0),
  };
}

module.exports = {
  purgeExpiredBaseLinkerData,
  terminalPickingCandidateFilter,
  BASELINKER_HISTORY_RETENTION_DAYS,
  BASELINKER_HISTORY_RETENTION_MS,
  PICKING_PURGE_VERIFY_LIMIT,
};

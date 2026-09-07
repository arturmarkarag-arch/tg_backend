'use strict';

const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { listBaseLinkerAccounts } = require('./baseLinkerAccounts');
const { getQueueScope, classifyUpstreamOrder, HISTORY_RETENTION_DAYS } = require('./baseLinkerQueueScope');
const { withLock } = require('../utils/lock');

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINKER_HISTORY_RETENTION_DAYS = HISTORY_RETENTION_DAYS;
const BASELINKER_HISTORY_RETENTION_MS = BASELINKER_HISTORY_RETENTION_DAYS * DAY_MS;
const PICKING_PURGE_VERIFY_LIMIT = Math.min(250, Math.max(1, Number(process.env.BASELINKER_RETENTION_VERIFY_LIMIT) || 100));

function terminalPickingCandidateFilter(cutoffDate, baseLinkerAccountId = '') {
  return {
    ...(baseLinkerAccountId ? { baseLinkerAccountId } : {}),
    ownerTelegramId: { $in: ['', null] },
    upstreamReviewRequired: { $ne: true },
    $or: [
      // Local Sent is a physical warehouse fact and may be retained after the
      // current BaseLinker status changes, once any conflict has been reviewed.
      // A newer upstream status/product event restarts the 14-day history age;
      // old sentAt alone must never erase a recently resolved conflict.
      {
        status: 'sent',
        sentAt: { $lt: cutoffDate },
        $or: [
          { lastUpstreamChangeAt: { $in: [null] } },
          { lastUpstreamChangeAt: { $lt: cutoffDate } },
        ],
      },
      // Cancellation can become terminal without any local Sent/Packed fact
      // after the warehouse explicitly reviews the upstream cancellation.
      { upstreamDisposition: 'cancelled', lastUpstreamChangeAt: { $lt: cutoffDate } },
    ],
  };
}

async function purgeVerifiedTerminalPickingForAccount(accountId, scope, cutoffDate, cutoffSeconds, limit) {
  if (!scope.configured || limit <= 0) return { deleted: 0, checked: 0, pending: 0, verifyFailed: 0 };
  const filter = terminalPickingCandidateFilter(cutoffDate, accountId);
  const total = await BaseLinkerPickingOrder.countDocuments(filter);
  const candidates = await BaseLinkerPickingOrder.find(filter)
    .select('_id baseLinkerAccountId orderId revision')
    .sort({ lastUpstreamChangeAt: 1, sentAt: 1, _id: 1 })
    .limit(limit)
    .lean();
  const callApi = makeBaseLinkerAccountCaller(accountId);

  let deleted = 0;
  let checked = 0;
  let verifyFailed = 0;
  for (const candidate of candidates) {
    const orderId = String(candidate?.orderId || '');
    if (!orderId) continue;
    try {
      await withLock(`baselinker-order:${accountId}:${orderId}`, async () => {
        const current = await BaseLinkerPickingOrder.findOne({
          _id: candidate._id,
          baseLinkerAccountId: accountId,
          orderId,
          revision: candidate.revision,
          ...terminalPickingCandidateFilter(cutoffDate, accountId),
        }).lean();
        if (!current) return;

        const exact = await fetchBaseLinkerOrders({ orderId, includeUnconfirmed: false, maxPages: 1 }, callApi);
        const order = (exact.orders || []).find((row) => String(row?.order_id || '') === orderId) || null;
        checked += 1;
        if (order) {
          if (classifyUpstreamOrder(order, scope) === 'intake') return;
          const changedAt = Number(order?.date_in_status || 0);
          if (!Number.isFinite(changedAt) || changedAt <= 0 || changedAt >= cutoffSeconds) return;
        }
        const result = await BaseLinkerPickingOrder.deleteOne({
          _id: candidate._id,
          baseLinkerAccountId: accountId,
          orderId,
          revision: candidate.revision,
        });
        deleted += Number(result?.deletedCount || 0);
      }, { ttlMs: 20_000, waitMs: 5_000 });
    } catch (_) {
      // Retention is fail-closed: an unverifiable row is kept.
      verifyFailed += 1;
    }
  }
  return { deleted, checked, pending: Math.max(0, total - candidates.length), verifyFailed, visited: candidates.length };
}

async function purgeVerifiedTerminalPicking(cutoffDate, cutoffSeconds) {
  // Disabled accounts are deliberately not touched. "Disabled" means no new
  // BaseLinker traffic; keeping history is safer than silently verifying/purging it.
  const accounts = await listBaseLinkerAccounts({ includeDisabled: false });
  let remaining = PICKING_PURGE_VERIFY_LIMIT;
  const aggregate = { deleted: 0, checked: 0, pending: 0, verifyFailed: 0 };
  for (const account of accounts) {
    if (remaining <= 0) break;
    const scope = await getQueueScope(account.accountId);
    const result = await purgeVerifiedTerminalPickingForAccount(account.accountId, scope, cutoffDate, cutoffSeconds, remaining);
    aggregate.deleted += result.deleted;
    aggregate.checked += result.checked;
    aggregate.pending += result.pending;
    aggregate.verifyFailed += result.verifyFailed;
    remaining -= Number(result.visited || 0);
  }
  return aggregate;
}

async function purgeExpiredBaseLinkerData(now = Date.now()) {
  const cutoffDate = new Date(now - BASELINKER_HISTORY_RETENTION_MS);
  const cutoffSeconds = Math.floor(cutoffDate.getTime() / 1000);
  const [printAgentResult, picking] = await Promise.all([
    BaseLinkerPrintAgent.deleteMany({ lastSeenAt: { $lt: cutoffDate } }),
    purgeVerifiedTerminalPicking(cutoffDate, cutoffSeconds),
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

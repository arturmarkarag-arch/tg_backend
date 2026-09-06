'use strict';

const BaseLinkerOrderCache = require('../models/BaseLinkerOrderCache');
const BaseLinkerOrderSnapshot = require('../models/BaseLinkerOrderSnapshot');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintAgent = require('../models/BaseLinkerPrintAgent');
const { fetchBaseLinkerOrders } = require('./baseLinkerOrders');
const {
  getQueueScope,
  classifyUpstreamOrder,
  HISTORY_LOOKBACK_DAYS,
} = require('./baseLinkerQueueScope');
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
      {
        upstreamDisposition: 'cancelled',
        lastUpstreamChangeAt: { $lt: cutoffDate },
      },
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
          const disposition = classifyUpstreamOrder(order, scope);
          // Never age-purge an order that BaseLinker has returned to ordinary
          // local work. Intake is the normal admission state; any non-terminal
          // status likewise fails closed here unless the persisted candidate is
          // still old enough by the current upstream status clock.
          if (disposition === 'intake') return;

          // For every still-existing order, BaseLinker's current date_in_status
          // is the retention clock. Missing/invalid timestamps
          // fail closed: keep the local audit state rather than guessing.
          const changedAt = Number(order?.date_in_status || 0);
          if (!Number.isFinite(changedAt) || changedAt <= 0 || changedAt >= cutoffSeconds) return;
        }
        // If BaseLinker no longer returns the order, the already-old local
        // `missing`/terminal state is sufficient to purge after the retention window.

        const result = await BaseLinkerPickingOrder.deleteOne({
          _id: candidate._id,
          orderId,
          revision: candidate.revision,
        });
        deleted += Number(result?.deletedCount || 0);
      }, { ttlMs: 20_000, waitMs: 5_000 });
    } catch (_) {
      // Retention is fail-closed. A network/lock/API failure keeps the row for a
      // later daily pass; cleanup must never be allowed to destroy uncertain state.
      verifyFailed += 1;
    }
  }

  return {
    deleted,
    checked,
    pending: Math.max(0, total - candidates.length),
    verifyFailed,
  };
}

/**
 * BaseLinker retention is intentionally asymmetric:
 *   - Intake is live operational state and is NEVER deleted merely because it is old.
 *   - Sent / Cancelled are bounded history shelves (14 days by date_in_status).
 *   - Immutable raw snapshots are forensic history, also bounded to 14 days.
 *   - Terminal Sent/Cancelled local picking rows are bounded to 14 days, but are
 *     exact-verified against BaseLinker before deletion to protect state restoration.
 *   - Print jobs already have a stricter 7-day TTL. Print-agent registrations are
 *     ephemeral and are also capped at 14 days.
 */
async function purgeExpiredBaseLinkerData(now = Date.now()) {
  const cutoffDate = new Date(now - BASELINKER_HISTORY_RETENTION_MS);
  const cutoffSeconds = Math.floor(cutoffDate.getTime() / 1000);
  const scope = await getQueueScope();

  const result = {
    retentionDays: BASELINKER_HISTORY_RETENTION_DAYS,
    cacheDeleted: 0,
    snapshotsDeleted: 0,
    pickingDeleted: 0,
    pickingChecked: 0,
    pickingPending: 0,
    pickingVerifyFailed: 0,
    printAgentsDeleted: 0,
  };

  // Serialize cache deletion with journal/full-sync writers. Active Intake rows
  // have no age limit; only bounded history / stale non-queue rows are purged.
  await withLock('baselinker-order-cache-sync', async () => {
    if (!scope.configured) return;
    const cacheResult = await BaseLinkerOrderCache.deleteMany({
      $or: [
        { orderStatusId: scope.sentStatusId, statusChangedAt: { $gt: 0, $lt: cutoffSeconds } },
        { orderStatusId: scope.cancelledStatusId, statusChangedAt: { $gt: 0, $lt: cutoffSeconds } },
        {
          orderStatusId: { $nin: [scope.intakeStatusId, scope.sentStatusId, scope.cancelledStatusId] },
          updatedAt: { $lt: cutoffDate },
        },
      ],
    });
    result.cacheDeleted = Number(cacheResult?.deletedCount || 0);
  }, { ttlMs: 60_000, waitMs: 5_000 });

  const [snapshotResult, printAgentResult, picking] = await Promise.all([
    BaseLinkerOrderSnapshot.deleteMany({ observedAt: { $lt: cutoffDate } }),
    BaseLinkerPrintAgent.deleteMany({ lastSeenAt: { $lt: cutoffDate } }),
    purgeVerifiedTerminalPicking(scope, cutoffDate, cutoffSeconds),
  ]);

  result.snapshotsDeleted = Number(snapshotResult?.deletedCount || 0);
  result.printAgentsDeleted = Number(printAgentResult?.deletedCount || 0);
  result.pickingDeleted = picking.deleted;
  result.pickingChecked = picking.checked;
  result.pickingPending = picking.pending;
  result.pickingVerifyFailed = picking.verifyFailed;
  return result;
}

module.exports = {
  purgeExpiredBaseLinkerData,
  terminalPickingCandidateFilter,
  BASELINKER_HISTORY_RETENTION_DAYS,
  BASELINKER_HISTORY_RETENTION_MS,
  PICKING_PURGE_VERIFY_LIMIT,
};

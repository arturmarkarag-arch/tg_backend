'use strict';

const BaseLinkerAccount = require('../models/BaseLinkerAccount');
const BaseLinkerOrderIndex = require('../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintJob = require('../models/BaseLinkerPrintJob');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');

const LIFECYCLE_TRACKED_FRESH_MS = Math.min(15 * 60_000, Math.max(60_000, Number(process.env.BASELINKER_LIFECYCLE_TRACKED_FRESH_MS) || 5 * 60_000));
const LIFECYCLE_TRACKED_VERIFY_MAX = Math.min(60, Math.max(4, Number(process.env.BASELINKER_LIFECYCLE_TRACKED_VERIFY_MAX) || 40));

function lifecycleLockKey(accountId) {
  return `baselinker-account:${String(accountId || '').trim()}:lifecycle`;
}

function withBaseLinkerAccountLifecycleLock(accountId, fn, opts = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  return withLock(lifecycleLockKey(id), fn, { ttlMs: 45_000, waitMs: 12_000, ...opts });
}

function unfinishedPickingConditions() {
  return [
    { upstreamReviewRequired: true },
    { ownerTelegramId: { $nin: ['', null] } },
    {
      status: { $ne: 'sent' },
      workflowStage: { $ne: 'sent' },
      upstreamDisposition: { $ne: 'cancelled' },
    },
  ];
}

function unfinishedPickingFilter(accountId) {
  return {
    baseLinkerAccountId: String(accountId || '').trim(),
    $or: unfinishedPickingConditions(),
  };
}

function emptyLifecycleBlockers() {
  return {
    intakeOrders: 0,
    unfinishedPicking: 0,
    activePrintJobs: 0,
    total: 0,
    canDisable: true,
    canChangeQueueStatuses: true,
  };
}

function lifecycleBlockersFromCounts({ intakeOrders = 0, unfinishedPicking = 0, activePrintJobs = 0 } = {}) {
  const normalized = {
    intakeOrders: Math.max(0, Number(intakeOrders) || 0),
    unfinishedPicking: Math.max(0, Number(unfinishedPicking) || 0),
    activePrintJobs: Math.max(0, Number(activePrintJobs) || 0),
  };
  const total = normalized.intakeOrders + normalized.unfinishedPicking + normalized.activePrintJobs;
  return {
    ...normalized,
    total,
    canDisable: total === 0,
    canChangeQueueStatuses: total === 0,
  };
}

function lifecycleCountMap(rows = []) {
  const out = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?._id || '').trim();
    if (!id) continue;
    out.set(id, Math.max(0, Number(row?.count ?? row?.n) || 0));
  }
  return out;
}

async function getBaseLinkerAccountLifecycleBlockersBatch(accountIds = []) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];

  const result = new Map(ids.map((id) => [id, emptyLifecycleBlockers()]));
  if (!ids.length) return result;

  const [intakeRows, pickingRows, printRows] = await Promise.all([
    BaseLinkerOrderIndex.aggregate([
      { $match: { baseLinkerAccountId: { $in: ids } } },
      { $group: { _id: '$baseLinkerAccountId', count: { $sum: 1 } } },
    ]),
    BaseLinkerPickingOrder.aggregate([
      {
        $match: {
          baseLinkerAccountId: { $in: ids },
          $or: unfinishedPickingConditions(),
        },
      },
      { $group: { _id: '$baseLinkerAccountId', count: { $sum: 1 } } },
    ]),
    BaseLinkerPrintJob.aggregate([
      {
        $match: {
          baseLinkerAccountId: { $in: ids },
          status: { $in: ['pending', 'claimed', 'printing'] },
        },
      },
      { $group: { _id: '$baseLinkerAccountId', count: { $sum: 1 } } },
    ]),
  ]);

  const intake = lifecycleCountMap(intakeRows);
  const picking = lifecycleCountMap(pickingRows);
  const printing = lifecycleCountMap(printRows);
  for (const id of ids) {
    result.set(id, lifecycleBlockersFromCounts({
      intakeOrders: intake.get(id) || 0,
      unfinishedPicking: picking.get(id) || 0,
      activePrintJobs: printing.get(id) || 0,
    }));
  }
  return result;
}

async function getBaseLinkerAccountLifecycleBlockers(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  const [intakeOrders, unfinishedPicking, activePrintJobs] = await Promise.all([
    BaseLinkerOrderIndex.countDocuments({ baseLinkerAccountId: id }),
    BaseLinkerPickingOrder.countDocuments(unfinishedPickingFilter(id)),
    BaseLinkerPrintJob.countDocuments({
      baseLinkerAccountId: id,
      status: { $in: ['pending', 'claimed', 'printing'] },
    }),
  ]);
  return lifecycleBlockersFromCounts({ intakeOrders, unfinishedPicking, activePrintJobs });
}

async function assertBaseLinkerAccountLifecycleIdle(accountId, operation = 'disable') {
  const blockers = await getBaseLinkerAccountLifecycleBlockers(accountId);
  if (blockers.total > 0) {
    throw appError(
      operation === 'queue' ? 'baselinker_queue_change_has_active_work' : 'baselinker_account_disable_has_active_work',
      blockers,
    );
  }
  return blockers;
}

async function refreshBaseLinkerLifecycleTruth(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  const { syncBaseLinkerOrderIndex, reconcileTrackedOrderStatuses, TRACKED_REVERIFY_LIMIT } = require('./baseLinkerOrderIndex');
  const { getQueueScope } = require('./baseLinkerQueueScope');

  // Lifecycle decisions may reuse exact verifications completed only a few
  // minutes ago. This lets repeated safe attempts make forward progress instead
  // of rechecking the same oldest rows forever, while still refusing to decide
  // from stale tracked state.
  const verifiedAfter = new Date(Date.now() - LIFECYCLE_TRACKED_FRESH_MS);
  const result = await syncBaseLinkerOrderIndex({
    accountId: id,
    force: true,
    maxAgeMs: 0,
    trackedVerifiedAfter: verifiedAfter,
  });

  const departurePending = Number(result?.departureVerificationPending || 0);
  let trackedPending = Number(result?.trackedReverifyPending || 0);
  let trackedChecked = Number(result?.trackedReverified || 0);

  if (trackedPending > 0 && trackedChecked < LIFECYCLE_TRACKED_VERIFY_MAX) {
    const scope = await getQueueScope(id);
    while (trackedPending > 0 && trackedChecked < LIFECYCLE_TRACKED_VERIFY_MAX) {
      const remaining = LIFECYCLE_TRACKED_VERIFY_MAX - trackedChecked;
      const batch = await reconcileTrackedOrderStatuses(scope, {
        limit: Math.min(TRACKED_REVERIFY_LIMIT, remaining),
        verifiedAfter,
      });
      const checked = Number(batch?.checked || 0);
      trackedChecked += checked;
      trackedPending = Number(batch?.pending || 0);
      if (checked <= 0) break;
    }
  }

  if (departurePending > 0 || trackedPending > 0) {
    throw appError('baselinker_lifecycle_reconciliation_incomplete', {
      departureVerificationPending: departurePending,
      trackedReverifyPending: trackedPending,
      trackedReverified: trackedChecked,
      trackedReverifyLimit: LIFECYCLE_TRACKED_VERIFY_MAX,
    });
  }
  return { ...result, trackedReverified: trackedChecked, trackedReverifyPending: trackedPending };
}

async function disableBaseLinkerAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  return withBaseLinkerAccountLifecycleLock(id, async () => {
    const account = await BaseLinkerAccount.findOne({ accountId: id });
    if (!account) throw appError('baselinker_account_not_found');
    if (account.enabled !== true) return account;
    // A disable decision must be based on fresh Intake membership plus complete
    // exact reconciliation of tracked orders. If the token is broken or the
    // bounded pass cannot finish, this fails closed and the admin retries later
    // or rotates the token.
    await refreshBaseLinkerLifecycleTruth(id);
    await assertBaseLinkerAccountLifecycleIdle(id, 'disable');
    account.enabled = false;
    await account.save();
    return account;
  });
}

module.exports = {
  lifecycleLockKey,
  withBaseLinkerAccountLifecycleLock,
  unfinishedPickingFilter,
  getBaseLinkerAccountLifecycleBlockers,
  getBaseLinkerAccountLifecycleBlockersBatch,
  lifecycleBlockersFromCounts,
  assertBaseLinkerAccountLifecycleIdle,
  refreshBaseLinkerLifecycleTruth,
  disableBaseLinkerAccount,
  LIFECYCLE_TRACKED_FRESH_MS,
  LIFECYCLE_TRACKED_VERIFY_MAX,
};

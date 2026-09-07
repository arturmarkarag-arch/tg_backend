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

function unfinishedPickingFilter(accountId) {
  return {
    baseLinkerAccountId: String(accountId || '').trim(),
    $or: [
      { upstreamReviewRequired: true },
      { ownerTelegramId: { $nin: ['', null] } },
      {
        status: { $ne: 'sent' },
        workflowStage: { $ne: 'sent' },
        upstreamDisposition: { $ne: 'cancelled' },
      },
    ],
  };
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
  const total = intakeOrders + unfinishedPicking + activePrintJobs;
  return {
    intakeOrders,
    unfinishedPicking,
    activePrintJobs,
    total,
    canDisable: total === 0,
    canChangeQueueStatuses: total === 0,
  };
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
  assertBaseLinkerAccountLifecycleIdle,
  refreshBaseLinkerLifecycleTruth,
  disableBaseLinkerAccount,
  LIFECYCLE_TRACKED_FRESH_MS,
  LIFECYCLE_TRACKED_VERIFY_MAX,
};

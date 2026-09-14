'use strict';

const FiscalSubmission = require('../../../models/FiscalSubmission');
const { runAsSchedulerLeader } = require('../../schedulerLeader');
const { reconcileSubmissionById, errorSnapshot } = require('./submissions');
const { retryAfterMs, retryDelayMs: policyRetryDelayMs } = require('./reconciliationPolicy');

const TICK_MS = Math.min(60_000, Math.max(30_000, Number(process.env.KSEF_RECONCILE_TICK_MS) || 30_000));
const LEASE_MS = Math.min(10 * 60_000, Math.max(30_000, Number(process.env.KSEF_RECONCILE_LEASE_MS) || 90_000));
const BATCH_SIZE = Math.min(5, Math.max(1, Number(process.env.KSEF_RECONCILE_BATCH_SIZE) || 5));
const MAX_BACKOFF_MS = 5 * 60_000;

let timer = null;

function retryDelayMs(attempt, error) {
  return policyRetryDelayMs(attempt, error, { tickMs: TICK_MS, maxBackoffMs: MAX_BACKOFF_MS });
}

function dueQuery(now) {
  return {
    provider: 'ksef',
    $and: [
      {
        $or: [
          { state: { $in: ['submitted', 'processing'] } },
          { state: 'accepted', 'receipt.receivedAt': { $exists: false } },
          { state: 'accepted', receipt: null },
          { state: 'error', 'providerData.sessionReferenceNumber': { $exists: true, $nin: ['', null] } },
        ],
      },
      {
        $or: [
          { 'reconciliation.state': { $exists: false } },
          { 'reconciliation.state': { $in: ['idle', 'pending', 'retry_wait'] } },
          { 'reconciliation.state': 'running', 'reconciliation.leaseUntil': { $lte: now } },
        ],
      },
      {
        $or: [
          { 'reconciliation.nextAttemptAt': { $exists: false } },
          { 'reconciliation.nextAttemptAt': null },
          { 'reconciliation.nextAttemptAt': { $lte: now } },
        ],
      },
      {
        $or: [
          { 'reconciliation.leaseUntil': { $exists: false } },
          { 'reconciliation.leaseUntil': null },
          { 'reconciliation.leaseUntil': { $lte: now } },
        ],
      },
    ],
  };
}

async function claimOne(now = new Date()) {
  return FiscalSubmission.findOneAndUpdate(
    dueQuery(now),
    {
      $set: {
        'reconciliation.state': 'running',
        'reconciliation.lastAttemptAt': now,
        'reconciliation.leaseUntil': new Date(now.getTime() + LEASE_MS),
        'reconciliation.lastError': null,
      },
      $inc: { 'reconciliation.attempts': 1 },
    },
    { sort: { 'reconciliation.nextAttemptAt': 1, updatedAt: 1, _id: 1 }, new: true },
  );
}

async function failClaim(row, error) {
  const attempt = Number(row?.reconciliation?.attempts || 1);
  const delay = retryDelayMs(attempt, error);
  const now = new Date();
  await FiscalSubmission.updateOne(
    { _id: row._id, 'reconciliation.state': 'running' },
    {
      $set: {
        'reconciliation.state': 'retry_wait',
        'reconciliation.nextAttemptAt': new Date(now.getTime() + delay),
        'reconciliation.leaseUntil': null,
        'reconciliation.lastError': errorSnapshot(error),
      },
    },
  );
  return { submissionId: String(row._id), ok: false, error: error?.code || 'ksef_reconcile_failed', retryAfterMs: delay };
}

async function processClaim(row) {
  try {
    const reconciled = await reconcileSubmissionById(row._id);
    // Defensive fallback: a successful reconciliation path must release its lease.
    if (reconciled?.reconciliation?.state === 'running') {
      const now = new Date();
      await FiscalSubmission.updateOne(
        { _id: row._id, 'reconciliation.state': 'running' },
        {
          $set: {
            'reconciliation.state': 'pending',
            'reconciliation.nextAttemptAt': new Date(now.getTime() + TICK_MS),
            'reconciliation.leaseUntil': null,
            'reconciliation.lastSuccessAt': now,
          },
        },
      );
    }
    return {
      submissionId: String(row._id),
      ok: true,
      state: reconciled?.state || '',
      reconciliationState: reconciled?.reconciliation?.state || '',
      hasUpo: Boolean(reconciled?.receipt?.receivedAt),
    };
  } catch (error) {
    return failClaim(row, error);
  }
}

async function runKsefReconciliationTick() {
  return runAsSchedulerLeader('ksef-submission-reconcile', async () => {
    const results = [];
    for (let i = 0; i < BATCH_SIZE; i += 1) {
      const row = await claimOne(new Date());
      if (!row) break;
      // Sequential inside the tiny bounded batch keeps us comfortably below KSeF GET limits.
      // Other app instances are excluded by scheduler leadership + per-row lease.
      results.push(await processClaim(row));
    }
    return {
      processed: results.length,
      succeeded: results.filter((row) => row.ok).length,
      failed: results.filter((row) => !row.ok).length,
      results,
    };
  }, { ttlMs: Math.max(LEASE_MS, TICK_MS * 3) });
}

function startKsefReconciliationScheduler() {
  if (timer) return timer;
  if (String(process.env.KSEF_RECONCILIATION_ENABLED || 'true').toLowerCase() === 'false') return null;
  const tick = async () => {
    try { await runKsefReconciliationTick(); }
    catch (error) { console.error('[ksef-reconciliation-scheduler]', error?.stack || error); }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return timer;
}

function isKsefReconciliationSchedulerStarted() { return Boolean(timer); }

module.exports = {
  TICK_MS,
  LEASE_MS,
  BATCH_SIZE,
  retryAfterMs,
  retryDelayMs,
  dueQuery,
  claimOne,
  runKsefReconciliationTick,
  startKsefReconciliationScheduler,
  isKsefReconciliationSchedulerStarted,
};

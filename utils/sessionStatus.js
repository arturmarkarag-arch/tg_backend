'use strict';

/**
 * Picking lifecycle state machine for OrderingSession.
 *
 * Two orthogonal axes live on the session document:
 *   - pickingStatus — the single CURRENT state (pending → confirmed → in_progress → completed)
 *   - events[]      — the timeline of things that HAPPENED (verbs: order_added, rescheduled, …)
 *
 * Centralised here so transitions are not duplicated across routes/services and
 * stay concurrency-safe: every transition is a single guarded findOneAndUpdate
 * whose filter pins the allowed source status, so two racing callers cannot push
 * a duplicate lifecycle event.
 */

const OrderingSession   = require('../models/OrderingSession');
const PickingTask       = require('../models/PickingTask');
const SupplementOffer   = require('../models/SupplementOffer');
const { ACTIVE_ITEM_STATUSES, ITEM_RELATION_STATUS } = require('./supplementState');
const { LIFECYCLE_EVENT } = require('./sessionVocab');
const { withSessionLifecycleLock } = require('./sessionLifecycleLock');

const MAX_EVENTS = 200; // keep the timeline bounded (order_added can fire often)

function withSession(opts, mongoSession) {
  return mongoSession ? { ...opts, session: mongoSession } : opts;
}

function actorFields(actor = {}) {
  return {
    by:     String(actor.by || ''),
    byName: String(actor.byName || ''),
  };
}

/**
 * Append an event to a session's timeline (bounded to the last MAX_EVENTS).
 */
async function pushSessionEvent(sessionId, { type, by = '', byName = '', meta = {} } = {}, mongoSession = null) {
  if (!sessionId || !type) return null;
  return OrderingSession.findByIdAndUpdate(
    sessionId,
    {
      $push: {
        events: {
          $each: [{ at: new Date(), type, by: String(by), byName: String(byName), meta }],
          $slice: -MAX_EVENTS,
        },
      },
    },
    withSession({ new: true }, mongoSession),
  );
}

/**
 * Move a session's pickingStatus forward (or, with allowReopen, back from
 * completed when late orders revive it), or back to pending (cancel-start).
 * Idempotent + concurrency-safe: the findOneAndUpdate filter pins the allowed
 * source status, so a no-op transition matches nothing and emits no duplicate event.
 * Returns the updated doc, or null when the transition did not apply.
 *
 * @param {string} sessionId
 * @param {'pending'|'confirmed'|'in_progress'|'completed'} toStatus
 * @param {{ actor?: object, meta?: object, allowReopen?: boolean }} [opts]
 * @param {object} [mongoSession]
 */
async function transitionPickingStatus(sessionId, toStatus, { actor = {}, meta = {}, allowReopen = false } = {}, mongoSession = null) {
  if (!sessionId) return null;

  const now = new Date();
  const { by, byName } = actorFields(actor);
  const eventType = LIFECYCLE_EVENT[toStatus];
  if (!eventType) throw new Error(`transitionPickingStatus: invalid target '${toStatus}'`);

  let fromStatuses;
  const set = { pickingStatus: toStatus };
  const unset = {};

  if (toStatus === 'pending') {
    // cancel-start: only allowed from confirmed (nobody packed yet)
    fromStatuses = ['confirmed'];
    set.pickingConfirmedAt = null;
  } else if (toStatus === 'confirmed') {
    fromStatuses = ['pending'];
    set.pickingConfirmedAt = now;
  } else if (toStatus === 'in_progress') {
    fromStatuses = allowReopen ? ['confirmed', 'completed'] : ['confirmed'];
    set.pickingStartedAt = now;
    if (allowReopen) {
      set.pickingCompletedAt = null; // reviving a finished session
      unset.finalSummary = 1; // old counters are no longer authoritative
    }
  } else { // completed
    fromStatuses = ['confirmed', 'in_progress'];
    set.pickingCompletedAt = now;
  }

  const update = {
    $set: set,
    $push: {
      events: {
        $each: [{ at: now, type: eventType, by, byName, meta }],
        $slice: -MAX_EVENTS,
      },
    },
  };
  if (Object.keys(unset).length) update.$unset = unset;

  return OrderingSession.findOneAndUpdate(
    { _id: sessionId, pickingStatus: { $in: fromStatuses } },
    update,
    withSession({ new: true }, mongoSession),
  );
}

/**
 * Mark the session completed iff it has no remaining active (pending|locked)
 * tasks. Called after a task completes. The transition filter ensures this only
 * fires from confirmed/in_progress, so an empty/never-built session is left for
 * start-session to finalise.
 */
async function maybeCompleteSessionUnlocked(orderingSessionId, { actor = {}, meta = {}, skipCoverageAudit = false } = {}, mongoSession = null) {
  if (!orderingSessionId) return null;

  // Contract stays EXACTLY as before: success => OrderingSession, blocked => null.
  // Callers use truthiness; returning {completed:false} here would be dangerous.
  const q = PickingTask.countDocuments({
    orderingSessionId: String(orderingSessionId),
    status: { $in: ['pending', 'locked'] },
  });
  if (mongoSession) q.session(mongoSession);
  const remaining = await q;
  if (remaining > 0) return null;

  // V48.S3: item revisions are the operational lifecycle. A reusable Wave
  // container may be summary-terminal and later receive another item, so session
  // closure must inspect exact-session current item work, not container status.
  const supplementQuery = SupplementOffer.countDocuments({
    orderingSessionId: String(orderingSessionId),
    waveId: { $ne: null },
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    status: { $in: ACTIVE_ITEM_STATUSES },
  });
  if (mongoSession) supplementQuery.session(mongoSession);
  if (await supplementQuery) return null;

  // Transactional callers cannot run a read-only audit outside their uncommitted
  // snapshot. Existing live completion paths call this again after commit.
  if (!skipCoverageAudit && !mongoSession) {
    const sessionDoc = await OrderingSession.findById(orderingSessionId, 'groupId').lean();
    if (!sessionDoc?.groupId) return null;
    const { auditSessionClosure } = require('../services/sessionClosure');
    const closure = await auditSessionClosure({
      deliveryGroupId: sessionDoc.groupId,
      orderingSessionId,
    });
    if (!closure.ok) return null;
  }

  // V48.S3: current supplement item revisions are part of this exact delivery-cycle lifecycle.
  const completed = await transitionPickingStatus(orderingSessionId, 'completed', { actor, meta }, mongoSession);
  if (!completed) return null;

  // Completion is the moment historical counters become immutable. The task
  // documents themselves have bounded retention, so without this snapshot an
  // old completed session would eventually degrade to a misleading 0/0 card.
  // No current caller finalises inside an external transaction; keep the guard
  // explicit so a future transactional caller cannot accidentally read outside
  // its snapshot. If the snapshot write fails, completion remains valid and the
  // presentation layer lazily backfills it while task history still exists.
  if (!mongoSession) {
    try {
      const { loadSessionSummaryStats } = require('../services/sessionPresentation');
      const summary = await loadSessionSummaryStats(String(orderingSessionId));
      const finalizedAt = completed.pickingCompletedAt || new Date();
      await OrderingSession.updateOne(
        { _id: orderingSessionId, pickingStatus: 'completed' },
        { $set: { finalSummary: { ...summary, finalizedAt } } },
      );
      completed.finalSummary = { ...summary, finalizedAt };
    } catch (err) {
    }
  }

  return completed;
}

async function maybeCompleteSession(orderingSessionId, opts = {}, mongoSession = null) {
  // Transaction-owned callers already serialize through Mongo and cannot safely
  // acquire an external lock around an uncommitted snapshot. Normal live callers
  // share this lifecycle lock with SupplementWave publication.
  if (mongoSession) return maybeCompleteSessionUnlocked(orderingSessionId, opts, mongoSession);
  return withSessionLifecycleLock(
    orderingSessionId,
    () => maybeCompleteSessionUnlocked(orderingSessionId, opts, null),
  );
}

module.exports = { pushSessionEvent, transitionPickingStatus, maybeCompleteSession, MAX_EVENTS };

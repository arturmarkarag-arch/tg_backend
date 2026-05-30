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

const OrderingSession = require('../models/OrderingSession');
const PickingTask     = require('../models/PickingTask');
const { LIFECYCLE_EVENT } = require('./sessionVocab');

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
    if (allowReopen) set.pickingCompletedAt = null; // reviving a finished session
  } else { // completed
    fromStatuses = ['confirmed', 'in_progress'];
    set.pickingCompletedAt = now;
  }

  return OrderingSession.findOneAndUpdate(
    { _id: sessionId, pickingStatus: { $in: fromStatuses } },
    {
      $set: set,
      $push: {
        events: {
          $each: [{ at: now, type: eventType, by, byName, meta }],
          $slice: -MAX_EVENTS,
        },
      },
    },
    withSession({ new: true }, mongoSession),
  );
}

/**
 * Mark the session completed iff it has no remaining active (pending|locked)
 * tasks. Called after a task completes. The transition filter ensures this only
 * fires from confirmed/in_progress, so an empty/never-built session is left for
 * start-session to finalise.
 */
async function maybeCompleteSession(orderingSessionId, { actor = {}, meta = {} } = {}, mongoSession = null) {
  if (!orderingSessionId) return null;
  const query = PickingTask.countDocuments({
    orderingSessionId: String(orderingSessionId),
    status: { $in: ['pending', 'locked'] },
  });
  if (mongoSession) query.session(mongoSession);
  const remaining = await query;
  if (remaining > 0) return null;
  return transitionPickingStatus(orderingSessionId, 'completed', { actor, meta }, mongoSession);
}

module.exports = { pushSessionEvent, transitionPickingStatus, maybeCompleteSession, MAX_EVENTS };

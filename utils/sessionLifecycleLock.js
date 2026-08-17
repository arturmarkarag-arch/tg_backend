'use strict';

const { withLock } = require('./lock');

/**
 * Cross-domain serialization for lifecycle membership changes of one delivery
 * cycle. Supplement publication and session completion use the same key so a
 * Wave cannot appear concurrently with the transition to completed.
 */
function withSessionLifecycleLock(orderingSessionId, work, opts = {}) {
  const id = String(orderingSessionId || '');
  if (!id) return work();
  return withLock(`session:lifecycle:${id}`, work, {
    ttlMs: opts.ttlMs || 30_000,
    waitMs: opts.waitMs || 10_000,
  });
}

module.exports = { withSessionLifecycleLock };

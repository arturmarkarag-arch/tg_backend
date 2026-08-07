'use strict';

/**
 * Canonical predicate for an unconsumed out-of-stock recovery signal.
 *
 * `packed` is fulfilment state, not the reason a task completed. A normal packed
 * task can contain packed:false (actualQty=0), while a real OOS can contain only
 * packed:true rows if shortage was discovered after all listed boxes were served.
 *
 * Optional orderingSessionId is critical for live recovery: a crash-recovery poll
 * for THIS week's picking must never resurrect an OOS intent from an old session.
 */
function buildUnreconciledOosTaskFilter(extra = {}) {
  return {
    ...extra,
    status: 'completed',
    completionReason: 'out_of_stock',
    archiveReconciled: { $ne: true },
  };
}

module.exports = { buildUnreconciledOosTaskFilter };

'use strict';

/**
 * A historical session with the same {groupId, openDate} is harmless while the
 * requested ordering window is closed: it remains read-only until the next
 * weekly start creates a fresh openDate. It is a conflict only when saving the
 * schedule would make that different, already-used session open right now.
 */
function shouldBlockUsedTargetSession({
  currentSessionId,
  requestedSessionId,
  targetUsed,
  requestedWindowIsOpen,
}) {
  return Boolean(
    requestedSessionId
    && currentSessionId
    && String(requestedSessionId) !== String(currentSessionId)
    && targetUsed
    && requestedWindowIsOpen
  );
}

module.exports = { shouldBlockUsedTargetSession };

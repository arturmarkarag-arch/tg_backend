'use strict';

const { shouldBlockUsedTargetSession } = require('../utils/deliveryGroupScheduleChange');

describe('delivery-group schedule target-session safety', () => {
  const base = {
    currentSessionId: 'current-session',
    requestedSessionId: 'historical-target',
    targetUsed: true,
  };

  it('allows a closed schedule to wait for its next weekly start', () => {
    expect(shouldBlockUsedTargetSession({
      ...base,
      requestedWindowIsOpen: false,
    })).toBe(false);
  });

  it('blocks reopening a different used session right now', () => {
    expect(shouldBlockUsedTargetSession({
      ...base,
      requestedWindowIsOpen: true,
    })).toBe(true);
  });

  it('does not treat an unused target shell as a conflict', () => {
    expect(shouldBlockUsedTargetSession({
      ...base,
      targetUsed: false,
      requestedWindowIsOpen: true,
    })).toBe(false);
  });

  it('leaves same-session edits to the existing live-work guards', () => {
    expect(shouldBlockUsedTargetSession({
      ...base,
      requestedSessionId: 'current-session',
      requestedWindowIsOpen: true,
    })).toBe(false);
  });
});

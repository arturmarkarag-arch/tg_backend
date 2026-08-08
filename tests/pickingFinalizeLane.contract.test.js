'use strict';

const fs = require('fs');
const path = require('path');
const picking = require('../services/pickingService');

describe('picking finalize contention lane contract', () => {
  it('exports the per-session finalize lock wrapper', () => {
    expect(typeof picking.withPickingFinalizeLock).toBe('function');
  });

  it('keeps normal completion and OOS archive inside the finalize lane', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/pickingService.js'), 'utf8');
    expect(source).toContain('withPickingFinalizeLock(pre.orderingSessionId');
    expect(source).toContain('withPickingFinalizeLock(task.orderingSessionId');
    expect(source).toContain('picking:finalize:${sessionId}');
  });
});

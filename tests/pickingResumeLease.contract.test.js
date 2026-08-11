const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('picking resume lease contract', () => {
  it('uses one 5-minute boundary for stale cleanup and force claim', () => {
    const src = read('services/pickingService.js');
    expect(src).toContain('const LOCK_TIMEOUT_MS      = 5 * 60 * 1000');
    expect(src).toContain('const FORCE_CLAIM_AFTER_MS = LOCK_TIMEOUT_MS');
  });

  it('heartbeat cannot resurrect an expired lease and reports reconciliation states', () => {
    const src = read('routes/picking.js');
    expect(src).toContain("lockedAt: { $gte: freshAfter }");
    expect(src).toContain("state: 'mine'");
    expect(src).toContain("state: 'available'");
    expect(src).toContain("state: 'other_worker'");
    expect(src).toContain("state: 'completed'");
    expect(src).toContain("state: 'session_changed'");
  });
});

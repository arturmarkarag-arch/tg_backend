'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const targets = read('services/supplementTargets.js');
const executableTargets = targets
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('V48.S3 supplement target contract', () => {
  it('pins a supplement target to the current OrderingSession', () => {
    expect(targets).toContain('findCurrentSessionId');
    expect(targets).toContain('expectedOrderingSessionId');
    expect(targets).toContain('orderingSessionId: str(session._id)');
    expect(targets).toContain('supplement_target_session_changed');
  });

  it('does not invent time-of-day / recent-close heuristics', () => {
    expect(executableTargets).not.toMatch(/humanDuration/);
    expect(executableTargets).not.toMatch(/getPreviousOrderingCloseAt/);
    expect(executableTargets).not.toMatch(/closed.{0,30}(minutes|min|хв)/i);
    expect(executableTargets).not.toMatch(/morning|ранок/i);
  });

  it('rejects a delivery cycle that has not started yet', () => {
    expect(targets).toContain('supplement_target_session_not_started');
    expect(targets).toContain('new Date(session.openAt).getTime() > now.getTime()');
  });

  it('keeps completed delivery cycles closed unless exact current supplement state proves cancellation', () => {
    expect(targets).toContain('hasReopenableSupplementCancellation');
    expect(targets).toContain('status: ITEM_STATUS.CANCELLED');
    expect(targets).toContain("session.pickingStatus === 'completed' && !reopenableSupplement");
    expect(targets).toContain('supplement_target_session_completed');
    expect(targets).toContain("reopenableSupplement ? 'supplement_reopenable' : 'completed'");
    expect(targets).toContain('blockedItemIds');
    expect(targets).toContain('publications.filter(blocksGenericRepublish)');
  });

  it('allows current delivery states before and during warehouse picking', () => {
    expect(targets).toContain("isOrderingOpen(group.orderingSchedule, now).isOpen ? 'ordering_open' : 'awaiting_picking'");
    expect(targets).toContain("return 'picking'");
  });

  it('target discovery is read-only with respect to session identity', () => {
    expect(targets).not.toContain('getOrCreateSessionId');
    expect(targets).not.toContain('OrderingSession.create');
    expect(targets).not.toMatch(/findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany/);
  });
});

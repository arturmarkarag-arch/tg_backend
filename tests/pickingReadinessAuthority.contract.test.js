'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function routeBlock(source, token, nextToken) {
  const start = source.indexOf(token);
  const end = source.indexOf(nextToken, start);
  return source.slice(start, end > start ? end : source.length);
}

describe('V48.14 ordering/picking time authority contract', () => {
  it('ordering-status is a pure session read and cannot materialise a cycle', () => {
    const groups = read('routes/deliveryGroups.js');
    const block = routeBlock(groups, "router.get('/ordering-status'", "router.post('/catalog-reviewed'");
    expect(block).toContain('findCurrentSessionId(String(group._id), group.orderingSchedule)');
    expect(block).not.toContain('getOrCreateSessionId(');
  });

  it('authenticated app profile resolution also reads an existing session instead of creating one', () => {
    const telegram = read('routes/v1/telegram.js');
    const start = telegram.indexOf('async function resolveOrderingSessionContext');
    const end = telegram.indexOf('\n// shopId', start);
    const block = telegram.slice(start, end);
    expect(block).toContain('findCurrentSessionId(');
    expect(block).not.toContain('getOrCreateSessionId(');
  });

  it('start-session enforces pickingReadyAt before every operational mutation', () => {
    const picking = read('routes/picking.js');
    const block = routeBlock(picking, "router.post('/start-session'", "router.post('/cancel-start'");
    const readyCalc = block.indexOf('getPickingReadiness(group.orderingSchedule, commandNow)');
    const readyGate = block.indexOf('if (!readiness.pickingReady)');
    const mutationCandidates = [
      'await releaseWorkerAndStaleLocks',
      'await getOrCreateSessionId',
      'await archiveOrphanedOutOfStockProducts',
      'await reconcileActiveTasksForSession',
      'await reconcileLateOrdersForSession',
    ].map((token) => block.indexOf(token)).filter((index) => index >= 0);
    const firstMutation = Math.min(...mutationCandidates);
    expect(readyCalc).toBeGreaterThan(-1);
    expect(readyGate).toBeGreaterThan(readyCalc);
    expect(firstMutation).toBeGreaterThan(readyGate);
    expect(block).toContain('pickingNotReady: true');
    expect(block).toContain('pickingReadyAt: readiness.pickingReadyAt.toISOString()');
  });

  it('read-only snapshot and queue stats expose the same server readiness timestamp', () => {
    const picking = read('routes/picking.js');
    const snapshotStart = picking.indexOf('async function buildReadOnlyPickingSessionSnapshot');
    const snapshotEnd = picking.indexOf('\nasync function buildTaskResponse', snapshotStart);
    const snapshot = picking.slice(snapshotStart, snapshotEnd);
    expect(snapshot).toContain('getPickingReadiness(group.orderingSchedule, now)');
    expect(snapshot).toContain('pickingReadyAt: readiness.pickingReadyAt.toISOString()');
    const queue = routeBlock(picking, "router.get('/queue-stats'", "router.post('/tasks/:taskId/complete'");
    expect(queue).toContain('getPickingReadiness(groupDoc.orderingSchedule, statusNow)');
    expect(queue).toContain('pickingReadyAt');
    expect(queue).toContain('serverNow');
  });

  it('ordering scheduler runs immediately and then aligns to real minute boundaries', () => {
    const scheduler = read('services/orderingOpenScheduler.js');
    expect(scheduler).toContain('tick();');
    expect(scheduler).toContain('msUntilNextMinuteBoundary()');
    expect(scheduler).toContain('setTimeout(async () =>');
    expect(scheduler).not.toContain('setInterval(tick, TICK_MS)');
  });
});

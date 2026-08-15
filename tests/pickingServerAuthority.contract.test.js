'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function routeSlices(source, method) {
  const re = new RegExp(`router\\.${method}\\('([^']+)'`, 'g');
  const hits = [];
  let match;
  while ((match = re.exec(source))) hits.push({ path: match[1], start: match.index });
  const allRoutes = [...source.matchAll(/router\.(?:get|post|patch|delete)\('/g)].map((m) => m.index).sort((a, b) => a - b);
  return hits.map((hit) => {
    const next = allRoutes.find((idx) => idx > hit.start) ?? source.length;
    return { path: hit.path, body: source.slice(hit.start, next) };
  });
}

describe('V48.13 picking server authority contract', () => {
  it('group switching has a dedicated read-only session snapshot route', () => {
    const picking = read('routes/picking.js');
    expect(picking).toContain("router.get('/session-snapshot'");
    expect(picking).toContain('buildReadOnlyPickingSessionSnapshot');

    const start = picking.indexOf('async function buildReadOnlyPickingSessionSnapshot');
    const end = picking.indexOf('\nasync function buildTaskResponse', start);
    const snapshot = picking.slice(start, end);
    for (const forbidden of [
      'getOrCreateSessionId(',
      'releaseWorkerAndStaleLocks(',
      'findAndLockNext(',
      'archiveOrphanedOutOfStockProducts(',
      'reconcileActiveTasksForSession(',
      'reconcileLateOrdersForSession(',
      '.updateOne(',
      '.updateMany(',
      '.findOneAndUpdate(',
      '.findByIdAndUpdate(',
      '.deleteMany(',
      '.save(',
    ]) {
      expect(snapshot, `snapshot contains ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('start-session only materialises operational state after explicit confirm:true', () => {
    const picking = read('routes/picking.js');
    const start = picking.indexOf("router.post('/start-session'");
    const end = picking.indexOf("router.post('/cancel-start'", start);
    const body = picking.slice(start, end);

    const readFallback = body.indexOf('if (!confirm)');
    const firstMutation = Math.min(
      ...[
        body.indexOf('await releaseWorkerAndStaleLocks'),
        body.indexOf('await getOrCreateSessionId'),
        body.indexOf('await archiveOrphanedOutOfStockProducts'),
        body.indexOf('await reconcileActiveTasksForSession'),
      ].filter((n) => n >= 0),
    );
    expect(readFallback).toBeGreaterThan(-1);
    expect(firstMutation).toBeGreaterThan(readFallback);
    expect(body).toContain('return res.json(await buildReadOnlyPickingSessionSnapshot(deliveryGroupId));');
  });

  it('picking GET routes contain no database/lock mutation calls', () => {
    const picking = read('routes/picking.js');
    const forbidden = [
      /await\s+[^;\n]*\.updateOne\s*\(/,
      /await\s+[^;\n]*\.updateMany\s*\(/,
      /await\s+[^;\n]*\.findOneAndUpdate\s*\(/,
      /await\s+[^;\n]*\.findByIdAndUpdate\s*\(/,
      /await\s+[^;\n]*\.deleteMany\s*\(/,
      /await\s+[^;\n]*\.deleteOne\s*\(/,
      /await\s+[^;\n]*\.save\s*\(/,
      /getOrCreateSessionId\s*\(/,
      /releaseWorkerAndStaleLocks\s*\(/,
      /findAndLockNext\s*\(/,
      /archiveOrphanedOutOfStockProducts\s*\(/,
      /reconcileActiveTasksForSession\s*\(/,
      /reconcileLateOrdersForSession\s*\(/,
    ];

    for (const route of routeSlices(picking, 'get').filter((route) => route.path !== '/next-task')) {
      for (const pattern of forbidden) {
        expect(route.body, `GET ${route.path} contains ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('next-task is a POST command with one rolling-deploy GET alias; polling GETs stay pure', () => {
    const picking = read('routes/picking.js');
    expect(picking).toContain("router.post('/next-task'");
    expect(picking).toContain("router.get('/next-task'");
    expect(picking).toContain('deprecated rolling-deploy alias');

    for (const routeName of ['/my-task', '/block-tasks', '/queue-stats']) {
      const route = routeSlices(picking, 'get').find((r) => r.path === routeName);
      expect(route).toBeTruthy();
      expect(route.body).not.toContain('releaseWorkerAndStaleLocks(');
      expect(route.body).not.toMatch(/\.updateMany\s*\(/);
    }
  });

  it('only the explicit start command may create a session inside picking routes', () => {
    const picking = read('routes/picking.js');
    const calls = [...picking.matchAll(/await\s+getOrCreateSessionId\s*\(/g)];
    expect(calls).toHaveLength(1);
    const start = picking.indexOf("router.post('/start-session'");
    const cancel = picking.indexOf("router.post('/cancel-start'", start);
    expect(calls[0].index).toBeGreaterThan(start);
    expect(calls[0].index).toBeLessThan(cancel);
  });

  it('background server maintenance owns stale/duplicate lock cleanup', () => {
    const scheduler = read('services/pickingMaintenanceScheduler.js');
    const service = read('services/pickingService.js');
    const index = read('index.js');

    expect(scheduler).toContain('releaseStalePickingLocks({ now })');
    expect(scheduler).toContain('repairDuplicateWorkerLocks()');
    expect(service).toContain('async function releaseStalePickingLocks');
    expect(service).toContain('async function repairDuplicateWorkerLocks');
    expect(index).toContain('startPickingMaintenanceScheduler();');
  });

  it('presentation helpers are pure reads; legacy summary repair moved off GET', () => {
    const presentation = read('services/sessionPresentation.js');
    expect(presentation).not.toContain('OrderingSession.updateOne(');
    const scheduler = read('services/pickingMaintenanceScheduler.js');
    expect(scheduler).toContain('repairMissingFinalSummaries');
    expect(scheduler).toContain('OrderingSession.updateOne(');
  });

  it('cancel/coverage commands cannot create an empty session as a side effect', () => {
    const picking = read('routes/picking.js');
    for (const [startToken, endToken] of [
      ["router.post('/cancel-start'", "router.post('/resolve-coverage-gap'"],
      ["router.post('/resolve-coverage-gap'", "router.get('/my-task'"],
    ]) {
      const start = picking.indexOf(startToken);
      const end = picking.indexOf(endToken, start);
      const block = picking.slice(start, end);
      expect(block).toContain('findCurrentSessionId(');
      expect(block).not.toContain('getOrCreateSessionId(');
    }
  });

  it('ordering-session materialisation is owned by the server scheduler, independent from Telegram/UI', () => {
    const scheduler = read('services/orderingOpenScheduler.js');
    expect(scheduler).toContain('async function materializeOpenOrderingSessions');
    expect(scheduler).toContain('isOrderingOpen(group.orderingSchedule, now).isOpen');
    expect(scheduler).toContain('getOrCreateSessionId(String(group._id), group.orderingSchedule)');
    const materializeCall = scheduler.indexOf('materializeOpenOrderingSessions({ now })');
    const notifyCall = scheduler.indexOf('notifyOrderingOpen({ now })');
    expect(materializeCall).toBeGreaterThan(-1);
    expect(notifyCall).toBeGreaterThan(materializeCall);
  });

});

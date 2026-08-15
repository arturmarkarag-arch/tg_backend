'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { indexOrThrow } = require('./helpers/sourceContract');

describe('V48.18 server boot / infra authority contract', () => {
  it('real index.js refuses unsafe multi-worker boot without Redis', () => {
    const index = read('index.js');
    expect(index).toContain('const workerCount = Number(process.env.WEB_CONCURRENCY) || 1');
    expect(index).toContain('if (workerCount > 1 && !redisEnabled())');
    expect(index).toContain('Refusing to start: WEB_CONCURRENCY=');
  });

  it('real boot wires Socket.IO and both server-owned schedulers before serving', () => {
    const index = read('index.js');
    const createServer = indexOrThrow(index, 'const server = http.createServer(app)');
    const socket = indexOrThrow(index, 'initSocket(server)', { from: createServer });
    const ordering = indexOrThrow(index, 'startOrderingOpenScheduler()', { from: socket });
    const picking = indexOrThrow(index, 'startPickingMaintenanceScheduler()', { from: ordering });
    const listen = indexOrThrow(index, 'server.listen(PORT', { from: picking });
    expect(socket).toBeGreaterThan(createServer);
    expect(ordering).toBeGreaterThan(socket);
    expect(picking).toBeGreaterThan(ordering);
    expect(listen).toBeGreaterThan(picking);
  });

  it('ordering scheduler owns session materialisation independently of Telegram delivery', () => {
    const scheduler = read('services/orderingOpenScheduler.js');
    const materialize = indexOrThrow(scheduler, 'materializeOpenOrderingSessions({ now })');
    const notify = indexOrThrow(scheduler, 'notifyOrderingOpen({ now })', { from: materialize });
    expect(notify).toBeGreaterThan(materialize);
    expect(scheduler).toContain('tick();');
    expect(scheduler).toContain('msUntilNextMinuteBoundary()');
  });

  it('picking maintenance scheduler starts immediately and then repeats server-side', () => {
    const scheduler = read('services/pickingMaintenanceScheduler.js');
    expect(scheduler).toContain('releaseStalePickingLocks({ now })');
    expect(scheduler).toContain('repairDuplicateWorkerLocks()');
    expect(scheduler).toContain('repairMissingFinalSummaries()');
    const immediate = indexOrThrow(scheduler, 'tick();');
    const interval = indexOrThrow(scheduler, 'setInterval(tick, TICK_MS)', { from: immediate });
    expect(interval).toBeGreaterThan(immediate);
  });

  it('Socket.IO switches to Redis adapter when Redis is available', () => {
    const socket = read('socket.js');
    expect(socket).toContain("require('@socket.io/redis-adapter')");
    expect(socket).toContain('if (redisEnabled() && pubClient && subClient)');
    expect(socket).toContain('io.adapter(createAdapter(pubClient, subClient))');
  });

  it('live boot smoke starts the actual index.js and proves scheduler/socket/index effects', () => {
    const boot = read('scripts/liveServerBootV48_18.js');
    expect(boot).toContain("spawn(process.execPath, ['index.js']");
    expect(boot).toContain('Temporary DB:');
    expect(boot).toContain('/api/health');
    expect(boot).toContain('/socket.io/?EIO=4&transport=polling');
    expect(boot).toContain('socketPollingOpen');
    expect(boot).toContain("['join_picking_group'");
    expect(boot).toContain('shop_status_changed');
    expect(boot).toContain('/api/delivery-groups/catalog-reviewed');
    expect(boot).toContain('server-owned OrderingSession materialisation');
    expect(boot).toContain('server-owned stale picking lock maintenance');
    expect(boot).toContain('OrderingSession groupId+openDate unique index');
    expect(boot).toContain('dropDatabase()');
  });
});

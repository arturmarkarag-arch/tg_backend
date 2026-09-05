const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const {
  queueScopeFromSettings,
  orderInIntakeScope,
  orderInSentScope,
  orderInCancelledScope,
  orderInQueueScope,
  HISTORY_LOOKBACK_DAYS,
} = require('../services/baseLinkerQueueScope');
const { appError } = require('../utils/errors');
const { retryDelayMs } = require('../services/baseLinkerSyncError');

let queueSettings = {};
const getQueueScope = () => queueScopeFromSettings(queueSettings);

function scopeMock() {
  return {
    getQueueScope: async () => getQueueScope(),
    orderInIntakeScope,
    orderInSentScope,
    orderInCancelledScope,
    orderInQueueScope,
    HISTORY_LOOKBACK_DAYS,
  };
}

function loadService(name, mocks) {
  const filename = path.join(__dirname, '../services', name);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => id in mocks ? mocks[id] : id === './baseLinkerQueueScope' ? scopeMock() : realRequire(id),
    module, exports: module.exports, process, Date, console, setInterval, clearInterval,
  }, { filename });
  return module.exports;
}

function emptyPickingFind() {
  return {
    select: () => ({ lean: async () => [] }),
  };
}

function cacheHarness(value = {}) {
  let state = value;
  const fetch = vi.fn(async () => ({ orders: [], truncated: false }));
  const reconcile = vi.fn(async () => ({}));
  const markUpdated = vi.fn(async () => ({}));
  const model = {
    collection: { name: 'baselinkerordercache', updateMany: vi.fn(async () => ({})) },
    syncIndexes: vi.fn(async () => {}),
    countDocuments: vi.fn(async () => 0),
    bulkWrite: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ deletedCount: 1 })),
    aggregate: vi.fn(() => ({ allowDiskUse: async () => [{ page: [], counts: [], updatedCount: [] }] })),
    find: vi.fn(() => ({ select: () => ({ lean: async () => [] }), lean: async () => [] })),
  };
  const pickingModel = {
    collection: { name: 'baselinkerpickingorders' },
    find: vi.fn(() => emptyPickingFind()),
  };
  const service = loadService('baseLinkerOrderCache.js', {
    '../models/AppSetting': {
      findOne: () => ({ lean: async () => ({ value: state }) }),
      findOneAndUpdate: async (_, update) => { state = update.$set.value; },
    },
    '../models/BaseLinkerOrderCache': model,
    '../models/BaseLinkerPickingOrder': pickingModel,
    './baseLinkerOrders': { fetchBaseLinkerOrders: fetch },
    './baseLinkerPicking': {
      ensurePickingIndexesReady: vi.fn(async () => {}),
      reconcilePickingFromUpstreamChanges: reconcile,
      markPickingOrdersUpstreamUpdated: markUpdated,
    },
    '../utils/lock': { withLock: async (_, work) => work() },
  });
  return { service, fetch, reconcile, markUpdated, model, pickingModel, state: () => state };
}

function journalMocks({ stateRef, callApi, sync = async () => ({ skipped: true }) }) {
  return {
    '../models/AppSetting': {
      findOne: () => ({ lean: async () => ({ value: stateRef.get() }) }),
      findOneAndUpdate: async (_, update) => stateRef.set(update.$set.value),
    },
    './baseLinkerClient': { isBaseLinkerConfigured: () => true, callBaseLinker: callApi },
    './baseLinkerOrderCache': {
      syncBaseLinkerOrderCache: sync,
      refreshBaseLinkerOrderCache: vi.fn(async () => {}),
    },
    './baseLinkerOrders': { fetchBaseLinkerOrders: vi.fn(async () => ({ orders: [] })) },
    './baseLinkerPicking': {
      reconcilePickingFromUpstreamChanges: vi.fn(async () => {}),
      markPickingOrdersUpstreamUpdated: vi.fn(async () => {}),
    },
    './schedulerLeader': { runAsSchedulerLeader: async (_, work) => work() },
    '../socket': { getIO: () => null },
  };
}

describe('scoped BaseLinker queue', () => {
  beforeEach(() => {
    queueSettings = { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'test' };
  });

  it('requires all three upstream statuses and never warms from a GET', async () => {
    queueSettings.cancelledStatusId = null;
    const h = cacheHarness({ initialized: true, orderCount: 2363 });
    await expect(h.service.getCachedOrderPage()).rejects.toMatchObject({ code: 'baselinker_queue_not_configured' });
    expect(await h.service.syncBaseLinkerOrderCache()).toMatchObject({ skipped: true });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('scans exact Intake, Sent and Cancelled statuses, then applies 14-day terminal retention by date_in_status', async () => {
    const h = cacheHarness();
    const scope = getQueueScope();
    const intake = { order_id: 1, order_status_id: 99, confirmed: true, date_confirmed: 1 };
    const sentRecent = { order_id: 2, order_status_id: 100, confirmed: true, date_in_status: scope.sentDateInStatusFrom + 60 };
    const cancelledRecent = { order_id: 3, order_status_id: 101, confirmed: true, date_in_status: scope.cancelledDateInStatusFrom + 60 };
    h.fetch.mockImplementation(async ({ statusId }) => ({
      orders: statusId === 99 ? [intake] : statusId === 100 ? [sentRecent] : statusId === 101 ? [cancelledRecent] : [],
      truncated: false,
    }));

    await h.service.syncBaseLinkerOrderCache();

    expect(h.fetch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      statusId: 99,
      includeUnconfirmed: true,
      maxPages: expect.any(Number),
    }));
    expect(h.fetch.mock.calls[0][0]).not.toHaveProperty('dateConfirmedFrom');
    expect(h.fetch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      statusId: 100,
      includeUnconfirmed: true,
    }));
    expect(h.fetch.mock.calls[1][0]).not.toHaveProperty('dateConfirmedFrom');
    expect(h.fetch).toHaveBeenNthCalledWith(3, expect.objectContaining({ statusId: 101, includeUnconfirmed: true }));
    expect(h.fetch.mock.calls[2][0]).not.toHaveProperty('dateConfirmedFrom');
    expect(h.reconcile).toHaveBeenCalledWith({ orders: [intake, sentRecent, cancelledRecent], removedOrderIds: [] });
    expect(h.model.bulkWrite.mock.calls[0][0]).toHaveLength(3);
  });

  it('mass-scans only the three explicitly configured statuses', async () => {
    const h = cacheHarness();
    await h.service.syncBaseLinkerOrderCache();
    const scannedStatuses = h.fetch.mock.calls.map(([args]) => args.statusId);
    expect(scannedStatuses).toEqual([99, 100, 101]);
  });

  it('exact-rereads a known order that disappears from Intake/Sent and observes Cancelled', async () => {
    const scope = getQueueScope();
    const h = cacheHarness({ initialized: true, scopeKey: scope.scopeKey, lastFullSyncAt: '2000-01-01T00:00:00.000Z', orderCount: 1 });
    h.model.find.mockImplementation((filter) => ({
      select: () => ({
        lean: async () => Array.isArray(filter?.$or) ? [{ orderId: '123', orderStatusId: 99 }] : [],
      }),
      lean: async () => [],
    }));
    const cancelled = { order_id: 123, order_status_id: 101, confirmed: true, date_in_status: Math.floor(Date.now() / 1000) };
    h.fetch.mockImplementation(async (args) => {
      if (args.orderId === '123') return { orders: [cancelled], truncated: false };
      return { orders: [], truncated: false };
    });

    await h.service.syncBaseLinkerOrderCache({ force: true });

    expect(h.fetch).toHaveBeenCalledWith(expect.objectContaining({ orderId: '123', includeUnconfirmed: true, maxPages: 1 }));
    expect(h.reconcile).toHaveBeenCalledWith({ orders: [cancelled], removedOrderIds: [] });
    expect(h.markUpdated).toHaveBeenCalledWith(expect.objectContaining({
      orderIds: ['123'],
      knownCachedOrderIds: ['123'],
      journalTypesByOrderId: { 123: [18] },
    }));
  });

  it('intake ignores age, while Sent and Cancelled expire after the 14-day cutoff', () => {
    const scope = getQueueScope();
    const ancientIntake = { order_status_id: 99, date_confirmed: 1, confirmed: true };
    expect(orderInIntakeScope(ancientIntake, scope)).toBe(true);
    expect(orderInQueueScope(ancientIntake, scope)).toBe(true);

    const sentAtBoundary = { order_status_id: 100, date_in_status: scope.sentDateInStatusFrom, confirmed: true };
    expect(orderInSentScope(sentAtBoundary, scope)).toBe(true);
    expect(orderInSentScope({ ...sentAtBoundary, date_in_status: scope.sentDateInStatusFrom - 1 }, scope)).toBe(false);
    const cancelledAtBoundary = { order_status_id: 101, date_in_status: scope.cancelledDateInStatusFrom, confirmed: true };
    expect(orderInCancelledScope(cancelledAtBoundary, scope)).toBe(true);
    expect(orderInCancelledScope({ ...cancelledAtBoundary, date_in_status: scope.cancelledDateInStatusFrom - 1 }, scope)).toBe(false);
    expect(orderInQueueScope(cancelledAtBoundary, scope)).toBe(true);
    expect(orderInQueueScope({ ...ancientIntake, confirmed: false }, scope)).toBe(true);
  });

  it('does not sweep or publish a truncated intake snapshot', async () => {
    const h = cacheHarness();
    h.fetch.mockResolvedValueOnce({ orders: [], truncated: true });
    await expect(h.service.syncBaseLinkerOrderCache()).rejects.toMatchObject({ code: 'baselinker_order_cache_bootstrap_truncated' });
    expect(h.model.deleteMany).not.toHaveBeenCalled();
    expect(h.model.bulkWrite).not.toHaveBeenCalled();
    expect(h.state()).toEqual({});
  });

  it('discards a scan when the administrator changes the scope before publication', async () => {
    const h = cacheHarness();
    h.fetch.mockImplementation(async () => {
      queueSettings.revision = 'changed';
      return { orders: [], truncated: false };
    });
    await expect(h.service.syncBaseLinkerOrderCache()).rejects.toMatchObject({ code: 'baselinker_queue_warming' });
    expect(h.model.deleteMany).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('persists detailed journal failure and resets cooldown when the status scope changes', async () => {
    let state = { initialized: true, scopeKey: getQueueScope().scopeKey, lastLogId: 50 };
    const stateRef = { get: () => state, set: (next) => { state = next; } };
    const callApi = vi.fn(async () => { throw appError('baselinker_api_error', {
      upstreamMethod: 'getJournalList', upstreamCode: 'ERROR_BAD_PARAMETERS', upstreamMessage: 'Bad cursor',
    }); });
    const mocks = journalMocks({ stateRef, callApi });

    await loadService('baseLinkerJournal.js', mocks).runBaseLinkerJournalTick();
    expect(state.lastError).toMatchObject({ upstreamMethod: 'getJournalList', upstreamCode: 'ERROR_BAD_PARAMETERS', upstreamMessage: 'Bad cursor' });
    expect(state.lastLogId).toBe(50);
    expect(Date.parse(state.nextRetryAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await loadService('baseLinkerJournal.js', mocks).runBaseLinkerJournalTick()).toMatchObject({ reason: 'backoff' });
    expect(callApi).toHaveBeenCalledOnce();

    queueSettings.revision = 'new-scope';
    await loadService('baseLinkerJournal.js', mocks).runBaseLinkerJournalTick();
    expect(callApi).toHaveBeenCalledTimes(2);
  });

  it('bootstraps an empty journal only after the three-status queue is configured', async () => {
    let state = {};
    const stateRef = { get: () => state, set: (next) => { state = next; } };
    const callApi = vi.fn(async () => ({ logs: [] }));
    const sync = vi.fn(async () => ({ skipped: true }));
    const mocks = journalMocks({ stateRef, callApi, sync });
    const service = loadService('baseLinkerJournal.js', mocks);

    queueSettings.cancelledStatusId = null;
    expect(await service.runBaseLinkerJournalTick()).toMatchObject({ reason: 'queue_not_configured' });
    expect(callApi).not.toHaveBeenCalled();

    queueSettings.cancelledStatusId = 101;
    await service.runBaseLinkerJournalTick();
    expect(state).toMatchObject({ initialized: true, lastLogId: 1 });
    expect(sync).toHaveBeenCalledWith({ force: true });
  });

  it('backs transient errors off exponentially with a cap', () => {
    expect(retryDelayMs(new Error(), 1)).toBe(30_000);
    expect(retryDelayMs(new Error(), 2)).toBe(60_000);
    expect(retryDelayMs(new Error(), 30)).toBe(900_000);
  });
});

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const STATUSES = [
  { id: 99, name: 'Do opakowania' },
  { id: 100, name: 'Wysłano' },
  { id: 101, name: 'Anulowane' },
  { id: 102, name: 'Inny status' },
];

function account(accountId, queue = {}, enabled = true) {
  return {
    accountId,
    name: `BL ${accountId}`,
    enabled,
    queue,
    metadataSnapshot: { statuses: STATUSES, sources: {}, inventories: [] },
  };
}

function harness(accounts = {}) {
  const savedQueues = new Map();
  const callers = new Map();

  const listBaseLinkerAccounts = vi.fn(async ({ includeDisabled } = {}) => Object.values(accounts)
    .filter((row) => includeDisabled || row.enabled === true));
  const getBaseLinkerAccount = vi.fn(async (accountId) => {
    const row = accounts[String(accountId)];
    if (!row) throw Object.assign(new Error('not found'), { code: 'baselinker_account_not_found' });
    return row;
  });
  const saveAccountQueue = vi.fn(async (accountId, payload) => {
    const row = accounts[String(accountId)];
    if (!row) throw Object.assign(new Error('not found'), { code: 'baselinker_account_not_found' });
    row.queue = {
      intakeStatusId: Number(payload.intakeStatusId),
      sentStatusId: Number(payload.sentStatusId),
      cancelledStatusId: Number(payload.cancelledStatusId),
      revision: `rev-${savedQueues.size + 1}`,
    };
    savedQueues.set(String(accountId), row.queue);
    return row;
  });
  const makeBaseLinkerAccountCaller = vi.fn((accountId) => {
    const id = String(accountId);
    if (!callers.has(id)) callers.set(id, vi.fn(async (method) => {
      if (method !== 'getOrderStatusList') throw new Error(`unexpected ${method}`);
      return { statuses: STATUSES };
    }));
    return callers.get(id);
  });
  const refreshBaseLinkerAccountMetadata = vi.fn(async (accountId) => {
    const row = accounts[String(accountId)];
    if (!row) throw Object.assign(new Error('not found'), { code: 'baselinker_account_not_found' });
    row.metadataSnapshot = { statuses: STATUSES, sources: {}, inventories: [] };
    return { metadata: row.metadataSnapshot };
  });

  function load() {
    const filename = path.join(__dirname, '../services/baseLinkerQueueScope.js');
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    const mocks = {
      './baseLinkerAccounts': { listBaseLinkerAccounts, getBaseLinkerAccount, saveAccountQueue },
      './baseLinkerClient': { makeBaseLinkerAccountCaller },
      './baseLinkerAccountValidation': { refreshBaseLinkerAccountMetadata },
      '../utils/errors': {
        appError: (code) => Object.assign(new Error(code), { code, status: 400 }),
      },
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, process, Date, require: (id) => mocks[id] || realRequire(id),
    });
    return module.exports;
  }

  return {
    load,
    callers,
    makeBaseLinkerAccountCaller,
    saveAccountQueue,
    savedQueues,
    refreshBaseLinkerAccountMetadata,
  };
}

describe('BaseLinker per-account queue settings', () => {
  it('has no global or legacy queue fallback: accountId is mandatory', async () => {
    const api = harness().load();
    await expect(api.getQueueScope()).rejects.toMatchObject({ code: 'baselinker_account_id_required' });
    await expect(api.saveQueueSettings('', {})).rejects.toMatchObject({ code: 'baselinker_account_id_required' });
  });

  it('derives independent scope keys even when accounts use identical BaseLinker status IDs', () => {
    const { queueScopeFromSettings } = harness().load();
    const queue = { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'same' };
    const a = queueScopeFromSettings(queue, Date.now(), account('A', queue));
    const b = queueScopeFromSettings(queue, Date.now(), account('B', queue));
    expect(a).toMatchObject({ configured: true, baseLinkerAccountId: 'A', intakeStatusName: 'Do opakowania' });
    expect(b).toMatchObject({ configured: true, baseLinkerAccountId: 'B', intakeStatusName: 'Do opakowania' });
    expect(a.scopeKey).not.toBe(b.scopeKey);
  });

  it('derives display names from API metadata and fails closed if a configured status disappeared', () => {
    const { queueScopeFromSettings } = harness().load();
    const queue = { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'r1' };
    const renamed = account('A', queue);
    renamed.metadataSnapshot.statuses = STATUSES.map((row) => row.id === 99 ? { ...row, name: 'NOWA NAZWA' } : row);
    expect(queueScopeFromSettings(queue, Date.now(), renamed)).toMatchObject({ configured: true, intakeStatusName: 'NOWA NAZWA' });

    const missing = account('A', queue);
    missing.metadataSnapshot.statuses = STATUSES.filter((row) => row.id !== 100);
    expect(queueScopeFromSettings(queue, Date.now(), missing)).toMatchObject({ configured: false, sentStatusName: '' });
  });

  it('reads only the requested account queue and never infers a single account', async () => {
    const queueA = { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'A-1' };
    const queueB = { intakeStatusId: 102, sentStatusId: 100, cancelledStatusId: 101, revision: 'B-1' };
    const h = harness({ A: account('A', queueA), B: account('B', queueB) });
    const api = h.load();
    expect(await api.getQueueScope('A')).toMatchObject({ baseLinkerAccountId: 'A', intakeStatusId: 99 });
    expect(await api.getQueueScope('B')).toMatchObject({ baseLinkerAccountId: 'B', intakeStatusId: 102 });
  });

  it('refreshes that account metadata before saving a queue and stores only status IDs', async () => {
    const h = harness({ A: account('A'), B: account('B') });
    const saved = await h.load().saveQueueSettings('B', {
      intakeStatusId: 99,
      sentStatusId: 100,
      cancelledStatusId: 101,
    });
    expect(h.refreshBaseLinkerAccountMetadata).toHaveBeenCalledWith('B');
    expect(h.saveAccountQueue).toHaveBeenCalledTimes(1);
    expect(h.saveAccountQueue.mock.calls[0][0]).toBe('B');
    expect(h.saveAccountQueue.mock.calls[0][1]).toMatchObject({
      intakeStatusId: 99,
      sentStatusId: 100,
      cancelledStatusId: 101,
      statuses: STATUSES,
    });
    expect(h.savedQueues.get('B')).toEqual({
      intakeStatusId: 99,
      sentStatusId: 100,
      cancelledStatusId: 101,
      revision: 'rev-1',
    });
    expect(saved).toMatchObject({ baseLinkerAccountId: 'B', configured: true });
  });

  it('lists only enabled scopes when requested', async () => {
    const queue = { intakeStatusId: 99, sentStatusId: 100, cancelledStatusId: 101, revision: 'r' };
    const h = harness({ A: account('A', queue, true), B: account('B', queue, false) });
    const api = h.load();
    const enabled = await api.getAllQueueScopes({ enabledOnly: true });
    const all = await api.getAllQueueScopes({ enabledOnly: false });
    expect(enabled.map((row) => row.baseLinkerAccountId)).toEqual(['A']);
    expect(all.map((row) => row.baseLinkerAccountId)).toEqual(['A', 'B']);
  });
});

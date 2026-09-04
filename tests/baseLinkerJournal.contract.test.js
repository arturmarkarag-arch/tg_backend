const fs = require('fs');
const path = require('path');
const {
  JOURNAL_LOG_TYPES,
  logIdOf,
  normalizeJournalLogs,
  affectedOrderIdsForLog,
  selectJournalWindow,
  fetchJournal,
} = require('../services/baseLinkerJournal');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker getJournalList realtime adapter', () => {
  it('accepts both documented id and sample log_id cursor fields', () => {
    expect(logIdOf({ id: 10 })).toBe(10);
    expect(logIdOf({ log_id: 11 })).toBe(11);
    expect(normalizeJournalLogs([{ log_id: 12 }, { id: 10 }, { id: 9 }], 9).map(logIdOf)).toEqual([10, 12]);
  });

  it('tracks both source and newly created order ids for split/copy/merge events', () => {
    expect(affectedOrderIdsForLog({ log_type: 6, order_id: 100, object_id: 101 })).toEqual(['100', '101']);
    expect(affectedOrderIdsForLog({ log_type: 17, order_id: 100, object_id: 202 })).toEqual(['100', '202']);
    expect(affectedOrderIdsForLog({ log_type: 15, order_id: 100 })).toEqual([]);
  });

  it('advances only through a safe prefix when one journal batch contains too many changed orders', () => {
    const logs = [
      { log_id: 1, log_type: 13, order_id: 10 },
      { log_id: 2, log_type: 18, order_id: 10 },
      { log_id: 3, log_type: 13, order_id: 11 },
      { log_id: 4, log_type: 13, order_id: 12 },
    ];
    const window = selectJournalWindow(logs, 2);
    expect(window.orderIds).toEqual(['10', '11']);
    expect(window.cutoffLogId).toBe(3);
    expect(window.selected).toHaveLength(3);
  });

  it('calls only the read-only getJournalList method with the persisted cursor', async () => {
    const calls = [];
    await fetchJournal(456, async (method, params) => {
      calls.push({ method, params });
      return { status: 'SUCCESS', logs: [] };
    });
    expect(calls).toEqual([{ method: 'getJournalList', params: { last_log_id: 456, logs_types: JOURNAL_LOG_TYPES } }]);
  });

  it('starts the journal scheduler server-side and pushes cache patches instead of adding browser polling', () => {
    expect(read('index.js')).toContain('startBaseLinkerJournalScheduler');
    expect(read('services/baseLinkerJournal.js')).toContain("emit('baselinker_orders_changed'");
    expect(read('services/baseLinkerJournal.js')).toContain('runAsSchedulerLeader');
    expect(read('services/baseLinkerJournal.js')).toContain('JOURNAL_STATE_KEY');
    expect(read('services/baseLinkerPicking.js')).toContain('reconcilePickingFromUpstreamChanges');
  });
});

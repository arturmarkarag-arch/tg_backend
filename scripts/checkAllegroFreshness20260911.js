'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const policy = require('../services/allegroFreshnessPolicy');
const query = (value) => ({ sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => value });
function load(file, deps, extra = '') {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + extra, {
    module, exports: module.exports, process, console, setTimeout, clearTimeout, setInterval, Date,
    require(id) { if (Object.hasOwn(deps, id)) return deps[id]; throw new Error(`Unexpected dependency ${id}`); },
  });
  return module.exports;
}
const error = (code) => Object.assign(new Error(code), { code });
function orderService(overrides = {}, extra = '') {
  return load('services/allegroOrders.js', {
    '../models/AllegroOfferImage': {}, '../models/AllegroAccount': {},
    '../models/AllegroOrderIndex': {}, '../models/AllegroOrderSyncState': {},
    './allegroFreshnessPolicy': policy, './allegroHttpClient': {}, './allegroAccounts': {},
    './allegroCapabilities': { capabilityMatrix: () => ({ scopesKnown: false }) },
    '../utils/errors': { appError: error }, '../socket': { getIO: () => null },
    '../utils/lock': { withLock: async (_key, fn) => fn() }, ...overrides,
  }, '\nmodule.exports.pollEventJournal = pollEventJournal; module.exports.relevantRefreshPrefix = relevantRefreshPrefix; module.exports.mapLimit = mapLimit; module.exports.resolveOfferImages = resolveOfferImages; module.exports.bootstrapAccount = bootstrapAccount;' + extra);
}
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }

async function main() {
  await test('a fresh poll with an unfinished journal never reports healthy', () => {
    const svc = orderService();
    const pending = svc.publicSyncState({ initialized: true, lastSuccessfulPollAt: new Date(), caughtUp: false });
    assert.equal(pending.health, 'catching_up');
    assert.equal(pending.stale, true);
    assert.equal(svc.publicSyncState({ initialized: true, caughtUp: true, lastCaughtUpAt: new Date() }).health, 'healthy');
    assert.equal(svc.publicSyncState({ initialized: true, caughtUp: true, lastCaughtUpAt: new Date(0) }).health, 'stale');
  });
  await test('an unrelated first offer is never used as the requested photo', () => {
    const svc = orderService();
    assert.equal(svc.offerListImagesFromPayload({ offers: [{ id: 'other', primaryImage: { url: 'https://example.com/wrong' } }] }, 'wanted').length, 0);
  });
  await test('the remaining per-tick budget limits all journal pages', () => {
    const svc = orderService();
    const events = ['a', 'b', 'c'].map((id) => ({ id, type: 'READY_FOR_PROCESSING', order: { checkoutForm: { id } } }));
    assert.equal(svc.relevantRefreshPrefix(events, 1).prefix.length, 1);
    assert.equal(svc.relevantRefreshPrefix(events, 0).prefix.length, 0);
  });
  await test('a malformed journal cannot advance the durable cursor', async () => {
    let writes = 0;
    const svc = orderService({
      './allegroHttpClient': { allegroRequest: async () => ({ payload: {} }) },
      '../models/AllegroOrderSyncState': { findOneAndUpdate: async () => { writes++; } },
    });
    await assert.rejects(svc.pollEventJournal({ accountId: 'a' }, { cursorEventId: 'old' }), /allegro_order_response_invalid/);
    assert.equal(writes, 0);
  });
  await test('sibling writes settle before an account lock can be released on failure', async () => {
    const svc = orderService();
    let finished = false;
    await assert.rejects(svc.mapLimit([1, 2], 2, async (n) => {
      if (n === 1) throw new Error('failed');
      await new Promise((resolve) => setTimeout(resolve, 10)); finished = true;
    }), /failed/);
    assert.equal(finished, true);
  });
  await test('bootstrap rechecks omitted orders instead of deleting their history', async () => {
    const exact = [];
    const svc = orderService({
      './allegroHttpClient': { allegroRequest: async (_id, options) => ({ payload: options.path === '/order/event-stats' ? { latestEvent: { id: 'barrier' } } : { checkoutForms: [], totalCount: 0 } }) },
      '../models/AllegroOrderIndex': { find: () => query([{ checkoutFormId: 'sent-order' }]) },
      '../models/AllegroAccount': { updateOne: async () => {} },
      '../models/AllegroOrderSyncState': { updateOne: async () => {}, findOneAndUpdate: async (_q, update) => update.$set },
    }, '\nrefreshCheckoutForms = async (_account, ids) => { module.exports.checkedIds = ids; return ids.map((checkoutFormId) => ({ checkoutFormId, removed: false })); };');
    await svc.bootstrapAccount({ accountId: 'a' }, {});
    exact.push(...svc.checkedIds);
    assert.deepEqual(exact, ['sent-order']);
  });
  await test('photo cache revalidates positive entries, backs off misses/errors, and isolates stores', async () => {
    const records = new Map();
    const rows = [{ _id: 'r', preview: { products: [{ auction_id: 'offer', images: [], image_url: '' }] } }];
    let lookups = 0;
    let mode = 'positive';
    const svc = orderService({
      '../models/AllegroOrderIndex': { find: () => query(rows), updateOne: async (_q, update, options) => {
        if (options?.arrayFilters) {
          const offerId = options.arrayFilters[0]['product.auction_id'];
          for (const product of rows[0].preview.products.filter((p) => p.auction_id === offerId)) {
            product.images = update.$set['preview.products.$[product].images'];
            product.image_url = update.$set['preview.products.$[product].image_url'];
          }
        }
      } },
      '../models/AllegroOfferImage': {
        find: (q) => query([...records.values()].filter((r) => r.accountId === q.accountId)),
        findOneAndUpdate: (q, update) => { const row = { ...records.get(q.accountId), ...q, ...update.$set }; records.set(q.accountId, row); return query(row); },
      },
      '../models/AllegroOrderSyncState': { updateOne: async () => {} },
      './allegroHttpClient': { allegroRequest: async (_account, options) => {
        lookups++;
        if (mode === 'error') throw error('unavailable');
        if (mode === 'missing') return { payload: {} };
        assert.equal(options.path, '/sale/offers');
        return { payload: { offers: [{ id: 'offer', primaryImage: { url: `https://example.com/${mode}` } }] } };
      } },
    });
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(lookups, 1);
    assert.equal(rows[0].preview.products[0].image_url, 'https://example.com/positive');
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(lookups, 1, 'fresh cache must not call provider again');
    records.get('a').nextCheckAt = new Date(0); mode = 'changed';
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(rows[0].preview.products[0].image_url, 'https://example.com/changed');
    const checkedAt = records.get('a').checkedAt;
    records.get('a').nextCheckAt = new Date(0); mode = 'error';
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(records.get('a').checkedAt, checkedAt);
    assert.equal(rows[0].preview.products[0].image_url, 'https://example.com/changed');
    const before = lookups;
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(lookups, before, 'transport backoff must suppress repeated calls');
    mode = 'missing'; records.get('a').nextCheckAt = new Date(0);
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(rows[0].preview.products[0].image_url, '');
    const afterMissing = lookups;
    await svc.backfillMissingOrderImages({ accountId: 'a' });
    assert.equal(lookups, afterMissing, 'negative cache must suppress repeated misses');
    mode = 'store-b'; await svc.backfillMissingOrderImages({ accountId: 'b' });
    assert.equal(records.get('b').images[0], 'https://example.com/store-b');
  });
  await test('slow store does not prevent a new tick for a fast store', async () => {
    let release;
    const slow = new Promise((resolve) => { release = resolve; });
    let fastCalls = 0;
    const svc = load('services/allegroOrderScheduler.js', {
      './allegroAccounts': { listAllegroAccounts: async () => ['slow', 'fast'].map((accountId) => ({ accountId, enabled: true, authState: 'connected' })) },
      './allegroOrders': {
        getAllegroOrderSyncStates: async () => [], setAllegroOrderRetryAt: async () => {},
        syncOneAllegroAccount: async (id) => { if (id === 'slow') await slow; else fastCalls++; return { accountId: id }; },
      },
      './schedulerLeader': { runAsSchedulerLeader: async (_key, fn) => fn() },
    });
    const first = svc.runAllegroOrderTick();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await svc.runAllegroOrderTick();
    assert.equal(fastCalls, 2);
    assert.equal(second.accounts.find((a) => a.accountId === 'slow').reason, 'account_busy');
    release(); await first;
  });
  console.log(`Allegro freshness: ${passed}/${passed} PASS`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });

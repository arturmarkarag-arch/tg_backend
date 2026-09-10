'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const between = (source, start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  return a >= 0 && b >= 0 ? source.slice(a, b) : '';
};

describe('2026-09-10 Sentry production regression contract', () => {
  it('keeps DeliveryGroup available on the who-ordered cache-miss path', () => {
    const products = read('routes/products.js');
    expect(products).toContain("const DeliveryGroup = require('../models/DeliveryGroup');");
    expect(products).toContain('groups = await DeliveryGroup.find().lean()');
  });

  it('keeps BaseLinker status O(1) in Mongo round-trips with account count', () => {
    const route = read('routes/baseLinker.js');
    const status = between(route, "router.get('/status'", "router.get('/api-usage'");
    expect(status).toContain('listBaseLinkerAccountRows({ includeDisabled: true })');
    expect(status).toContain('queueScopeFromSettings(row.queue || {}, now, row)');
    expect(status).toContain('loadIndexStates(scopes)');
    expect(status).not.toContain('getQueueScope(');
    expect(status).not.toContain('loadIndexState(');
  });

  it('preserves queue revision while avoiding credential exposure in the status read', () => {
    const accounts = read('services/baseLinkerAccounts.js');
    const route = read('routes/baseLinker.js');
    expect(accounts).toContain(".select('-tokenEncrypted')");
    expect(route).toContain('queueScopeFromSettings(row.queue || {}, now, row)');
    expect(route).toContain('const account = publicAccount(row)');
  });

  it('bulk-loads BaseLinker index state instead of AppSetting.findOne per account', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    const bulk = between(index, 'async function loadIndexStates(', 'async function saveIndexState(');
    expect(bulk).toContain("AppSetting.find({ key: { $in: keys } }, 'key value').lean()");
    expect(bulk).not.toContain('findOne(');
  });

  it('bulk-updates packed orders and bulk-checks fulfilment', () => {
    const picking = read('services/pickingService.js');
    const markPacked = between(picking, 'async function markOrderItemsPacked(', '/**\n * Atomically advance');
    expect(markPacked).toContain('Order.bulkWrite(itemUpdates');
    expect(markPacked).toContain('Order.updateMany(');
    expect(markPacked).not.toContain('Order.updateOne(');
    expect(markPacked).toContain("delivered < ordered ? 'short_pick' : null");
    expect(markPacked).toContain("skipped: { $ne: true }, voided: { $ne: true }");
    expect(markPacked).toContain('const opts = session ? { session } : {}');
  });

  it('loads notification buyers once instead of findById per order', () => {
    const picking = read('services/pickingService.js');
    const markPacked = between(picking, 'async function markOrderItemsPacked(', '/**\n * Atomically advance');
    expect(markPacked).toContain('Order.find(');
    expect(markPacked).toContain("'buyerTelegramId'");
    expect(markPacked).not.toContain('Order.findById(');
  });
});

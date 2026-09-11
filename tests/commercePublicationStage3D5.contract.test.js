'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.5 contract', () => {
  test('exposes read-only preview plus one price-sync business command', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("'/publications/allegro/price-sync/preview'");
    expect(route).toContain("'/publications/allegro/price-sync'");
    expect(route).not.toContain("'/publications/allegro/price-sync/status'");
  });

  test('uses Allegro current bulk price contract with beta media type and max 25 modifications', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain("'/sale/offer-bulk-modification-commands'");
    expect(service).toContain("application/vnd.allegro.beta.v1+json");
    expect(service).toContain('const BULK_LIMIT = 25');
    expect(service).toContain('modifications: jobs.map(modificationForJob)');
  });

  test('price payload uses per-offer FIXED prices and never mixes stock', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain("changeType: 'FIXED'");
    expect(service).toContain('prices: {');
    const fn = service.slice(service.indexOf('function modificationForJob'), service.indexOf('function isAmbiguous'));
    expect(fn).not.toContain('stock:');
  });

  test('preview batches GET offers by stable external ids and detects price automation', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain("path: '/sale/offers'");
    expect(service).toContain("'external.id': part");
    expect(service).toContain('priceAutomationRule');
    expect(service).toContain('requiresAutomationOverride');
  });

  test('price automation override needs explicit confirmation before a new write', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain('allowDisablePriceAutomation');
    expect(service).toContain('commerce_allegro_price_sync_automation_confirmation_required');
  });

  test('command id is durable before POST and POST has no blind retry', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain('await setJobsCommand(jobs, commandId)');
    expect(service).toContain('providerOperationId = commandId');
    expect(service).toContain("retryPolicy: 'never'");
    expect(service).toContain('maxAttempts: 1');
  });

  test('unknown recovery reuses the same command id and stale desired blocks replay', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain('retryUnknownCommand(group.accountId, group.commandId, group.jobs)');
    expect(service).toContain('upstreamStatus === 409');
    expect(service).toContain('commerce_allegro_price_sync_unknown_stale_desired');
    expect(service).toContain('the entire command stays');
  });

  test('unresolved jobs are polled independently of current needsChange before any new command', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain('Recovery always comes first');
    expect(service).toContain("state: { $in: ['sending', 'pending', 'unknown'] }");
    expect(service).toContain('const preview = await previewAllegroPriceSync({ items });');
    expect(service).toContain('unresolvedListingIds');
  });

  test('summary tasks are polled and successful price tasks get fresh read-back verification', () => {
    const service = read('services/commerce/allegroPriceSync.js');
    expect(service).toContain("path: `${commandPath(commandId)}/tasks`");
    expect(service).toContain("text(task?.subject?.field, 40) === 'prices'");
    expect(service).toContain('verifySuccessfulJobs');
    expect(service).toContain('samePrice(storedDesired, row.actualPrice)');
  });

  test('registry marks price sync live but stock remains a separate planned stage', () => {
    const registry = read('services/commerce/integrationRegistry.js');
    expect(registry).toContain("id: 'offers.price.write'");
    expect(registry).toContain('offer-bulk-modification-commands');
    expect(registry).toContain("id: 'offers.stock.write'");
    const stockLine = registry.split('\n').find((line) => line.includes("id: 'offers.stock.write'") && line.includes("label: 'Синхронізація залишку'"));
    expect(stockLine).toContain('implementation: PLANNED');
  });
});

'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce publication Stage 3D.6C contract', () => {
  test('exposes stock preview plus one stock-sync business command and no status endpoint', () => {
    const route = read('routes/commerce.js');
    expect(route).toContain("'/publications/allegro/stock-sync/preview'");
    expect(route).toContain("'/publications/allegro/stock-sync'");
    expect(route).not.toContain("'/publications/allegro/stock-sync/status'");
  });

  test('uses Allegro bulk beta stock contract with maximum 25 modifications', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(apply).toContain("path: '/sale/offer-bulk-modification-commands'");
    expect(apply).toContain('application/vnd.allegro.beta.v1+json');
    expect(apply).toContain('const BULK_LIMIT = 25');
    expect(apply).toContain('modifications: jobs.map(modificationForJob)');
  });

  test('stock payload uses FIXED whole quantities and never mixes price', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    const fn = apply.slice(apply.indexOf('function modificationForJob'), apply.indexOf('function isAmbiguous'));
    expect(fn).toContain("changeType: 'FIXED'");
    expect(fn).toContain('stock: {');
    expect(fn).not.toContain('prices:');
  });

  test('main warehouse quantity is not a stock source', () => {
    const preview = read('services/commerce/publicationPreview.js');
    const stock = read('services/commerce/allegroStockSync.js');
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(preview).toContain('product.availableStock is the independent internet-store inventory');
    expect(preview).toContain('inventoryOnHand');
    expect(stock).toContain("sourceOfTruth: 'commerce_inventory_minus_central_reservations'");
    expect(apply).toContain("sourceOfTruth: 'commerce_inventory_minus_central_reservations'");
    expect(apply).not.toContain('Product.quantity');
  });

  test('zero stock requires explicit confirmation because it can end an offer', () => {
    const preview = read('services/commerce/allegroStockSync.js');
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(preview).toContain('zero_stock_will_end_offer');
    expect(apply).toContain('allowEndOffers');
    expect(apply).toContain('commerce_allegro_stock_sync_end_confirmation_required');
  });

  test('reservation mapping and inventory movements are hard gates before write', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(apply).toContain('mappingCoverageReady !== true');
    expect(apply).toContain('commerce_allegro_stock_sync_reservation_mapping_incomplete');
    expect(apply).toContain('inventoryConsumptionReady !== true');
    expect(apply).toContain('commerce_allegro_stock_sync_inventory_movements_blocked');
  });

  test('command id is durable before POST and POST has no blind retry', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(apply).toContain('await setJobsCommand(jobs, commandId)');
    expect(apply).toContain('providerOperationId = commandId');
    expect(apply).toContain("retryPolicy: 'never'");
    expect(apply).toContain('maxAttempts: 1');
    expect(apply).toContain('upstreamStatus === 409');
  });

  test('unknown recovery reuses exact command and stale desired stock blocks replay', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(apply).toContain('submitCommand(group.accountId, group.jobs, group.commandId)');
    expect(apply).toContain('commerce_allegro_stock_sync_unknown_stale_desired');
    expect(apply).toContain('desired stock хоча б одного offer уже змінився');
  });

  test('unresolved jobs are recovered before a fresh preview/new command', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    expect(apply).toContain('Recovery always comes before deciding whether a fresh write is needed');
    expect(apply).toContain("state: { $in: ['sending', 'pending', 'unknown'] }");
    expect(apply).toContain('const preview = await previewAllegroStockSync({ items });');
    expect(apply).toContain('unresolvedListingIds');
  });

  test('summary/tasks and fresh read-back verify stock, registry marks stock sync LIVE', () => {
    const apply = read('services/commerce/allegroStockSyncApply.js');
    const registry = read('services/commerce/integrationRegistry.js');
    expect(apply).toContain("path: `${commandPath(commandId)}/tasks`");
    expect(apply).toContain("text(task?.subject?.field, 40) === 'stock'");
    expect(apply).toContain('sameStock(storedDesired, row.actualStock)');
    const line = registry.split('\n').find((row) => row.includes("id: 'offers.stock.write'") && row.includes('offer-bulk-modification-commands'));
    expect(line).toContain('implementation: LIVE');
    expect(line).toContain('Stage 3D.6C');
  });
});

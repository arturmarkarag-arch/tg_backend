'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { effectiveStock } = require('../services/commerce/publicationPreview');
const { baseLinkerCanonical, reservationKey } = require('../services/commerce/stockReservations');

describe('Commerce publication Stage 3D.6B reservation ledger contract', () => {
  test('adds a provider-neutral durable reservation model without buyer/payment payload', () => {
    const model = read('models/CommerceStockReservation.js');
    expect(model).toContain("sourceKind: { type: String, enum: ['marketplace_order']");
    expect(model).toContain("state: { type: String, enum: ['reserved', 'consumed', 'released', 'unknown']");
    expect(model).toContain('countsAgainstStock');
    expect(model).not.toMatch(/\b(?:buyer|delivery_fullname|phone|email|payment_done|invoice)\s*:/i);
  });

  test('uses an epoch so first deployment never backfills all historical sent orders', () => {
    const state = read('models/CommerceStockReservationState.js');
    const service = read('services/commerce/stockReservations.js');
    expect(state).toContain('startedAt');
    expect(service).toContain("{ upstreamStage: 'sent', orderSortDate: { $gte: startedAt } }");
    expect(service).toContain('sentAt: { $gte: startedAt }');
  });

  test('deduplicates BaseLinker Allegro bridge orders onto the direct Allegro canonical identity', () => {
    const canonical = baseLinkerCanonical({ accountId: 'bl-A', orderId: '123', sourceType: 'allegro', externalOrderId: 'checkout-uuid' });
    expect(canonical.canonicalProvider).toBe('allegro');
    expect(canonical.canonicalOrderKey).toBe('allegro:checkout-uuid');
    expect(reservationKey(canonical.canonicalOrderKey, 'offer:999'))
      .toBe(reservationKey('allegro:checkout-uuid', 'offer:999'));
  });

  test('maps order lines exact-first by Allegro offerId, then SKU/EAN, and fails closed on ambiguity', () => {
    const service = read('services/commerce/stockReservations.js');
    expect(service).toContain("matchStrategy: 'listing_offer_id'");
    expect(service).toContain("matchStrategy: 'sku'");
    expect(service).toContain("matchStrategy: 'ean'");
    expect(service).toContain('reservation_offer_mapping_ambiguous');
    expect(service).toContain('reservation_ean_mapping_ambiguous');
    expect(service).toContain('countsAgainstStock: true');
  });

  test('subtracts central holds before channel buffer/cap policy', () => {
    const stock = effectiveStock(
      { availableStock: 10 },
      { stock: { mode: 'capped', maxQuantity: 8, buffer: 1 } },
      { held: 3 },
    );
    expect(stock.inventoryOnHand).toBe(10);
    expect(stock.physicalSource).toBe(10); // compatibility alias
    expect(stock.reservedUnits).toBe(3);
    expect(stock.source).toBe(7);
    expect(stock.available).toBe(6);
  });

  test('stock preview remains ledger-aware after stock write is added later', () => {
    const service = read('services/commerce/allegroStockSync.js');
    const route = read('routes/commerce.js');
    expect(service).toContain('reservationLedgerReady: true');
    expect(service).toContain('refreshCommerceStockReservations');
    expect(service).toContain('reservationLedgerReady: true');
    expect(service).toContain('inventoryConsumptionReady: inventoryConsumption.ready');
    expect(service).toContain('providerWriteCalls: 0');
    expect(route).toContain("'/publications/allegro/stock-sync/preview'");
    expect(route).toContain("'/publications/allegro/stock-sync/preview'");
  });

  test('registry keeps central reservation ledger LIVE independently of stock write stage', () => {
    const registry = read('services/commerce/providers/allegro.js');
    const ledger = registry.split('\n').find((line) => line.includes("id: 'inventory.reservations'"));
    const write = registry.split('\n').find((line) => line.includes("id: 'offers.stock.write'") && line.includes('offer-bulk-modification-commands'));
    expect(ledger).toContain('implementation: LIVE');
    expect(write).toBeTruthy();
    expect(write).toContain('Stage 3D.6C')
  });

  test('disappeared reservations are held fail-closed unless terminal cancel/sent is proven', () => {
    const service = read('services/commerce/stockReservations.js');
    expect(service).toContain('reservation_source_disappeared_unverified');
    expect(service).toContain("state: 'unknown', countsAgainstStock: true");
    expect(service).toContain("state: 'released', countsAgainstStock: false");
    expect(service).toContain("state: 'consumed', countsAgainstStock: true");
  });
});

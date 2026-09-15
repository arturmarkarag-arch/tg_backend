'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { effectiveStock } = require('../services/commerce/publicationPreview');
const { reservationKey } = require('../services/commerce/providers/reservationProjection');

describe('Commerce publication Stage 3D.6B reservation ledger contract', () => {
  test('adds a provider-neutral durable reservation model without buyer/payment payload', () => {
    const model = read('models/CommerceStockReservation.js');
    expect(model).toContain("sourceKind: { type: String, enum: ['marketplace_order']");
    expect(model).toContain("state: { type: String, enum: ['reserved', 'consumed', 'released', 'unknown']");
    expect(model).toContain('countsAgainstStock');
    expect(model).not.toMatch(/\b(?:buyer|delivery_fullname|phone|email|payment_done|invoice)\s*:/i);
  });

  test('provider adapters own their epoch queries so core never imports provider order models', () => {
    const state = read('models/CommerceStockReservationState.js');
    const core = read('services/commerce/stockReservations.js');
    const allegro = read('services/commerce/providers/allegro.js');
    const baseLinker = read('services/commerce/providers/baseLinker.js');
    expect(state).toContain('startedAt');
    expect(allegro).toContain("{ upstreamStage: 'sent', orderSortDate: { $gte: startedAt } }");
    expect(baseLinker).toContain('sentAt: { $gte: startedAt }');
    expect(core).not.toMatch(/AllegroOrderIndex|BaseLinkerOrderIndex|BaseLinkerPickingOrder/);
  });

  test('BaseLinker adapter canonicalizes Allegro bridge orders before the provider-neutral merge', () => {
    const baseLinker = read('services/commerce/providers/baseLinker.js');
    expect(baseLinker).toContain("sourceType === 'allegro'");
    expect(baseLinker).toContain("canonicalProvider: 'allegro'");
    expect(baseLinker).toContain('priority: 70');
    const key = reservationKey('allegro:checkout-uuid', 'offer:999');
    expect(key).toHaveLength(64);
    expect(key).toBe(reservationKey('allegro:checkout-uuid', 'offer:999'));
  });

  test('core maps exact listing external id then SKU/EAN and fails closed on ambiguity', () => {
    const service = read('services/commerce/stockReservations.js');
    expect(service).toContain("matchStrategy: 'listing_external_id'");
    expect(service).toContain("matchStrategy: 'sku'");
    expect(service).toContain("matchStrategy: 'ean'");
    expect(service).toContain('reservation_listing_mapping_ambiguous');
    expect(service).toContain('reservation_ean_mapping_ambiguous');
    expect(service).toContain('countsAgainstStock: true');
  });

  test('subtracts central holds before channel buffer/cap policy', () => {
    const stock = effectiveStock({ availableStock: 10 }, { stock: { mode: 'capped', maxQuantity: 8, buffer: 1 } }, { held: 3 });
    expect(stock.inventoryOnHand).toBe(10);
    expect(stock.physicalSource).toBe(10);
    expect(stock.reservedUnits).toBe(3);
    expect(stock.source).toBe(7);
    expect(stock.available).toBe(6);
  });

  test('stock preview remains ledger-aware after stock write is added later', () => {
    const service = read('services/commerce/allegroStockSync.js');
    const route = read('routes/commerce.js');
    expect(service).toContain('reservationLedgerReady: true');
    expect(service).toContain('refreshCommerceStockReservations');
    expect(service).toContain('inventoryConsumptionReady: inventoryConsumption.ready');
    expect(service).toContain('providerWriteCalls: 0');
    expect(route).toContain("'/publications/allegro/stock-sync/preview'");
  });

  test('registry keeps central reservation ledger LIVE independently of stock write stage', () => {
    const registry = read('services/commerce/providers/allegro.js');
    const ledger = registry.split('\n').find((line) => line.includes("id: 'inventory.reservations'"));
    const write = registry.split('\n').find((line) => line.includes("id: 'offers.stock.write'") && line.includes('offer-bulk-modification-commands'));
    expect(ledger).toContain('implementation: LIVE');
    expect(write).toBeTruthy();
    expect(write).toContain('Stage 3D.6C');
  });

  test('disappeared reservations are held fail-closed unless terminal cancel/sent is proven', () => {
    const service = read('services/commerce/stockReservations.js');
    expect(service).toContain('reservation_source_disappeared_unverified');
    expect(service).toContain("state: 'unknown', countsAgainstStock: true");
    expect(service).toContain("state: 'released', countsAgainstStock: false");
    expect(service).toContain("state: 'consumed', countsAgainstStock: true");
  });
});

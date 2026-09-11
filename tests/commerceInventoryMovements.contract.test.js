'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce Inventory movement contract', () => {
  test('has durable unique movement keyed by reservation', () => {
    const model = read('models/CommerceInventoryMovement.js');
    expect(model).toContain('movementKey');
    expect(model).toContain('unique: true');
    expect(model).toContain("type: { type: String, enum: ['marketplace_order_consumption']");
    expect(model).toContain('appliedQuantity');
  });

  test('consumption is transactionally applied only to CommerceInventoryItem', () => {
    const service = read('services/commerce/inventoryMovements.js');
    expect(service).toContain('session.withTransaction');
    expect(service).toContain("CommerceInventoryItem.findOne({ commerceProductId: reservation.commerceProductId })");
    expect(service).toContain('inventory.onHand = after');
    expect(service).not.toContain("require('../../models/Product')");
  });

  test('applied movement releases reservation hold to avoid double subtraction', () => {
    const service = read('services/commerce/inventoryMovements.js');
    expect(service).toContain('reservation.countsAgainstStock = false');
    expect(service).toContain("movement?.state === 'applied'");
  });

  test('insufficient online inventory stays fail-closed', () => {
    const service = read('services/commerce/inventoryMovements.js');
    expect(service).toContain('commerce_inventory_insufficient_for_consumption');
    expect(service).toContain('reservation.countsAgainstStock = true');
  });

  test('quantity regression never auto-restocks a shipped order', () => {
    const service = read('services/commerce/inventoryMovements.js');
    expect(service).toContain('commerce_inventory_consumption_quantity_regressed');
    expect(service).toContain('Never auto-restock an already shipped order');
  });

  test('stock preview reconciles movements before reservation totals', () => {
    const stock = read('services/commerce/allegroStockSync.js');
    expect(stock).toContain('const inventoryConsumption = await reconcileConsumedReservations();');
    const fn = stock.slice(stock.indexOf('async function previewAllegroStockSync'));
    expect(fn.indexOf('reconcileConsumedReservations()')).toBeLessThan(fn.indexOf('getReservationTotals'));
    expect(stock).toContain("stage: '3D.6B.2'");
  });
});

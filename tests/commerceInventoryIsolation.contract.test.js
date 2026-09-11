'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Commerce Inventory isolation contract', () => {
  test('internet-store stock has its own one-to-one durable model', () => {
    const model = read('models/CommerceInventoryItem.js');
    expect(model).toContain("commerceProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceProduct', required: true, unique: true");
    expect(model).toContain('onHand');
    expect(model).toContain("source: { type: String, enum: ['manual', 'warehouse_copy', 'migration']");
  });

  test('catalog hydration reads onHand from CommerceInventoryItem, not Product.quantity', () => {
    const catalog = read('services/commerce/catalog.js');
    expect(catalog).toContain("CommerceInventoryItem.find({ commerceProductId: { $in: commerceIds } })");
    expect(catalog).toContain('availableStock: onHand');
    expect(catalog).not.toContain('calculateBindingStock(');
    expect(catalog).not.toContain("availableStock: calculateBindingStock");
  });

  test('copying a main-warehouse product creates independent online stock at zero', () => {
    const catalog = read('services/commerce/catalog.js');
    expect(catalog).toContain("source: 'warehouse_copy'");
    expect(catalog).toContain('onHand: 0');
    expect(catalog).toContain('sourceWarehouseProductId: product._id');
    expect(catalog).toContain('Internet-store stock starts independently');
  });

  test('manual/edit API can set online inventory without touching Product.quantity', () => {
    const catalog = read('services/commerce/catalog.js');
    expect(catalog).toContain("field: 'inventoryQuantity'");
    expect(catalog).toContain('raw?.inventoryQuantity !== undefined');
    expect(catalog).not.toMatch(/Product\.(?:update|findOneAndUpdate).*quantity/s);
  });

  test('Allegro stock source is Commerce inventory minus reservations', () => {
    const preview = read('services/commerce/publicationPreview.js');
    const stock = read('services/commerce/allegroStockSync.js');
    expect(preview).toContain('inventoryOnHand - reservedUnits');
    expect(stock).toContain("sourceOfTruth: 'commerce_inventory_minus_central_reservations'");
    expect(stock).toContain('Основний Product.quantity не використовується');
  });

  test('reservation comments explicitly keep main warehouse outside Commerce stock', () => {
    const reservation = read('models/CommerceStockReservation.js');
    expect(reservation).toContain('Main warehouse Product.quantity is a separate domain');
  });
});

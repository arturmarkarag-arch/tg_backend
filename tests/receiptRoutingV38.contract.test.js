const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const itemModel = read('models/ReceiptItem.js');
const productModel = read('models/Product.js');
const receipts = read('routes/receipts.js');
const products = read('routes/products.js');
const orders = read('routes/orders.js');
const blocks = read('routes/blocks.js');
const shopUpsert = read('utils/upsertShopProduct.js');
const itemLogModel = read('models/ReceiptItemLog.js');
const routing = read('utils/receiptRouting.js');
const permissions = read('utils/receiptPermissions.js');
const supplement = read('services/supplementOffers.js');
const supplementRoute = read('routes/supplement.js');
const supplementTargets = read('services/supplementTargets.js');
const supplementScheduler = read('services/supplementScheduler.js');

describe('receipt routing v38 contract', () => {
  test('receiving and routing are separate', () => {
    expect(itemModel).toContain('routingVersion');
    expect(itemModel).toContain('mandatory');
    expect(itemModel).toContain('supplementDeliveryGroupId');
    expect(receipts).toContain("router.patch('/:id/items/:itemId/routing'");
    expect(receipts).toContain("routingVersion: receipt.type === 'supplement' ? 0 : 1");
    expect(receipts).toContain('let routing = blankRouting()');
    expect(receipts).toContain("if (receipt.type === 'supplement')");
    expect(receipts).toContain('routing = { ...routing, warehouse: true, supplement: true }');
    expect(receipts).toContain('    routing,');
  });

  test('mandatory + supplement is forbidden while warehouse may combine with either', () => {
    expect(routing).toContain('if (r.mandatory && r.supplement)');
    expect(routing).toContain("reason: 'mandatory_and_supplement'");
    expect(routing).not.toContain('r.warehouse && r.mandatory');
    expect(routing).not.toContain('r.warehouse && r.supplement');
    expect(routing).toContain("reason: 'may_not_reach_with_warehouse'");
  });

  test('received quantity stays mandatory but is not automatic stock for new routing', () => {
    expect(itemModel).toContain('totalQty: { type: Number, required: true, min: 1 }');
    expect(permissions).toContain("if (!(Number(item?.totalQty) >= 1)) missing.push('кількість що приїхала')");
    expect(receipts).toContain('Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty');
    expect(blocks).toContain("{ source: 'receipt' }");
  });

  test('price and package quantity are Stage 2 and mandatory before routing/confirm; legacy commit still revalidates', () => {
    expect(permissions).toContain("if (!(Number(item?.price) > 0)) missing.push('ціна')");
    expect(permissions).toContain("if (!(Number(item?.qtyPerPackage) >= 1)) missing.push('кількість в упаковці')");
    expect(permissions).toContain('assertItemReadyForRouting');
    expect(receipts).toContain('assertItemReadyForRouting(authItem)');
    expect(receipts).toContain('for (const item of items) {\n      assertItemReadyToConfirm(item, receipt);');
    expect(receipts).toContain("if (item.status === 'confirmed') {\n        assertItemReadyToConfirm(item, liveReceipt);");
  });


  test('current regular receipt completion is receiving-only and publication remains per item', () => {
    expect(receipts).toContain('const currentReceivingFlow = receivingItems.length > 0');
    expect(receipts).toContain('receivingItems.every((item) => Number(item.routingVersion || 0) >= 1)');
    expect(receipts).toContain("{ $set: { status: 'completed', completedAt: new Date() } }");
    expect(receipts).toContain('return res.json({ receipt, createdProductsCount: 0, supplementOffersCount });');
    expect(receipts).toContain("router.post('/:id/items/:itemId/confirm'");
  });
  test('supplement-only physical Product is hidden from ordinary seller ordering', () => {
    expect(productModel).toContain('orderingEnabled');
    expect(routing).toContain('if (r.supplement && !r.warehouse) return false');
    expect(products).toContain('query.orderingEnabled = { $ne: false }');
    expect(orders).toContain('product.orderingEnabled === false');
  });

  test('seller catalogue is frozen to the current session start, including mid-session block placement', () => {
    expect(productModel).toContain('firstBlockPlacedAt');
    expect(blocks).toContain('activationSet.firstBlockPlacedAt = new Date()');
    expect(products).toContain('getSellerCatalogCycleOpenAt');
    expect(products).toContain('applySellerCycleCutoff');
    expect(products).toContain('firstBlockPlacedAt: { $lte: cutoff }');
    expect(products).toContain('getOrderingWindowOpenAt(group.orderingSchedule)');
    expect(orders).toContain('orderingCycleOpenAt');
    expect(orders).toContain('product.firstBlockPlacedAt || product.shelvedAt || product.createdAt');
    expect(orders).toContain('availableStamp && new Date(availableStamp) > new Date(orderingCycleOpenAt)');
  });

  test('mandatory-only new goods are informational, not seller-choice ShopProducts', () => {
    expect(shopUpsert).toContain('Number(item.routingVersion || 0) >= 1 ? false : true');
    expect(shopUpsert).toContain('mandatoryDistribution: !!item.routing?.mandatory');
  });

  test('routing changes are atomic draft-only writes and audited', () => {
    expect(receipts).toContain("status: 'draft'");
    expect(receipts).toContain('findOneAndUpdate');
    expect(receipts).toContain("action: 'routing_change'");
    expect(itemLogModel).toContain("'routing_change'");
  });

  test('new regular receipts can create per-item supplement offers without productId in UI', () => {
    expect(supplement).toContain('normalizeReceiptItemRouting(item, receipt)');
    expect(supplement).toContain('routing.supplementDeliveryGroupId');
    expect(supplement).toContain('productId: String(item.createdProductId)');
  });
  test('new per-item supplement never opens inside ordinary ordering and may defer safely until close', () => {
    expect(supplementTargets).toContain('requireOrderingClosed');
    expect(supplementTargets).toContain('isOrderingOpen(group.orderingSchedule, now).isOpen');
    expect(receipts).toContain('{ requireOrderingClosed: true, allowDeferred: true }');
    expect(supplement).toContain('{ requireOrderingClosed: true, allowDeferred: true }');
    expect(supplement).toContain('if (target.deferred)');
  });

  test('forgotten supplement waves cannot overlap the next ordinary ordering window', () => {
    expect(supplement).toContain('freezeOffersForActiveOrderingWindows');
    expect(supplement).toContain('ordinary_ordering_opened');
    expect(supplementScheduler).toContain('freezeOffersForActiveOrderingWindows(now)');
    expect(supplementRoute).toContain('isOrdinaryOrderingOpenForSeller');
    expect(supplementRoute).toContain("throw appError('supplement_ordering_still_open'");
  });

  test('per-item supplements can be frozen per delivery group even in regular receipts', () => {
    expect(supplement).toContain('deliveryGroupId = null');
    expect(supplement).toContain("filter.deliveryGroupId = String(deliveryGroupId)");
    expect(supplementRoute).not.toContain("if (!receipt || receipt.type !== 'supplement')");
    expect(supplementRoute).toContain("req.body?.deliveryGroupId");
    expect(supplementRoute).toContain('{ deliveryGroupId }');
  });

});

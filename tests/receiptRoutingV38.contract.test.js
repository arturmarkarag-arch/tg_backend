const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const itemModel = read('models/ReceiptItem.js');
const productModel = read('models/Product.js');
const receipts = read('routes/receipts.js');
const products = read('routes/products.js');
const orders = read('routes/orders.js');
const blocks = read('routes/blocks.js');
const blockMoveCommand = read('services/blockMoveCommand.js');
const shopUpsert = read('utils/upsertShopProduct.js');
const itemLogModel = read('models/ReceiptItemLog.js');
const routing = read('utils/receiptRouting.js');
const permissions = read('utils/receiptPermissions.js');
const supplement = read('services/supplementOffers.js');
const waveService = read('services/supplementWaveService.js');
const artifacts = read('services/receiptRoutingArtifacts.js');
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

  test('received quantity is optional modern metadata, remains integer-only, and is not automatic stock', () => {
    expect(itemModel).toContain('validator: (value) => value == null || (Number.isInteger(value) && value >= 1)');
    expect(permissions).toContain("if (!isModernReceiptItem(item) && !(Number.isInteger(Number(item?.totalQty)) && Number(item?.totalQty) >= 1))");
    expect(receipts).toContain('function parseOptionalPositiveInt');
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
  test('supplement-only current items do not require a fake warehouse Product', () => {
    expect(routing).toContain('function needsWarehouseProduct');
    expect(routing).toContain('return !!r.warehouse');
    expect(artifacts).toContain('if (!needsWarehouseProduct(routing)) return null');
    expect(waveService).toContain('productId: item.createdProductId || null');
    expect(waveService).toContain('sourceSnapshot: sourceSnapshotFromReceiptItem(item)');
    // Legacy technical products remain understood by the old catalogue guard.
    expect(productModel).toContain('orderingEnabled');
    expect(products).toContain('query.orderingEnabled = { $ne: false }');
    expect(orders).toContain('product.orderingEnabled === false');
  });

  test('seller catalogue is frozen to the current session start, including mid-session block placement', () => {
    expect(productModel).toContain('firstBlockPlacedAt');
    expect(blockMoveCommand).toContain('activationSet.firstBlockPlacedAt = new Date()');
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

  test('new regular supplements publish a Wave with optional Product identity', () => {
    expect(receipts).toContain('createWaveWithItems({');
    expect(waveService).toContain('SupplementWave.create');
    expect(waveService).toContain('SupplementOffer.bulkWrite');
    expect(waveService).toContain('productId: item.createdProductId || null');
    expect(waveService).toContain('sourceSnapshot: sourceSnapshotFromReceiptItem(item)');
  });

  test('supplement target is the current delivery session only after ordinary ordering closes', () => {
    expect(supplementTargets).toContain('findCurrentSessionId');
    expect(supplementTargets).toContain('expectedOrderingSessionId');
    expect(supplementTargets).toContain("isOrderingOpen(group.orderingSchedule, now).isOpen ? 'ordering_open' : 'awaiting_picking'");
    expect(supplementTargets).toContain("state !== 'ordering_open'");
    expect(supplementTargets).toContain("throw appError('supplement_ordering_still_open'");
    expect(supplementTargets).toContain("return 'picking'");
    expect(supplementTargets).toContain('supplement_target_session_not_started');
    expect(supplementTargets).toContain('supplement_target_session_completed');
    expect(receipts).toContain('expectedOrderingSessionId: firstTarget.orderingSessionId');
  });

  test('automatic ordinary-window freeze remains legacy-only; modern Wave freezes explicitly', () => {
    expect(supplement).toContain('freezeOffersForActiveOrderingWindows');
    expect(supplement).toContain("status: 'open', waveId: null");
    expect(supplementScheduler).toContain('freezeOffersForActiveOrderingWindows(now)');
    expect(supplementRoute).toContain("router.post('/waves/:waveId/freeze'");
    expect(supplementRoute).toContain('freezeWave(req.params.waveId');
  });

  test('packing of modern supplements begins only after Wave freeze', () => {
    expect(supplementRoute).toContain('effective !== ITEM_STATUS.FROZEN');
    expect(supplementRoute).toContain("supplement_pack_before_freeze");
    expect(supplementRoute).toContain("router.post('/waves/:waveId/freeze'");
  });


});

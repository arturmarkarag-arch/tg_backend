const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const model = read('models/ReceiptItem.js');
const route = read('routes/receipts.js');
const permissions = read('utils/receiptPermissions.js');
const supplement = read('services/supplementOffers.js');

describe('receipt core contract', () => {
  test('totalQty remains the single received quantity', () => {
    expect(model).toContain("totalQty: { type: Number, required: true, min: 1 }");
    expect(permissions).toContain("if (!(Number(item?.totalQty) >= 1)) missing.push('кількість що приїхала')");
  });

  test('legacy receipt structure, split, matching and evidence fields are absent', () => {
    const forbidden = [
      'existingProductId',
      'shelfQty',
      'transitQty',
      'expectedQty',
      'boxesPerPallet',
      'itemsPerBox',
      'itemsPerPallet',
      'defectPhotoUrls',
      'defectFilenames',
      'keptDefectPhotoUrls',
      'warehousePending',
      'resolveStructure',
      'deriveSplit',
      'resolve_pending',
    ];
    for (const token of forbidden) {
      expect(model).not.toContain(token);
      expect(route).not.toContain(token);
    }
  });

  test('receipt does not accept manual name, barcode or notes fields', () => {
    expect(route).not.toContain('parsed.fields.name');
    expect(route).not.toContain('parsed.fields.barcode');
    expect(route).not.toContain('parsed.fields.notes');
    // Internal AI identity remains allowed and is generated from the photo.
    expect(route).toContain('const { text, name } = await describeImageUrl(url)');
  });

  // Проведена накладна більше не заморожена (docs/receipt/readme.md §5), тому
  // PATCH тримається не на статусі, а на транзакції: позиція перечитується
  // всередині неї, і в ній же правка доходить до товару й дзеркала.
  test('PATCH re-reads the item and propagates inside one write transaction', () => {
    const start = route.indexOf("router.patch('/:id/items/:itemId'");
    const end = route.indexOf('// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)', start);
    const patch = route.slice(start, end);
    expect(patch).toContain('.session(txSession)');
    expect(patch).toContain('await item.save({ session: txSession })');
    expect(patch).toContain('await propagateItemEdit(item, prev, { session: txSession })');
    // Статус накладної не гейтить правку позиції.
    expect(patch).not.toContain("status: 'draft'");
  });

  test('supplement offers project the receipt-created product identity even as the projection grows', () => {
    const start = supplement.indexOf('const items = await ReceiptItem.find');
    const end = supplement.indexOf(').lean();', start);
    const projection = supplement.slice(start, end);
    for (const field of ['createdProductId', 'name', 'routing', 'routingVersion']) {
      expect(projection).toContain(field);
    }
    expect(supplement).not.toContain('existingProductId');
  });

  test('photo gallery carries display, inline-preparation and edit-navigation context', () => {
    const start = route.indexOf("router.get('/items-gallery'");
    const end = route.indexOf("router.get('/:id'", start);
    const gallery = route.slice(start, end);
    for (const field of [
      'receiptId', 'photoUrl', 'originalPhotoUrl', 'totalQty', 'destination',
      'routingVersion', 'routing', 'price', 'qtyPerPackage', 'status', 'createdBy',
    ]) expect(gallery).toContain(field);
    expect(gallery).toContain('receiptType');
    expect(gallery).toContain('receiptTargetDeliveryGroupId');
  });
  test('cleanup migration removes retired DB fields without touching totalQty or AI metadata', () => {
    const migration = read('scripts/cleanupReceiptContractLegacyFields.js');
    for (const token of [
      "'structure'", "'expectedQty'", "'shelfQty'", "'transitQty'",
      "'barcode'", "'existingProductId'", "'notes'", "'defectPhotoUrls'", "'warehousePending'",
    ]) expect(migration).toContain(token);
    expect(migration).toContain('Protected: ReceiptItem.totalQty, ReceiptItem.name, ReceiptItem.aiDescription');
    expect(migration).not.toMatch(/RECEIPT_FIELDS\s*=\s*\[[\s\S]*?'totalQty'/);
  });

});

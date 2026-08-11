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
    expect(permissions).toContain("if (!(item.totalQty >= 1)) missing.push('кількість що приїхала')");
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

  test('PATCH re-checks draft status inside its write transaction', () => {
    const start = route.indexOf("router.patch('/:id/items/:itemId'");
    const end = route.indexOf('// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)', start);
    const patch = route.slice(start, end);
    expect(patch).toContain("{ _id: req.params.id, status: 'draft' }");
    expect(patch).toContain('await item.save({ session: txSession })');
  });

  test('supplement offers use only the product created by the receipt item', () => {
    expect(supplement).toContain("'_id destination createdProductId name'");
    expect(supplement).not.toContain('existingProductId');
  });

  test('photo gallery keeps totalQty metadata contract', () => {
    expect(route).toContain("ReceiptItem.find(query, '_id photoUrl totalQty destination receiptId')");
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

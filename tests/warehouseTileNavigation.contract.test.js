const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
const blocks = read('routes/blocks.js');
const receipts = read('routes/receipts.js');

describe('warehouse tile navigation server contract', () => {
  test('block and incoming reads expose photos plus the receiving-link identity', () => {
    expect(blocks).toContain("const BLOCK_PRODUCT_FIELDS = 'imageUrls localImageUrl originalImageUrl receiptItemId'");
    expect(blocks).toContain('.select(BLOCK_PRODUCT_FIELDS)');
    expect(blocks).toContain('attachReceiptItemLinks');
    expect(blocks).not.toContain("const BLOCK_PRODUCT_FIELDS = 'name");
  });

  test('product context resolves only a real receipt item and fails closed otherwise', () => {
    expect(receipts).toContain("router.get('/product-context/:productId'");
    expect(receipts).toContain('ReceiptItem.findById(product.receiptItemId');
    expect(receipts).toContain('{ createdProductId: product._id }');
    expect(receipts).toContain("if (!item) throw appError('receipt_item_not_found')");
    expect(receipts).not.toContain('item: null, product');
  });
});

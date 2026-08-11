const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'receipts.js'), 'utf8');

describe('empty receipt deletion contract', () => {
  test('DELETE /:id allows only draft receipts with zero items', () => {
    expect(source).toContain("router.delete('/:id'");
    expect(source).toContain("if (receipt.status !== 'draft') throw appError('receipt_only_draft_delete')");
    expect(source).toContain("ReceiptItem.countDocuments({ receiptId: receipt._id })");
    expect(source).toContain("if (itemCount > 0) throw appError('receipt_only_empty_delete')");
    expect(source).toContain('await receipt.deleteOne()');
  });
});

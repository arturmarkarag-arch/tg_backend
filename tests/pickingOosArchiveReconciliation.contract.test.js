'use strict';

const fs = require('fs');
const path = require('path');

describe('OOS archive reconciliation contract', () => {
  it('consumes unreconciled OOS signals in the same archive transaction', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/archiveProduct.js'), 'utf8');
    expect(source).toContain('oosSignals.map((t) => t._id)');
    expect(source).toContain('{ $set: { archiveReconciled: true } }');
  });

  it('also heals an unreconciled signal when the product is already archived', () => {
    const archiveSource = fs.readFileSync(path.join(__dirname, '../services/archiveProduct.js'), 'utf8');
    const pickingSource = fs.readFileSync(path.join(__dirname, '../services/pickingService.js'), 'utf8');
    expect(archiveSource).toContain("if (product.status === 'archived')");
    expect(archiveSource).toContain('buildUnreconciledOosTaskFilter({ productId: product._id })');
    expect(pickingSource).toContain("if (product.status === 'archived')");
    expect(pickingSource).toContain('{ $set: { archiveReconciled: true } }');
  });
});

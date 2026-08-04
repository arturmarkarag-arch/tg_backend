'use strict';
/**
 * Why /upsert-item revives a dead position instead of pushing a second row.
 *
 * A product can leave an order in two very different ways:
 *   • the seller un-picks it  → the row is SPLICED OUT (hard removal);
 *   • the warehouse runs out  → the row stays with `cancelled: true` («закінчився»).
 * Only the first one disappears. So when a cancelled product is later restored and
 * the seller adds it again, a naive push leaves TWO rows for one productId — and
 * the model's own normalizer then merges them with the rules asserted below.
 */
const Order = require('../models/Order');

describe('Order.normalizeItems — the merge that makes a duplicate row a trap', () => {
  it('ORs the flags and SUMS the quantities of two rows for one product', () => {
    const merged = Order.normalizeItems([
      { productId: 'p1', name: 'Товар', price: 10, quantity: 3, cancelled: true },
      { productId: 'p1', name: 'Товар', price: 10, quantity: 2, cancelled: false },
    ]);

    expect(merged).toHaveLength(1);
    // A freshly added position would come back dead, carrying the ghost quantity:
    expect(merged[0].cancelled).toBe(true);
    expect(merged[0].quantity).toBe(5);
  });

  it('does the same for a skipped row', () => {
    const merged = Order.normalizeItems([
      { productId: 'p1', name: 'Товар', price: 10, quantity: 1, skipped: true },
      { productId: 'p1', name: 'Товар', price: 10, quantity: 4 },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].skipped).toBe(true);
    expect(merged[0].quantity).toBe(5);
  });

  // The normaliser REPLACES `items` wholesale, so any fulfilment field it forgets
  // to copy is erased from a merged order — silently destroying the
  // ordered-vs-delivered record the warehouse wrote.
  it('carries the delivered-quantity record through a merge', () => {
    const merged = Order.normalizeItems([
      {
        productId: 'p1', name: 'Товар', price: 10, quantity: 10,
        packed: true, packedQuantity: 7, shortfallReason: 'short_pick',
        packedBy: '42', packedByName: 'Іван', packedAt: new Date('2026-08-04T10:00:00Z'),
      },
      { productId: 'p2', name: 'Інший', price: 5, quantity: 1 },
    ]);

    const p1 = merged.find((i) => i.productId === 'p1');
    expect(p1.packedQuantity).toBe(7);
    expect(p1.shortfallReason).toBe('short_pick');
    expect(p1.packedBy).toBe('42');
    expect(p1.packedByName).toBe('Іван');
    expect(p1.packedAt).toBeInstanceOf(Date);
  });

  it('sums delivered quantities but keeps an untouched pair null', () => {
    const summed = Order.normalizeItems([
      { productId: 'p1', name: 'Товар', price: 10, quantity: 4, packedQuantity: 3 },
      { productId: 'p1', name: 'Товар', price: 10, quantity: 2, packedQuantity: 2 },
    ]);
    expect(summed[0].quantity).toBe(6);
    expect(summed[0].packedQuantity).toBe(5);

    const untouched = Order.normalizeItems([
      { productId: 'p1', name: 'Товар', price: 10, quantity: 4 },
      { productId: 'p1', name: 'Товар', price: 10, quantity: 2 },
    ]);
    // null, NOT 0 — "nobody has picked this yet" must not read as "delivered zero".
    expect(untouched[0].packedQuantity).toBe(null);
  });

  it('leaves distinct products alone', () => {
    const merged = Order.normalizeItems([
      { productId: 'p1', name: 'A', price: 1, quantity: 1 },
      { productId: 'p2', name: 'B', price: 2, quantity: 2 },
    ]);
    expect(merged).toHaveLength(2);
  });
});

// The revival the route performs in place of that push. Kept as a plain data
// transform so the expected end state is pinned even though the real thing runs
// inside a transaction (see routes/orders.js, /upsert-item).
function reviveRow(row, { name, price, quantity }) {
  row.name = name;
  row.price = price;
  row.quantity = quantity;
  row.packed = false;
  row.cancelled = false;
  row.skipped = false;
  return row;
}

describe('re-adding a restored product', () => {
  it('yields ONE live row with exactly the requested quantity', () => {
    const items = [{ productId: 'p1', name: 'Товар', price: 10, quantity: 3, cancelled: true }];

    const stale = items.find((i) => String(i.productId) === 'p1');
    reviveRow(stale, { name: 'Товар', price: 12, quantity: 2 });

    const normalized = Order.normalizeItems(items);
    expect(normalized).toHaveLength(1);
    expect(normalized[0].cancelled).toBe(false);
    expect(normalized[0].skipped).toBe(false);
    expect(normalized[0].quantity).toBe(2);
    expect(normalized[0].price).toBe(12);
  });
});

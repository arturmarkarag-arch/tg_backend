'use strict';

const {
  PRICE_BASIS,
  normalizeInvoiceDraft,
  validateFinalizableInvoice,
  buildSnapshotPayload,
} = require('../services/invoices/contract');
const { stableStringify } = require('../services/invoices/stableJson');
const { buildWarehouseOrderDraftFromDocument } = require('../services/invoices/sourceProviders/warehouseOrder');

describe('Invoice Core Stage 1', () => {
  it('normalizes a complete manual invoice and validates exact totals', () => {
    const draft = normalizeInvoiceDraft({
      type: 'invoice',
      source: { provider: 'manual', entityType: 'manual', entityId: 'test-1' },
      seller: { name: 'Seller Sp. z o.o.', taxId: '1234567890', address: { countryCode: 'PL' } },
      buyer: { name: 'Buyer' },
      issueDate: '2026-09-13',
      currency: 'pln',
      items: [{
        name: 'Towar',
        quantity: '2',
        unitPrice: '10',
        priceBasis: 'net',
        vat: { code: '23', rate: '23' },
        amounts: { net: '20', vat: '4.60', gross: '24.60' },
      }],
    });
    expect(draft.currency).toBe('PLN');
    expect(draft.items[0].amounts.net).toBe('20.00');
    expect(draft.totals).toEqual({ net: '20.00', vat: '4.60', gross: '24.60' });
    expect(validateFinalizableInvoice(draft)).toEqual([]);
  });

  it('blocks finalization when line pricing is ambiguous', () => {
    const draft = normalizeInvoiceDraft({
      source: { provider: 'warehouse_order', entityType: 'order', entityId: 'abc' },
      seller: { name: 'Seller' },
      issueDate: '2026-09-13',
      items: [{ name: 'Towar', quantity: 1, unitPrice: 10, priceBasis: PRICE_BASIS.UNKNOWN }],
    });
    const blockers = validateFinalizableInvoice(draft);
    expect(blockers).toContain('item_0_price_basis_required');
    expect(blockers).toContain('item_0_vat_code_required');
    expect(blockers).toContain('item_0_amounts_required');
  });

  it('builds Warehouse Order draft only with explicit ordered/fulfilled policy', () => {
    const order = {
      _id: '66f000000000000000000001',
      orderNumber: 143,
      buyerTelegramId: '926546988',
      status: 'fulfilled',
      orderType: 'manual',
      orderingSessionId: 'session-1',
      buyerSnapshot: { shopName: 'Test shop', shopCity: 'Rzeszów', shopAddress: 'Street 1' },
      items: [
        { _id: 'a', productId: 'p1', name: 'A', price: 12, quantity: 5, packed: true, packedQuantity: 3 },
        { _id: 'b', productId: 'p2', name: 'B', price: 20, quantity: 2, cancelled: true },
      ],
    };
    expect(() => buildWarehouseOrderDraftFromDocument(order, {})).toThrow();
    const raw = buildWarehouseOrderDraftFromDocument(order, { quantityMode: 'fulfilled' });
    const draft = normalizeInvoiceDraft(raw);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].quantity).toBe('3');
    expect(draft.items[0].priceBasis).toBe('unknown');
    expect(draft.source.externalNumber).toBe('143');
  });

  it('produces stable canonical snapshot JSON regardless of object key order', () => {
    const a = buildSnapshotPayload(normalizeInvoiceDraft({
      source: { provider: 'manual', entityType: 'manual', entityId: 'x', metadata: { z: 1, a: 2 } },
      seller: { name: 'S' }, issueDate: '2026-09-13', items: [],
    }));
    const b = buildSnapshotPayload(normalizeInvoiceDraft({
      issueDate: '2026-09-13', seller: { name: 'S' }, items: [],
      source: { metadata: { a: 2, z: 1 }, entityId: 'x', entityType: 'manual', provider: 'manual' },
    }));
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});

'use strict';

const { isValidPolishNip, normalizePolishNip } = require('../services/invoices/taxId');
const { calculateItemAmounts, completeItemAmounts } = require('../services/invoices/pricing');
const { normalizeInvoiceDraft, validateFinalizableInvoice } = require('../services/invoices/contract');
const { buildWarehouseOrderDraftFromDocument } = require('../services/invoices/sourceProviders/warehouseOrder');

// Pure-domain tests: no Mongo connection and no KSeF network are required.
describe('Invoice Core Stage 2', () => {
  it('validates and normalizes a Polish NIP', () => {
    expect(normalizePolishNip('PL 526-025-09-95')).toBe('5260250995');
    expect(isValidPolishNip('5260250995')).toBe(true);
    expect(isValidPolishNip('5260250994')).toBe(false);
  });

  it('calculates NET-basis VAT with decimal-safe rounding', () => {
    expect(calculateItemAmounts({
      quantity: '3', unitPrice: '9.99', priceBasis: 'net', vat: { code: '23', rate: '23' },
    })).toEqual({ net: '29.97', vat: '6.89', gross: '36.86' });
  });

  it('calculates GROSS-basis VAT without floating point drift', () => {
    expect(calculateItemAmounts({
      quantity: '1', unitPrice: '12.30', priceBasis: 'gross', vat: { code: '23', rate: '23' },
    })).toEqual({ net: '10.00', vat: '2.30', gross: '12.30' });
  });

  it('keeps explicit amounts but later validation catches mismatches', () => {
    const item = {
      name: 'Towar', quantity: '1', unitPrice: '10', priceBasis: 'net',
      vat: { code: '23', rate: '23' }, amounts: { net: '10', vat: '1', gross: '11' },
    };
    expect(completeItemAmounts(item)).toEqual({ net: '10', vat: '1', gross: '11' });
    const draft = normalizeInvoiceDraft({
      source: { provider: 'manual', entityType: 'manual', entityId: 'x' },
      seller: { legalEntityId: 'le-1', name: 'Seller' },
      issueDate: '2026-09-13',
      invoiceNumber: 'FV/1/2026',
      items: [item],
      totals: { net: '10', vat: '1', gross: '11' },
    });
    expect(validateFinalizableInvoice(draft)).toContain('item_0_pricing_amounts_mismatch');
  });

  it('Warehouse Order fulfilled mode excludes cancelled and unpacked quantities', () => {
    const raw = buildWarehouseOrderDraftFromDocument({
      _id: '66f000000000000000000001', orderNumber: 7,
      items: [
        { _id: 'a', productId: 'p1', name: 'A', quantity: 5, packedQuantity: 3, price: 2 },
        { _id: 'b', productId: 'p2', name: 'B', quantity: 2, packed: false, price: 3 },
        { _id: 'c', productId: 'p3', name: 'C', quantity: 4, packed: true, cancelled: true, price: 4 },
      ],
    }, {
      quantityMode: 'fulfilled', priceBasis: 'net', defaultVat: { code: '23', rate: '23' },
    });
    const draft = normalizeInvoiceDraft(raw);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0].quantity).toBe('3');
    expect(draft.items[0].amounts).toEqual({ net: '6.00', vat: '1.38', gross: '7.38' });
  });
});

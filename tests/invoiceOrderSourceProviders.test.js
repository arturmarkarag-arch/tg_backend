'use strict';

const {
  normalizeOrderSourceSnapshot,
  validateOrderSourceSnapshot,
  snapshotHash,
  buildInvoiceDraftFromOrderSnapshot,
} = require('../services/invoices/sourceProviders/orderSourceContract');
const { snapshotFromBaseLinkerOrder } = require('../services/invoices/sourceProviders/baseLinkerOrder');
const { snapshotFromAllegroOrder } = require('../services/invoices/sourceProviders/allegroOrder');

function validSnapshot(overrides = {}) {
  return {
    provider: 'example',
    adapter: 'example_order',
    accountId: 'account-1',
    orderId: 'order-1',
    externalNumber: 'EXT-1',
    revision: '1',
    observedAt: '2026-09-14T12:00:00.000Z',
    confirmed: true,
    invoiceRequested: true,
    currency: 'PLN',
    saleDate: '2026-09-14',
    buyer: {
      name: 'Acme Sp. z o.o.',
      taxId: '5252674798',
      taxIdType: 'nip',
      email: 'invoice@example.test',
      address: { street: 'Prosta 1', postalCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
    },
    items: [{
      sourceLineId: 'line-1', productRef: 'sku-1', name: 'Towar', quantity: '2', unit: 'szt.',
      unitPriceGross: '123.00', currency: 'PLN', vat: { code: '23', rate: '23' },
    }],
    delivery: { name: 'Dostawa', gross: '0', currency: 'PLN', vat: {} },
    payment: { method: 'transfer', paid: true, paidAt: '2026-09-14T12:10:00Z' },
    discountsPresent: false,
    ...overrides,
  };
}

describe('provider-authoritative invoice order source contract', () => {
  test('builds immutable-source invoice facts from one valid upstream snapshot', () => {
    const draft = buildInvoiceDraftFromOrderSnapshot(validSnapshot(), { issueDate: '2026-09-15' });
    expect(draft.source.provider).toBe('example');
    expect(draft.source.metadata.authority).toBe('upstream_order');
    expect(draft.source.metadata.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(draft.buyer.taxId).toBe('5252674798');
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]).toMatchObject({ unitPrice: '123', priceBasis: 'gross', vat: { code: '23', rate: '23' } });
  });

  test('snapshot hash ignores observation time but changes with business facts', () => {
    const a = normalizeOrderSourceSnapshot(validSnapshot({ observedAt: '2026-09-14T10:00:00Z' }));
    const b = normalizeOrderSourceSnapshot(validSnapshot({ observedAt: '2026-09-14T11:00:00Z' }));
    expect(snapshotHash(a)).toBe(snapshotHash(b));
    b.items[0].quantity = '3';
    expect(snapshotHash(a)).not.toBe(snapshotHash(b));
  });

  test('fails closed when an order line has no VAT', () => {
    const input = validSnapshot({ items: [{ sourceLineId: 'line-1', name: 'Towar', quantity: 1, unitPriceGross: 10, currency: 'PLN', vat: {} }] });
    expect(validateOrderSourceSnapshot(input).blockers).toContain('invoice_source_item_0_vat_required');
  });

  test('fails closed for paid delivery without an explicit delivery VAT fact', () => {
    const input = validSnapshot({ delivery: { name: 'Kurier', gross: '12.99', currency: 'PLN', vat: {} } });
    expect(validateOrderSourceSnapshot(input).blockers).toContain('invoice_source_delivery_vat_required');
  });

  test('allows an explicit audited delivery VAT override without changing the upstream hash', () => {
    const input = validSnapshot({ delivery: { name: 'Kurier', gross: '12.99', currency: 'PLN', vat: {} } });
    const draft = buildInvoiceDraftFromOrderSnapshot(input, {
      issueDate: '2026-09-15',
      sourceOverrides: { deliveryVatRate: '23' },
    });
    expect(draft.items.at(-1)).toMatchObject({
      sourceLineId: 'delivery', unitPrice: '12.99', vat: { code: '23', rate: '23' },
    });
    expect(draft.source.metadata.overrides).toEqual({ deliveryVatRate: '23', deliveryVatSource: 'operator' });
    expect(draft.source.metadata.snapshotSha256).toBe(snapshotHash(input));
  });

  test('rejects a delivery VAT override outside the supported KSeF rates', () => {
    const input = validSnapshot({ delivery: { name: 'Kurier', gross: '12.99', currency: 'PLN', vat: {} } });
    expect(() => buildInvoiceDraftFromOrderSnapshot(input, {
      sourceOverrides: { deliveryVatRate: '7' },
    })).toThrow(expect.objectContaining({ code: 'invoice_source_contract_invalid' }));
  });

  test('fails closed while upstream discounts are not losslessly allocated', () => {
    expect(validateOrderSourceSnapshot(validSnapshot({ discountsPresent: true })).blockers)
      .toContain('invoice_source_discounts_not_supported');
  });

  test('maps BaseLinker billing, gross price and tax rate without using the local order index', () => {
    const snapshot = snapshotFromBaseLinkerOrder({
      order_id: 7834521,
      external_order_id: 'EXT-7834521',
      confirmed: true,
      date_confirmed: 1789387200,
      date_in_status: 1789387200,
      currency: 'PLN',
      want_invoice: '1',
      invoice_company: 'Kupujący Sp. z o.o.',
      invoice_nip: '5252674798',
      invoice_address: 'Prosta 1', invoice_postcode: '00-001', invoice_city: 'Warszawa', invoice_country_code: 'PL',
      email: 'buyer@example.test', phone: '500100200',
      payment_method: 'PayU', payment_done: 123,
      delivery_method: 'Odbiór', delivery_price: 0,
      products: [{ order_product_id: 9876, product_id: '2847', name: 'Towar BL', price_brutto: 123, tax_rate: 23, quantity: 1, sku: 'SKU-1' }],
      discounts: [],
    }, { accountId: 'bl-account' });
    expect(snapshot).toMatchObject({ provider: 'baselinker', adapter: 'baselinker_order', confirmed: true, invoiceRequested: true, currency: 'PLN' });
    expect(snapshot.buyer).toMatchObject({ name: 'Kupujący Sp. z o.o.', taxId: '5252674798' });
    expect(snapshot.items[0]).toMatchObject({ name: 'Towar BL', unitPriceGross: '123', vat: { code: '23', rate: '23' } });
  });

  test('maps Allegro invoice address and lineItems tax from the exact checkout form', () => {
    const snapshot = snapshotFromAllegroOrder({
      id: '29738e61-7f6a-11e8-ac45-09db60ede9d6',
      revision: '819b5836',
      status: 'READY_FOR_PROCESSING',
      updatedAt: '2026-09-14T12:00:00Z',
      buyer: { email: 'buyer@example.test' },
      invoice: {
        required: true,
        address: {
          street: 'Prosta 1', zipCode: '00-001', city: 'Warszawa', countryCode: 'PL',
          company: { name: 'Kupujący Sp. z o.o.', taxId: '5252674798' },
        },
      },
      delivery: { cost: { amount: '0.00', currency: 'PLN' }, method: { name: 'Odbiór' } },
      payment: { type: 'ONLINE', finishedAt: '2026-09-14T12:05:00Z' },
      lineItems: [{
        id: 'line-1', quantity: 1, boughtAt: '2026-09-14T11:59:00Z',
        offer: { id: 'offer-1', name: 'Towar Allegro' },
        price: { amount: '99.99', currency: 'PLN' }, tax: { rate: '23.00', subject: 'GOODS' }, discounts: [],
      }],
    }, { accountId: 'allegro-account' });
    expect(snapshot).toMatchObject({ provider: 'allegro', adapter: 'allegro_order', confirmed: true, invoiceRequested: true, currency: 'PLN' });
    expect(snapshot.buyer).toMatchObject({ name: 'Kupujący Sp. z o.o.', taxId: '5252674798' });
    expect(snapshot.items[0].vat).toMatchObject({ code: '23.00', rate: '23' });
  });
});

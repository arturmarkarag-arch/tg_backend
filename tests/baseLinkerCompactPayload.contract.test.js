const {
  compactOrder,
  compactProductCatalog,
} = require('../services/baseLinkerPublicDto');
const { buildOrdersParameters } = require('../services/baseLinkerOrders');
const { publicState } = require('../services/baseLinkerPicking');

describe('BaseLinker compact worker payload', () => {
  it('keeps only worker-list order fields and removes customer/payment/invoice payload', () => {
    const compact = compactOrder({
      order_id: 156189781,
      shop_order_id: 123,
      external_order_id: 'ext-1',
      order_source: 'allegro',
      order_source_id: 24035,
      order_status_id: 178231,
      confirmed: true,
      date_confirmed: 100,
      date_add: 90,
      phone: '+48123456789',
      email: 'buyer@example.com',
      delivery_fullname: 'Buyer Name',
      invoice_nip: '123',
      payment_done: 99.99,
      commissions: [{ cost_brutto: 10 }],
      custom_extra_fields: { secret: 'x' },
      products: [{
        storage: 'db',
        storage_id: 26108,
        order_product_id: 276868452,
        product_id: '363990137',
        variant_id: '0',
        name: 'Product',
        sku: 'SKU',
        ean: '5900000000000',
        auction_id: 'A1',
        quantity: 17,
        price_brutto: 25,
        tax_rate: 23,
        transaction_id: 'secret-transaction',
        weight: 0.5,
      }],
    });

    expect(compact).toEqual({
      order_id: 156189781,
      shop_order_id: 123,
      external_order_id: 'ext-1',
      order_source: 'allegro',
      order_source_id: 24035,
      order_status_id: 178231,
      confirmed: true,
      date_confirmed: 100,
      date_add: 90,
      products: [{
        storage: 'db',
        storage_id: 26108,
        order_product_id: 276868452,
        product_id: '363990137',
        variant_id: '0',
        name: 'Product',
        sku: 'SKU',
        ean: '5900000000000',
        auction_id: 'A1',
        quantity: 17,
      }],
    });
    expect(JSON.stringify(compact)).not.toMatch(/phone|email|invoice|payment|commission|transaction|price_brutto|tax_rate|weight/);
  });

  it('returns only one image and never exposes the full BaseLinker product object', () => {
    const compact = compactProductCatalog({
      'db:1:2': {
        state: 'resolved',
        source: 'inventory',
        images: ['https://cdn/1.jpg', 'https://cdn/2.jpg'],
        product: { text_fields: { description: 'very long html' }, prices: { x: 10 }, stock: { x: 4 } },
      },
    });
    expect(compact).toEqual({
      'db:1:2': { state: 'resolved', images: ['https://cdn/1.jpg'] },
    });
    expect(JSON.stringify(compact)).not.toMatch(/description|prices|stock|source|product/);
  });

  it('does not request optional heavy getOrders expansions from BaseLinker', () => {
    const params = buildOrdersParameters({ includeUnconfirmed: true });
    expect(params).toEqual({ get_unconfirmed_orders: true });
  });

  it('keeps public picking state operational and drops history/fingerprints/audit metadata', () => {
    const state = publicState({
      orderId: '156189781',
      groupKey: 'external:a:b:c',
      memberOrderIds: ['156189781'],
      status: 'problem',
      revision: 10,
      ownerTelegramId: '123',
      ownerName: 'Worker',
      lastActivityAt: new Date('2026-09-05T00:00:00.000Z'),
      lastUpstreamChangeAt: null,
      lastUpstreamChangeSummary: { added: 1, removed: 0, changed: 0 },
      orderFingerprint: 'secret-fingerprint',
      packedSummary: { requestedQty: 10 },
      history: [{ action: 'order_claimed', by: '123' }],
      items: [{
        lineKey: 'op:1',
        name: 'Product',
        requestedQty: 5,
        state: 'shortage',
        pickedQty: 3,
        issueNote: '2 missing',
        sourceFingerprint: 'secret-line-fingerprint',
        updatedBy: '123',
      }],
    });

    expect(state.orderId).toBe('156189781');
    expect(state.items).toEqual([{
      lineKey: 'op:1',
      name: 'Product',
      requestedQty: 5,
      state: 'shortage',
      pickedQty: 3,
      issueNote: '2 missing',
    }]);
    expect(JSON.stringify(state)).not.toMatch(/history|Fingerprint|updatedBy|packedSummary|orderFingerprint/);
  });
});

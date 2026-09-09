'use strict';

const fs = require('fs');
const path = require('path');
const { orderFromTrackedDoc } = require('../services/baseLinkerProductImageSweep');

describe('BaseLinker tracked product image sweep', () => {
  it('rebuilds the documented product identity from a durable tracked order', () => {
    const order = orderFromTrackedDoc({
      baseLinkerAccountId: 'account-a',
      orderId: '12345',
      sourceType: 'Allegro',
      sourceId: '12179',
      items: [{
        orderProductId: '987',
        storage: 'DB',
        storageId: '11049',
        productId: '268764087',
        variantId: '0',
        auctionId: '18000000001',
        sku: 'SKU-1',
        ean: '5900000000001',
        name: 'Product',
        requestedQty: 2,
      }],
    });

    expect(order).toEqual({
      baseLinkerAccountId: 'account-a',
      order_id: 12345,
      order_source: 'allegro',
      order_source_id: '12179',
      products: [{
        order_product_id: '987',
        storage: 'db',
        storage_id: '11049',
        product_id: '268764087',
        variant_id: '0',
        auction_id: '18000000001',
        sku: 'SKU-1',
        ean: '5900000000001',
        name: 'Product',
        attributes: '',
        quantity: 2,
      }],
    });
  });

  it('rejects rows that cannot be namespaced to an account and order', () => {
    expect(orderFromTrackedDoc({ accountId: '', orderId: '1' })).toBeNull();
    expect(orderFromTrackedDoc({ baseLinkerAccountId: 'a', orderId: '' })).toBeNull();
  });

  it('runs as a bounded persistent sweep behind the central queue leader', () => {
    const sweep = fs.readFileSync(path.resolve(process.cwd(), 'services/baseLinkerProductImageSweep.js'), 'utf8');
    const scheduler = fs.readFileSync(path.resolve(process.cwd(), 'services/baseLinkerQueueScheduler.js'), 'utf8');

    expect(sweep).toContain("const SWEEP_STATE_PREFIX = 'baselinker.productImageSweep.v1'");
    expect(sweep).toContain("usageStage: 'tracked_product_image_sweep'");
    expect(sweep).toContain('maxRequests: Math.min(5');
    expect(sweep).toContain('AppSetting.findOneAndUpdate');
    expect(scheduler).toContain('await sweepTrackedProductImages(accountId)');
    expect(scheduler.indexOf('await sweepTrackedProductImages(accountId)'))
      .toBeGreaterThan(scheduler.indexOf('runAsSchedulerLeader('));
  });
});

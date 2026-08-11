'use strict';

const { summarizeSessionRows } = require('../utils/sessionSummaryMath');

describe('picking session presentation counters', () => {
  it('reports the real completed PROD-like cycle instead of 0/0', () => {
    const tasks = [
      ...Array.from({ length: 527 }, () => ({ status: 'completed', completionReason: 'packed' })),
      ...Array.from({ length: 13 }, () => ({
        status: 'completed',
        completionReason: 'out_of_stock',
        archiveReconciled: true,
      })),
    ];
    const orders = [
      ...Array.from({ length: 34 }, () => ({ status: 'fulfilled' })),
      { status: 'expired' }, // historical/admin-terminal, intentionally outside the delivery cycle
    ];

    expect(summarizeSessionRows({ tasks, orders })).toEqual({
      processedProductCount: 540,
      totalProductCount: 540,
      archivedProductCount: 13,
      archiveRequiredProductCount: 13,
      completedOrderCount: 34,
      totalOrderCount: 34,
    });
  });

  it('does not claim an interrupted OOS archive is finished', () => {
    const stats = summarizeSessionRows({
      tasks: [
        { status: 'completed', completionReason: 'out_of_stock', archiveReconciled: true },
        { status: 'completed', completionReason: 'out_of_stock', archiveReconciled: false },
        { status: 'completed', completionReason: 'system_archive' },
        { status: 'pending', completionReason: null },
      ],
      orders: [
        { status: 'fulfilled' },
        { status: 'confirmed' },
        { status: 'new' },
      ],
    });

    expect(stats.processedProductCount).toBe(3);
    expect(stats.totalProductCount).toBe(4);
    expect(stats.archiveRequiredProductCount).toBe(3);
    expect(stats.archivedProductCount).toBe(2);
    expect(stats.completedOrderCount).toBe(2);
    expect(stats.totalOrderCount).toBe(3);
  });
  it('uses archived Product as a legacy fallback when old OOS task lacks archiveReconciled', () => {
    const stats = summarizeSessionRows({
      tasks: [{
        status: 'completed',
        completionReason: 'out_of_stock',
        archiveReconciled: false,
        productId: 'legacy-product',
      }],
      orders: [{ status: 'confirmed' }],
      archivedProductIds: ['legacy-product'],
    });
    expect(stats.archivedProductCount).toBe(1);
    expect(stats.archiveRequiredProductCount).toBe(1);
  });

});

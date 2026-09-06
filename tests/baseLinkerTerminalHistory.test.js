const { scanQueue } = require('../services/baseLinkerOrderIndex');
const { queueScopeFromSettings } = require('../services/baseLinkerQueueScope');

describe('BaseLinker terminal history index', () => {
  it('scans all three configured statuses and keeps terminal rows by date_in_status', async () => {
    const now = Date.UTC(2026, 8, 6, 12, 0, 0);
    const scope = queueScopeFromSettings({
      intakeStatusId: 10,
      sentStatusId: 20,
      cancelledStatusId: 30,
      revision: 'test',
    }, now);
    const recent = Math.floor(now / 1000) - (2 * 86400);
    const expired = Math.floor(now / 1000) - (15 * 86400);
    const fetchOrders = vi.fn(async ({ statusId }) => ({
      truncated: false,
      orders: statusId === 10
        ? [{ order_id: 1, order_status_id: 10, date_in_status: expired }]
        : statusId === 20
          ? [
              { order_id: 2, order_status_id: 20, date_in_status: recent },
              { order_id: 3, order_status_id: 20, date_in_status: expired },
            ]
          : [
              { order_id: 4, order_status_id: 30, date_in_status: recent },
              { order_id: 5, order_status_id: 30, date_in_status: expired },
            ],
    }));

    const result = await scanQueue(scope, fetchOrders);

    expect(fetchOrders.mock.calls.map(([options]) => options.statusId)).toEqual([10, 20, 30]);
    expect(fetchOrders.mock.calls.every(([options]) => options.includeUnconfirmed === true)).toBe(true);
    expect(result.rows.map(({ orderId, disposition, dateInStatus }) => ({ orderId, disposition, dateInStatus }))).toEqual([
      { orderId: '1', disposition: 'intake', dateInStatus: 0 },
      { orderId: '2', disposition: 'sent', dateInStatus: recent },
      { orderId: '4', disposition: 'cancelled', dateInStatus: recent },
    ]);
  });
});

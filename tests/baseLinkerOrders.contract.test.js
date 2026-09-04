const {
  BASE_INCLUDE_FLAGS,
  buildOrdersParameters,
  fetchBaseLinkerOrders,
} = require('../services/baseLinkerOrders');

describe('BaseLinker orders adapter', () => {
  it('always requests the optional getOrders payloads so no order data is silently dropped', () => {
    expect(buildOrdersParameters({ dateConfirmedFrom: 123, statusId: 9 })).toEqual({
      ...BASE_INCLUDE_FLAGS,
      get_unconfirmed_orders: false,
      date_confirmed_from: 123,
      status_id: 9,
    });
  });

  it('follows BaseLinker 100-order cursor pages and deduplicates by order_id', async () => {
    const calls = [];
    const first = Array.from({ length: 100 }, (_, i) => ({
      order_id: i + 1,
      date_confirmed: 1000 + i,
    }));
    const second = [
      { order_id: 100, date_confirmed: 1099, changed: true },
      { order_id: 101, date_confirmed: 1100 },
    ];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return { status: 'SUCCESS', orders: calls.length === 1 ? first : second };
    };

    const result = await fetchBaseLinkerOrders({ dateConfirmedFrom: 900, maxPages: 5 }, callApi);

    expect(calls).toHaveLength(2);
    expect(calls[0].params.date_confirmed_from).toBe(900);
    expect(calls[1].params.date_confirmed_from).toBe(1100);
    expect(result.orders).toHaveLength(101);
    expect(result.orders.find((o) => o.order_id === 100)?.changed).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('marks a bounded scan as truncated instead of pretending it returned everything', async () => {
    let seq = 0;
    const callApi = async () => {
      seq += 1;
      return {
        status: 'SUCCESS',
        orders: Array.from({ length: 100 }, (_, i) => ({
          order_id: (seq * 1000) + i,
          date_confirmed: (seq * 1000) + i + 1,
        })),
      };
    };

    const result = await fetchBaseLinkerOrders({ dateConfirmedFrom: 1, maxPages: 2 }, callApi);
    expect(result.truncated).toBe(true);
    expect(result.nextDateConfirmedFrom).toBeGreaterThan(1);
  });
  it('uses creation-date + id cursor when unconfirmed orders are requested', async () => {
    const calls = [];
    const first = Array.from({ length: 100 }, (_, i) => ({ order_id: i + 10, date_add: 2000 + i, date_confirmed: 0 }));
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return { status: 'SUCCESS', orders: calls.length === 1 ? first : [] };
    };

    await fetchBaseLinkerOrders({ dateConfirmedFrom: 1500, includeUnconfirmed: true, maxPages: 3 }, callApi);
    expect(calls[0].params.date_from).toBe(1500);
    expect(calls[0].params.date_confirmed_from).toBeUndefined();
    expect(calls[1].params.id_from).toBe(110);
  });

});

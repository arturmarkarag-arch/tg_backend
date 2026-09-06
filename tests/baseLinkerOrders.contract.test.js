const {
  BASE_INCLUDE_FLAGS,
  buildOrdersParameters,
  fetchBaseLinkerOrders,
} = require('../services/baseLinkerOrders');

describe('BaseLinker orders adapter', () => {
  it('has no date/period scan mode: queue reads are status + id_from only', () => {
    expect(buildOrdersParameters({ statusId: 9, idFrom: 123 })).toEqual({
      ...BASE_INCLUDE_FLAGS,
      get_unconfirmed_orders: false,
      status_id: 9,
      id_from: 123,
    });
    expect(buildOrdersParameters({ statusId: 9 })).not.toHaveProperty('date_confirmed_from');
    expect(buildOrdersParameters({ statusId: 9 })).not.toHaveProperty('date_from');
  });

  it('follows BaseLinker 100-order id_from pages and deduplicates by order_id', async () => {
    const calls = [];
    const first = Array.from({ length: 100 }, (_, i) => ({
      order_id: i + 1,
      date_confirmed: 1000 + i,
    }));
    const second = [
      { order_id: 101, date_confirmed: 1100 },
      { order_id: 102, date_confirmed: 1101 },
    ];
    const callApi = async (method, params) => {
      calls.push({ method, params });
      return { status: 'SUCCESS', orders: calls.length === 1 ? first : second };
    };

    const result = await fetchBaseLinkerOrders({ statusId: 9, maxPages: 5 }, callApi);

    expect(calls).toHaveLength(2);
    expect(calls[0].params).not.toHaveProperty('id_from');
    expect(calls[1].params.id_from).toBe(101);
    expect(result.orders).toHaveLength(102);
    expect(result.truncated).toBe(false);
    expect(result.nextIdFrom).toBeNull();
  });

  it('marks a bounded status scan as truncated instead of pretending it returned everything', async () => {
    let seq = 0;
    const callApi = async () => {
      seq += 1;
      return {
        status: 'SUCCESS',
        orders: Array.from({ length: 100 }, (_, i) => ({
          order_id: ((seq - 1) * 100) + i + 1,
          date_confirmed: (seq * 1000) + i,
        })),
      };
    };

    const result = await fetchBaseLinkerOrders({ statusId: 9, maxPages: 2 }, callApi);
    expect(result.truncated).toBe(true);
    expect(result.nextIdFrom).toBe(201);
  });

  it('rejects unfiltered or invalid exact scans before calling upstream', async () => {
    const callApi = vi.fn();
    for (const options of [{}, { orderId: 'bad' }]) {
      await expect(fetchBaseLinkerOrders(options, callApi)).rejects.toBeDefined();
    }
    expect(callApi).not.toHaveBeenCalled();
  });

  it('allows the selected intake status to include unconfirmed orders without adding a date filter', async () => {
    const callApi = vi.fn(async () => ({ status: 'SUCCESS', orders: [] }));
    await fetchBaseLinkerOrders({ statusId: 9, includeUnconfirmed: true }, callApi);
    expect(callApi).toHaveBeenCalledWith('getOrders', {
      status_id: 9,
      get_unconfirmed_orders: true,
    });
  });

  it('exact order lookup is one account-bound API request and ignores cursor pagination', async () => {
    const callApi = vi.fn(async () => ({ status: 'SUCCESS', orders: [{ order_id: 123 }] }));
    const result = await fetchBaseLinkerOrders({ orderId: 123, includeUnconfirmed: true, maxPages: 90 }, callApi);
    expect(callApi).toHaveBeenCalledTimes(1);
    expect(callApi).toHaveBeenCalledWith('getOrders', { get_unconfirmed_orders: true, order_id: 123 });
    expect(result.orders).toEqual([{ order_id: 123 }]);
  });
});

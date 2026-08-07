'use strict';

const PickingTask = require('../models/PickingTask');
const OrderingSession = require('../models/OrderingSession');

describe('session isolation schema contracts', () => {
  it('scopes active PickingTask uniqueness by orderingSessionId', () => {
    const indexes = PickingTask.schema.indexes();
    const [, opts] = indexes.find(([, options]) => options?.name === 'one_active_task_per_product_group_session') || [];
    const [keys] = indexes.find(([, options]) => options?.name === 'one_active_task_per_product_group_session') || [];

    expect(keys).toEqual({ productId: 1, deliveryGroupId: 1, orderingSessionId: 1 });
    expect(opts?.unique).toBe(true);
    expect(opts?.partialFilterExpression).toEqual({ status: { $in: ['pending', 'locked'] } });
  });

  it('keeps one OrderingSession per delivery group + openDate', () => {
    const indexes = OrderingSession.schema.indexes();
    const [keys, opts] = indexes.find(([k, o]) => o?.unique && k.groupId === 1 && k.openDate === 1) || [];
    expect(keys).toEqual({ groupId: 1, openDate: 1 });
    expect(opts?.unique).toBe(true);
  });
});

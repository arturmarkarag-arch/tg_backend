'use strict';

const { buildUnreconciledOosTaskFilter } = require('../utils/pickingOosRecovery');

describe('Picking OOS recovery predicate', () => {
  it('uses completionReason as the authoritative OOS signal', () => {
    expect(buildUnreconciledOosTaskFilter({ deliveryGroupId: 'g1' })).toEqual({
      deliveryGroupId: 'g1',
      status: 'completed',
      completionReason: 'out_of_stock',
      archiveReconciled: { $ne: true },
    });
  });

  it('cannot be weakened by caller-provided lifecycle fields', () => {
    expect(buildUnreconciledOosTaskFilter({
      productId: 'p1',
      status: 'pending',
      completionReason: 'packed',
      archiveReconciled: true,
    })).toEqual({
      productId: 'p1',
      status: 'completed',
      completionReason: 'out_of_stock',
      archiveReconciled: { $ne: true },
    });
  });
});

const {
  ORDER_STATUS,
  WRITABLE_ITEM_STATES,
  ISSUE_STATES,
  deriveWorkingStatus,
  packingReadiness,
} = require('../domain/baseLinkerPickingState');

const picked = (requestedQty = 2) => ({ state: 'picked', requestedQty, pickedQty: requestedQty });
const pending = (requestedQty = 2) => ({ state: 'pending', requestedQty, pickedQty: 0 });
const shortage = (requestedQty = 3, pickedQty = 1) => ({ state: 'shortage', requestedQty, pickedQty });

describe('BaseLinker picking state machine', () => {
  it('keeps completed work ready even when ownership is released', () => {
    expect(deriveWorkingStatus([picked()], true)).toBe(ORDER_STATUS.READY);
    expect(deriveWorkingStatus([picked()], false)).toBe(ORDER_STATUS.READY);
    expect(deriveWorkingStatus([shortage()], true)).toBe(ORDER_STATUS.READY_WITH_ISSUE);
    expect(deriveWorkingStatus([shortage()], false)).toBe(ORDER_STATUS.READY_WITH_ISSUE);
  });

  it('keeps an unresolved issue in problem until every line is handled', () => {
    expect(deriveWorkingStatus([shortage(), pending()], true)).toBe(ORDER_STATUS.PROBLEM);
    expect(deriveWorkingStatus([shortage(), picked()], true)).toBe(ORDER_STATUS.READY_WITH_ISSUE);
  });

  it('allows only the two current worker problem reasons for new writes', () => {
    expect(WRITABLE_ITEM_STATES.has('not_found')).toBe(true);
    expect(WRITABLE_ITEM_STATES.has('shortage')).toBe(true);
    expect(WRITABLE_ITEM_STATES.has('damaged')).toBe(false);
    expect(WRITABLE_ITEM_STATES.has('other')).toBe(false);
    expect(ISSUE_STATES.has('damaged')).toBe(true);
    expect(ISSUE_STATES.has('other')).toBe(true);
  });

  it('calculates physical packed quantity separately from requested quantity', () => {
    expect(packingReadiness([picked(2), shortage(3, 1)])).toMatchObject({
      totalQty: 5,
      pickedQty: 3,
      missingQty: 2,
      allHandled: true,
      hasIssues: true,
    });
  });
});

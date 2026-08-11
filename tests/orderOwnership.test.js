const { isOwnershipFrozenFromSession } = require('../utils/orderOwnership');

describe('order ownership freeze', () => {
  test('stays transferable while ordering is open and picking is pending', () => {
    const now = new Date('2026-08-11T18:00:00.000Z');
    expect(isOwnershipFrozenFromSession({
      closeAt: new Date('2026-08-11T19:00:00.000Z'),
      pickingStatus: 'pending',
    }, now)).toBe(false);
  });

  test('freezes exactly when the ordering window closes', () => {
    const closeAt = new Date('2026-08-11T19:00:00.000Z');
    expect(isOwnershipFrozenFromSession({ closeAt, pickingStatus: 'pending' }, closeAt)).toBe(true);
  });

  test('fails closed when closeAt is missing', () => {
    expect(isOwnershipFrozenFromSession({ pickingStatus: 'pending' }, new Date())).toBe(true);
  });

  test('freezes as soon as picking leaves pending even before closeAt', () => {
    const now = new Date('2026-08-11T18:00:00.000Z');
    expect(isOwnershipFrozenFromSession({
      closeAt: new Date('2026-08-11T19:00:00.000Z'),
      pickingStatus: 'confirmed',
    }, now)).toBe(true);
  });
});

'use strict';

const {
  deriveSellerTelegramGroupAccess,
  ACCESS_ALLOWED,
  ACCESS_DENIED,
  ACCESS_UNVERIFIED,
} = require('../services/sellerTelegramGroupAccess');

describe('seller Telegram group access decision', () => {
  const groups = ['-1001', '-1002'];

  it('allows when any configured work group confirms presence', () => {
    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: 'left', left: true },
      { groupChatId: '-1002', telegramStatus: 'member', left: false },
    ], groups)).toEqual({
      state: ACCESS_ALLOWED,
      reason: 'member',
      groupId: '-1002',
    });
  });

  it('denies only when every configured work group confirms absence', () => {
    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: 'left', left: true },
      { groupChatId: '-1002', telegramStatus: 'kicked', left: true },
    ], groups)).toEqual({
      state: ACCESS_DENIED,
      reason: 'not_in_group',
      groupId: '',
    });
  });

  it('keeps missing/unknown evidence unverified instead of treating it as absence', () => {
    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: 'left', left: true },
      { groupChatId: '-1002', telegramStatus: 'unknown', left: true },
    ], groups).state).toBe(ACCESS_UNVERIFIED);

    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: 'left', left: true },
    ], groups).state).toBe(ACCESS_UNVERIFIED);
  });

  it('supports passive legacy rows without telegramStatus', () => {
    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: '', left: false },
    ], ['-1001']).state).toBe(ACCESS_ALLOWED);

    expect(deriveSellerTelegramGroupAccess([
      { groupChatId: '-1001', telegramStatus: '', left: true },
    ], ['-1001']).state).toBe(ACCESS_DENIED);
  });

  it('cannot authorize a seller when no work group is configured', () => {
    expect(deriveSellerTelegramGroupAccess([], [])).toEqual({
      state: ACCESS_UNVERIFIED,
      reason: 'group_not_configured',
      groupId: '',
    });
  });
});

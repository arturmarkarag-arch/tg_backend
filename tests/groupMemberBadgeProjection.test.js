'use strict';

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');
const { countUnregisteredPresentMembers } = require('../services/groupMemberSync');

function leanResult(rows) {
  return { lean: vi.fn().mockResolvedValue(rows) };
}

describe('countUnregisteredPresentMembers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts only persisted present unregistered rows and preserves duplicate group membership', async () => {
    const members = [
      { telegramId: '1', telegramStatus: 'member', left: false },
      { telegramId: '1', telegramStatus: 'administrator', left: false }, // same person in another group = second badge row
      { telegramId: '2', telegramStatus: '', left: false }, // legacy present
      { telegramId: '3', telegramStatus: 'left', left: true },
      { telegramId: '4', telegramStatus: 'unknown', left: false },
      { telegramId: '5', telegramStatus: 'restricted', left: false },
    ];
    const groupFind = vi.spyOn(GroupMember, 'find').mockReturnValue(leanResult(members));
    const userFind = vi.spyOn(User, 'find').mockReturnValue(leanResult([
      { telegramId: '5' }, // registered: must not count
    ]));

    const count = await countUnregisteredPresentMembers(['-100A', '-100B', '-100A']);

    expect(count).toBe(3); // tid 1 twice + legacy tid 2 once
    expect(groupFind).toHaveBeenCalledTimes(1);
    expect(groupFind.mock.calls[0][0]).toEqual({
      groupChatId: { $in: ['-100A', '-100B'] },
      isBot: false,
      hiddenAt: null,
    });
    expect(userFind).toHaveBeenCalledTimes(1);
    expect(userFind.mock.calls[0][0]).toEqual({
      telegramId: { $in: ['1', '2', '5'] },
      accountState: { $ne: 'removed' },
    });
  });

  it('does not query users when no persisted member is currently present', async () => {
    vi.spyOn(GroupMember, 'find').mockReturnValue(leanResult([
      { telegramId: '3', telegramStatus: 'left', left: true },
      { telegramId: '4', telegramStatus: 'unknown', left: false },
    ]));
    const userFind = vi.spyOn(User, 'find');

    await expect(countUnregisteredPresentMembers(['-100A'])).resolves.toBe(0);
    expect(userFind).not.toHaveBeenCalled();
  });

  it('does no database reads when no groups are configured', async () => {
    const groupFind = vi.spyOn(GroupMember, 'find');
    const userFind = vi.spyOn(User, 'find');

    await expect(countUnregisteredPresentMembers([])).resolves.toBe(0);
    expect(groupFind).not.toHaveBeenCalled();
    expect(userFind).not.toHaveBeenCalled();
  });
});

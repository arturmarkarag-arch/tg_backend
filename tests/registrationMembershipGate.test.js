const { checkMembershipAcrossGroups } = require('../services/registrationMembershipGate');

describe('registration membership gate', () => {
  it('accepts a restricted user because they are still a group member', async () => {
    const bot = { getChatMember: vi.fn().mockResolvedValue({ status: 'restricted', user: {} }) };
    await expect(checkMembershipAcrossGroups({ bot, telegramId: '10', groupIds: ['-1001'] }))
      .resolves.toMatchObject({ allowed: true, reason: 'member', telegramStatus: 'restricted' });
  });

  it('distinguishes a Telegram failure from confirmed absence', async () => {
    const bot = { getChatMember: vi.fn().mockRejectedValue(new Error('network unavailable')) };
    await expect(checkMembershipAcrossGroups({ bot, telegramId: '10', groupIds: ['-1001'] }))
      .resolves.toEqual({ allowed: false, reason: 'check_failed' });
  });

  it('reports missing group configuration separately', async () => {
    await expect(checkMembershipAcrossGroups({ bot: {}, telegramId: '10', groupIds: [] }))
      .resolves.toEqual({ allowed: false, reason: 'group_not_configured' });
  });

  it('reports a confirmed left status as absence', async () => {
    const bot = { getChatMember: vi.fn().mockResolvedValue({ status: 'left', user: {} }) };
    await expect(checkMembershipAcrossGroups({ bot, telegramId: '10', groupIds: ['-1001'] }))
      .resolves.toEqual({ allowed: false, reason: 'not_in_group' });
  });
});

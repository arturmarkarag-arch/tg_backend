'use strict';

const { checkOneGroup } = require('../services/groupMemberAudit');

function telegramError(description, retryAfter = null) {
  const err = new Error(description);
  err.response = { body: { description } };
  if (retryAfter) err.response.body.parameters = { retry_after: retryAfter };
  return err;
}

describe('groupMemberAudit.checkOneGroup', () => {
  it.each(['member', 'administrator', 'creator', 'restricted'])('%s is present', async (status) => {
    const bot = { getChatMember: vi.fn().mockResolvedValue({ status, user: { id: 42 } }) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result.known).toBe(true);
    expect(result.present).toBe(true);
    expect(result.status).toBe(status);
  });

  it.each(['left', 'kicked'])('%s is a determinate absence', async (status) => {
    const bot = { getChatMember: vi.fn().mockResolvedValue({ status, user: { id: 42 } }) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result.known).toBe(true);
    expect(result.present).toBe(false);
    expect(result.status).toBe(status);
  });

  it('user not found is absence, not infrastructure failure', async () => {
    const bot = { getChatMember: vi.fn().mockRejectedValue(telegramError('Bad Request: user not found')) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result).toMatchObject({ known: true, present: false, status: 'not_found' });
  });

  it('Telegram/API failure stays unknown and must not become left', async () => {
    const bot = { getChatMember: vi.fn().mockRejectedValue(telegramError('ETIMEDOUT')) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result.known).toBe(false);
    expect(result.present).toBe(false);
    expect(result.status).toBe('unknown');
  });
});

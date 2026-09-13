'use strict';

const { checkOneGroup } = require('../services/groupMemberAudit');



function telegramV2Error(description, { errorCode = 500, retryAfter = null } = {}) {
  const err = new Error(description);
  err.description = description;
  err.errorCode = errorCode;
  if (retryAfter != null) err.retryAfter = retryAfter;
  return err;
}

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


  it('understands node-telegram-bot-api 2.x error shape for deterministic absence', async () => {
    const bot = { getChatMember: vi.fn().mockRejectedValue(
      telegramV2Error('Bad Request: user not found', { errorCode: 400 }),
    ) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result).toMatchObject({ known: true, present: false, status: 'not_found' });
  });

  it('honours SDK 2.x retryAfter on 429 before retrying membership lookup', async () => {
    vi.useFakeTimers();
    try {
      const bot = {
        getChatMember: vi.fn()
          .mockRejectedValueOnce(telegramV2Error('Too Many Requests: retry after 1', { errorCode: 429, retryAfter: 1 }))
          .mockResolvedValueOnce({ status: 'member', user: { id: 42 } }),
      };

      const pending = checkOneGroup(bot, '-1001', '42');
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await pending;

      expect(bot.getChatMember).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ known: true, present: true, status: 'member' });
    } finally {
      vi.useRealTimers();
    }
  });


  it('Telegram/API failure stays unknown and must not become left', async () => {
    const bot = { getChatMember: vi.fn().mockRejectedValue(telegramError('ETIMEDOUT')) };
    const result = await checkOneGroup(bot, '-1001', '42');
    expect(result.known).toBe(false);
    expect(result.present).toBe(false);
    expect(result.status).toBe('unknown');
  });
});

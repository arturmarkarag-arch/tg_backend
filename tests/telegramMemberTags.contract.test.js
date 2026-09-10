'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  formatTelegramMemberTag,
  hasEmoji,
  decideTelegramMemberTagAction,
} = require('../utils/telegramMemberTagPolicy');
const { applyTelegramMemberTag } = require('../services/telegramMemberTagSync');

describe('Telegram shop member tags contract', () => {
  it('formats #ShopName with a 16-character Unicode ceiling', () => {
    expect(formatTelegramMemberTag('Poznań')).toBe('#Poznań');
    expect(formatTelegramMemberTag('VeryLongShopName123')).toBe('#VeryLongShopNam');
    expect(Array.from(formatTelegramMemberTag('ŻółćŻółćŻółćŻółćŻółć')).length).toBeLessThanOrEqual(16);
  });

  it('rejects emoji instead of silently inventing a rewritten shop tag', () => {
    expect(hasEmoji('#Shop🔥')).toBe(true);
    expect(hasEmoji('#Poznań')).toBe(false);
  });

  it('never writes administrator/creator/restricted and no-ops correct member tags', () => {
    expect(decideTelegramMemberTagAction({ status: 'administrator', desiredTag: '#Poznań' })).toEqual({ result: 'skipped_admin', write: false });
    expect(decideTelegramMemberTagAction({ status: 'creator', desiredTag: '#Poznań' })).toEqual({ result: 'skipped_creator', write: false });
    expect(decideTelegramMemberTagAction({ status: 'restricted', desiredTag: '#Poznań' }).write).toBe(false);
    expect(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '#Poznań' })).toEqual({ result: 'unchanged', write: false });
  });

  it('updates or clears only ordinary members when actual differs from desired', () => {
    expect(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '#Warszawa' })).toEqual({ result: 'updated', write: true });
    expect(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '' })).toEqual({ result: 'cleared', write: true });
  });

  it('uses the library setChatMemberTag options contract and skips admin writes', async () => {
    const calls = [];
    const memberBot = {
      getChatMember: async () => ({ status: 'member', tag: '#Poznań' }),
      setChatMemberTag: async (...args) => { calls.push(args); return true; },
    };
    const updated = await applyTelegramMemberTag({
      bot: memberBot,
      chatId: '-100123',
      telegramId: '123456',
      desiredTag: '#Warszawa',
    });
    expect(updated.result).toBe('updated');
    expect(calls).toEqual([['-100123', 123456, { tag: '#Warszawa' }]]);

    const adminCalls = [];
    const adminBot = {
      getChatMember: async () => ({ status: 'administrator', custom_title: 'Administrator' }),
      setChatMemberTag: async (...args) => adminCalls.push(args),
    };
    const skipped = await applyTelegramMemberTag({
      bot: adminBot,
      chatId: '-100123',
      telegramId: '123456',
      desiredTag: '#Warszawa',
    });
    expect(skipped.result).toBe('skipped_admin');
    expect(adminCalls).toEqual([]);
  });

  it('clears by sending an empty tag and treats missing participant as a skip', async () => {
    const calls = [];
    const bot = {
      getChatMember: async () => ({ status: 'member', tag: '#Poznań' }),
      setChatMemberTag: async (...args) => { calls.push(args); return true; },
    };
    const cleared = await applyTelegramMemberTag({ bot, chatId: '-100123', telegramId: '123456', desiredTag: '' });
    expect(cleared.result).toBe('cleared');
    expect(calls).toEqual([['-100123', 123456, { tag: '' }]]);

    const absent = new Error('Bad Request: USER_NOT_PARTICIPANT');
    absent.response = { body: { error_code: 400, description: 'Bad Request: USER_NOT_PARTICIPANT' } };
    const missing = await applyTelegramMemberTag({
      bot: { getChatMember: async () => { throw absent; } },
      chatId: '-100123',
      telegramId: '123456',
      desiredTag: '#Poznań',
    });
    expect(missing.result).toBe('not_in_group');
    expect(missing.writePerformed).toBe(false);
  });

  it('passes the architecture/source gate', () => {
    const script = path.join(__dirname, '..', 'scripts', 'checkTelegramMemberTagsArchitecture20260910.js');
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
  });
});

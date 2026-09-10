'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  formatTelegramMemberTag,
  hasEmoji,
  decideTelegramMemberTagAction,
} = require('../utils/telegramMemberTagPolicy');
const { applyTelegramMemberTag, cleanupManagedTag } = require('../services/telegramMemberTagSync');
const { setChatMemberTag } = require('../services/telegramMemberTagTransport');

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

  it('updates or clears only ordinary members through injected member-tag transport', async () => {
    const calls = [];
    const bot = { getChatMember: async () => ({ status: 'member', tag: '#Poznań' }) };
    const setMemberTag = async (...args) => { calls.push(args); return true; };

    const updated = await applyTelegramMemberTag({
      bot, chatId: '-100123', telegramId: '123456', desiredTag: '#Warszawa', setMemberTag,
    });
    expect(updated.result).toBe('updated');
    expect(calls).toEqual([[bot, '-100123', 123456, '#Warszawa']]);

    const cleared = await applyTelegramMemberTag({
      bot, chatId: '-100123', telegramId: '123456', desiredTag: '', setMemberTag,
    });
    expect(cleared.result).toBe('cleared');
    expect(calls[1]).toEqual([bot, '-100123', 123456, '']);
  });

  it('never touches admin titles and ownership-protects cleanup', async () => {
    const calls = [];
    const admin = await applyTelegramMemberTag({
      bot: { getChatMember: async () => ({ status: 'administrator', custom_title: 'Administrator' }) },
      chatId: '-100123', telegramId: '123456', desiredTag: '#Warszawa',
      setMemberTag: async (...args) => calls.push(args),
    });
    expect(admin.result).toBe('skipped_admin');
    expect(calls).toEqual([]);

    const changed = await cleanupManagedTag({
      bot: { getChatMember: async () => ({ status: 'member', tag: '#ManualTag' }) },
      chatId: '-100123', telegramId: '123456', cleanupTag: '#Poznań',
      setMemberTag: async (...args) => calls.push(args),
    });
    expect(changed.result).toBe('cleanup_skipped_tag_changed');
    expect(calls).toEqual([]);
  });

  it('maps setChatMemberTag through the existing SDK generic request transport', async () => {
    const calls = [];
    const bot = {
      _request: async (...args) => { calls.push(args); return true; },
    };
    await setChatMemberTag(bot, '-100123', 123456, '#Poznań');
    expect(calls).toEqual([[
      'setChatMemberTag',
      { form: { chat_id: '-100123', user_id: 123456, tag: '#Poznań' } },
    ]]);
  });

  it('passes the architecture/source gate', () => {
    const script = path.join(__dirname, '..', 'scripts', 'checkTelegramMemberTagsArchitecture20260910.js');
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
  });
});

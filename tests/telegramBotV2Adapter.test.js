'use strict';

const { TelegramBotV2Adapter, normalizeReplyOptions } = require('../services/telegramBotV2Adapter');

describe('TelegramBotV2Adapter', () => {
  it('maps legacy positional calls to SDK 2.x wire-shaped params', async () => {
    const adapter = new TelegramBotV2Adapter('123:test');
    const calls = [];
    adapter.api = {
      sendMessage: async (params) => { calls.push(['sendMessage', params]); return params; },
      answerCallbackQuery: async (params) => { calls.push(['answerCallbackQuery', params]); return true; },
      setChatMemberTag: async (params) => { calls.push(['setChatMemberTag', params]); return true; },
    };

    await adapter.sendMessage('-1001', 'hello', {
      reply_to_message_id: 7,
      allow_sending_without_reply: true,
      disable_web_page_preview: true,
    });
    await adapter.answerCallbackQuery('callback-1', { text: 'ok' });
    await adapter.setChatMemberTag({ chat_id: '-1001', user_id: 9, tag: '#Shop' });

    expect(calls).toEqual([
      ['sendMessage', {
        chat_id: '-1001',
        text: 'hello',
        reply_parameters: { message_id: 7, allow_sending_without_reply: true },
        link_preview_options: { is_disabled: true },
      }],
      ['answerCallbackQuery', { callback_query_id: 'callback-1', text: 'ok' }],
      ['setChatMemberTag', { chat_id: '-1001', user_id: 9, tag: '#Shop' }],
    ]);
  });

  it('delivers raw legacy event payloads through the SDK 2.x Context', async () => {
    const adapter = new TelegramBotV2Adapter('123:test');
    const received = [];
    adapter.on('message', async (message) => { received.push(message); });

    const message = {
      message_id: 3,
      date: 1,
      chat: { id: 42, type: 'private' },
      text: '/start',
    };
    await adapter.processUpdate({ update_id: 1, message });
    expect(received).toEqual([message]);
  });

  it('does not perform hidden SDK retries for ambiguous send failures', async () => {
    let attempts = 0;
    const adapter = new TelegramBotV2Adapter('123:test', {
      fetch: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          ok: false,
          error_code: 500,
          description: 'Internal Server Error',
        }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await expect(adapter.sendMessage(42, 'hello')).rejects.toMatchObject({
      code: 'ETELEGRAM',
      errorCode: 500,
    });
    expect(attempts).toBe(1);
  });

  it('does not leave deprecated reply and link-preview fields on the wire', () => {
    expect(normalizeReplyOptions({ reply_to_message_id: 8, disable_web_page_preview: false }))
      .toEqual({
        reply_parameters: { message_id: 8 },
        link_preview_options: { is_disabled: false },
      });
  });
});

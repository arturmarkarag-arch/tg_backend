'use strict';

/**
 * Compatibility adapter for Bot API methods newer than the public method list in
 * node-telegram-bot-api 0.67.x. The installed SDK already exposes a generic
 * _request(path, options) transport internally, so we reuse its configured
 * timeout/baseApiUrl/proxy/error handling instead of maintaining a second HTTP stack.
 *
 * The dependency is constrained to ^0.67.0 (<0.68.0), so this private adapter is
 * isolated here and has an explicit runtime guard. A future SDK migration only
 * needs to replace this one file.
 */
async function setChatMemberTag(bot, chatId, userId, tag) {
  if (!bot || typeof bot._request !== 'function') {
    const error = new Error('Telegram SDK generic request transport is unavailable');
    error.code = 'ETELEGRAMTRANSPORT';
    throw error;
  }
  return bot._request('setChatMemberTag', {
    form: {
      chat_id: String(chatId),
      user_id: Number(userId),
      tag: String(tag ?? ''),
    },
  });
}

module.exports = { setChatMemberTag };

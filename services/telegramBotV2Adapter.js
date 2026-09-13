'use strict';

const { Bot, InputFile } = require('node-telegram-bot-api');

function normalizeReplyOptions(options = {}) {
  const normalized = { ...options };

  if (normalized.reply_to_message_id !== undefined && normalized.reply_parameters === undefined) {
    normalized.reply_parameters = {
      message_id: normalized.reply_to_message_id,
      ...(normalized.allow_sending_without_reply !== undefined
        ? { allow_sending_without_reply: normalized.allow_sending_without_reply }
        : {}),
    };
  }
  delete normalized.reply_to_message_id;
  delete normalized.allow_sending_without_reply;

  if (normalized.disable_web_page_preview !== undefined && normalized.link_preview_options === undefined) {
    normalized.link_preview_options = { is_disabled: Boolean(normalized.disable_web_page_preview) };
  }
  delete normalized.disable_web_page_preview;

  return normalized;
}

function normalizeUpload(value, fileOptions = {}) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return new InputFile(value, {
      filename: fileOptions.filename || 'upload.bin',
      contentType: fileOptions.contentType || fileOptions.content_type,
    });
  }
  return value;
}

/**
 * Keeps the application's narrow node-telegram-bot-api 0.x call surface while
 * the runtime uses the 2.x wire-shaped API. New code should prefer params objects
 * through the public methods exposed here; private SDK methods are not forwarded.
 */
class TelegramBotV2Adapter {
  constructor(token, options = {}) {
    const timeoutMs = options.timeoutMs ?? options.request?.timeout;
    this._errorHandlers = [];
    this._webhookErrorHandlers = [];
    this._bot = new Bot(token, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      // Delivery retries are owned by the durable application ledger. An SDK
      // retry after an ambiguous CREATE response could duplicate a message.
      maxRetries: options.maxRetries ?? 0,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.apiRoot ? { apiRoot: options.apiRoot } : {}),
    });
    this.api = this._bot.api;
    this._bot.catch(async (error) => {
      const handlers = this._errorHandlers.length
        ? this._errorHandlers
        : this._webhookErrorHandlers;
      for (const handler of handlers) await handler(error);
    });
  }

  on(kind, handler) {
    if (kind === 'error') {
      this._errorHandlers.push(handler);
      return this;
    }
    if (kind === 'webhook_error') {
      this._webhookErrorHandlers.push(handler);
      return this;
    }
    this._bot.on(kind, (ctx) => handler(ctx.update[kind]));
    return this;
  }

  processUpdate(update) {
    return this._bot.handleUpdate(update);
  }

  getMe() {
    return this.api.getMe();
  }

  getChat(chatId) {
    return this.api.getChat({ chat_id: chatId });
  }

  getChatMember(chatId, userId) {
    return this.api.getChatMember({ chat_id: chatId, user_id: userId });
  }

  getUserProfilePhotos(userId, options = {}) {
    return this.api.getUserProfilePhotos({ user_id: userId, ...options });
  }

  setMyCommands(commands, options = {}) {
    return this.api.setMyCommands({ commands, ...options });
  }

  setWebHook(url, options = {}) {
    return this.api.setWebhook({ url, ...options });
  }

  sendMessage(chatId, text, options = {}) {
    return this.api.sendMessage({ chat_id: chatId, text, ...normalizeReplyOptions(options) });
  }

  sendPhoto(chatId, photo, options = {}, fileOptions = {}) {
    return this.api.sendPhoto({
      chat_id: chatId,
      photo: normalizeUpload(photo, fileOptions),
      ...normalizeReplyOptions(options),
    });
  }

  deleteMessage(chatId, messageId) {
    return this.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }

  editMessageCaption(caption, options = {}) {
    return this.api.editMessageCaption({ caption, ...options });
  }

  editMessageMedia(media, options = {}) {
    return this.api.editMessageMedia({ media, ...options });
  }

  editMessageReplyMarkup(replyMarkup, options = {}) {
    return this.api.editMessageReplyMarkup({ reply_markup: replyMarkup, ...options });
  }

  answerCallbackQuery(callbackQueryId, options = {}) {
    return this.api.answerCallbackQuery({ callback_query_id: callbackQueryId, ...options });
  }

  setChatMemberTag(params) {
    return this.api.setChatMemberTag(params);
  }
}

module.exports = { TelegramBotV2Adapter, normalizeReplyOptions };

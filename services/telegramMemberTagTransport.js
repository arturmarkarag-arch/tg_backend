'use strict';

/**
 * Compatibility adapter for Bot API methods newer than the public method list in
 * node-telegram-bot-api 0.67.x. The installed SDK already exposes a generic
 * _request(path, options) transport internally, so we reuse its configured
 * timeout/baseApiUrl/proxy/error handling instead of maintaining a second HTTP stack.
 *
 * Telegram does not publish a method-specific setChatMemberTag flood-control
 * budget. Production has demonstrated 429 responses during bulk reconcile, so tag
 * writes are deliberately paced per chat. This affects writes only; read-only
 * getChatMember checks and NOOPs are not delayed.
 */
const DEFAULT_MEMBER_TAG_WRITE_INTERVAL_MS = 3500;
const MIN_MEMBER_TAG_WRITE_INTERVAL_MS = 500;
const nextWriteAtByChat = new Map();

function configuredWriteIntervalMs() {
  const raw = Number(process.env.TELEGRAM_MEMBER_TAG_WRITE_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_MEMBER_TAG_WRITE_INTERVAL_MS;
  return Math.max(MIN_MEMBER_TAG_WRITE_INTERVAL_MS, Math.floor(raw));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function normalizeChatKey(chatId) {
  return String(chatId ?? '').trim();
}

/**
 * Reserve the next per-chat write slot before hitting setChatMemberTag.
 * The scheduler is already distributed-single-leader; this in-process gate keeps
 * one leader from bursting multiple writes into the same Telegram group.
 */
async function waitForMemberTagWriteSlot(chatId) {
  const key = normalizeChatKey(chatId);
  const now = Date.now();
  const reservedAt = Math.max(now, Number(nextWriteAtByChat.get(key) || 0));
  nextWriteAtByChat.set(key, reservedAt + configuredWriteIntervalMs());
  const waitMs = reservedAt - now;
  if (waitMs > 0) await sleep(waitMs);
  return { waitMs, reservedAt };
}

/** Keep the in-memory gate aligned with Telegram's explicit flood-control pause. */
function deferMemberTagWritesUntil(chatId, until) {
  const key = normalizeChatKey(chatId);
  const untilMs = until instanceof Date ? until.getTime() : Number(until || 0);
  if (!key || !Number.isFinite(untilMs) || untilMs <= Date.now()) return;
  nextWriteAtByChat.set(key, Math.max(Number(nextWriteAtByChat.get(key) || 0), untilMs));
}

async function setChatMemberTag(bot, chatId, userId, tag) {
  if (!bot || typeof bot._request !== 'function') {
    const error = new Error('Telegram SDK generic request transport is unavailable');
    error.code = 'ETELEGRAMTRANSPORT';
    throw error;
  }
  await waitForMemberTagWriteSlot(chatId);
  return bot._request('setChatMemberTag', {
    form: {
      chat_id: String(chatId),
      user_id: Number(userId),
      tag: String(tag ?? ''),
    },
  });
}

module.exports = {
  DEFAULT_MEMBER_TAG_WRITE_INTERVAL_MS,
  configuredWriteIntervalMs,
  waitForMemberTagWriteSlot,
  deferMemberTagWritesUntil,
  setChatMemberTag,
};

'use strict';

/**
 * Rate-limited boundary around the public setChatMemberTag method in
 * node-telegram-bot-api 2.x. Keeping pacing here avoids coupling domain logic to
 * SDK transport details.
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
  if (!bot || typeof bot.setChatMemberTag !== 'function') {
    const error = new Error('Telegram SDK setChatMemberTag method is unavailable');
    error.code = 'ETELEGRAMTRANSPORT';
    throw error;
  }
  await waitForMemberTagWriteSlot(chatId);
  return bot.setChatMemberTag({
    chat_id: String(chatId),
    user_id: Number(userId),
    tag: String(tag ?? ''),
  });
}

module.exports = {
  DEFAULT_MEMBER_TAG_WRITE_INTERVAL_MS,
  configuredWriteIntervalMs,
  waitForMemberTagWriteSlot,
  deferMemberTagWritesUntil,
  setChatMemberTag,
};

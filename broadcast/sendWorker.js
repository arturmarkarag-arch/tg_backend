/**
 * Telegram send worker with rate limiting and flood-wait handling.
 *
 * Rate limits enforced:
 *  - Global:   max 25 messages/sec across all chats
 *  - Per-chat: max 1 message/sec per individual chat
 *
 * Flood Wait (HTTP 429):
 *  - Worker pauses the ENTIRE queue for `retry_after` seconds,
 *    then automatically resumes.
 *
 * Job data:
 *   { chatId, caption, photoBase64?, telegramFileId?, broadcastId, productId }
 */
const { Worker } = require('bullmq');
const { redisOpts, createRedisClient } = require('./connection');
const { SEND_QUEUE_NAME, sendQueue } = require('./queues');
const Product = require('../models/Product');

// Per-chat rate limiter using Redis
const redisRateLimiter = createRedisClient();

const GLOBAL_RATE   = 25;   // msgs/sec total
const PER_CHAT_MS   = 1000; // 1 msg per chat per second

let sendWorker = null;
let paused = false;

/**
 * Check if a chat can receive a message (per-chat 1 msg/sec limit).
 * Returns true if allowed, false if throttled.
 */
async function canSendToChat(chatId) {
  const key = `broadcast:ratelimit:chat:${chatId}`;
  const result = await redisRateLimiter.set(key, '1', 'PX', PER_CHAT_MS, 'NX');
  return result === 'OK';
}

/**
 * Build Telegram API base URL (local or cloud).
 */
function getTelegramApiBase() {
  const localApi = process.env.TELEGRAM_LOCAL_API_URL;
  if (localApi) return localApi;
  return 'https://api.telegram.org';
}

/**
 * Safely parse JSON from a fetch response.
 * Throws a descriptive error if response is empty or not JSON.
 */
async function safeJsonParse(res) {
  const text = await res.text();
  if (!text) {
    const err = new Error(`Empty response from Telegram (HTTP ${res.status})`);
    err.transient = true;  // always retry empty responses
    err.errorCode = res.status === 429 ? 429 : 0;
    err.retryAfter = res.status === 429 ? 5 : undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`Invalid JSON from Telegram (HTTP ${res.status}): ${text.slice(0, 200)}`);
    err.transient = true;  // always retry invalid responses
    err.errorCode = res.status === 429 ? 429 : 0;
    err.retryAfter = res.status === 429 ? 5 : undefined;
    throw err;
  }
}

/**
 * Send a text message via Telegram Bot API using raw HTTP.
 */
async function sendTextDirectly(chatId, text, botToken) {
  const apiBase = getTelegramApiBase();
  const url = `${apiBase}/bot${botToken}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await safeJsonParse(res);
  if (!data.ok) {
    const err = new Error(data.description || 'sendMessage failed');
    err.errorCode = data.error_code;
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

/**
 * Send a photo message via Telegram Bot API using raw HTTP
 * (bypasses node-telegram-bot-api to support local API server).
 */
async function sendPhotoDirectly(chatId, photoBuffer, telegramFileId, caption, botToken) {
  const apiBase = getTelegramApiBase();
  const url = `${apiBase}/bot${botToken}/sendPhoto`;

  if (telegramFileId) {
    // Send by file_id (no upload needed)
    const body = JSON.stringify({
      chat_id: chatId,
      photo: telegramFileId,
      caption: caption || undefined,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const data = await safeJsonParse(res);
    if (!data.ok) {
      const err = new Error(data.description || 'sendPhoto failed');
      err.errorCode = data.error_code;
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  // Upload photo buffer via multipart/form-data (native FormData + Blob)
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', new Blob([photoBuffer], { type: 'image/jpeg' }), 'photo.jpg');
  if (caption) form.append('caption', caption);

  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  const data = await safeJsonParse(res);
  if (!data.ok) {
    const err = new Error(data.description || 'sendPhoto failed');
    err.errorCode = data.error_code;
    err.retryAfter = data.parameters?.retry_after;
    throw err;
  }
  return data.result;
}

/**
 * Pause the send queue for a given duration (flood wait).
 */
async function pauseForFloodWait(seconds) {
  if (paused) return; // already paused
  paused = true;
  const ms = (seconds + 1) * 1000; // add 1s safety margin
  console.warn(`[SendWorker] FLOOD WAIT — pausing queue for ${seconds + 1}s`);
  await sendWorker.pause();
  setTimeout(async () => {
    try {
      await sendWorker.resume();
      paused = false;
      console.log('[SendWorker] Queue resumed after flood wait');
    } catch (e) {
      console.error('[SendWorker] Failed to resume after flood wait:', e);
      paused = false;
    }
  }, ms);
}

function startSendWorker() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  sendWorker = new Worker(
    SEND_QUEUE_NAME,
    async (job) => {
      const { chatId, caption, photoBase64, telegramFileId, broadcastId, productId } = job.data;

      // Per-chat rate limit — wait until slot is available
      let allowed = await canSendToChat(chatId);
      if (!allowed) {
        // Wait 1 second and try once more
        await new Promise((r) => setTimeout(r, PER_CHAT_MS));
        allowed = await canSendToChat(chatId);
        if (!allowed) {
          // Still throttled — throw to trigger BullMQ retry with backoff
          const err = new Error('Per-chat rate limited');
          err.rateLimited = true;
          throw err;
        }
      }

      const photoBuffer = photoBase64 ? Buffer.from(photoBase64, 'base64') : null;

      try {
        let result;
        if (!photoBuffer && !telegramFileId) {
          // Text-only message (no photo)
          result = await sendTextDirectly(chatId, caption, botToken);
        } else {
          result = await sendPhotoDirectly(chatId, photoBuffer, telegramFileId, caption, botToken);
        }
        return { messageId: result.message_id, chatId };
      } catch (err) {
        // Handle Telegram Flood Wait
        if (err.errorCode === 429 && err.retryAfter) {
          await pauseForFloodWait(err.retryAfter);
          throw err; // BullMQ will retry after backoff
        }

        // Transient errors (empty response, bad JSON) — always retry
        if (err.transient) {
          console.warn(`[SendWorker] Transient error for chat ${chatId}: ${err.message}`);
          throw err;
        }

        // Handle chat not found / bot blocked — don't retry
        if (err.errorCode === 403 || err.errorCode === 400) {
          console.warn(`[SendWorker] Chat ${chatId} unreachable (${err.errorCode}): ${err.message}`);
          return { chatId, skipped: true, reason: err.message };
        }

        throw err; // other errors — BullMQ will retry
      }
    },
    {
      ...redisOpts,
      concurrency: 3,   // 3 concurrent sends (safe for cloud API)
      limiter: {
        max: 20,
        duration: 1000,
      },
    },
  );

  // Save telegramMessageId so sellers can reply to order
  sendWorker.on('completed', async (job, result) => {
    if (result?.messageId && job.data?.productId && !result.skipped) {
      try {
        await Product.findByIdAndUpdate(job.data.productId, {
          $addToSet: { telegramMessageIds: String(result.messageId) },
        });
      } catch (err) {
        console.error(`[SendWorker] Failed to save messageId for product ${job.data.productId}:`, err.message);
      }
    }
  });

  // Custom error filter: don't log rate-limit retries as failures
  sendWorker.on('failed', (job, err) => {
    if (err.rateLimited) return; // expected, will retry
    console.error(`[SendWorker] Job ${job?.id} failed:`, err.message);
  });

  sendWorker.on('error', (err) => {
    console.error('[SendWorker] Worker error:', err);
  });

  return sendWorker;
}

function getSendWorker() {
  return sendWorker;
}

module.exports = { startSendWorker, getSendWorker };

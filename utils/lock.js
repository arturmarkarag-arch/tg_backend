'use strict';

/**
 * Lightweight distributed lock built on Redis.
 *
 * Use `withLock(key, fn, opts)` to serialise critical sections across all
 * Node workers / processes. If Redis is not configured, the lock degrades
 * to a process-local mutex (single-worker dev mode).
 *
 * Semantics:
 *   - Lock is acquired with SET NX EX, so it is atomic.
 *   - Each holder writes a unique token; release verifies the token via Lua
 *     script so a slow holder cannot accidentally release another holder's
 *     lock after the TTL expired.
 *   - On contention the helper waits with capped exponential backoff until
 *     `waitMs` elapses, then throws `appError('lock_busy', { resource: key })`.
 *
 * Typical usage:
 *
 *   const { withLock } = require('./utils/lock');
 *   await withLock(`user:${telegramId}:shop`, async () => {
 *     // critical section — no other worker can run this for the same user
 *   });
 */

const crypto = require('crypto');
const { redis, isEnabled } = require('./redis');
const { appError } = require('./errors');

const DEFAULT_TTL_MS  = 15_000; // how long the lock can be held before auto-expiry
const DEFAULT_WAIT_MS = 5_000;  // how long to wait to acquire before giving up

// Lua: release ONLY if the token matches (prevents releasing someone else's lock)
const UNLOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

// Process-local fallback (used only when Redis is unavailable)
const localQueues = new Map(); // key → Promise chain

async function acquireLocal(key) {
  const prev = localQueues.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  localQueues.set(key, prev.then(() => next));
  await prev;
  return () => {
    release();
    // tidy up the map once no one is waiting
    if (localQueues.get(key) === next) localQueues.delete(key);
  };
}

async function acquireRedis(key, token, ttlMs, waitMs) {
  const namespaced = `lock:${key}`;
  const deadline = Date.now() + waitMs;
  let backoff = 50;
  // Try-acquire loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ok = await redis.set(namespaced, token, 'PX', ttlMs, 'NX');
    if (ok === 'OK') return namespaced;
    if (Date.now() >= deadline) {
      throw appError('lock_busy', { resource: key });
    }
    await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * 50)));
    backoff = Math.min(backoff * 2, 500);
  }
}

async function withLock(key, fn, opts = {}) {
  const ttlMs  = opts.ttlMs  ?? DEFAULT_TTL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;

  if (!isEnabled()) {
    const release = await acquireLocal(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const token = crypto.randomBytes(16).toString('hex');
  const namespaced = await acquireRedis(key, token, ttlMs, waitMs);
  try {
    return await fn();
  } finally {
    try {
      await redis.eval(UNLOCK_SCRIPT, 1, namespaced, token);
    } catch (err) {
      console.warn('[Lock] release failed for', key, err.message);
    }
  }
}

module.exports = { withLock };

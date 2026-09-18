'use strict';

const crypto = require('crypto');
const { redis, isReady } = require('../utils/redis');

const localBuckets = new Map();
let redisBackoffUntil = 0;

function positiveEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const MAX_LOCAL_BUCKETS = positiveEnvInt('RATE_LIMIT_LOCAL_BUCKET_MAX', 20_000);
const REDIS_ERROR_BACKOFF_MS = positiveEnvInt('RATE_LIMIT_REDIS_ERROR_BACKOFF_MS', 5_000);

function safeNamespace(value) {
  return String(value || 'default')
    .replace(/[^a-zA-Z0-9:._-]/g, '_')
    .slice(0, 120);
}

function hashIdentity(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 32);
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows) || windows.length === 0) {
    throw new Error('rate_limit_windows_required');
  }
  return windows.map((window, index) => {
    const max = Number(window?.max);
    const windowMs = Number(window?.windowMs);
    if (!Number.isSafeInteger(max) || max <= 0) throw new Error(`rate_limit_max_invalid:${index}`);
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) throw new Error(`rate_limit_window_invalid:${index}`);
    return {
      name: safeNamespace(window?.name || `w${index}`),
      max,
      windowMs,
    };
  });
}

function pruneLocalBuckets(now) {
  if (localBuckets.size <= MAX_LOCAL_BUCKETS) return;

  for (const [key, bucket] of localBuckets) {
    if (bucket.resetAt <= now) localBuckets.delete(key);
  }
  if (localBuckets.size <= MAX_LOCAL_BUCKETS) return;

  // Identity spraying must not turn the fallback itself into an unbounded-memory
  // DoS. Evict the oldest map entries if all buckets are still live.
  const excess = localBuckets.size - MAX_LOCAL_BUCKETS;
  const target = excess + Math.ceil(MAX_LOCAL_BUCKETS * 0.05);
  let removed = 0;
  for (const key of localBuckets.keys()) {
    localBuckets.delete(key);
    removed += 1;
    if (removed >= target) break;
  }
}

function consumeLocal(keys, windows) {
  const now = Date.now();
  const results = [];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const window = windows[i];
    let bucket = localBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 1, resetAt: now + window.windowMs };
      localBuckets.set(key, bucket);
    } else {
      bucket.count += 1;
    }
    results.push({ count: bucket.count, ttlMs: Math.max(0, bucket.resetAt - now) });
  }

  pruneLocalBuckets(now);
  return results;
}

// One Redis round trip evaluates every window for a bucket. Each window is a
// fixed-window counter with its own TTL. Redis is coordination, not availability:
// on an outage callers fall back to the bounded per-process store below.
const MULTI_WINDOW_LUA = `
local out = {}
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  local ttl = redis.call('PTTL', KEYS[i])
  if count == 1 or ttl < 0 then
    redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[i]))
    ttl = tonumber(ARGV[i])
  end
  table.insert(out, count)
  table.insert(out, ttl)
end
return out
`;

async function consumeRedis(keys, windows) {
  const raw = await redis.eval(
    MULTI_WINDOW_LUA,
    keys.length,
    ...keys,
    ...windows.map((window) => String(window.windowMs)),
  );
  const results = [];
  for (let i = 0; i < windows.length; i += 1) {
    results.push({
      count: Number(raw?.[i * 2]) || 0,
      ttlMs: Math.max(0, Number(raw?.[(i * 2) + 1]) || windows[i].windowMs),
    });
  }
  return results;
}

async function consumeRateLimit({ namespace, identity, windows }) {
  const normalized = normalizeWindows(windows);
  const ns = safeNamespace(namespace);
  const identityHash = hashIdentity(identity);
  const keys = normalized.map((window) => `rate:${ns}:${window.name}:${identityHash}`);

  let counts;
  let backend = 'local';
  const now = Date.now();
  if (redis && isReady(redis) && now >= redisBackoffUntil) {
    try {
      counts = await consumeRedis(keys, normalized);
      backend = 'redis';
    } catch (_) {
      redisBackoffUntil = Date.now() + REDIS_ERROR_BACKOFF_MS;
      counts = consumeLocal(keys, normalized);
      backend = 'local-fallback';
    }
  } else {
    counts = consumeLocal(keys, normalized);
  }

  const evaluated = normalized.map((window, index) => ({
    ...window,
    count: counts[index].count,
    ttlMs: counts[index].ttlMs,
    remaining: Math.max(0, window.max - counts[index].count),
    limited: counts[index].count > window.max,
  }));
  const violated = evaluated.filter((window) => window.limited);

  return {
    limited: violated.length > 0,
    retryAfterMs: violated.length
      ? Math.max(...violated.map((window) => window.ttlMs))
      : 0,
    windows: evaluated,
    backend,
  };
}

function resetLocalRateLimitStateForTests() {
  localBuckets.clear();
  redisBackoffUntil = 0;
}

module.exports = {
  consumeRateLimit,
  resetLocalRateLimitStateForTests,
};

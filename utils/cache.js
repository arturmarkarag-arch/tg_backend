'use strict';

/**
 * Two-layer cache:
 *   - L1: per-process in-memory Map (fast path, short TTL).
 *   - L2: Redis (source of truth across all workers).
 * Invalidation is published over a Redis pub/sub channel so all workers drop L1 in sync.
 *
 * If Redis is not configured (REDIS_URL missing), the cache degrades to L1-only
 * with a 5-minute TTL — fine for local development, NOT safe for cluster/PM2.
 *
 * Values are JSON-serialised, so only plain data (objects, arrays, primitives).
 */

const { redis, pubClient, subClient, isEnabled } = require('./redis');

const L1_TTL_MS  = 60 * 1000;          // 60 s in-process — refreshed from Redis frequently
const L2_TTL_SEC = 10 * 60;            // 10 min in Redis
const FALLBACK_TTL_MS = 5 * 60 * 1000; // used only when Redis is unavailable

const CHANNEL = 'cache:invalidate';

const local = new Map(); // key → { value, expiresAt }

// Subscribe to invalidation events — every worker drops L1 when ANY worker invalidates.
if (isEnabled() && subClient) {
  subClient.subscribe(CHANNEL).catch((err) => {
    console.warn('[Cache] failed to subscribe:', err.message);
  });
  subClient.on('message', (channel, message) => {
    if (channel !== CHANNEL) return;
    if (message === '*') {
      local.clear();
    } else {
      local.delete(message);
    }
  });
}

function nsKey(key) {
  return `cache:${key}`;
}

async function get(key) {
  // L1
  const entry = local.get(key);
  if (entry && Date.now() <= entry.expiresAt) {
    return entry.value;
  }
  if (entry) local.delete(key);

  // L2 (Redis)
  if (isEnabled()) {
    try {
      const raw = await redis.get(nsKey(key));
      if (raw != null) {
        const value = JSON.parse(raw);
        local.set(key, { value, expiresAt: Date.now() + L1_TTL_MS });
        return value;
      }
    } catch (err) {
      console.warn('[Cache] L2 get failed:', err.message);
    }
  }
  return null;
}

async function set(key, value, ttlSec = L2_TTL_SEC) {
  const localTtl = isEnabled() ? L1_TTL_MS : FALLBACK_TTL_MS;
  local.set(key, { value, expiresAt: Date.now() + localTtl });

  if (isEnabled()) {
    try {
      await redis.set(nsKey(key), JSON.stringify(value), 'EX', ttlSec);
    } catch (err) {
      console.warn('[Cache] L2 set failed:', err.message);
    }
  }
}

async function invalidate(key) {
  local.delete(key);
  if (isEnabled()) {
    try {
      await redis.del(nsKey(key));
      await pubClient.publish(CHANNEL, key);
    } catch (err) {
      console.warn('[Cache] L2 invalidate failed:', err.message);
    }
  }
}

async function invalidateAll() {
  local.clear();
  if (isEnabled()) {
    try {
      // Conservative: only clear our namespace
      const keys = await redis.keys('cache:*');
      if (keys.length) await redis.del(...keys);
      await pubClient.publish(CHANNEL, '*');
    } catch (err) {
      console.warn('[Cache] L2 invalidateAll failed:', err.message);
    }
  }
}

const KEYS = {
  ORDERING_SCHEDULE: 'ordering_schedule',
  CITIES: 'cities',
  DELIVERY_GROUPS: 'delivery_groups',
};

module.exports = { get, set, invalidate, invalidateAll, KEYS };

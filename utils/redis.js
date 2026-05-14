'use strict';

/**
 * Centralised Redis clients.
 *
 * We export three clients so different subsystems do not interfere with each other:
 *   - `redis`     — generic client for cache reads/writes, locks, counters.
 *   - `pubClient` — publisher used by Socket.IO adapter AND by the cache-invalidation channel.
 *   - `subClient` — subscriber used by Socket.IO adapter AND by the cache-invalidation channel.
 *
 * Socket.IO and the cache layer share pub/sub clients because that is how the
 * official @socket.io/redis-adapter is wired; they live on different channels
 * so there is no collision.
 *
 * If REDIS_URL is not set, every export becomes `null` and callers must fall
 * back gracefully (the cache and lock helpers already handle this).
 */

const Redis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || '';

let redis = null;
let pubClient = null;
let subClient = null;
let connected = false;

function makeClient(label) {
  if (!REDIS_URL) return null;
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // never give up on transient hiccups
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  client.on('connect', () => { console.log(`[Redis:${label}] connected`); });
  client.on('ready',   () => { connected = true; });
  client.on('error',   (err) => { console.warn(`[Redis:${label}] error:`, err.message); });
  client.on('end',     () => { connected = false; console.warn(`[Redis:${label}] connection closed`); });
  return client;
}

if (REDIS_URL) {
  redis     = makeClient('main');
  pubClient = makeClient('pub');
  subClient = makeClient('sub');
} else {
  console.warn('[Redis] REDIS_URL is not set — running in single-process mode (no shared cache, no distributed locks, no socket adapter).');
}

function isEnabled() {
  return Boolean(redis);
}

module.exports = { redis, pubClient, subClient, isEnabled };

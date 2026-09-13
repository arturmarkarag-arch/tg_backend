'use strict';

const { redis, isReady } = require('../utils/redis');
const { appError } = require('../utils/errors');

const localBuckets = new Map();

function safePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 160);
}

function clientKey(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const direct = req.ip || req.socket?.remoteAddress || 'unknown';
  return safePart(`${direct}|${forwarded || 'no-forwarded-ip'}`);
}

function localIncrement(key, windowMs) {
  const now = Date.now();
  const current = localBuckets.get(key);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 1, resetAt: now + windowMs };
    localBuckets.set(key, fresh);
    return fresh;
  }
  current.count += 1;
  // Opportunistic cleanup keeps this fallback bounded without a timer.
  if (localBuckets.size > 5000) {
    for (const [bucketKey, bucket] of localBuckets) {
      if (bucket.resetAt <= now) localBuckets.delete(bucketKey);
    }
  }
  return current;
}

function createAuthRateLimit({ name, max = 300, windowMs = 5 * 60 * 1000 } = {}) {
  const prefix = `auth-rate:${safePart(name || 'default')}`;
  return async function authRateLimit(req, res, next) {
    const key = `${prefix}:${clientKey(req)}`;
    try {
      let count;
      let ttlMs = windowMs;
      if (redis && isReady(redis)) {
        count = await redis.incr(key);
        const currentTtl = Number(await redis.pttl(key));
        if (count === 1 || currentTtl < 0) {
          await redis.pexpire(key, windowMs);
          ttlMs = windowMs;
        } else {
          ttlMs = Math.max(0, currentTtl || windowMs);
        }
      } else {
        const bucket = localIncrement(key, windowMs);
        count = bucket.count;
        ttlMs = Math.max(0, bucket.resetAt - Date.now());
      }

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - count)));
      if (count > max) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ttlMs / 1000))));
        return next(appError('auth_rate_limited'));
      }
      return next();
    } catch (_) {
      // Rate limiting is a protective layer, not an availability dependency.
      return next();
    }
  };
}

module.exports = { createAuthRateLimit };

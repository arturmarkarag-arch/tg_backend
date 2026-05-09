/**
 * Redis connection configuration for BullMQ.
 */
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || (process.env.NODE_ENV === 'production' ? null : 'redis://127.0.0.1:6379');

if (!REDIS_URL && process.env.NODE_ENV === 'production') {
  throw new Error('REDIS_URL is required in production');
}

/** Shared connection opts passed to BullMQ Queue / Worker constructors */
const redisOpts = {
  connection: {
    host: new URL(REDIS_URL).hostname || '127.0.0.1',
    port: Number(new URL(REDIS_URL).port) || 6379,
    password: new URL(REDIS_URL).password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  },
};

/** Create a dedicated IORedis instance */
function createRedisClient() {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

module.exports = { redisOpts, createRedisClient, REDIS_URL };

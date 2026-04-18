/**
 * Redis connection configuration for BullMQ.
 * All queues and workers share the same connection settings.
 */
const IORedis = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** Shared connection opts passed to BullMQ Queue / Worker constructors */
const redisOpts = {
  connection: {
    host: new URL(REDIS_URL).hostname || '127.0.0.1',
    port: Number(new URL(REDIS_URL).port) || 6379,
    password: new URL(REDIS_URL).password || undefined,
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,
  },
};

/** Create a dedicated IORedis instance (for Bull Board or manual use) */
function createRedisClient() {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

module.exports = { redisOpts, createRedisClient, REDIS_URL };

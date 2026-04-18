/**
 * BullMQ queue definitions for the broadcast pipeline.
 *
 * Pipeline:
 *  1. IMAGE_QUEUE  – process images with Sharp (add labels, compress)
 *  2. SEND_QUEUE   – send the processed photo to a single chat via Telegram API
 */
const { Queue } = require('bullmq');
const { redisOpts } = require('./connection');

const IMAGE_QUEUE_NAME = 'broadcast-image';
const SEND_QUEUE_NAME  = 'broadcast-send';

const imageQueue = new Queue(IMAGE_QUEUE_NAME, {
  ...redisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 5000 },
    removeOnFail: { count: 10000 },
  },
});

const sendQueue = new Queue(SEND_QUEUE_NAME, {
  ...redisOpts,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 2000 },
  },
});

module.exports = {
  imageQueue,
  sendQueue,
  IMAGE_QUEUE_NAME,
  SEND_QUEUE_NAME,
};

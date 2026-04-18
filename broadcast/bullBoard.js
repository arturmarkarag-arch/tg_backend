/**
 * Bull Board — web-based monitoring UI for broadcast queues.
 * Mounts on /admin/queues.
 */
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { imageQueue, sendQueue } = require('./queues');

function setupBullBoard(app) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [
      new BullMQAdapter(imageQueue),
      new BullMQAdapter(sendQueue),
    ],
    serverAdapter,
  });

  app.use('/admin/queues', serverAdapter.getRouter());
  console.log('Bull Board UI available at /admin/queues');
}

module.exports = { setupBullBoard };

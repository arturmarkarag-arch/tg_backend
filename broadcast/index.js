/**
 * Broadcast module entry point.
 *
 * Starts all workers and exposes the broadcast API.
 */
const { startImageWorker } = require('./imageWorker');
const { startSendWorker } = require('./sendWorker');
const { setupBullBoard } = require('./bullBoard');
const { startBroadcast, getBroadcastStats, cancelBroadcast } = require('./broadcastService');

let initialized = false;

/**
 * Initialize the broadcast system — call once at app startup.
 * @param {express.Application} app - Express app (for Bull Board UI)
 */
function initBroadcast(app) {
  if (initialized) return;
  initialized = true;

  startImageWorker();
  startSendWorker();

  if (app) {
    setupBullBoard(app);
  }

  console.log('[Broadcast] System initialized (ImageWorker + SendWorker + BullBoard)');
}

module.exports = {
  initBroadcast,
  startBroadcast,
  getBroadcastStats,
  cancelBroadcast,
};

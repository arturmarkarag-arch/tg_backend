'use strict';

const { runAsSchedulerLeader } = require('./schedulerLeader');
const { drainDueTelegramMemberTagSync } = require('./telegramMemberTagSync');

const TICK_MS = 5 * 1000;
let timer = null;
let running = false;

async function runTelegramMemberTagTick() {
  return runAsSchedulerLeader(
    'telegram-member-tags',
    () => drainDueTelegramMemberTagSync({ limit: 25 }),
    { ttlMs: 2 * 60 * 1000 },
  );
}

function startTelegramMemberTagScheduler() {
  if (timer) return timer;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runTelegramMemberTagTick(); }
    catch (err) { console.warn('[telegram-member-tags] scheduler tick failed', err?.message || err); }
    finally { running = false; }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return timer;
}

function stopTelegramMemberTagScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { TICK_MS, runTelegramMemberTagTick, startTelegramMemberTagScheduler, stopTelegramMemberTagScheduler };

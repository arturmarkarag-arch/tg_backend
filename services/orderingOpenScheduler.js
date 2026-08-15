'use strict';

// Тік раз на хвилину: чи не відкрилось щойно вікно замовлень якоїсь групи.
// Хвилини достатньо — вікно відкривається на рівній хвилині за розкладом, а
// сама розсилка захищена від дублів прапорцем на сесії, не таймінгом тіку.

const { notifyOrderingOpen } = require('./orderingOpenNotify');
const { runAsSchedulerLeader } = require('./schedulerLeader');
const DeliveryGroup = require('../models/DeliveryGroup');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');

const TICK_MS = 60 * 1000;
let timer = null;
let running = false;
const MIN_BOUNDARY_SLOP_MS = 150;

async function materializeOpenOrderingSessions({ now = new Date() } = {}) {
  const groups = await DeliveryGroup.find({}, '_id orderingSchedule').lean();
  let materializedSessions = 0;
  let failedGroups = 0;

  for (const group of groups) {
    try {
      if (!isOrderingOpen(group.orderingSchedule, now).isOpen) continue;
      const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
      if (sessionId) materializedSessions += 1;
    } catch (err) {
      failedGroups += 1;
      console.warn('[ordering-open] session materialization failed for group', String(group._id), err?.message || err);
    }
  }

  return { materializedSessions, failedGroups };
}

async function runOrderingOpenTick(now = new Date()) {
  // Session lifecycle is server-owned. This runs even when Telegram is disabled,
  // so opening a Mini App tab is never required to create the current session.
  const materialized = await materializeOpenOrderingSessions({ now });
  try {
    const notified = await notifyOrderingOpen({ now });
    return { ...materialized, ...notified };
  } catch (err) {
    return { ...materialized, notifiedGroups: 0, sentPrivate: 0, sentGroups: 0 };
  }
}

function msUntilNextMinuteBoundary(nowMs = Date.now()) {
  const remainder = nowMs % TICK_MS;
  return (remainder === 0 ? TICK_MS : TICK_MS - remainder) + MIN_BOUNDARY_SLOP_MS;
}

function startOrderingOpenScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAsSchedulerLeader('ordering-open', () => runOrderingOpenTick(), { ttlMs: 5 * 60 * 1000 });
    } finally {
      running = false;
    }
  };

  const scheduleNext = () => {
    timer = setTimeout(async () => {
      await tick();
      scheduleNext();
    }, msUntilNextMinuteBoundary());
    timer.unref();
  };

  // Immediate recovery on process start, then align every subsequent run to the
  // server's real minute boundary instead of drifting from deploy/startup time.
  tick();
  scheduleNext();
  return timer;
}

function stopOrderingOpenScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  startOrderingOpenScheduler,
  stopOrderingOpenScheduler,
  runOrderingOpenTick,
  materializeOpenOrderingSessions,
  TICK_MS,
  msUntilNextMinuteBoundary,
};

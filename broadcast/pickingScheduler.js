'use strict';

/**
 * Picking task auto-scheduler.
 *
 * At closeHour:closeMinute (Warsaw timezone) each day, automatically calls
 * buildPickingTasksFromOrders() so picking tasks are ready when warehouse
 * workers open the mini-app.
 *
 * Uses BullMQ delayed jobs stored in Redis so the schedule survives server
 * restarts and is rescheduled dynamically when admin changes the ordering window.
 *
 * Lifecycle:
 *   initPickingScheduler()   — call once at app startup
 *   reschedulePickingJob()   — call after admin saves a new ordering schedule
 */

const { Queue, Worker } = require('bullmq');
const { redisOpts } = require('../utils/redisConnection');

const QUEUE_NAME = 'picking-schedule';
const JOB_NAME  = 'build-picking-tasks';
const TIMEZONE  = 'Europe/Warsaw';

// Queue is created at module load (shared between initPickingScheduler and reschedulePickingJob)
const pickingScheduleQueue = new Queue(QUEUE_NAME, {
  ...redisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail:    { count: 100 },
  },
});

let pickingScheduleWorker = null;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/**
 * Returns the UTC Date for the next occurrence of closeHour:closeMinute in Warsaw.
 * Tries today first, then tomorrow. Guarantees at least 1 minute in the future.
 */
function nextCloseTimeUTC(closeHour, closeMinute) {
  const now = new Date();

  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const candidateDate = new Date(now.getTime() + dayOffset * 86400000);

    // Get Warsaw calendar date (YYYY-MM-DD) for this candidate UTC moment
    const dateParts = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      year:     'numeric',
      month:    '2-digit',
      day:      '2-digit',
      hour12:   false,
    }).formatToParts(candidateDate).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    const warsawDateStr = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
    const hh = String(closeHour).padStart(2, '0');
    const mm = String(closeMinute).padStart(2, '0');

    // Treat Warsaw time as UTC first (approximate)
    const approxUTC = new Date(`${warsawDateStr}T${hh}:${mm}:00Z`);

    // Find what Warsaw clock shows for this approximate UTC moment
    const approxWarsaw = new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE,
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    }).formatToParts(approxUTC).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

    let wHour = parseInt(approxWarsaw.hour, 10);
    if (wHour === 24) wHour = 0; // midnight edge case on some platforms
    const wMin = parseInt(approxWarsaw.minute, 10);

    // Correct for the Warsaw UTC offset (DST-aware)
    const diffMs = ((wHour - closeHour) * 60 + (wMin - closeMinute)) * 60000;
    const targetUTC = new Date(approxUTC.getTime() - diffMs);

    // Must be at least 1 minute in the future
    if (targetUTC.getTime() > now.getTime() + 60 * 1000) {
      return targetUTC;
    }
  }

  // Safety fallback: 25 hours from now (should never be reached)
  console.warn('[PickingScheduler] nextCloseTimeUTC fallback triggered — scheduling 25h from now');
  return new Date(now.getTime() + 25 * 3600 * 1000);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function scheduleNextPickingJob(closeHour, closeMinute) {
  const targetTime = nextCloseTimeUTC(closeHour, closeMinute);
  const delay = targetTime.getTime() - Date.now();

  await pickingScheduleQueue.add(JOB_NAME, { closeHour, closeMinute }, { delay });

  const label = `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')} Warsaw`;
  console.log(`[PickingScheduler] Next job scheduled for ${targetTime.toISOString()} (${label}), delay=${Math.round(delay / 1000)}s`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Remove all pending/delayed jobs and schedule a fresh one.
 * Call this after admin saves a new ordering schedule.
 */
async function reschedulePickingJob(closeHour, closeMinute) {
  const [waitingJobs, delayedJobs] = await Promise.all([
    pickingScheduleQueue.getJobs(['waiting']),
    pickingScheduleQueue.getJobs(['delayed']),
  ]);

  const pending = [...waitingJobs, ...delayedJobs];
  await Promise.all(pending.map((job) => job.remove().catch(() => {})));

  console.log(`[PickingScheduler] Removed ${pending.length} pending job(s) — rescheduling for ${closeHour}:${closeMinute}`);
  await scheduleNextPickingJob(closeHour, closeMinute);
}

/**
 * Initialize the picking scheduler.
 * - If a delayed job already exists in Redis (e.g. after a restart), skip scheduling.
 * - Otherwise, read the ordering schedule from DB and schedule the next job.
 * - Starts the BullMQ worker that processes jobs.
 */
async function initPickingScheduler() {
  // Check if there's already a delayed/waiting job (e.g. after server restart)
  const existingJobs = await pickingScheduleQueue.getJobs(['delayed', 'waiting']);

  if (existingJobs.length > 0) {
    const earliest = existingJobs
      .map((j) => ({ job: j, fireAt: j.timestamp + (j.opts?.delay || 0) }))
      .sort((a, b) => a.fireAt - b.fireAt)[0];
    console.log(`[PickingScheduler] ${existingJobs.length} job(s) already queued. Next fire: ${new Date(earliest.fireAt).toISOString()}`);
  } else {
    // No pending jobs — create one from the current DB schedule
    try {
      const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
      const schedule = await getOrderingSchedule();
      await scheduleNextPickingJob(schedule.closeHour, schedule.closeMinute);
    } catch (err) {
      console.error('[PickingScheduler] Cannot schedule — ordering schedule not in DB:', err.message);
      // Non-fatal: the scheduler will work once reschedulePickingJob() is called
      // (e.g. when admin saves the schedule next time)
    }
  }

  // Start the worker
  pickingScheduleWorker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { closeHour, closeMinute } = job.data;
      console.log(`[PickingScheduler] Worker fired at ${new Date().toISOString()} — building picking tasks`);

      // Build picking tasks for all delivery groups whose window just closed
      const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
      await buildPickingTasksFromOrders(null);
      console.log('[PickingScheduler] buildPickingTasksFromOrders completed successfully');

      // Schedule next daily occurrence — re-read DB in case admin changed the schedule
      try {
        const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
        let nextCloseHour   = closeHour;
        let nextCloseMinute = closeMinute;
        try {
          const fresh = await getOrderingSchedule();
          nextCloseHour   = fresh.closeHour;
          nextCloseMinute = fresh.closeMinute;
        } catch (_) {
          // DB read failed — fall back to the values this job was created with
        }
        await scheduleNextPickingJob(nextCloseHour, nextCloseMinute);
      } catch (schedErr) {
        console.error('[PickingScheduler] Failed to schedule next job after processing:', schedErr.message);
        // Non-fatal — the chain can be restarted manually via reschedulePickingJob()
      }
    },
    redisOpts,
  );

  pickingScheduleWorker.on('failed', (job, err) => {
    console.error(`[PickingScheduler] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });

  pickingScheduleWorker.on('error', (err) => {
    console.error('[PickingScheduler] Worker error:', err.message);
  });

  console.log('[PickingScheduler] Initialized');
}

module.exports = {
  initPickingScheduler,
  reschedulePickingJob,
  pickingScheduleQueue,
};

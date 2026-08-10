'use strict';

const OrderingSession = require('../models/OrderingSession');
const Order = require('../models/Order');
const {
  getOpenDateWarsaw,
  getOrderingWindowBoundsForOpenDate,
  normalizeOrderingSchedule,
} = require('./orderingSchedule');
const { isMaintenanceActive } = require('../services/maintenanceState');

function addDaysToDateStr(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function upsertSession(gid, openDate, schedule) {
  // Hot/read path first: polling an already-materialised session must be a READ,
  // not a findOneAndUpdate. With Mongoose timestamps the old $setOnInsert upsert
  // still bumped updatedAt on every poll even when nothing changed.
  const existing = await OrderingSession.findOne({ groupId: gid, openDate });
  if (existing) return existing;

  // Only a genuinely missing session reaches the race-safe upsert below.
  const normalizedSchedule = normalizeOrderingSchedule(schedule);
  const { openAt, closeAt } = getOrderingWindowBoundsForOpenDate(openDate, normalizedSchedule);
  try {
    return await OrderingSession.findOneAndUpdate(
      { groupId: gid, openDate },
      {
        $setOnInsert: {
          groupId: gid,
          openDate,
          openAt,
          closeAt,
          scheduleSnapshot: normalizedSchedule,
          pickingStatus: 'pending',
          events: [{ at: new Date(), type: 'created' }],
        },
      },
      { upsert: true, new: true },
    );
  } catch (err) {
    if (err && err.code === 11000) {
      const existing = await OrderingSession.findOne({ groupId: gid, openDate });
      if (existing) return existing;
    }
    throw err;
  }
}

/**
 * Stable id of the current weekly cycle for a group.
 * Session identity is {groupId, openDate}, where openDate is derived ONLY from
 * the group's explicit orderingSchedule.start* fields.
 */
async function getOrCreateSessionId(groupId, schedule) {
  const gid = String(groupId);
  const normalizedSchedule = normalizeOrderingSchedule(schedule);
  const openDate = getOpenDateWarsaw(normalizedSchedule);

  if (isMaintenanceActive()) {
    const existing = await OrderingSession.findOne({ groupId: gid, openDate }, '_id').lean();
    return existing ? String(existing._id) : null;
  }

  const doc = await upsertSession(gid, openDate, normalizedSchedule);
  return String(doc._id);
}

async function findCurrentSessionId(groupId, schedule) {
  const openDate = getOpenDateWarsaw(normalizeOrderingSchedule(schedule));
  const doc = await OrderingSession.findOne({ groupId: String(groupId), openDate }, '_id').lean();
  return doc ? String(doc._id) : null;
}

async function getOrCreateNextSessionId(groupId, schedule) {
  const gid = String(groupId);
  const normalizedSchedule = normalizeOrderingSchedule(schedule);
  const currentOpenDate = getOpenDateWarsaw(normalizedSchedule);
  const nextOpenDate = addDaysToDateStr(currentOpenDate, 7);

  if (isMaintenanceActive()) {
    const existing = await OrderingSession.findOne({ groupId: gid, openDate: nextOpenDate }, '_id').lean();
    return existing ? String(existing._id) : null;
  }

  const doc = await upsertSession(gid, nextOpenDate, normalizedSchedule);
  return String(doc._id);
}

/**
 * One-shot legacy migration for very old orderingSessionId strings. It does not
 * depend on current group schedules because the legacy id already contains the
 * historical open timestamp.
 */
async function migrateOrdersToSessionIds() {
  const OLD_FORMAT_RE = /^[0-9a-f]{24}:\d{4}-\d{2}-\d{2}T/;
  const oldOrders = await Order.find(
    { orderingSessionId: { $regex: '^[0-9a-f]{24}:' } },
    'orderingSessionId',
  ).lean();
  if (oldOrders.length === 0) return;

  const oldIds = new Set();
  for (const order of oldOrders) {
    const sid = order.orderingSessionId || '';
    if (OLD_FORMAT_RE.test(sid)) oldIds.add(sid);
  }

  let totalConverted = 0;
  for (const oldSid of oldIds) {
    const colonIdx = oldSid.indexOf(':');
    const groupId = oldSid.slice(0, colonIdx);
    const isoTs = oldSid.slice(colonIdx + 1);
    const openAt = new Date(isoTs);
    if (isNaN(openAt.getTime())) continue;

    const openDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(openAt);

    // Historical old-format ids pre-date per-group schedules, so preserve the
    // timestamp exactly and do not invent a schedule snapshot.
    let doc;
    try {
      doc = await OrderingSession.findOneAndUpdate(
        { groupId, openDate },
        {
          $setOnInsert: {
            groupId,
            openDate,
            openAt,
            pickingStatus: 'pending',
            events: [{ at: new Date(), type: 'created' }],
          },
        },
        { upsert: true, new: true },
      );
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await OrderingSession.findOne({ groupId, openDate });
    }

    const newSid = String(doc._id);
    const result = await Order.updateMany(
      { orderingSessionId: oldSid },
      { $set: { orderingSessionId: newSid } },
    );
    const n = result.modifiedCount ?? result.nModified ?? 0;
    totalConverted += n;
    console.log(`[OrderingSession migration] ${oldSid} → ${newSid} (${n} orders)`);
  }

  if (totalConverted > 0) {
    console.log(`[OrderingSession migration] Done. Total orders migrated: ${totalConverted}`);
  }
}

module.exports = {
  getOrCreateSessionId,
  getOrCreateNextSessionId,
  findCurrentSessionId,
  migrateOrdersToSessionIds,
};

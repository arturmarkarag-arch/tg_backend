'use strict';

const OrderingSession = require('../models/OrderingSession');
const Order           = require('../models/Order');
const { getOrderingWindowOpenAt, getOpenDateWarsaw } = require('./orderingSchedule');

/**
 * Race-safe find-or-create for an OrderingSession document.
 *
 * findOneAndUpdate({ upsert:true }) is NOT atomic against the unique
 * {groupId, openDate} index: when two callers concurrently miss, both try to
 * insert and the losing one throws E11000. This happens in practice both on
 * the FIRST order of a new session (many sellers click at once) and on a
 * multi-instance startup running the migration simultaneously. On E11000 the
 * document now exists — just read it back.
 */
async function upsertSession(gid, openDate, openAt) {
  try {
    return await OrderingSession.findOneAndUpdate(
      { groupId: gid, openDate },
      { $setOnInsert: { groupId: gid, openDate, openAt } },
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
 * Returns the stable MongoDB ObjectId string for the ordering session that is
 * currently active for a delivery group. Creates the session document on first
 * access so that all future calls — even after the admin changes the schedule
 * times — return the same ID (keyed on the Warsaw calendar date, not the exact
 * open timestamp).
 *
 * @param {string} groupId
 * @param {number} dayOfWeek   0=Sun … 6=Sat
 * @param {object} [schedule]
 * @returns {Promise<string>}  ObjectId as string
 */
async function getOrCreateSessionId(groupId, dayOfWeek, schedule = {}) {
  const gid      = String(groupId);
  const openAt   = getOrderingWindowOpenAt(dayOfWeek, schedule);
  const openDate = getOpenDateWarsaw(dayOfWeek, schedule);

  const doc = await upsertSession(gid, openDate, openAt);
  return String(doc._id);
}

/**
 * One-shot startup migration: converts old-format orderingSessionId strings
 * ("<24-hex-groupId>:<ISO timestamp>") on ALL existing orders to stable
 * OrderingSession ObjectId strings.  Safe to re-run — find-or-create is idempotent.
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
    const groupId  = oldSid.slice(0, colonIdx);
    const isoTs    = oldSid.slice(colonIdx + 1);
    const openAt   = new Date(isoTs);
    if (isNaN(openAt.getTime())) continue;

    const openDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(openAt);

    const doc = await upsertSession(groupId, openDate, openAt);
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

module.exports = { getOrCreateSessionId, migrateOrdersToSessionIds };

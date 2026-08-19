'use strict';

const mongoose = require('mongoose');
const TelegramNotificationEvent = require('../models/TelegramNotificationEvent');
const TelegramNotificationDelivery = require('../models/TelegramNotificationDelivery');
const { withLock } = require('../utils/lock');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');

const DELIVERY_LEASE_MS = 90 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const PRIVATE_GAP_MS = 60; // ~16.7 private sends/s, comfortably below Telegram's bulk ceiling.
const PRIVATE_RECIPIENT_GAP_MS = 1100; // avoid >1 msg/s to one private chat.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeRecipient(row) {
  const channel = row?.channel === 'group' ? 'group' : 'private';
  const recipientId = String(row?.recipientId ?? '').trim();
  if (!recipientId) throw new Error('telegram delivery recipientId is required');
  return {
    channel,
    recipientId,
    recipientName: String(row?.recipientName || '').trim(),
    recipientShopId: String(row?.recipientShopId || '').trim(),
    recipientShopName: String(row?.recipientShopName || '').trim(),
    text: String(row?.text || ''),
    eligibilityType: String(row?.eligibilityType || '').trim(),
    eligibilitySessionId: String(row?.eligibilitySessionId || '').trim(),
    eligibilityGroupId: String(row?.eligibilityGroupId || '').trim(),
    initialStatus: row?.initialStatus === 'skipped' ? 'skipped' : 'pending',
    skipReason: String(row?.skipReason || '').trim(),
  };
}

async function ensureNotificationEvent({
  eventKey,
  kind,
  sourceType,
  sourceId,
  sourceRevision = 1,
  deliveryGroupId = '',
  recipients = [],
  metadata = {},
  scheduledAt = null,
  now = new Date(),
  prepareSourceInTransaction = null,
} = {}) {
  const key = String(eventKey || '').trim();
  if (!key) throw new Error('telegram notification eventKey is required');
  const normalized = recipients.map(normalizeRecipient);

  return withLock(`telegram:event:${key}`, async () => {
    const existing = await TelegramNotificationEvent.findOne({ eventKey: key }).lean();
    if (existing) return { event: existing, created: false };

    const session = await mongoose.connection.startSession();
    let createdEvent = null;
    try {
      await session.withTransaction(async () => {
        const again = await TelegramNotificationEvent.findOne({ eventKey: key }).session(session).lean();
        if (again) {
          createdEvent = again;
          return;
        }

        const privateCount = normalized.filter((row) => row.channel === 'private').length;
        const groupCount = normalized.length - privateCount;
        const sendableCount = normalized.filter((row) => row.initialStatus !== 'skipped').length;
        const [event] = await TelegramNotificationEvent.create([{
          eventKey: key,
          kind: String(kind || 'notification'),
          sourceType: String(sourceType || 'system'),
          sourceId: String(sourceId || ''),
          sourceRevision: Number(sourceRevision) || 1,
          deliveryGroupId: String(deliveryGroupId || ''),
          status: sendableCount ? 'pending' : 'completed',
          preparedAt: now,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
          completedAt: sendableCount ? null : now,
          recipientCount: normalized.length,
          privateCount,
          groupCount,
          sentCount: 0,
          failedCount: 0,
          skippedCount: normalized.filter((row) => row.initialStatus === 'skipped').length,
          possibleDuplicateCount: 0,
          metadata,
        }], { session });

        if (normalized.length) {
          await TelegramNotificationDelivery.insertMany(normalized.map((row) => ({
            eventId: event._id,
            eventKey: key,
            channel: row.channel,
            recipientId: row.recipientId,
            recipientName: row.recipientName,
            recipientShopId: row.recipientShopId,
            recipientShopName: row.recipientShopName,
            text: row.text,
            eligibilityType: row.eligibilityType,
            eligibilitySessionId: row.eligibilitySessionId,
            eligibilityGroupId: row.eligibilityGroupId,
            status: row.initialStatus,
            attempts: 0,
            maxAttempts: DEFAULT_MAX_ATTEMPTS,
            nextAttemptAt: row.initialStatus === 'skipped' ? null : now,
            skipReason: row.skipReason,
          })), { session, ordered: true });
        }

        if (typeof prepareSourceInTransaction === 'function') {
          await prepareSourceInTransaction({ session, event, now });
        }
        createdEvent = event.toObject ? event.toObject() : event;
      });
    } finally {
      await session.endSession();
    }

    return { event: createdEvent, created: true };
  }, { ttlMs: 15_000, waitMs: 5_000 });
}

async function claimFreshDueDelivery(now, eventKey = null) {
  const query = {
    status: { $in: ['pending', 'retry_wait'] },
    nextAttemptAt: { $lte: now },
  };
  if (eventKey) query.eventKey = String(eventKey);
  return TelegramNotificationDelivery.findOneAndUpdate(
    query,
    {
      $set: {
        status: 'sending',
        lastAttemptAt: now,
        leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true },
  ).lean();
}

async function claimExpiredSending(now, eventKey = null) {
  const query = { status: 'sending', leaseUntil: { $lte: now } };
  if (eventKey) query.eventKey = String(eventKey);
  return TelegramNotificationDelivery.findOneAndUpdate(
    query,
    {
      $set: {
        status: 'sending',
        possibleDuplicate: true,
        lastAttemptAt: now,
        leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { sort: { leaseUntil: 1, createdAt: 1 }, new: true },
  ).lean();
}

async function claimDueDelivery(now = new Date(), eventKey = null) {
  const fresh = await claimFreshDueDelivery(now, eventKey);
  if (fresh) return fresh;
  return claimExpiredSending(now, eventKey);
}

async function markEventStarted(eventId, now) {
  await TelegramNotificationEvent.updateOne(
    { _id: eventId, firstAttemptAt: null },
    { $set: { firstAttemptAt: now, status: 'delivering' } },
  );
}

async function markDeliverySent(delivery, message, now) {
  const telegramDateSeconds = Number(message?.date);
  const telegramDate = Number.isFinite(telegramDateSeconds)
    ? new Date(telegramDateSeconds * 1000)
    : null;
  await TelegramNotificationDelivery.updateOne(
    { _id: delivery._id, status: 'sending' },
    {
      $set: {
        status: 'sent',
        sentAt: now,
        telegramMessageId: Number(message?.message_id) || null,
        telegramDate,
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: {},
      },
    },
  );
}

async function markDeliveryFailed(delivery, error, now) {
  const classification = classifyTelegramSendError(error);
  const attempts = Number(delivery.attempts || 1);
  // 429 is backpressure, not a terminal delivery failure: honor retry_after and
  // keep it retryable regardless of the ordinary transport-attempt cap.
  const canRetry = classification.rateLimited
    || (classification.retryable && attempts < Number(delivery.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const update = {
    lastError: {
      at: now,
      statusCode: classification.statusCode,
      libraryCode: classification.libraryCode,
      description: classification.description,
      retryable: classification.retryable,
      ambiguous: classification.ambiguous,
    },
    leaseUntil: null,
  };

  if (classification.ambiguous) update.possibleDuplicate = true;

  if (canRetry) {
    update.status = 'retry_wait';
    update.nextAttemptAt = new Date(now.getTime() + retryDelayMs(classification, attempts));
  } else {
    update.status = 'failed';
    update.nextAttemptAt = null;
  }

  await TelegramNotificationDelivery.updateOne(
    { _id: delivery._id, status: 'sending' },
    { $set: update },
  );

  // A Telegram 429 is global backpressure. Move every currently-due ledger row
  // behind the same durable boundary so the next recipient does not immediately
  // hit the same flood limit. This survives a process restart because nextAttemptAt
  // is persisted, unlike an in-memory sleep.
  if (classification.rateLimited && canRetry) {
    const pauseUntil = update.nextAttemptAt;
    await TelegramNotificationDelivery.updateMany(
      {
        status: { $in: ['pending', 'retry_wait'] },
        $or: [
          { nextAttemptAt: null },
          { nextAttemptAt: { $lt: pauseUntil } },
        ],
      },
      { $set: { nextAttemptAt: pauseUntil } },
    );
  }

  if (classification.botBlocked && delivery.channel === 'private') {
    try {
      const { markBotBlocked } = require('../telegramBot');
      if (typeof markBotBlocked === 'function') await markBotBlocked(delivery.recipientId);
    } catch (err) {
      // Delivery truth is already persisted; botBlocked is a derived user flag.
    }
  }
  return classification;
}

async function recomputeEvent(eventId, now = new Date()) {
  const rows = await TelegramNotificationDelivery.aggregate([
    { $match: { eventId: new mongoose.Types.ObjectId(String(eventId)) } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        sent: { $sum: { $cond: [{ $eq: ['$status', 'sent'] }, 1, 0] } },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        skipped: { $sum: { $cond: [{ $eq: ['$status', 'skipped'] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'sending', 'retry_wait']] }, 1, 0] } },
        possibleDuplicate: { $sum: { $cond: ['$possibleDuplicate', 1, 0] } },
      },
    },
  ]);
  const summary = rows[0] || { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0, possibleDuplicate: 0 };
  const terminal = Number(summary.pending || 0) === 0;
  await TelegramNotificationEvent.updateOne(
    { _id: eventId },
    {
      $set: {
        status: terminal ? 'completed' : 'delivering',
        completedAt: terminal ? now : null,
        sentCount: Number(summary.sent || 0),
        failedCount: Number(summary.failed || 0),
        skippedCount: Number(summary.skipped || 0),
        possibleDuplicateCount: Number(summary.possibleDuplicate || 0),
      },
    },
  );
  return { ...summary, terminal };
}

async function markDeliverySkipped(delivery, reason, now = new Date()) {
  await TelegramNotificationDelivery.updateOne(
    { _id: delivery._id, status: 'sending' },
    {
      $set: {
        status: 'skipped',
        skipReason: String(reason || 'not_eligible'),
        leaseUntil: null,
        nextAttemptAt: null,
      },
      $inc: { attempts: Number(delivery.attempts || 0) > 0 ? -1 : 0 },
    },
  );
  await recomputeEvent(delivery.eventId, now);
}

async function deferPrivateRecipientGap(delivery, now = new Date()) {
  if (delivery.channel !== 'private') return false;
  const previous = await TelegramNotificationDelivery.findOne({
    _id: { $ne: delivery._id },
    channel: 'private',
    recipientId: String(delivery.recipientId),
    status: 'sent',
    sentAt: { $ne: null },
  }, 'sentAt').sort({ sentAt: -1 }).lean();
  if (!previous?.sentAt) return false;
  const earliest = new Date(previous.sentAt).getTime() + PRIVATE_RECIPIENT_GAP_MS;
  if (earliest <= now.getTime()) return false;
  await TelegramNotificationDelivery.updateOne(
    { _id: delivery._id, status: 'sending' },
    {
      $set: {
        status: 'retry_wait',
        nextAttemptAt: new Date(earliest),
        leaseUntil: null,
      },
      $inc: { attempts: Number(delivery.attempts || 0) > 0 ? -1 : 0 },
    },
  );
  await recomputeEvent(delivery.eventId, now);
  return true;
}

async function orderingReminderEligibility(delivery) {
  const User = require('../models/User');
  const Shop = require('../models/Shop');
  const CatalogReview = require('../models/CatalogReview');
  const sessionId = String(delivery.eligibilitySessionId || '');
  const groupId = String(delivery.eligibilityGroupId || '');
  const telegramId = String(delivery.recipientId || '');
  if (!sessionId || !groupId || !telegramId) return { eligible: false, reason: 'eligibility_context_missing' };

  const reviewed = await CatalogReview.exists({ sessionId, telegramId });
  if (reviewed) return { eligible: false, reason: 'catalog_reviewed_before_send' };

  const user = await User.findOne({ telegramId }, 'shopId botBlocked accountState role').lean();
  if (!user || user.accountState === 'removed' || !['seller', 'admin'].includes(user.role)) {
    return { eligible: false, reason: 'recipient_no_longer_eligible' };
  }
  if (user.botBlocked) return { eligible: false, reason: 'known_bot_blocked' };
  if (!user.shopId) return { eligible: false, reason: 'recipient_unassigned' };
  const shop = await Shop.findById(user.shopId, 'deliveryGroupId isActive').lean();
  if (!shop || shop.isActive === false || String(shop.deliveryGroupId || '') !== groupId) {
    return { eligible: false, reason: 'recipient_left_delivery_group' };
  }
  return { eligible: true };
}

async function evaluateDeliveryEligibility(delivery) {
  if (delivery.eligibilityType === 'ordering_catalog_review_pending') {
    return orderingReminderEligibility(delivery);
  }
  return { eligible: true };
}

async function sendClaimedDelivery(delivery, now = new Date()) {
  const eligibility = await evaluateDeliveryEligibility(delivery);
  if (!eligibility.eligible) {
    await markDeliverySkipped(delivery, eligibility.reason, now);
    return { sent: false, skipped: true, reason: eligibility.reason };
  }
  if (await deferPrivateRecipientGap(delivery, now)) {
    return { sent: false, deferred: true, reason: 'private_recipient_gap' };
  }
  await markEventStarted(delivery.eventId, now);
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    const err = new Error('telegram bot is not initialized');
    err.code = 'EFATAL';
    await markDeliveryFailed(delivery, err, now);
    return { sent: false };
  }

  try {
    const message = await bot.sendMessage(delivery.recipientId, delivery.text);
    await markDeliverySent(delivery, message, new Date());
    return { sent: true, message };
  } catch (error) {
    const classification = await markDeliveryFailed(delivery, error, new Date());
    return { sent: false, classification };
  } finally {
    await recomputeEvent(delivery.eventId, new Date());
  }
}

async function drainDueDeliveries({ eventKey = null, limit = 100, now = new Date() } = {}) {
  // One global send lane is the transport authority for every Telegram ledger
  // event (ordering-open, hourly reminders, supplement lifecycle, future kinds).
  // Event producers only enqueue durable rows; they never fan out in parallel.
  // This distributed lock is therefore a defence-in-depth invariant against a
  // future call-site accidentally creating a second sender beside the scheduler.
  return withLock('telegram:delivery:send-lane', async () => {
    let processed = 0;
    let sent = 0;
    let sentPrivate = 0;
    let sentGroups = 0;
    let failedOrDeferred = 0;
    while (processed < limit) {
      const delivery = await claimDueDelivery(new Date(), eventKey);
      if (!delivery) break;
      const result = await sendClaimedDelivery(delivery, new Date());
      processed += 1;
      if (result.sent) {
        sent += 1;
        if (delivery.channel === 'private') sentPrivate += 1;
        else sentGroups += 1;
      } else {
        failedOrDeferred += 1;
      }
      if (delivery.channel === 'private') await sleep(PRIVATE_GAP_MS);
    }
    return { processed, sent, sentPrivate, sentGroups, failedOrDeferred };
  }, { ttlMs: 10 * 60 * 1000, waitMs: 1_000 });
}

async function getEventWithDeliveries(eventKey) {
  const event = await TelegramNotificationEvent.findOne({ eventKey: String(eventKey) }).lean();
  if (!event) return null;
  const deliveries = await TelegramNotificationDelivery.find({ eventId: event._id })
    .sort({ channel: 1, recipientName: 1, recipientId: 1 })
    .lean();
  return { event, deliveries };
}

async function listEvents({ deliveryGroupId = '', kind = '', limit = 20 } = {}) {
  const query = {};
  if (deliveryGroupId) query.deliveryGroupId = String(deliveryGroupId);
  if (kind) query.kind = String(kind);
  return TelegramNotificationEvent.find(query)
    .sort({ preparedAt: -1 })
    .limit(Math.min(100, Math.max(1, Number(limit) || 20)))
    .lean();
}

module.exports = {
  DELIVERY_LEASE_MS,
  PRIVATE_GAP_MS,
  PRIVATE_RECIPIENT_GAP_MS,
  DEFAULT_MAX_ATTEMPTS,
  ensureNotificationEvent,
  claimDueDelivery,
  sendClaimedDelivery,
  drainDueDeliveries,
  recomputeEvent,
  getEventWithDeliveries,
  listEvents,
};

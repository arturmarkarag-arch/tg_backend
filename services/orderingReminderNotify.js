'use strict';

/**
 * Hourly private ordering reminders for sellers who have NOT marked the current
 * catalogue as reviewed. This is session-owned server work: no client timer and
 * no group-chat fan-out.
 *
 * Schedule policy (Europe/Warsaw):
 * - the normal ordering-open notification owns T0;
 * - on the opening day reminders start T0+1h and repeat hourly, never after 22:00;
 * - on every following day of the same still-open session reminders resume at
 *   08:00, then 09:00 ... 22:00;
 * - one durable event per exact slot; current-slot derivation prevents a restart
 *   from burst-sending every missed hour.
 */

const OrderingSession = require('../models/OrderingSession');
const DeliveryGroup = require('../models/DeliveryGroup');
const CatalogReview = require('../models/CatalogReview');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup } = require('../utils/groupRecipients');
const { getCurrentOrderingReminderSlot, reminderSlotKey } = require('../utils/orderingReminderSchedule');
const { ensureNotificationEvent } = require('./telegramDeliveryLedger');

function formatRemainingOrderingTime(closeAt, now = new Date()) {
  const remainingMinutes = Math.max(0, Math.ceil((new Date(closeAt).getTime() - new Date(now).getTime()) / 60000));
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} дн`);
  if (hours > 0) parts.push(`${hours} год`);
  if (minutes > 0 || !parts.length) parts.push(`${minutes} хв`);
  return parts.join(' ');
}

function buildOrderingReminderText({ closeAt, now = new Date(), appUrl }) {
  return [
    '⏰ Замовлення досі тривають',
    '',
    'Ви ще не позначили, що переглянули всі товари.',
    `До кінця замовлень залишилось: ${formatRemainingOrderingTime(closeAt, now)}.`,
    'Завершіть замовлення та натисніть «Я переглянув усі товари».',
    appUrl,
  ].filter((line) => line !== '').join('\n');
}

async function activeOrderingSessions(now) {
  const rows = await OrderingSession.find(
    { openAt: { $lte: now }, closeAt: { $gt: now } },
    '_id groupId openDate openAt closeAt pickingStatus',
  ).sort({ groupId: 1, openAt: -1 }).lean();

  // There must be at most one active ordering session per delivery group. If old
  // data violates that invariant, fail closed for that group rather than sending
  // two contradictory reminder streams.
  const byGroup = new Map();
  const conflicted = new Set();
  for (const row of rows) {
    const groupId = String(row.groupId || '');
    if (!groupId) continue;
    if (byGroup.has(groupId)) {
      conflicted.add(groupId);
      continue;
    }
    byGroup.set(groupId, row);
  }
  for (const groupId of conflicted) {
    byGroup.delete(groupId);
    console.warn('[ordering-reminder] multiple active sessions for group; reminders skipped', groupId);
  }
  return [...byGroup.values()];
}

async function prepareOrderingReminderForSession({ session, group, now, appUrl }) {
  const slotAt = getCurrentOrderingReminderSlot({
    openAt: session.openAt,
    closeAt: session.closeAt,
    now,
  });
  if (!slotAt) return { prepared: false, reason: 'no_due_slot' };

  const sellers = await sellersOfGroup(String(group._id), { includeBlocked: true });
  if (!sellers.length) return { prepared: false, reason: 'no_recipients' };

  const sellerIds = sellers.map((seller) => String(seller.telegramId));
  const reviewed = await CatalogReview.find(
    { sessionId: String(session._id), telegramId: { $in: sellerIds } },
    'telegramId',
  ).lean();
  const reviewedIds = new Set(reviewed.map((row) => String(row.telegramId)));
  const pendingSellers = sellers.filter((seller) => !reviewedIds.has(String(seller.telegramId)));
  if (!pendingSellers.length) return { prepared: false, reason: 'all_reviewed' };

  const eventKey = `ordering_reminder:${String(session._id)}:${reminderSlotKey(slotAt)}`;
  const recipients = pendingSellers.map((seller) => ({
    channel: 'private',
    recipientId: String(seller.telegramId),
    recipientName: [seller.firstName, seller.lastName].filter(Boolean).join(' '),
    recipientShopId: String(seller.shopId || ''),
    recipientShopName: String(seller.shopName || ''),
    text: buildOrderingReminderText({ closeAt: session.closeAt, now, appUrl }),
    eligibilityType: 'ordering_catalog_review_pending',
    eligibilitySessionId: String(session._id),
    eligibilityGroupId: String(group._id),
    initialStatus: seller.botBlocked ? 'skipped' : 'pending',
    skipReason: seller.botBlocked ? 'known_bot_blocked' : '',
  }));

  const ensured = await ensureNotificationEvent({
    eventKey,
    kind: 'ordering_reminder',
    sourceType: 'ordering_session',
    sourceId: String(session._id),
    sourceRevision: 1,
    deliveryGroupId: String(group._id),
    recipients,
    scheduledAt: slotAt,
    metadata: {
      groupName: group.name || '',
      slotAt,
      closeAt: session.closeAt,
      stopCondition: 'catalog_review',
      privateOnly: true,
    },
    now,
  });

  return {
    prepared: Boolean(ensured?.created),
    eventKey,
    slotAt,
    recipientCount: recipients.length,
    queued: Boolean(ensured?.created) ? recipients.length : 0,
  };
}

async function notifyDueOrderingReminders({ now = new Date() } = {}) {
  const { getBot } = require('../telegramBot');
  if (!getBot()) return { activeSessions: 0, preparedEvents: 0, sent: 0 };

  const sessions = await activeOrderingSessions(now);
  if (!sessions.length) return { activeSessions: 0, preparedEvents: 0, sent: 0 };

  const groupIds = [...new Set(sessions.map((session) => String(session.groupId)))];
  const groups = await DeliveryGroup.find({ _id: { $in: groupIds } }, '_id name').lean();
  const groupById = new Map(groups.map((group) => [String(group._id), group]));
  const { appUrl = '' } = await getSupplementSettings().catch(() => ({ appUrl: '' }));

  let preparedEvents = 0;
  let queued = 0;
  let recipients = 0;
  for (const session of sessions) {
    const group = groupById.get(String(session.groupId));
    if (!group) continue;
    try {
      const result = await prepareOrderingReminderForSession({ session, group, now, appUrl });
      if (result.prepared) preparedEvents += 1;
      queued += Number(result.queued || 0);
      recipients += Number(result.recipientCount || 0);
    } catch (err) {
      console.warn('[ordering-reminder] session reminder failed', String(session._id), err?.message || err);
    }
  }
  return { activeSessions: sessions.length, preparedEvents, recipients, queued, sent: 0 };
}

module.exports = {
  buildOrderingReminderText,
  formatRemainingOrderingTime,
  activeOrderingSessions,
  prepareOrderingReminderForSession,
  notifyDueOrderingReminders,
};

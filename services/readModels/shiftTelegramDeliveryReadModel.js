'use strict';

const TelegramNotificationEvent = require('../../models/TelegramNotificationEvent');
const TelegramNotificationDelivery = require('../../models/TelegramNotificationDelivery');

const ORDERING_KINDS = ['ordering_open', 'ordering_reminder'];

async function buildShiftTelegramDeliveryReadModel({ orderingSessionId, deliveryGroupId }) {
  const sessionId = String(orderingSessionId || '');
  const groupId = String(deliveryGroupId || '');
  if (!sessionId || !groupId) return { byRecipient: new Map(), recipientSnapshots: [] };

  const events = await TelegramNotificationEvent.find({
    sourceType: 'ordering_session',
    sourceId: sessionId,
    deliveryGroupId: groupId,
    kind: { $in: ORDERING_KINDS },
  }, 'eventKey kind scheduledAt preparedAt metadata').sort({ scheduledAt: 1, preparedAt: 1 }).lean();
  if (!events.length) return { byRecipient: new Map(), recipientSnapshots: [] };

  const eventById = new Map(events.map((event) => [String(event._id), event]));
  const deliveries = await TelegramNotificationDelivery.find({
    eventId: { $in: events.map((event) => event._id) },
    channel: 'private',
  }, 'eventId eventKey recipientId recipientName recipientShopId recipientShopName status attempts sentAt telegramMessageId telegramDate possibleDuplicate skipReason lastError').sort({ createdAt: 1 }).lean();

  const byRecipient = new Map();
  const snapshotByRecipient = new Map();
  for (const row of deliveries) {
    const recipientId = String(row.recipientId || '');
    if (!recipientId) continue;
    const event = eventById.get(String(row.eventId));
    if (!event) continue;
    if (!byRecipient.has(recipientId)) byRecipient.set(recipientId, []);
    byRecipient.get(recipientId).push({
      eventKey: row.eventKey,
      kind: event.kind,
      scheduledAt: event.scheduledAt || event.preparedAt || null,
      preparedAt: event.preparedAt || null,
      status: row.status,
      attempts: Number(row.attempts || 0),
      sentAt: row.sentAt || null,
      telegramMessageId: row.telegramMessageId ?? null,
      telegramDate: row.telegramDate || null,
      possibleDuplicate: Boolean(row.possibleDuplicate),
      skipReason: row.skipReason || '',
      lastError: row.lastError || {},
    });
    if (!snapshotByRecipient.has(recipientId)) {
      snapshotByRecipient.set(recipientId, {
        telegramId: recipientId,
        name: row.recipientName || recipientId,
        shopId: String(row.recipientShopId || ''),
        shopName: row.recipientShopName || '',
      });
    }
  }

  for (const rows of byRecipient.values()) {
    rows.sort((a, b) => new Date(a.scheduledAt || a.preparedAt || 0) - new Date(b.scheduledAt || b.preparedAt || 0));
  }
  return { byRecipient, recipientSnapshots: [...snapshotByRecipient.values()] };
}

module.exports = { ORDERING_KINDS, buildShiftTelegramDeliveryReadModel };

'use strict';

// Telegram-правила: docs/supplement/readme.md#7-telegram

const DeliveryGroup = require('../models/DeliveryGroup');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementWave = require('../models/SupplementWave');
const SupplementOfferModel = SupplementOffer;
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup, serviceGroupChatIds } = require('../utils/groupRecipients');
const { ITEM_STATUS, ITEM_RELATION_STATUS } = require('../utils/supplementState');

const NOTIFY_TYPES = ['opened', 'reminder', 'frozen', 'cancelled'];
const REMINDER_EVERY_MS = 2 * 60 * 60 * 1000;
const SEND_GAP_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildText(type, { groupName, appUrl, offersCount = 0 }) {
  const name = groupName || 'Група доставки';
  if (type === 'frozen') {
    return [
      'Відкриті позиції дозамовлення передано в роботу',
      name,
      '',
      'Зміни цих позицій більше недоступні. Вони передані в роботу складу.',
      appUrl,
    ].join('\n');
  }
  if (type === 'cancelled') {
    return [
      'Дозамовлення скасовано',
      name,
      '',
      'Скасовано.',
      appUrl,
    ].join('\n');
  }
  const title = type === 'reminder'
    ? `Нагадування — Дозамовлення — ${name}`
    : `Дозамовлення — ${name}`;
  return [
    '‼️',
    title,
    '',
    `Всі магазини ${name}, приїхав новий товар, ЗРОБІТЬ ТЕРМІНОВО ЗАМОВЛЕННЯ.`,
    ...(offersCount > 1 ? [`Відкритих товарів у дозамовленні: ${offersCount}.`] : []),
    '',
    'Відкрийте додаток → «Товари» — картки позначені бейджем «Дозамовлення».',
    appUrl,
  ].join('\n');
}

async function claimOpened(offers, now) {
  const claimed = [];
  for (const offer of offers) {
    const updated = await SupplementOffer.findOneAndUpdate(
      { _id: offer._id, status: ITEM_STATUS.OPEN, notifiedTypes: { $ne: 'opened' } },
      { $addToSet: { notifiedTypes: 'opened' }, $set: { lastReminderAt: now } },
      { new: true },
    );
    if (updated) claimed.push(offer);
  }
  return claimed;
}

async function releaseOpened(offers) {
  if (!offers.length) return;
  await SupplementOffer.updateMany(
    { _id: { $in: offers.map((offer) => offer._id) } },
    { $pull: { notifiedTypes: 'opened' }, $set: { lastReminderAt: null } },
  );
}

async function claimReminders(offers, now) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const claimed = [];
  for (const offer of offers) {
    const updated = await SupplementOffer.findOneAndUpdate(
      {
        _id: offer._id,
        status: ITEM_STATUS.OPEN,
        waveId: null,
        notifiedTypes: 'opened',
        $or: [
          { lastReminderAt: null },
          { lastReminderAt: { $lte: threshold } },
        ],
      },
      { $set: { lastReminderAt: now } },
      { new: true },
    );
    if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
  }
  return claimed;
}

async function notifyOffers(offers, type, { now = new Date() } = {}) {
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`supplementNotify: невідомий тип '${type}'`);
  if (!offers?.length) return { sentPrivate: 0, sentGroups: 0 };

  const { appUrl } = await getSupplementSettings();
  if (!appUrl) {
    return { sentPrivate: 0, sentGroups: 0 };
  }

  const { getBot, sendMessageWithRetry } = require('../telegramBot');
  if (!getBot()) {
    return { sentPrivate: 0, sentGroups: 0 };
  }

  const claimed = type === 'opened'
    ? await claimOpened(offers, now)
    : await claimReminders(offers, now);
  if (!claimed.length) return { sentPrivate: 0, sentGroups: 0 };

  const byGroup = new Map();
  for (const offer of claimed) {
    const groupId = String(offer.deliveryGroupId);
    if (!byGroup.has(groupId)) byGroup.set(groupId, []);
    byGroup.get(groupId).push(offer);
  }

  const groups = await DeliveryGroup.find(
    { _id: { $in: [...byGroup.keys()] } },
    'name',
  ).lean();
  const groupNameById = new Map(groups.map((group) => [String(group._id), group.name || '']));
  const chatIds = await serviceGroupChatIds();

  let sentPrivate = 0;
  let sentGroups = 0;
  let deliveredAny = false;

  for (const [groupId] of byGroup) {
    const text = buildText(type, {
      groupName: groupNameById.get(groupId) || '',
      appUrl,
      offersCount: byGroup.get(groupId)?.length || 0,
    });

    const sellers = await sellersOfGroup(groupId);
    for (const seller of sellers) {
      try {
        await sendMessageWithRetry(seller.telegramId, text);
        sentPrivate += 1;
        deliveredAny = true;
      } catch (err) {
      }
      await sleep(SEND_GAP_MS);
    }

    for (const chatId of chatIds) {
      try {
        await sendMessageWithRetry(chatId, text);
        sentGroups += 1;
        deliveredAny = true;
      } catch (err) {
      }
    }
  }

  // Стартове повідомлення можна повторити на наступному тіку, якщо Telegram не
  // прийняв жодного повідомлення. Для reminder достатньо наступної спроби через
  // дві години — це нагадування, а не критичний запис.
  if (type === 'opened' && !deliveredAny) await releaseOpened(claimed);

  return { sentPrivate, sentGroups };
}

async function findDueReminders(now = new Date()) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const [opened, reminder] = await Promise.all([
    SupplementOffer.find(
      { status: ITEM_STATUS.OPEN, waveId: null, notifiedTypes: { $ne: 'opened' } },
      '_id receiptId deliveryGroupId openedAt notifiedTypes lastReminderAt',
    ).lean(),
    SupplementOffer.find(
      {
        status: ITEM_STATUS.OPEN,
        waveId: null,
        notifiedTypes: 'opened',
        $or: [
          { lastReminderAt: null, openedAt: { $lte: threshold } },
          { lastReminderAt: { $lte: threshold } },
        ],
      },
      '_id receiptId deliveryGroupId openedAt notifiedTypes lastReminderAt',
    ).lean(),
  ]);
  return { opened, reminder };
}



// ── V48.S3 group-session container lifecycle notifications ───────────────────────────────

function isV3NotificationWave(wave) {
  return Number(wave?.architectureVersion || 0) >= 3 && Number(wave?.activityRevision || 0) > 0;
}

async function claimWaveOpened(waves, now) {
  const claimed = [];
  for (const wave of waves || []) {
    if (isV3NotificationWave(wave)) {
      const revision = Number(wave.activityRevision);
      const updated = await SupplementWave.findOneAndUpdate(
        { _id: wave._id, status: ITEM_STATUS.OPEN, activityRevision: revision, openedNotifiedRevision: { $lt: revision } },
        { $set: { openedNotifiedRevision: revision, lastReminderRevision: revision, lastReminderAt: now } },
        { new: true },
      );
      if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
      continue;
    }
    const updated = await SupplementWave.findOneAndUpdate(
      { _id: wave._id, status: ITEM_STATUS.OPEN, notifiedTypes: { $ne: 'opened' } },
      { $addToSet: { notifiedTypes: 'opened' }, $set: { lastReminderAt: now } },
      { new: true },
    );
    if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
  }
  return claimed;
}

async function releaseWaveOpened(waves) {
  if (!waves?.length) return;
  for (const wave of waves) {
    if (isV3NotificationWave(wave)) {
      const revision = Number(wave.activityRevision);
      await SupplementWave.updateOne(
        { _id: wave._id, activityRevision: revision, openedNotifiedRevision: revision },
        { $set: { openedNotifiedRevision: Math.max(0, revision - 1), lastReminderRevision: 0, lastReminderAt: null } },
      );
      continue;
    }
    await SupplementWave.updateOne(
      { _id: wave._id },
      { $pull: { notifiedTypes: 'opened' }, $set: { lastReminderAt: null } },
    );
  }
}

async function claimWaveReminders(waves, now) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const claimed = [];
  for (const wave of waves || []) {
    if (isV3NotificationWave(wave)) {
      const revision = Number(wave.activityRevision);
      const updated = await SupplementWave.findOneAndUpdate(
        {
          _id: wave._id,
          status: ITEM_STATUS.OPEN,
          activityRevision: revision,
          openedNotifiedRevision: revision,
          $or: [
            { lastReminderRevision: { $lt: revision } },
            { lastReminderAt: null },
            { lastReminderAt: { $lte: threshold } },
          ],
        },
        { $set: { lastReminderRevision: revision, lastReminderAt: now } },
        { new: true },
      );
      if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
      continue;
    }
    const updated = await SupplementWave.findOneAndUpdate(
      {
        _id: wave._id,
        status: ITEM_STATUS.OPEN,
        notifiedTypes: 'opened',
        $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: threshold } }],
      },
      { $set: { lastReminderAt: now } },
      { new: true },
    );
    if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
  }
  return claimed;
}

async function claimWaveLifecycle(waves, type) {
  const claimed = [];
  for (const wave of waves || []) {
    const requiredStatus = type === 'frozen' ? ITEM_STATUS.FROZEN : type === 'cancelled' ? ITEM_STATUS.CANCELLED : wave.status;
    if (isV3NotificationWave(wave) && ['frozen', 'cancelled'].includes(type)) {
      const revision = Number(wave.activityRevision);
      const field = type === 'frozen' ? 'frozenNotifiedRevision' : 'cancelledNotifiedRevision';
      const updated = await SupplementWave.findOneAndUpdate(
        { _id: wave._id, status: requiredStatus, activityRevision: revision, [field]: { $lt: revision } },
        { $set: { [field]: revision } },
        { new: true },
      );
      if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
      continue;
    }
    const updated = await SupplementWave.findOneAndUpdate(
      { _id: wave._id, status: requiredStatus, notifiedTypes: { $ne: type } },
      { $addToSet: { notifiedTypes: type } },
      { new: true },
    );
    if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
  }
  return claimed;
}

async function prepareWaveNotificationEvent(wave, type, { now, text, sellers, chatIds }) {
  const { ensureNotificationEvent } = require('./telegramDeliveryLedger');
  const revision = isV3NotificationWave(wave) ? Number(wave.activityRevision) : 1;
  const reminderSuffix = type === 'reminder' ? `:${now.getTime()}` : '';
  const eventKey = `supplement_wave:${String(wave._id)}:rev:${revision}:${type}${reminderSuffix}`;
  const recipients = [
    ...sellers.map((seller) => ({
      channel: 'private',
      recipientId: String(seller.telegramId),
      recipientName: [seller.firstName, seller.lastName].filter(Boolean).join(' '),
      text,
      initialStatus: seller.botBlocked ? 'skipped' : 'pending',
      skipReason: seller.botBlocked ? 'known_bot_blocked' : '',
    })),
    ...chatIds.map((chatId) => ({ channel: 'group', recipientId: String(chatId), text })),
  ];

  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  return ensureNotificationEvent({
    eventKey,
    kind: `supplement_${type}`,
    sourceType: 'supplement_wave',
    sourceId: String(wave._id),
    sourceRevision: revision,
    deliveryGroupId: String(wave.deliveryGroupId || ''),
    recipients,
    metadata: { notificationType: type },
    now,
    prepareSourceInTransaction: async ({ session }) => {
      let query = { _id: wave._id };
      let update = {};
      if (isV3NotificationWave(wave)) {
        if (type === 'opened') {
          query = { ...query, status: ITEM_STATUS.OPEN, activityRevision: revision, openedNotifiedRevision: { $lt: revision } };
          update = { $set: { openedNotifiedRevision: revision, lastReminderRevision: revision, lastReminderAt: now } };
        } else if (type === 'reminder') {
          query = {
            ...query,
            status: ITEM_STATUS.OPEN,
            activityRevision: revision,
            openedNotifiedRevision: { $gte: revision },
            $or: [
              { lastReminderRevision: { $lt: revision } },
              { lastReminderAt: null },
              { lastReminderAt: { $lte: threshold } },
            ],
          };
          update = { $set: { lastReminderRevision: revision, lastReminderAt: now } };
        } else {
          const requiredStatus = type === 'frozen' ? ITEM_STATUS.FROZEN : ITEM_STATUS.CANCELLED;
          const field = type === 'frozen' ? 'frozenNotifiedRevision' : 'cancelledNotifiedRevision';
          query = { ...query, status: requiredStatus, activityRevision: revision, [field]: { $lt: revision } };
          update = { $set: { [field]: revision } };
        }
      } else if (type === 'opened') {
        query = { ...query, status: ITEM_STATUS.OPEN, notifiedTypes: { $ne: 'opened' } };
        update = { $addToSet: { notifiedTypes: 'opened' }, $set: { lastReminderAt: now } };
      } else if (type === 'reminder') {
        query = {
          ...query,
          status: ITEM_STATUS.OPEN,
          notifiedTypes: 'opened',
          $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: threshold } }],
        };
        update = { $set: { lastReminderAt: now } };
      } else {
        const requiredStatus = type === 'frozen' ? ITEM_STATUS.FROZEN : ITEM_STATUS.CANCELLED;
        query = { ...query, status: requiredStatus, notifiedTypes: { $ne: type } };
        update = { $addToSet: { notifiedTypes: type } };
      }
      const marker = await SupplementWave.updateOne(query, update, { session });
      if (Number(marker?.matchedCount || 0) !== 1) {
        const err = new Error(`supplement ${type} notification marker already claimed`);
        err.code = 'supplement_notification_marker_claim_lost';
        throw err;
      }
    },
  });
}

async function notifyWaves(waves, type, { now = new Date() } = {}) {
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`supplementNotify: невідомий тип '${type}'`);
  if (!waves?.length) return { sentPrivate: 0, sentGroups: 0, queuedPrivate: 0, queuedGroups: 0 };

  const { appUrl } = await getSupplementSettings();
  if (!appUrl) return { sentPrivate: 0, sentGroups: 0, queuedPrivate: 0, queuedGroups: 0 };
  const { getBot } = require('../telegramBot');
  if (!getBot()) return { sentPrivate: 0, sentGroups: 0, queuedPrivate: 0, queuedGroups: 0 };

  const groupIds = [...new Set(waves.map((wave) => String(wave.deliveryGroupId)))];
  const [groups, counts, chatIds] = await Promise.all([
    DeliveryGroup.find({ _id: { $in: groupIds } }, 'name').lean(),
    Promise.all(waves.map(async (wave) => ({
      waveId: String(wave._id),
      count: await SupplementOfferModel.countDocuments({
        waveId: wave._id,
        itemStatus: ITEM_RELATION_STATUS.ACTIVE,
        status: type === 'frozen' ? ITEM_STATUS.FROZEN : type === 'cancelled' ? ITEM_STATUS.CANCELLED : ITEM_STATUS.OPEN,
      }),
    }))),
    serviceGroupChatIds(),
  ]);
  const groupNameById = new Map(groups.map((group) => [String(group._id), group.name || '']));
  const countByWave = new Map(counts.map((row) => [row.waveId, row.count]));

  let sentPrivate = 0;
  let sentGroups = 0;
  let queuedPrivate = 0;
  let queuedGroups = 0;

  for (const wave of waves) {
    const groupId = String(wave.deliveryGroupId);
    const text = buildText(type, {
      groupName: groupNameById.get(groupId) || '',
      appUrl,
      offersCount: countByWave.get(String(wave._id)) || 0,
    });
    const sellers = await sellersOfGroup(groupId, { includeBlocked: true });
    if (!sellers.length && !chatIds.length) continue;

    let prepared;
    try {
      prepared = await prepareWaveNotificationEvent(wave, type, { now, text, sellers, chatIds });
    } catch (err) {
      if (err?.code === 'supplement_notification_marker_claim_lost') continue;
      throw err;
    }
    if (prepared?.created) {
      queuedPrivate += sellers.length;
      queuedGroups += chatIds.length;
    }
    // Actual transport is owned by the single global delivery worker. Keeping
    // preparation and transport separate prevents parallel ordering/supplement
    // schedulers from multiplying the Telegram send rate.
  }

  return { sentPrivate, sentGroups, queuedPrivate, queuedGroups };
}

async function findDueWaveNotifications(now = new Date()) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const openWaves = await SupplementWave.find(
    { status: ITEM_STATUS.OPEN, mergedIntoWaveId: null },
    '_id deliveryGroupId orderingSessionId status architectureVersion activityRevision openedNotifiedRevision lastReminderRevision openedAt notifiedTypes lastReminderAt',
  ).lean();
  const opened = [];
  const reminder = [];
  for (const wave of openWaves) {
    if (isV3NotificationWave(wave)) {
      const revision = Number(wave.activityRevision);
      if (Number(wave.openedNotifiedRevision || 0) < revision) opened.push(wave);
      else if (Number(wave.lastReminderRevision || 0) < revision || !wave.lastReminderAt || new Date(wave.lastReminderAt) <= threshold) reminder.push(wave);
      continue;
    }
    if (!(wave.notifiedTypes || []).includes('opened')) opened.push(wave);
    else if (!wave.lastReminderAt || new Date(wave.lastReminderAt) <= threshold) reminder.push(wave);
  }
  return { opened, reminder };
}

module.exports = {
  NOTIFY_TYPES,
  REMINDER_EVERY_MS,
  buildText,
  notifyOffers,
  findDueReminders,
  notifyWaves,
  findDueWaveNotifications,
};

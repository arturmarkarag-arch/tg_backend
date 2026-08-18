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

async function notifyWaves(waves, type, { now = new Date() } = {}) {
  if (!NOTIFY_TYPES.includes(type)) throw new Error(`supplementNotify: невідомий тип '${type}'`);
  if (!waves?.length) return { sentPrivate: 0, sentGroups: 0 };

  const { appUrl } = await getSupplementSettings();
  if (!appUrl) return { sentPrivate: 0, sentGroups: 0 };
  const { getBot, sendMessageWithRetry } = require('../telegramBot');
  if (!getBot()) return { sentPrivate: 0, sentGroups: 0 };

  const claimed = type === 'opened'
    ? await claimWaveOpened(waves, now)
    : type === 'reminder'
      ? await claimWaveReminders(waves, now)
      : await claimWaveLifecycle(waves, type);
  if (!claimed.length) return { sentPrivate: 0, sentGroups: 0 };

  const groupIds = [...new Set(claimed.map((wave) => String(wave.deliveryGroupId)))];
  const [groups, counts, chatIds] = await Promise.all([
    DeliveryGroup.find({ _id: { $in: groupIds } }, 'name').lean(),
    Promise.all(claimed.map(async (wave) => ({
      waveId: String(wave._id),
      count: await SupplementOfferModel.countDocuments({ waveId: wave._id, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: type === 'frozen' ? ITEM_STATUS.FROZEN : type === 'cancelled' ? ITEM_STATUS.CANCELLED : ITEM_STATUS.OPEN }),
    }))),
    serviceGroupChatIds(),
  ]);
  const groupNameById = new Map(groups.map((group) => [String(group._id), group.name || '']));
  const countByWave = new Map(counts.map((row) => [row.waveId, row.count]));

  let sentPrivate = 0;
  let sentGroups = 0;
  let deliveredAny = false;
  for (const wave of claimed) {
    const groupId = String(wave.deliveryGroupId);
    const text = buildText(type, {
      groupName: groupNameById.get(groupId) || '',
      appUrl,
      offersCount: countByWave.get(String(wave._id)) || 0,
    });
    const sellers = await sellersOfGroup(groupId);
    for (const seller of sellers) {
      try { await sendMessageWithRetry(seller.telegramId, text); sentPrivate += 1; deliveredAny = true; } catch (_) {}
      await sleep(SEND_GAP_MS);
    }
    for (const chatId of chatIds) {
      try { await sendMessageWithRetry(chatId, text); sentGroups += 1; deliveredAny = true; } catch (_) {}
    }
  }

  if (type === 'opened' && !deliveredAny) await releaseWaveOpened(claimed);
  return { sentPrivate, sentGroups };
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

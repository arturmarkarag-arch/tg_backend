'use strict';

// Telegram-правила: docs/supplement/readme.md#7-telegram

const DeliveryGroup = require('../models/DeliveryGroup');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementWave = require('../models/SupplementWave');
const SupplementOfferModel = SupplementOffer;
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup, serviceGroupChatIds } = require('../utils/groupRecipients');

const NOTIFY_TYPES = ['opened', 'reminder', 'frozen', 'cancelled'];
const REMINDER_EVERY_MS = 2 * 60 * 60 * 1000;
const SEND_GAP_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildText(type, { groupName, appUrl, offersCount = 0 }) {
  const name = groupName || 'Група доставки';
  if (type === 'frozen') {
    return [
      'Дозамовлення закрито',
      name,
      '',
      'Зміни замовлень більше недоступні. Товар передано в роботу складу.',
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
    ...(offersCount > 1 ? [`Нових товарів у пачці: ${offersCount}.`] : []),
    '',
    'Відкрийте додаток → «Товари» — картки позначені бейджем «Дозамовлення».',
    appUrl,
  ].join('\n');
}

async function claimOpened(offers, now) {
  const claimed = [];
  for (const offer of offers) {
    const updated = await SupplementOffer.findOneAndUpdate(
      { _id: offer._id, status: 'open', notifiedTypes: { $ne: 'opened' } },
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
        status: 'open',
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
      { status: 'open', waveId: null, notifiedTypes: { $ne: 'opened' } },
      '_id receiptId deliveryGroupId openedAt notifiedTypes lastReminderAt',
    ).lean(),
    SupplementOffer.find(
      {
        status: 'open',
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



// ── V48.S2 Wave-level lifecycle notifications ───────────────────────────────

async function claimWaveOpened(waves, now) {
  const claimed = [];
  for (const wave of waves || []) {
    const updated = await SupplementWave.findOneAndUpdate(
      { _id: wave._id, status: 'open', notifiedTypes: { $ne: 'opened' } },
      { $addToSet: { notifiedTypes: 'opened' }, $set: { lastReminderAt: now } },
      { new: true },
    );
    if (updated) claimed.push(updated.toObject ? updated.toObject() : updated);
  }
  return claimed;
}

async function releaseWaveOpened(waves) {
  if (!waves?.length) return;
  await SupplementWave.updateMany(
    { _id: { $in: waves.map((wave) => wave._id) } },
    { $pull: { notifiedTypes: 'opened' }, $set: { lastReminderAt: null } },
  );
}

async function claimWaveReminders(waves, now) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const claimed = [];
  for (const wave of waves || []) {
    const updated = await SupplementWave.findOneAndUpdate(
      {
        _id: wave._id,
        status: 'open',
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
    const requiredStatus = type === 'frozen' ? 'frozen' : type === 'cancelled' ? 'cancelled' : wave.status;
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
      count: await SupplementOfferModel.countDocuments({ waveId: wave._id, itemStatus: 'active' }),
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
  const [opened, reminder] = await Promise.all([
    SupplementWave.find(
      { status: 'open', notifiedTypes: { $ne: 'opened' } },
      '_id deliveryGroupId orderingSessionId openedAt notifiedTypes lastReminderAt',
    ).lean(),
    SupplementWave.find(
      {
        status: 'open',
        notifiedTypes: 'opened',
        $or: [
          { lastReminderAt: null, openedAt: { $lte: threshold } },
          { lastReminderAt: { $lte: threshold } },
        ],
      },
      '_id deliveryGroupId orderingSessionId openedAt notifiedTypes lastReminderAt',
    ).lean(),
  ]);
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

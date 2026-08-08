'use strict';

// Telegram-правила: docs/supplement/readme.md#7-telegram

const DeliveryGroup = require('../models/DeliveryGroup');
const SupplementOffer = require('../models/SupplementOffer');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup, serviceGroupChatIds } = require('../utils/groupRecipients');

const NOTIFY_TYPES = ['opened', 'reminder'];
const REMINDER_EVERY_MS = 2 * 60 * 60 * 1000;
const SEND_GAP_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildText(type, { groupName, appUrl }) {
  const name = groupName || 'Група доставки';
  const title = type === 'reminder'
    ? `Нагадування — Дозамовлення — ${name}`
    : `Дозамовлення — ${name}`;

  return [
    '‼️',
    title,
    '',
    `Всі магазини ${name}, приїхав новий товар, ЗРОБІТЬ ТЕРМІНОВО ЗАМОВЛЕННЯ.`,
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
    console.warn('[supplement/notify] не налаштовано посилання на Mini App — повідомлення не надіслано');
    return { sentPrivate: 0, sentGroups: 0 };
  }

  const { getBot, sendMessageWithRetry } = require('../telegramBot');
  if (!getBot()) {
    console.warn('[supplement/notify] бот не піднятий — повідомлення відкладено');
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
    });

    const sellers = await sellersOfGroup(groupId);
    for (const seller of sellers) {
      try {
        await sendMessageWithRetry(seller.telegramId, text);
        sentPrivate += 1;
        deliveredAny = true;
      } catch (err) {
        console.warn('[supplement/notify] приватне повідомлення', seller.telegramId, 'не доставлено:', err.message);
      }
      await sleep(SEND_GAP_MS);
    }

    for (const chatId of chatIds) {
      try {
        await sendMessageWithRetry(chatId, text);
        sentGroups += 1;
        deliveredAny = true;
      } catch (err) {
        console.warn('[supplement/notify] пост у групу', chatId, 'не доставлено:', err.message);
      }
    }
  }

  // Стартове повідомлення можна повторити на наступному тіку, якщо Telegram не
  // прийняв жодного повідомлення. Для reminder достатньо наступної спроби через
  // дві години — це нагадування, а не критичний запис.
  if (type === 'opened' && !deliveredAny) await releaseOpened(claimed);

  console.log(`[supplement/notify] ${type}: ${claimed.length} пропозицій → ${sentPrivate} продавцям, ${sentGroups} у групи`);
  return { sentPrivate, sentGroups };
}

async function findDueReminders(now = new Date()) {
  const threshold = new Date(now.getTime() - REMINDER_EVERY_MS);
  const [opened, reminder] = await Promise.all([
    SupplementOffer.find(
      { status: 'open', notifiedTypes: { $ne: 'opened' } },
      '_id receiptId deliveryGroupId openedAt notifiedTypes lastReminderAt',
    ).lean(),
    SupplementOffer.find(
      {
        status: 'open',
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

module.exports = {
  NOTIFY_TYPES,
  REMINDER_EVERY_MS,
  buildText,
  notifyOffers,
  findDueReminders,
};

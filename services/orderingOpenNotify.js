'use strict';

/**
 * «Замовлення відкрито» — розсилка на старті вікна замовлень групи доставки.
 *
 * Два адресати, один привід:
 *   - робочі Telegram-чати (спільний плоский список) — пост НАЗИВАЄ групу, бо
 *     чат один на всіх, і продавці інших груп мають розуміти, що це не їм;
 *   - приватка кожному продавцю цієї групи — короткий текст лише з дедлайном,
 *     бо людина вже знає, у якій вона групі.
 *
 * Надійність — durable Telegram delivery ledger: одна подія на orderingSession
 * і один delivery-row на кожного адресата. `openNotifiedAt` лишився legacy marker
 * факту, що fan-out атомарно підготовлено, але НЕ є джерелом delivery truth.
 */

const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const {
  isOrderingOpen,
  getWindowDescription,
  getOrderingWindowOpenAt,
  getOpenDateWarsaw,
  getSessionDeliveryDate,
  DAY_FULL_UK,
} = require('../utils/orderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');
const { getSupplementSettings } = require('../utils/supplementSettings');
const { sellersOfGroup, serviceGroupChatIds } = require('../utils/groupRecipients');

// Наскільки пізно ще має сенс казати «замовлення відкрито». Якщо сервер лежав
// або деплоївся довше — нову подію вже не створюємо. Якщо ж durable event був
// створений вчасно, його pending/retry deliveries продовжує окремий scheduler. Свідомий
// вибір: повідомлення «старт замовлень», надіслане за годину до закриття вікна,
// дезорієнтує сильніше, ніж його відсутність. Це ж правило гасить залп на
// першому деплої цієї фічі: вікна, відкриті раніше, нікого не розбудять.
const MAX_LATENESS_MS = 2 * 60 * 60 * 1000;

/**
 * Чи вікно відкрилось достатньо недавно, щоб про це ще варто було писати.
 *
 * Опорна точка — ОБЧИСЛЕНИЙ момент відкриття з поточного розкладу, а не
 * `OrderingSession.openAt`. Збережене поле пишеться при створенні сесії тодішнім
 * розкладом і застаріває, щойно адмін зсуне години: сесія лишається та сама
 * (її ідентичність — openDate), а openAt починає показувати на момент, якого
 * вже немає. Спіймано наживо: розклад зсунули з 16:30 на 03:30, `now - openAt`
 * вийшло ВІД'ЄМНИМ (відкриття «через 3.7 години»), і перевірка на запізнення
 * пропустила давно відкрите вікно. getOrderingWindowOpenAt завжди повертає
 * найближче МИНУЛЕ відкриття і рахується з того самого розкладу, що й
 * isOrderingOpen — розійтись вони не можуть.
 */
function isFreshOpen(openedAt, now) {
  const elapsed = now.getTime() - openedAt.getTime();
  return elapsed >= 0 && elapsed <= MAX_LATENESS_MS;
}

/**
 * Пряме посилання на Mini App. Джерело — те саме налаштування, що й у
 * дозамовленнях (адмін вписує його в Налаштуваннях). Якщо воно не заповнене,
 * повідомлення йде без посилання: текст самодостатній, і мовчати через
 * відсутній URL було б гірше, ніж надіслати без нього.
 */
async function miniAppLink() {
  try {
    const { appUrl } = await getSupplementSettings();
    return appUrl || '';
  } catch (err) {
    return '';
  }
}

/**
 * «понеділок, 17.08» — physical delivery date for this session. The delivery
 * weekday is independent from the ordering close weekday.
 */
function deliveryDateLabel(dayOfWeek, schedule, now = new Date()) {
  const openDate = getOpenDateWarsaw(schedule, now);
  const deliveryDate = getSessionDeliveryDate(openDate, dayOfWeek, schedule);
  const [, month, day] = deliveryDate.split('-');
  return `${DAY_FULL_UK[dayOfWeek]}, ${day}.${month}`;
}

/** «завтра о 07:30» / «сьогодні о 07:30» / «в четвер о 07:30». */
function closePhrase(window) {
  return `${window.closeLabel} о ${window.closeTime}`;
}

function buildGroupText({ groupName, deliveryLabel, closeLabel, appUrl }) {
  const name = groupName || 'Група доставки';
  return [
    '‼️‼️‼️',
    `Замовлення відкрито — ${name}`,
    'Перейдить за посиланням  Настиність «Відкрити» - «Товари» і зробіть замовлення.',
    '👇👇👇',
    appUrl,
  ].filter((line) => line !== '').join('\n');
}

function buildPrivateText({ closeLabel, appUrl }) {
  return [
    '‼️‼️‼️',
    'Замовлення відкрито',
    '',
    'Перейдить за посиланням Настиність «Відкрити» - «Товари» і зробіть замовлення.',
    '👇👇👇',
    appUrl,
  ].filter((line) => line !== '').join('\n');
}

/**
 * Delivery truth no longer lives in OrderingSession.openNotifiedAt.
 * A notification event + one durable row per recipient are created atomically.
 * `openNotifiedAt` is retained only as a legacy/session marker that the fan-out
 * was DURABLY prepared; retries/recovery are driven by TelegramNotificationDelivery.
 */
async function prepareOrderingOpenEvent({ sessionId, group, sellers, chatIds, closeLabel, appUrl, groupText, now }) {
  const { ensureNotificationEvent } = require('./telegramDeliveryLedger');
  const eventKey = `ordering_open:${String(sessionId)}`;
  const recipients = [
    ...sellers.map((seller) => ({
      channel: 'private',
      recipientId: String(seller.telegramId),
      recipientName: [seller.firstName, seller.lastName].filter(Boolean).join(' '),
      recipientShopId: String(seller.shopId || ''),
      recipientShopName: String(seller.shopName || ''),
      text: buildPrivateText({ closeLabel, appUrl }),
      initialStatus: seller.botBlocked ? 'skipped' : 'pending',
      skipReason: seller.botBlocked ? 'known_bot_blocked' : '',
    })),
    ...chatIds.map((chatId) => ({
      channel: 'group',
      recipientId: String(chatId),
      recipientName: '',
      text: groupText,
    })),
  ];

  return ensureNotificationEvent({
    eventKey,
    kind: 'ordering_open',
    sourceType: 'ordering_session',
    sourceId: String(sessionId),
    sourceRevision: 1,
    deliveryGroupId: String(group._id),
    recipients,
    scheduledAt: now,
    metadata: {
      groupName: group.name || '',
      deliveryDay: Number(group.dayOfWeek),
    },
    now,
    prepareSourceInTransaction: async ({ session }) => {
      const marker = await OrderingSession.updateOne(
        { _id: sessionId, openNotifiedAt: null },
        { $set: { openNotifiedAt: now } },
        { session },
      );
      if (Number(marker?.matchedCount || 0) !== 1) {
        const err = new Error('ordering-open notification marker was claimed by another deployment');
        err.code = 'ordering_open_marker_claim_lost';
        throw err;
      }
    },
  });
}

async function notifyOrderingOpen({ now = new Date() } = {}) {
  const { getBot } = require('../telegramBot');
  if (!getBot()) return { notifiedGroups: 0, sentPrivate: 0, sentGroups: 0, queuedPrivate: 0, queuedGroups: 0, sentNow: 0 };

  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule').lean();
  let notifiedGroups = 0;
  let queuedPrivate = 0;
  let queuedGroups = 0;
  let sentNow = 0;
  let sentPrivate = 0;
  let sentGroups = 0;
  let chatIds = null;

  for (const group of groups) {
    const status = isOrderingOpen(group.orderingSchedule, now);
    if (!status.isOpen) continue;
    if (!isFreshOpen(getOrderingWindowOpenAt(group.orderingSchedule, now), now)) continue;

    const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);
    if (!sessionId) continue;

    const session = await OrderingSession.findById(sessionId, 'openNotifiedAt').lean();
    if (!session) continue;

    // Legacy sessions notified before the ledger existed intentionally remain
    // untouched. New ledger-backed sessions have an event row and are recovered
    // by telegramDeliveryScheduler even if this process dies after preparation.
    if (session.openNotifiedAt) {
      const Event = require('../models/TelegramNotificationEvent');
      const ledgerEvent = await Event.findOne(
        { eventKey: `ordering_open:${String(sessionId)}` },
        'status',
      ).lean();
      if (!ledgerEvent) continue; // legacy pre-ledger send
      if (ledgerEvent.status === 'completed') continue;
    }

    const sellers = await sellersOfGroup(String(group._id), { includeBlocked: true });
    if (!sellers.length) continue;
    if (chatIds === null) chatIds = await serviceGroupChatIds();

    const window = getWindowDescription(group.orderingSchedule, now);
    const appUrl = await miniAppLink();
    const closeLabel = closePhrase(window);
    const groupText = buildGroupText({
      groupName: group.name,
      deliveryLabel: deliveryDateLabel(group.dayOfWeek, group.orderingSchedule, now),
      closeLabel,
      appUrl,
    });

    const prepared = await prepareOrderingOpenEvent({
      sessionId,
      group,
      sellers,
      chatIds,
      closeLabel,
      appUrl,
      groupText,
      now,
    });

    if (prepared?.created) {
      notifiedGroups += 1;
      queuedPrivate += sellers.length;
      queuedGroups += chatIds.length;
    }

    // Event producers only enqueue durable delivery rows. One shared Telegram
    // delivery worker owns all actual sends across ordering/supplement/reminders,
    // so concurrent business schedulers can never multiply the global send rate.
  }

  return { notifiedGroups, sentPrivate, sentGroups, queuedPrivate, queuedGroups, sentNow };
}

module.exports = {
  MAX_LATENESS_MS,
  isFreshOpen,
  buildGroupText,
  buildPrivateText,
  deliveryDateLabel,
  closePhrase,
  notifyOrderingOpen,
};

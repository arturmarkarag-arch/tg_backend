'use strict';

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'static-test-telegram-token';
const fs = require('fs');
const path = require('path');
const { warsawWallClockToUTC } = require('../utils/orderingSchedule');
const { getCurrentOrderingReminderSlot } = require('../utils/orderingReminderSchedule');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) { pass += 1; console.log(`PASS ${label}`); }
  else { fail += 1; console.error(`FAIL ${label}`); }
}

const reminder = read('services/orderingReminderNotify.js');
const schedule = read('utils/orderingReminderSchedule.js');
const ledger = read('services/telegramDeliveryLedger.js');
const deliveryModel = read('models/TelegramNotificationDelivery.js');
const eventModel = read('models/TelegramNotificationEvent.js');
const openNotify = read('services/orderingOpenNotify.js');
const scheduler = read('services/orderingOpenScheduler.js');
const deliveryScheduler = read('services/telegramDeliveryScheduler.js');
const telegramRoute = read('routes/v1/telegram.js');
const shiftRead = read('services/readModels/shiftTelegramDeliveryReadModel.js');
const picking = read('routes/picking.js');
const policy = read('utils/telegramDeliveryPolicy.js');

const open = warsawWallClockToUTC(2026, 8, 19, 15, 0);
const close = warsawWallClockToUTC(2026, 8, 20, 12, 0);
const slot = (day, hour, minute) => getCurrentOrderingReminderSlot({
  openAt: open,
  closeAt: close,
  now: warsawWallClockToUTC(2026, 8, day, hour, minute),
});
check(slot(19, 15, 59) === null, 'opening message owns the first hour; no reminder before T0+1h');
check(slot(19, 16, 0)?.getTime() === warsawWallClockToUTC(2026, 8, 19, 16, 0).getTime(), 'opening day starts reminders exactly one hour after session start');
const oddOpen = warsawWallClockToUTC(2026, 8, 19, 15, 30);
const oddClose = warsawWallClockToUTC(2026, 8, 20, 12, 0);
const oddSlot = getCurrentOrderingReminderSlot({ openAt: oddOpen, closeAt: oddClose, now: warsawWallClockToUTC(2026, 8, 19, 16, 30) });
check(oddSlot?.getTime() === warsawWallClockToUTC(2026, 8, 19, 16, 30).getTime(), 'non-round opening time stays anchored exactly one hour after session start');
check(slot(19, 21, 45)?.getTime() === warsawWallClockToUTC(2026, 8, 19, 21, 0).getTime(), 'current hourly slot stays stable inside its hour');
check(slot(19, 22, 0)?.getTime() === warsawWallClockToUTC(2026, 8, 19, 22, 0).getTime(), '22:00 Warsaw reminder is allowed');
check(slot(19, 22, 1) === null, 'no new reminder is prepared after the 22:00 Warsaw boundary');
check(slot(20, 7, 59) === null && slot(20, 8, 0)?.getTime() === warsawWallClockToUTC(2026, 8, 20, 8, 0).getTime(), 'multi-day session resumes reminders at 08:00 Warsaw');

check(!reminder.includes('trackingToken') && !reminder.includes('startapp=') && reminder.includes('appUrl'), 'hourly reminder uses the shared Mini App URL without recipient tracking');
check(reminder.includes('Замовлення досі тривають') && reminder.includes('До кінця замовлень залишилось') && !reminder.includes('Сесія замовлень досі триває'), 'seller reminder uses plain ordering language instead of technical session wording');
check(!openNotify.includes('trackingToken') && !openNotify.includes('startapp=') && openNotify.includes('appUrl'), 'ordering-open private message uses the shared Mini App URL without recipient tracking');
check(!deliveryModel.includes('trackingToken') && !deliveryModel.includes('linkOpenedAt'), 'delivery ledger stores Telegram delivery facts, not recipient click tracking');
check(!ledger.includes('recordTrackedDeliveryOpen') && !telegramRoute.includes('recordTrackedDeliveryOpen'), 'Telegram profile read has no delivery-link attribution side effect');

check(reminder.includes("kind: 'ordering_reminder'") && reminder.includes("sourceType: 'ordering_session'"), 'hourly reminder is an exact ordering-session ledger event');
check(reminder.includes('CatalogReview.find') && reminder.includes('pendingSellers') && reminder.includes("stopCondition: 'catalog_review'"), 'CatalogReview is the only reminder completion signal');
check(!reminder.includes('serviceGroupChatIds') && reminder.includes("channel: 'private'"), 'hourly reminders are private-only and never posted to service groups');
check(reminder.includes("eligibilityType: 'ordering_catalog_review_pending'") && ledger.includes('catalog_reviewed_before_send'), 'retry path revalidates review state before every actual send');
check(ledger.includes('recipient_left_delivery_group') && ledger.includes('recipient_unassigned'), 'queued reminders are cancelled when recipient leaves the group');
check(ledger.includes('PRIVATE_RECIPIENT_GAP_MS = 1100') && ledger.includes('PRIVATE_GAP_MS = 60'), 'ledger rate policy throttles both global private fan-out and same-chat sends');
check(ledger.includes("withLock('telegram:delivery:send-lane'") && deliveryScheduler.includes('drainDueDeliveries({ limit: 100 })'), 'one shared delivery worker serializes all Telegram notification kinds');
check(!reminder.includes('drainDueDeliveries') && !openNotify.includes('drainDueDeliveries'), 'ordering producers only enqueue ledger work and cannot race the global sender');
check(ledger.includes('classification.rateLimited') && ledger.includes("status = 'retry_wait'"), '429 remains backpressure/retry_wait rather than terminal failure');
check(policy.includes("headers?.['retry-after']") && policy.includes('parameters?.retry_after'), '429 delay accepts Bot API retry_after from body/header');
check(eventModel.includes('scheduledAt'), 'notification event separates scheduled slot from preparation time');
check(scheduler.includes('notifyDueOrderingReminders') && scheduler.includes('materializeOpenOrderingSessions'), 'server minute scheduler owns both session materialization and reminder generation');
check(shiftRead.includes("['ordering_open', 'ordering_reminder']") && picking.includes('buildShiftTelegramDeliveryReadModel'), 'Shift read model embeds exact-session ordering notification trail');

console.log(`\nOrdering reminder + Shift delivery: ${pass}/${pass + fail} PASS`);
if (fail) process.exit(1);

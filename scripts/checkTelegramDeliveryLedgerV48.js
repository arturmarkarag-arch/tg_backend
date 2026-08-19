'use strict';

const fs = require('fs');
const path = require('path');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let pass = 0;
let fail = 0;
function check(ok, label) {
  if (ok) { pass += 1; console.log(`PASS ${label}`); }
  else { fail += 1; console.error(`FAIL ${label}`); }
}

const ordering = read('services/orderingOpenNotify.js');
const supplement = read('services/supplementNotify.js');
const ledger = read('services/telegramDeliveryLedger.js');
const scheduler = read('services/telegramDeliveryScheduler.js');
const eventModel = read('models/TelegramNotificationEvent.js');
const deliveryModel = read('models/TelegramNotificationDelivery.js');
const bot = read('telegramBot.js');
const admin = read('routes/admin.js');
const index = read('index.js');

check(ordering.includes('ensureNotificationEvent') && ordering.includes('ordering_open:'), 'ordering-open uses durable event ledger');
check(!ordering.includes('deliveredAny') && !ordering.includes('releaseSession(') && !ordering.includes('claimSession('), 'ordering-open no longer uses whole-session pre-send claim/deliveredAny');
check(ordering.includes('prepareSourceInTransaction') && ordering.includes('openNotifiedAt: now'), 'legacy openNotifiedAt marker is written in same transaction as durable fan-out');
check(deliveryModel.includes('eventKey: 1, channel: 1, recipientId: 1') && deliveryModel.includes('unique: true'), 'one delivery row per event/channel/recipient is DB-enforced');
check(deliveryModel.includes("['pending', 'sending', 'retry_wait', 'sent', 'failed', 'skipped']"), 'delivery lifecycle is explicit');
check(supplement.includes('prepareWaveNotificationEvent') && supplement.includes('ensureNotificationEvent') && supplement.includes('supplement_wave:'), 'modern supplement Wave notifications use the same durable ledger');
check(!supplement.slice(supplement.indexOf('async function notifyWaves'), supplement.indexOf('async function findDueWaveNotifications')).includes('deliveredAny'), 'modern Wave notifier has no whole-wave deliveredAny shortcut');
check(ordering.includes('includeBlocked: true') && ordering.includes("skipReason: seller.botBlocked ? 'known_bot_blocked'"), 'known blocked recipients remain visible as skipped instead of disappearing from the audience');
check(ledger.includes('telegramMessageId') && ledger.includes('telegramDate') && ledger.includes('message?.message_id'), 'Telegram Message acknowledgement is persisted');
check(ledger.includes('leaseUntil') && ledger.includes('claimExpiredSending') && ledger.includes('possibleDuplicate: true'), 'crash recovery uses a lease and records duplicate uncertainty');
check(ledger.includes('retryDelayMs') && ledger.includes("status = 'retry_wait'"), 'retryable failures persist next-attempt state');
check(scheduler.includes("runAsSchedulerLeader") && scheduler.includes("'telegram-delivery'"), 'retry/recovery has an independent durable scheduler');
check(ledger.includes("telegram:delivery:send-lane") && ledger.includes("withLock('telegram:delivery:send-lane'"), 'all actual Telegram transport is serialized through one distributed send lane');
check(!ordering.includes('drainDueDeliveries') && !supplement.includes('drainDueDeliveries'), 'business notification producers enqueue only and never create parallel send loops');
check(index.includes('startTelegramDeliveryScheduler') && index.includes("key: 'telegram_delivery_ledger'"), 'delivery worker and critical indexes start at boot');
check(admin.includes("/telegram-delivery/events") && admin.includes('appOpenedAfterSend') && admin.includes('orderedInSourceSession'), 'admin audit API exposes delivery truth plus clearly-derived post-send signals');
const sendMessageBlock = bot.slice(bot.indexOf('async function sendMessageWithRetry'), bot.indexOf('async function sendPhotoWithRetry'));
check(sendMessageBlock.includes('classifyTelegramSendError') && sendMessageBlock.includes('retryDelayMs') && !sendMessageBlock.includes("code === 'ETELEGRAM'"), 'generic sendMessage retry no longer retries only 429/dead ETELEGRAM branch');

const rate = classifyTelegramSendError({ response: { statusCode: 429, body: { description: 'Too Many Requests', parameters: { retry_after: 7 } } } });
check(rate.retryable && rate.retryAfterSeconds === 7 && !rate.ambiguous, '429 is retryable and honors Telegram retry_after');
const server = classifyTelegramSendError({ response: { statusCode: 502, body: { description: 'Bad Gateway' } }, code: 'ETELEGRAM' });
check(server.retryable && server.ambiguous, 'Telegram 5xx is retryable and marked ambiguous');
const network = classifyTelegramSendError({ code: 'EFATAL', message: 'socket hang up' });
check(network.retryable && network.ambiguous, 'network/EFATAL is retryable and marked ambiguous');
const blocked = classifyTelegramSendError({ response: { statusCode: 403, body: { description: 'Forbidden: bot was blocked by the user' } } });
check(blocked.permanent && blocked.botBlocked && !blocked.retryable, 'blocked user is permanent failure, not retry loop');
check(retryDelayMs(rate, 1) === 7000, 'retry_after wins over exponential backoff');

console.log(`\nTelegram delivery ledger: ${pass}/${pass + fail} PASS`);
if (fail) process.exit(1);

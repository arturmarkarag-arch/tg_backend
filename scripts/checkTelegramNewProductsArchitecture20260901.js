'use strict';

const fs = require('fs');
const path = require('path');
const { classifyTelegramSendError } = require('../utils/telegramDeliveryPolicy');
const transport = require('../utils/telegramTransportPolicy');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const service = read('services/receiptNewProductTelegram.js');
const cleanup = read('services/telegramMessageCleanup.js');
const receipts = read('routes/receipts.js');
const bot = read('telegramBot.js');
const index = read('index.js');

let passed = 0;
const failures = [];
function check(name, condition) {
  if (condition) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.error(`FAIL ${name}`);
  }
}
function contains(source, ...needles) {
  return needles.every((needle) => source.includes(needle));
}
function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start < 0) return '';
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}
function telegramError(statusCode, description, parameters = {}) {
  const error = new Error(description);
  error.response = { body: { error_code: statusCode, description, parameters } };
  return error;
}

for (const model of [
  'models/TelegramDestination.js',
  'models/TelegramPublication.js',
  'models/TelegramPublicationBinding.js',
  'models/TelegramPublicationEvent.js',
  'models/TelegramMessageCleanup.js',
]) {
  check(`domain model exists: ${model}`, fs.existsSync(path.join(root, model)));
}

check('physical Binding identity is unique by chatId/messageId', contains(read('models/TelegramPublicationBinding.js'), "{ chatId: 1, messageId: 1 }", 'unique: true'));
check('Publication is unique per receipt source', contains(read('models/TelegramPublication.js'), "{ sourceType: 1, sourceId: 1 }", 'unique: true'));
check('events index physical Telegram identity', contains(read('models/TelegramPublicationEvent.js'), "{ chatId: 1, messageId: 1, createdAt: -1 }"));

const decision = between(service, 'async function recordDecision', 'async function recoverExpiredSending');
check('publish decision takes per-item lifecycle lock', decision.includes('withReceiptTelegramPublicationLock(itemId'));
check('publish decision re-reads ReceiptItem inside lock', decision.includes('ReceiptItem.findOne({ _id: itemId, receiptId })'));
check('publish decision rejects non-confirmed source', decision.includes("item.status !== 'confirmed'"));
check('new generation is blocked by unresolved cleanup and historical ambiguity', contains(decision, 'assertNoOldLifecycleBlockers(publication', 'allowAmbiguousBindingId'));
check('historical cleanup/ambiguity does not freeze known live update', contains(service, 'const reconciliationBlocked = historicalAmbiguousCount > 0 && !hasMessage', 'const cleanupBlocked = (cleanupCount > 0 || reconciliationBlocked) && !hasMessage'));
check('force retry only exempts current UNKNOWN binding, not older ambiguity', contains(decision, "publication.status === 'unknown' && forceUnknownRetry ? binding?._id : null"));
check('publication tracks unresolved vs ambiguous binding counts separately', contains(read('models/TelegramPublication.js'), 'unresolvedBindingCount', 'ambiguousBindingCount') && contains(service, 'possibleDuplicate: ambiguousCount > 0'));
check('possibleDuplicate is derived only from no-message ambiguous bindings', contains(service, "state: { $in: ['unknown', 'manual_required'] }", 'messageId: null') && contains(cleanup, 'messageId: null', 'possibleDuplicate: ambiguousCount > 0'));


const claim = between(service, 'async function claimDue', 'function telegramPhotoFileId');
check('worker claim only accepts confirmed lifecycle', claim.includes("sourceState: 'confirmed'"));
const sender = between(service, 'async function sendClaimed', 'async function verifyPublication');
check('worker re-reads authoritative ReceiptItem', sender.includes('ReceiptItem.findOne'));
check('worker cancels delivery for draft/deleted item', sender.includes("item.status !== 'confirmed'"));
check('worker rechecks destination before Bot API', sender.includes('Full pause semantics'));
check('unhealthy destination pauses create without consuming retry attempts', contains(sender, 'destinationCreateHealthBlocked', "kind: 'destination_unhealthy'", '$inc: { attempts: -1 }'));
check('invalid cached file_id falls back once to canonical photo URL', contains(sender, "classification.kind === 'photo_source_unavailable'", 'photoInput = snapshot.photoUrl'));

const ensure = between(service, 'async function legacyMigrationNeedsBindings', 'async function currentBinding');
check('first legacy migration is transactional', contains(ensure, 'mongoSession.withTransaction', 'ensurePublicationForItem(item, { session: mongoSession })'));
check('partial legacy migration is repairable', contains(ensure, 'publication_migration_repaired', 'needsLegacyRepair'));
check('legacy in-flight CREATE migrates fail-closed to unknown', contains(service, "status: 'unknown'", 'possibleDuplicate: true', "status === 'sending'"));

const recovery = between(service, 'async function recoverExpiredSending', 'async function claimDue');
check('expired CREATE recovers as explicit ambiguity', contains(recovery, "sendingOperation === 'create'", "state: 'unknown'"));
check('expired known UPDATE remains safely retryable', contains(recovery, "eventType: 'sending_lease_expired'", "operation: 'update'", "toStatus: 'retry_wait'"));

const failure = between(service, 'async function markFailure', 'async function sendClaimed');
check('delivery failure state transitions are transactional', (failure.match(/runMongoTransaction\(async \(session\)/g) || []).length >= 3);
check('message-not-found updates Binding + Publication + Event in one transaction', contains(failure, "classification.kind === 'message_not_found'", "state: 'missing'", "status: 'missing'", "eventType: 'message_missing'", '{ session }'));
check('ambiguous CREATE updates Binding + Publication + issue counters atomically', contains(failure, "operation === 'create' && classification.ambiguous", "state: 'unknown'", 'refreshUnresolvedBindingCount(publication._id, { session })', "eventType: 'create_result_unknown'"));
check('delivery access errors update destination/binding health at the right level', contains(failure, 'destinationAccessFailure', 'affectsCurrentDestination', 'TelegramDestination.updateOne', 'bindingAccessFailure', 'accessCode: classification.kind'));

check('DELETE/unconfirm cleanup includes in-flight creating generation', contains(cleanup, 'includeCreating: inFlightCreateMayBeAmbiguous', 'allowCreatingAmbiguity: inFlightCreateMayBeAmbiguous'));
check('ambiguous create creates durable manual_required cleanup', contains(cleanup, "kind = exact ? 'exact_message' : 'ambiguous_create'", "status = exact ? 'pending' : 'manual_required'"));
check('cleanup stores operator-identifiable caption/hash snapshot', contains(cleanup, 'captionSnapshot', 'payloadHash'));
check('operator can resolve absent ambiguous generation', cleanup.includes('resolveAmbiguousTelegramBinding'));
check('operator can identify an existing unknown post', cleanup.includes('identifyAmbiguousTelegramBinding'));
check('operator can retry terminal exact cleanup', cleanup.includes('retryTelegramMessageCleanup'));
check('operator can manually resolve terminal cleanup', cleanup.includes('resolveTelegramMessageCleanup'));

const deleteHandler = between(receipts, "router.delete('/:id/items/:itemId'", '// ── ROUTING AFTER');
check('DELETE holds same item lifecycle lock', deleteHandler.includes('withReceiptTelegramPublicationLock'));
check('DELETE enqueues Telegram cleanup before source delete', deleteHandler.indexOf('enqueueReceiptNewProductCleanup') >= 0 && deleteHandler.indexOf('enqueueReceiptNewProductCleanup') < deleteHandler.indexOf('item.deleteOne'));
check('DELETE cleanup and source delete share Mongo session', deleteHandler.includes('{ session'));

const settings = between(service, 'async function setNewProductsGroupId', 'async function handleNewProductsMyChatMember');
check('destination change + queued-create retarget are one transaction', contains(settings, 'withTransaction', 'TelegramDestination.findOneAndUpdate', 'AppSetting.findOneAndUpdate', 'TelegramPublication.updateOne'));
check('only unsent creates are retargeted on destination change', contains(settings, 'safeToRetarget', "binding?.state === 'creating'", '!Number(binding?.messageId)'));
check('my_chat_member covers configured and historical binding chats', contains(service, 'handleNewProductsMyChatMember', 'affectedBindings', 'isCurrentDestination'));
check('own channel-post deletion capability follows publish right, not can_delete_messages only', contains(service, "const canDelete = canPost || status === 'creator'", 'can_delete_messages'));
check('chat migration updates Destination/Publication/Binding/Cleanup atomically', contains(service, 'applyTelegramChatMigration', 'TelegramPublicationBinding.updateMany', 'TelegramMessageCleanup.updateMany', 'withTransaction'));

check('canonical hash contains exact business route signature', contains(service, 'routeSignature', 'warehouse:', 'mandatory:', 'supplement:', 'mayNotReachAllShops:', 'supplementDeliveryGroupId:'));
check('legacy routing fetches Receipt context when routingVersion<1', contains(service, 'async function buildDesiredForItem', "Receipt.findById(receiptId).select('type targetDeliveryGroupId')"));

check('manual MESSAGE_ID_INVALID normalizes to missing', classifyTelegramSendError(telegramError(400, 'Bad Request: MESSAGE_ID_INVALID')).kind === 'message_not_found');
check('MESSAGE_NOT_MODIFIED is treated as semantic success signal', classifyTelegramSendError(telegramError(400, 'Bad Request: MESSAGE_NOT_MODIFIED')).kind === 'message_not_modified');
check('429 preserves retry_after', classifyTelegramSendError(telegramError(429, 'Too Many Requests', { retry_after: 17 })).retryAfterSeconds === 17);
check('migrate_to_chat_id is preserved', classifyTelegramSendError(telegramError(400, 'Bad Request: migrated', { migrate_to_chat_id: -100123 })).migrateToChatId === '-100123');
check('bot-not-initialized is retryable but NOT ambiguous create', (() => { const e = new Error('not initialized'); e.code = 'EBOTUNAVAILABLE'; const c = classifyTelegramSendError(e); return c.kind === 'bot_unavailable' && c.retryable && !c.ambiguous; })());

const itemLockMatch = service.match(/const ITEM_LOCK_TTL_MS = (\d+) \* 60 \* 1000/);
const itemLockMs = itemLockMatch ? Number(itemLockMatch[1]) * 60 * 1000 : 0;
check('Telegram request timeout is strictly below per-item lock TTL', itemLockMs > 0 && transport.TELEGRAM_REQUEST_TIMEOUT_MS < itemLockMs);
check('delivery batch budget leaves headroom below global lane TTL', transport.TELEGRAM_DELIVERY_BATCH_BUDGET_MS + transport.TELEGRAM_REQUEST_TIMEOUT_MS < transport.TELEGRAM_DELIVERY_LANE_TTL_MS);
check('all Telegram delivery drains use shared lane TTL/budget policy', contains(read('services/telegramDeliveryLedger.js'), 'TELEGRAM_DELIVERY_LANE_TTL_MS', 'telegramBatchBudgetExceeded') && contains(cleanup, 'TELEGRAM_DELIVERY_LANE_TTL_MS', 'telegramBatchBudgetExceeded') && contains(service, 'TELEGRAM_DELIVERY_LANE_TTL_MS', 'telegramBatchBudgetExceeded'));

check('startup runs legacy migration after index bootstrap', contains(index, "require('./services/receiptNewProductTelegram').migrateLegacyTelegramNewProducts()", 'legacy publications migrated='));
check('startup migration repairs ambiguous issue counters for first-ledger rollout', contains(service, 'ambiguousBindingCount: { $exists: false }', 'issueCountersRepaired', 'refreshUnresolvedBindingCount(publication._id)'));

check('history survives physical ReceiptItem deletion via ledger fallback', contains(service, "TelegramPublication.findOne({", "sourceId: String(itemId || '')", 'sourceExists: !!item'));

check('runtime lifecycle does not write embedded ReceiptItem.telegramNewProduct', !/ReceiptItem\.(?:updateOne|findOneAndUpdate|updateMany)[\s\S]{0,500}telegramNewProduct/.test(service + '\n' + receipts));
check('legacy embedded state is explicitly compatibility-only', service.includes('New lifecycle state lives in TelegramPublication/Binding/Event'));

check('Bot client has bounded request timeout', bot.includes("new TelegramBot(token, { request: { timeout: TELEGRAM_REQUEST_TIMEOUT_MS } })"));

console.log(`\nTelegram new-products architecture gate: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(failures.map((name) => ` - ${name}`).join('\n'));
  process.exit(1);
}

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const { formatTelegramMemberTag, decideTelegramMemberTagAction } = require('../utils/telegramMemberTagPolicy');

function check(label, fn) {
  try { fn(); console.log(`PASS ${label}`); }
  catch (error) { console.error(`FAIL ${label}: ${error.message}`); process.exitCode = 1; }
}

check('tag format is DB name -> #name and max 16 Unicode characters', () => {
  assert.strictEqual(formatTelegramMemberTag('Poznań'), '#Poznań');
  assert.strictEqual(formatTelegramMemberTag(' Warszawa '), '#Warszawa');
  assert.strictEqual(formatTelegramMemberTag('VeryLongShopName123'), '#VeryLongShopNam');
  assert.ok(Array.from(formatTelegramMemberTag('ŻółćŻółćŻółćŻółćŻółć')).length <= 16);
});

check('only regular member is managed; admins/creator are immutable', () => {
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'administrator', desiredTag: '#Poznań' }), { result: 'skipped_admin', write: false });
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'creator', desiredTag: '#Poznań' }), { result: 'skipped_creator', write: false });
  assert.strictEqual(decideTelegramMemberTagAction({ status: 'restricted', desiredTag: '#Poznań' }).write, false);
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '#Poznań' }), { result: 'unchanged', write: false });
});

check('all configured bot groups are tag targets; there is no MAIN identity', () => {
  const settings = read('utils/telegramGroupSettings.js');
  const service = read('services/telegramMemberTagSync.js');
  const admin = read('routes/admin.js');
  assert.ok(settings.includes("TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds'"));
  assert.ok(!settings.includes('TELEGRAM_MAIN_GROUP_KEY'));
  assert.ok(service.includes('getAllowedGroupIds()'));
  assert.ok(!service.includes('getMainTelegramGroupId'));
  assert.ok(!admin.includes("/telegram-groups/main"));
});

check('queue identity is user + group and retries are isolated per target', () => {
  const model = read('models/TelegramMemberTagSync.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(model.includes("schema.index({ telegramId: 1, chatId: 1 }, { unique: true"));
  assert.ok(service.includes("filter: { telegramId, chatId: groupId }"));
  assert.ok(service.includes('Failure-isolated per (telegramId, chatId)'));
  assert.ok(service.includes('MAX_AUTOMATIC_ATTEMPTS'));
  assert.ok(service.includes('PROCESSING_LEASE_MS'));
  assert.ok(service.includes('requestedRevision: row.processingRevision'));
});

check('shop assignment/rename fan out to configured groups', () => {
  const assignment = read('services/shopAssignmentCommand.js');
  const topology = read('services/shopTopologyCommand.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(assignment.includes("enqueueTelegramMemberTagSync(result.sellerTelegramId"));
  assert.ok(topology.includes('enqueueShopMemberTagSync'));
  assert.ok(service.includes("chatId ? [normalizeChatId(chatId)].filter(Boolean) : await getAllowedGroupIds()"));
});

check('Telegram membership events invalidate only the affected configured group', () => {
  const source = read('telegramBot.js');
  assert.ok(source.includes("source: 'telegram_chat_member_changed'"));
  assert.ok(source.includes("source: 'telegram_new_chat_member'"));
  assert.ok(source.includes('chatId: groupChatId'));
  assert.ok(source.includes("chatId }).catch"));
  assert.ok(!source.includes('getMainTelegramGroupId'));
});

check('group add persists independently, exposes health and immediately reconciles that group', () => {
  const source = read('routes/admin.js');
  const persistPos = source.indexOf('setAllowedGroupIds([...current, groupId])');
  const healthPos = source.indexOf('getTelegramMemberTagGroupHealth(groupId, { live: true })');
  assert.ok(persistPos >= 0 && healthPos > persistPos);
  assert.ok(source.includes("source: 'telegram_group_added'"));
  assert.ok(source.includes('chatId: groupId'));
});

check('group removal has ownership-safe cleanup and never touches admin titles', () => {
  const admin = read('routes/admin.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(admin.includes('enqueueTelegramGroupTagCleanup'));
  assert.ok(service.includes('cleanup_skipped_tag_changed'));
  assert.ok(service.includes('cleanup_skipped_admin'));
  assert.ok(!service.includes('setChatAdministratorCustomTitle'));
});

check('new member-tag method reuses existing SDK transport without upgrading proven bot SDK', () => {
  const transport = read('services/telegramMemberTagTransport.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.strictEqual(pkg.dependencies['node-telegram-bot-api'], '^0.67.0');
  assert.ok(transport.includes("bot._request('setChatMemberTag'"));
  assert.ok(transport.includes("form: {"));
  assert.ok(service.includes("require('./telegramMemberTagTransport')"));
  assert.ok(!service.includes('bot.setChatMemberTag'));
});

check('compatibility transport is isolated and fails closed if generic SDK transport disappears', () => {
  const transport = read('services/telegramMemberTagTransport.js');
  assert.ok(transport.includes("typeof bot._request !== 'function'"));
  assert.ok(transport.includes("error.code = 'ETELEGRAMTRANSPORT'"));
});


check('account removal/reactivation paths invalidate tags even without shop transition', () => {
  const remove = read('services/softRemoveUser.js');
  const registration = read('routes/v1/telegram.js');
  const bot = read('telegramBot.js');
  assert.ok(remove.includes("source: 'account_soft_removed'"));
  assert.ok(registration.includes("source: 'account_registered'"));
  assert.ok(bot.includes("source: 'account_registered'"));
});

check('scheduler is dedicated and blocked groups are throttled, not multiplied into user failures', () => {
  const scheduler = read('services/telegramMemberTagScheduler.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(scheduler.includes("'telegram-member-tags'"));
  assert.ok(service.includes('BLOCKED_GROUP_RECHECK_MS'));
  assert.ok(service.includes('getTelegramMemberTagGroupHealth(chatId, { live: true })'));
  assert.ok(service.includes('readyChatIds'));
});

check('manual reconcile is ERP-driven across every configured group', () => {
  const source = read('services/telegramMemberTagSync.js');
  const admin = read('routes/admin.js');
  assert.ok(source.includes("User.find({ telegramId: { $type: 'string', $ne: '' } }"));
  assert.ok(source.includes('for (const groupId of groupIds)'));
  assert.ok(admin.includes("router.post('/telegram-member-tags/reconcile'"));
  assert.ok(!admin.includes('telegram_main_group_not_configured'));
});

if (process.exitCode) process.exit(process.exitCode);
console.log('Telegram member-tag architecture: PASS');

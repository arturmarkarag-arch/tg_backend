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

check('bot groups and member-tag groups are independent persisted settings', () => {
  const botSettings = read('utils/telegramGroupSettings.js');
  const tagSettings = read('utils/telegramMemberTagGroupSettings.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(botSettings.includes("TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds'"));
  assert.ok(tagSettings.includes("TELEGRAM_MEMBER_TAG_GROUPS_KEY = 'telegram.memberTagGroupIds'"));
  assert.ok(tagSettings.includes('return Array.isArray(row?.value) ? normalizeGroupIds(row.value) : []'));
  assert.ok(!tagSettings.includes('TELEGRAM_ALLOWED_GROUP_IDS'));
  assert.ok(service.includes("require('../utils/telegramMemberTagGroupSettings')"));
  assert.ok(!service.includes("require('../utils/telegramGroupSettings')"));
});

check('ordinary bot-group CRUD does not enable, reconcile or clean member tags', () => {
  const admin = read('routes/admin.js');
  const start = admin.indexOf("router.get('/telegram-groups'");
  const end = admin.indexOf('// ── Telegram shop member-tag groups', start);
  assert.ok(start >= 0 && end > start);
  const block = admin.slice(start, end);
  assert.ok(block.includes('getAllowedGroupIds'));
  assert.ok(block.includes('setAllowedGroupIds'));
  assert.ok(!block.includes('telegramMemberTag'));
  assert.ok(!block.includes('enqueueTelegram'));
  assert.ok(!block.includes('can_manage_tags'));
});

check('member-tag groups have their own CRUD, reconcile and ownership-safe removal', () => {
  const admin = read('routes/admin.js');
  assert.ok(admin.includes("router.get('/telegram-member-tag-groups'"));
  assert.ok(admin.includes("router.post('/telegram-member-tag-groups'"));
  assert.ok(admin.includes("router.delete('/telegram-member-tag-groups/:groupId'"));
  assert.ok(admin.includes('getTelegramMemberTagGroupIds'));
  assert.ok(admin.includes('setTelegramMemberTagGroupIds'));
  assert.ok(admin.includes("source: 'telegram_member_tag_group_added'"));
  assert.ok(admin.includes("source: 'telegram_member_tag_group_removed'"));
  assert.ok(admin.includes('enqueueTelegramGroupTagCleanup'));
});

check('queue identity is user + member-tag group and retries are isolated per target', () => {
  const model = read('models/TelegramMemberTagSync.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(model.includes("schema.index({ telegramId: 1, chatId: 1 }, { unique: true"));
  assert.ok(service.includes("filter: { telegramId, chatId: groupId }"));
  assert.ok(service.includes('Failure-isolated per (telegramId, chatId)'));
  assert.ok(service.includes('MAX_AUTOMATIC_ATTEMPTS'));
  assert.ok(service.includes('PROCESSING_LEASE_MS'));
  assert.ok(service.includes('requestedRevision: row.processingRevision'));
});

check('event sync fans out only to dedicated member-tag groups', () => {
  const assignment = read('services/shopAssignmentCommand.js');
  const topology = read('services/shopTopologyCommand.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(assignment.includes("enqueueTelegramMemberTagSync(result.sellerTelegramId"));
  assert.ok(topology.includes('enqueueShopMemberTagSync'));
  assert.ok(service.includes('resolveConfiguredMemberTagGroups'));
  assert.ok(service.includes('const configured = await getTelegramMemberTagGroupIds()'));
  assert.ok(service.includes('configured.includes(requested)'));
});

check('chat_member handling keeps bot authorization separate from tag projection', () => {
  const source = read('telegramBot.js');
  assert.ok(source.includes('const [authorizedGroup, memberTagGroups] = await Promise.all'));
  assert.ok(source.includes('const memberTagGroup = memberTagGroups.includes(groupChatId)'));
  assert.ok(source.includes('if (!authorizedGroup && !memberTagGroup) return'));
  assert.ok(source.includes('if (memberTagGroup)'));
  assert.ok(source.includes('if (!authorizedGroup) return'));
  assert.ok(source.includes("source: 'telegram_chat_member_changed'"));
});

check('group removal cleanup never touches admin titles or manually changed tags', () => {
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(service.includes('cleanup_skipped_tag_changed'));
  assert.ok(service.includes('cleanup_skipped_admin'));
  assert.ok(service.includes('cleanup_skipped_creator'));
  assert.ok(!service.includes('setChatAdministratorCustomTitle'));
});

check('new member-tag method reuses existing SDK transport without upgrading proven bot SDK', () => {
  const transport = read('services/telegramMemberTagTransport.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.strictEqual(pkg.dependencies['node-telegram-bot-api'], '^0.67.0');
  assert.ok(transport.includes("bot._request('setChatMemberTag'"));
  assert.ok(transport.includes('form: {'));
  assert.ok(service.includes("require('./telegramMemberTagTransport')"));
  assert.ok(!service.includes('bot.setChatMemberTag'));
});

check('compatibility transport is isolated and fails closed if generic SDK transport disappears', () => {
  const transport = read('services/telegramMemberTagTransport.js');
  assert.ok(transport.includes("typeof bot._request !== 'function'"));
  assert.ok(transport.includes("error.code = 'ETELEGRAMTRANSPORT'"));
});

check('account removal/reactivation paths invalidate member tags', () => {
  const remove = read('services/softRemoveUser.js');
  const registration = read('routes/v1/telegram.js');
  const bot = read('telegramBot.js');
  assert.ok(remove.includes("source: 'account_soft_removed'"));
  assert.ok(registration.includes("source: 'account_registered'"));
  assert.ok(bot.includes("source: 'account_registered'"));
});

check('scheduler is dedicated and 429 pauses the whole member-tag group durably', () => {
  const scheduler = read('services/telegramMemberTagScheduler.js');
  const transport = read('services/telegramMemberTagTransport.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(scheduler.includes("'telegram-member-tags'"));
  assert.ok(transport.includes('DEFAULT_MEMBER_TAG_WRITE_INTERVAL_MS = 3500'));
  assert.ok(transport.includes('waitForMemberTagWriteSlot'));
  assert.ok(service.includes('deferGroupAfterRateLimit'));
  assert.ok(service.includes('classification.rateLimited'));
  assert.ok(service.includes("lastErrorCode: '429'"));
  assert.ok(service.includes('$max: { nextAttemptAt: retryAt }'));
  assert.ok(service.includes('activeGroupRateLimitUntil'));
});

check('legacy V3/V4 bot-group queue rows are retired without Telegram writes', () => {
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(service.includes('V3/V4 incorrectly used telegram.allowedGroupIds as tag targets'));
  assert.ok(service.includes("mode: { $ne: 'cleanup' }, chatId: { $nin: configuredGroupIds }"));
  assert.ok(service.includes("lastResult: 'skipped_group_removed'"));
});

check('manual reconcile is ERP-driven only across dedicated member-tag groups', () => {
  const source = read('services/telegramMemberTagSync.js');
  const admin = read('routes/admin.js');
  assert.ok(source.includes("User.find({ telegramId: { $type: 'string', $ne: '' } }"));
  assert.ok(source.includes('for (const groupId of groupIds)'));
  assert.ok(admin.includes("router.post('/telegram-member-tags/reconcile'"));
  assert.ok(admin.includes('getTelegramMemberTagGroupIds()'));
  assert.ok(admin.includes('Спочатку додайте хоча б одну групу в «Плашки магазинів».'));
});

if (process.exitCode) process.exit(process.exitCode);
console.log('Telegram member-tag architecture: PASS');

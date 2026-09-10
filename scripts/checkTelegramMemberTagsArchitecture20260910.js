'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const {
  formatTelegramMemberTag,
  decideTelegramMemberTagAction,
} = require('../utils/telegramMemberTagPolicy');

function check(label, fn) {
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('tag format is DB name -> #name and max 16 Unicode characters', () => {
  assert.strictEqual(formatTelegramMemberTag('Poznań'), '#Poznań');
  assert.strictEqual(formatTelegramMemberTag(' Warszawa '), '#Warszawa');
  assert.strictEqual(formatTelegramMemberTag('VeryLongShopName123'), '#VeryLongShopNam');
  assert.ok(Array.from(formatTelegramMemberTag('ŻółćŻółćŻółćŻółćŻółć')).length <= 16);
});

check('only regular member is managed; admins/creator are immutable', () => {
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'administrator', currentTag: '', desiredTag: '#Poznań' }), { result: 'skipped_admin', write: false });
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'creator', currentTag: '', desiredTag: '#Poznań' }), { result: 'skipped_creator', write: false });
  assert.strictEqual(decideTelegramMemberTagAction({ status: 'restricted', currentTag: '', desiredTag: '#Poznań' }).write, false);
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '#Poznań' }), { result: 'unchanged', write: false });
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'member', currentTag: '#Poznań', desiredTag: '' }), { result: 'cleared', write: true });
  assert.deepStrictEqual(decideTelegramMemberTagAction({ status: 'member', currentTag: '', desiredTag: '#Warszawa' }), { result: 'updated', write: true });
});

check('Telegram service uses member tag API, live member status and never administrator titles', () => {
  const source = read('services/telegramMemberTagSync.js');
  assert.ok(source.includes('getChatMember(chatId, Number(telegramId))'));
  assert.ok(source.includes('setChatMemberTag(chatId, Number(telegramId), { tag: desiredTag })'));
  assert.ok(source.includes('previousTag'));
  assert.ok(!source.includes('setChatAdministratorCustomTitle'));
});

check('desired state is always re-read from canonical User -> Shop', () => {
  const source = read('services/telegramMemberTagSync.js');
  assert.ok(source.includes("User.findOne({ telegramId: cleanString(telegramId) })"));
  assert.ok(source.includes('Shop.findById(user.shopId)'));
  assert.ok(source.includes('formatTelegramMemberTag(shop.name)'));
});

check('main Telegram group is explicit DB identity, not allowed-list ordering', () => {
  const source = read('utils/telegramGroupSettings.js');
  assert.ok(source.includes("TELEGRAM_MAIN_GROUP_KEY = 'telegram.mainGroupId'"));
  assert.ok(source.includes("TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds'"));
  assert.ok(!source.includes('allowed[0]'));
  assert.ok(!source.includes('ids[0]'));
});

check('assignment and Shop rename both invalidate member-tag projection', () => {
  const assignment = read('services/shopAssignmentCommand.js');
  const topology = read('services/shopTopologyCommand.js');
  assert.ok(assignment.includes("enqueueTelegramMemberTagSync(result.sellerTelegramId"));
  assert.ok(assignment.includes("source: 'shop_assignment_changed'"));
  assert.ok(topology.includes('if (outcome?.nameChanged)'));
  assert.ok(topology.includes('enqueueShopMemberTagSync'));
});

check('Socket availability cannot suppress member-tag outbox', () => {
  const source = read('services/shopAssignmentCommand.js');
  assert.ok(source.includes('if (io) {'));
  assert.ok(!source.includes('if (!io) return result;'));
});

check('Telegram membership changes invalidate only configured main group', () => {
  const source = read('telegramBot.js');
  assert.ok(source.includes("source: 'telegram_chat_member_changed'"));
  assert.ok(source.includes("source: 'telegram_new_chat_member'"));
  assert.ok(source.includes('mainGroupId === groupChatId'));
  assert.ok(source.includes('mainGroupId === chatId'));
});

check('durable queue has uniqueness, revision race guard, crash recovery and finite retries', () => {
  const model = read('models/TelegramMemberTagSync.js');
  const service = read('services/telegramMemberTagSync.js');
  assert.ok(model.includes('unique: true'));
  assert.ok(model.includes('requestedRevision'));
  assert.ok(service.includes('requestedRevision: row.processingRevision'));
  assert.ok(service.includes('PROCESSING_LEASE_MS'));
  assert.ok(service.includes("status: 'processing', lastAttemptAt: { $lte: staleBefore }"));
  assert.ok(service.includes('MAX_AUTOMATIC_ATTEMPTS'));
  assert.ok(service.includes('retry_exhausted:'));
});

check('reconcile is ERP-driven and one-row failures are isolated', () => {
  const source = read('services/telegramMemberTagSync.js');
  assert.ok(source.includes("User.find({ telegramId: { $type: 'string', $ne: '' } }"));
  assert.ok(source.includes('Reconcile is failure-isolated'));
  assert.ok(!source.includes('getChatAdministrators('));
});

check('main-group migration cleans only ERP-owned old tags and still protects admins', () => {
  const source = read('services/telegramMemberTagSync.js');
  assert.ok(source.includes('cleanupPreviousMainGroupTag'));
  assert.ok(source.includes("currentTag !== previouslyManagedTag"));
  assert.ok(source.includes("status === 'administrator' || status === 'creator'"));
  assert.ok(source.includes("result: 'migration_cleared'"));
});

check('member tags have their own scheduler leader and cannot block Telegram delivery', () => {
  const tagScheduler = read('services/telegramMemberTagScheduler.js');
  const deliveryScheduler = read('services/telegramDeliveryScheduler.js');
  assert.ok(tagScheduler.includes('drainDueTelegramMemberTagSync'));
  assert.ok(tagScheduler.includes("'telegram-member-tags'"));
  assert.ok(!deliveryScheduler.includes('drainDueTelegramMemberTagSync'));
});

check('admin API exposes explicit main-group health and manual reconcile', () => {
  const source = read('routes/admin.js');
  assert.ok(source.includes("router.put('/telegram-groups/main'"));
  assert.ok(source.includes("router.get('/telegram-member-tags'"));
  assert.ok(source.includes("router.post('/telegram-member-tags/reconcile'"));
  assert.ok(source.includes('telegram_main_group_in_use'));
});

check('Bot library version is minimal compatible CommonJS release', () => {
  assert.strictEqual(pkg.dependencies['node-telegram-bot-api'], '0.68.0');
});

if (process.exitCode) process.exit(process.exitCode);
console.log('Telegram member-tag architecture: PASS');

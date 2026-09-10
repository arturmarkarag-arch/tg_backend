'use strict';

const User = require('../models/User');
const Shop = require('../models/Shop');
const TelegramMemberTagSync = require('../models/TelegramMemberTagSync');
const TelegramMemberTagSyncEvent = require('../models/TelegramMemberTagSyncEvent');
const { getTelegramMemberTagGroupIds } = require('../utils/telegramMemberTagGroupSettings');
const { isRemovedUser } = require('../utils/userAccountState');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');
const { setChatMemberTag, deferMemberTagWritesUntil } = require('./telegramMemberTagTransport');

const {
  MAX_TAG_CHARACTERS,
  formatTelegramMemberTag,
  hasEmoji,
  decideTelegramMemberTagAction,
} = require('../utils/telegramMemberTagPolicy');

const DEFAULT_BATCH_LIMIT = 25;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const MAX_AUTOMATIC_ATTEMPTS = 8;
const BLOCKED_GROUP_RECHECK_MS = 60 * 1000;
const RATE_LIMIT_FALLBACK_MS = 60 * 1000;
const RATE_LIMIT_SAFETY_BUFFER_MS = 1000;
let queueIndexesReady = false;
let queueIndexesPromise = null;

function cleanString(value) {
  return value == null ? '' : String(value);
}

function normalizeTelegramId(value) {
  const id = cleanString(value).trim();
  return /^\d+$/.test(id) ? id : '';
}

function normalizeChatId(value) {
  const id = cleanString(value).trim();
  return /^-?\d+$/.test(id) ? id : '';
}

function telegramErrorDescription(error) {
  return cleanString(
    error?.response?.body?.description
    || error?.message
    || error?.code
    || 'telegram_member_tag_failed',
  ).trim();
}

function telegramErrorCode(error) {
  return cleanString(
    error?.response?.body?.error_code
    || error?.response?.statusCode
    || error?.response?.status
    || error?.code
    || '',
  ).trim();
}

function participantAbsentError(error) {
  const text = telegramErrorDescription(error).toLowerCase();
  return text.includes('user not found')
    || text.includes('user_not_participant')
    || text.includes('participant_id_invalid')
    || text.includes('participant not found')
    || text.includes('member not found');
}

function rightsError(error) {
  const text = telegramErrorDescription(error).toLowerCase();
  return text.includes('right_forbidden')
    || text.includes('chat_admin_required')
    || text.includes('chat_creator_required')
    || text.includes('not enough rights')
    || text.includes('need administrator rights')
    || text.includes('can_manage_tags');
}


function rateLimitRetryAt(classification, now = Date.now()) {
  const retryAfterSeconds = Math.max(0, Number(classification?.retryAfterSeconds || 0));
  const delayMs = retryAfterSeconds > 0
    ? (retryAfterSeconds * 1000) + RATE_LIMIT_SAFETY_BUFFER_MS
    : RATE_LIMIT_FALLBACK_MS;
  return new Date(now + delayMs);
}

async function activeGroupRateLimitUntil(chatId, now = new Date()) {
  const gid = normalizeChatId(chatId);
  if (!gid) return null;
  const row = await TelegramMemberTagSync.findOne({
    chatId: gid,
    status: 'retry_wait',
    lastErrorCode: '429',
    nextAttemptAt: { $gt: now },
  }).sort({ nextAttemptAt: -1 }).select('nextAttemptAt').lean();
  return row?.nextAttemptAt ? new Date(row.nextAttemptAt) : null;
}

async function deferGroupAfterRateLimit(chatId, until) {
  const gid = normalizeChatId(chatId);
  const retryAt = until instanceof Date ? until : new Date(until);
  if (!gid || Number.isNaN(retryAt.getTime())) return;

  deferMemberTagWritesUntil(gid, retryAt);
  await TelegramMemberTagSync.updateMany(
    { chatId: gid, status: { $in: ['pending', 'retry_wait'] } },
    {
      $set: {
        status: 'retry_wait',
        lastErrorCode: '429',
        lastError: 'Telegram flood control: group member-tag writes deferred',
      },
      $max: { nextAttemptAt: retryAt },
    },
  );
}

async function ensureTelegramMemberTagQueueIndexes() {
  if (queueIndexesReady) return;
  if (queueIndexesPromise) return queueIndexesPromise;
  queueIndexesPromise = (async () => {
    try { await TelegramMemberTagSync.createCollection(); } catch (_) {}
    let indexes = [];
    try { indexes = await TelegramMemberTagSync.collection.indexes(); } catch (_) {}

    // v1 of this feature briefly used one row per telegramId. If that schema ever
    // reached a DB, remove only that exact feature-owned unique index before the
    // new (telegramId, chatId) target identity becomes active.
    for (const index of indexes) {
      const keys = Object.keys(index?.key || {});
      if (index?.unique === true && keys.length === 1 && index.key.telegramId === 1) {
        try { await TelegramMemberTagSync.collection.dropIndex(index.name); } catch (_) {}
      }
    }

    // Rows without chatId belong to the abandoned MAIN-group prototype and have
    // no deterministic target under the all-configured-groups contract.
    await TelegramMemberTagSync.deleteMany({
      $or: [{ chatId: { $exists: false } }, { chatId: '' }, { chatId: null }],
    }).catch(() => {});

    await TelegramMemberTagSync.collection.createIndex(
      { telegramId: 1, chatId: 1 },
      { unique: true, name: 'telegram_member_tag_target_unique' },
    );
    queueIndexesReady = true;
  })().finally(() => { queueIndexesPromise = null; });
  return queueIndexesPromise;
}

async function writeEvent(payload) {
  const event = {
    telegramId: cleanString(payload.telegramId),
    userId: cleanString(payload.userId),
    shopId: cleanString(payload.shopId),
    shopName: cleanString(payload.shopName),
    chatId: cleanString(payload.chatId),
    telegramStatus: cleanString(payload.telegramStatus),
    previousTag: cleanString(payload.previousTag),
    desiredTag: cleanString(payload.desiredTag),
    result: cleanString(payload.result || 'failed'),
    source: cleanString(payload.source || 'system'),
    requestedRevision: payload.requestedRevision == null ? null : Number(payload.requestedRevision),
    errorCode: cleanString(payload.errorCode).slice(0, 100),
    error: cleanString(payload.error).slice(0, 1000),
    retryAfterSeconds: payload.retryAfterSeconds == null ? null : Number(payload.retryAfterSeconds),
    retryAt: payload.retryAt ? new Date(payload.retryAt) : null,
  };
  try { await TelegramMemberTagSyncEvent.create(event); } catch (_) {}
  try { console.info('[telegram-member-tag-sync]', JSON.stringify(event)); } catch (_) {}
  return event;
}

/** Telegram-only decision layer. No ERP reads/writes happen here. */
async function applyTelegramMemberTag({ bot, chatId, telegramId, desiredTag, setMemberTag = setChatMemberTag }) {
  let member;
  try {
    member = await bot.getChatMember(chatId, Number(telegramId));
  } catch (error) {
    if (participantAbsentError(error)) {
      return { result: 'not_in_group', telegramStatus: 'not_found', previousTag: '', writePerformed: false };
    }
    throw error;
  }

  const status = cleanString(member?.status);
  const previousTag = cleanString(member?.tag);
  const decision = decideTelegramMemberTagAction({ status, currentTag: previousTag, desiredTag });
  if (!decision.write) {
    return { result: decision.result, telegramStatus: status || 'unknown', previousTag, writePerformed: false };
  }

  await setMemberTag(bot, chatId, Number(telegramId), desiredTag);
  return { result: decision.result, telegramStatus: status, previousTag, writePerformed: true };
}

async function cleanupManagedTag({ bot, chatId, telegramId, cleanupTag, setMemberTag = setChatMemberTag }) {
  let member;
  try {
    member = await bot.getChatMember(chatId, Number(telegramId));
  } catch (error) {
    if (participantAbsentError(error)) {
      return { result: 'cleanup_not_in_group', telegramStatus: 'not_found', previousTag: '', writePerformed: false };
    }
    throw error;
  }

  const status = cleanString(member?.status);
  const previousTag = cleanString(member?.tag);
  if (status === 'administrator') return { result: 'cleanup_skipped_admin', telegramStatus: status, previousTag, writePerformed: false };
  if (status === 'creator') return { result: 'cleanup_skipped_creator', telegramStatus: status, previousTag, writePerformed: false };
  if (status !== 'member') return { result: `cleanup_skipped_${status || 'unknown'}`, telegramStatus: status || 'unknown', previousTag, writePerformed: false };
  if (!cleanupTag || previousTag !== cleanupTag) {
    return { result: previousTag ? 'cleanup_skipped_tag_changed' : 'cleanup_unchanged', telegramStatus: status, previousTag, writePerformed: false };
  }

  await setMemberTag(bot, chatId, Number(telegramId), '');
  return { result: 'cleanup_cleared', telegramStatus: status, previousTag, writePerformed: true };
}

async function loadDesiredState(telegramId) {
  const user = await User.findOne({ telegramId: cleanString(telegramId) })
    .select('_id telegramId shopId accountState')
    .lean();
  if (!user || isRemovedUser(user)) return { user, shop: null, desiredTag: '' };

  let shop = null;
  if (user.shopId) shop = await Shop.findById(user.shopId).select('_id name').lean();
  return { user, shop, desiredTag: shop ? formatTelegramMemberTag(shop.name) : '' };
}

async function getTelegramMemberTagGroupHealth(groupId, { live = true } = {}) {
  const chatId = normalizeChatId(groupId);
  const base = {
    groupId: chatId,
    configured: Boolean(chatId),
    botAvailable: false,
    chatReachable: false,
    chatType: '',
    chatTitle: '',
    botStatus: '',
    canManageTags: false,
    transportSupportsMemberTags: false,
    ok: false,
    error: '',
  };
  if (!chatId || !live) return base;

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) return { ...base, error: 'bot_unavailable' };
  base.botAvailable = true;
  base.transportSupportsMemberTags = typeof bot._request === 'function';
  if (!base.transportSupportsMemberTags) return { ...base, error: 'telegram_member_tag_transport_unavailable' };

  try {
    const [me, chat] = await Promise.all([bot.getMe(), bot.getChat(chatId)]);
    base.chatReachable = Boolean(chat?.id);
    base.chatType = cleanString(chat?.type);
    base.chatTitle = cleanString(chat?.title);
    if (!['group', 'supergroup'].includes(base.chatType)) return { ...base, error: 'chat_not_group' };

    const botMember = await bot.getChatMember(chatId, Number(me.id));
    base.botStatus = cleanString(botMember?.status);
    base.canManageTags = base.botStatus === 'creator'
      || (base.botStatus === 'administrator' && botMember?.can_manage_tags === true);
    base.ok = base.chatReachable && ['administrator', 'creator'].includes(base.botStatus) && base.canManageTags;
    if (!base.ok) base.error = 'can_manage_tags_required';
    return base;
  } catch (error) {
    return { ...base, error: telegramErrorDescription(error).slice(0, 500) };
  }
}

async function getTelegramMemberTagHealth({ live = true } = {}) {
  const groupIds = await getTelegramMemberTagGroupIds();
  const groups = await Promise.all(groupIds.map((groupId) => getTelegramMemberTagGroupHealth(groupId, { live })));
  const readyGroups = groups.filter((row) => row.ok).length;
  return {
    configured: groupIds.length > 0,
    groupCount: groupIds.length,
    readyGroups,
    blockedGroups: groups.length - readyGroups,
    ok: groupIds.length > 0 && readyGroups === groupIds.length,
    groups,
  };
}

async function upsertTarget(telegramId, chatId, { source = 'system', mode = 'sync', cleanupTag = '' } = {}) {
  const tid = normalizeTelegramId(telegramId);
  const gid = normalizeChatId(chatId);
  if (!tid || !gid) return null;
  await ensureTelegramMemberTagQueueIndexes();
  const now = new Date();
  const cooldownUntil = await activeGroupRateLimitUntil(gid, now);
  const rateLimited = Boolean(cooldownUntil);
  return TelegramMemberTagSync.findOneAndUpdate(
    { telegramId: tid, chatId: gid },
    {
      $set: {
        mode,
        cleanupTag: mode === 'cleanup' ? cleanString(cleanupTag) : '',
        status: rateLimited ? 'retry_wait' : 'pending',
        requestedAt: now, nextAttemptAt: cooldownUntil || now,
        source: cleanString(source || 'system'), completedAt: null, attempts: 0,
        lastErrorCode: rateLimited ? '429' : '',
        lastError: rateLimited ? 'Telegram flood control: waiting for active group cooldown' : '',
      },
      $inc: { requestedRevision: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

async function resolveConfiguredMemberTagGroups(chatId = null) {
  const configured = await getTelegramMemberTagGroupIds();
  if (chatId == null) return configured;
  const requested = normalizeChatId(chatId);
  return requested && configured.includes(requested) ? [requested] : [];
}

async function enqueueTelegramMemberTagSync(telegramId, { source = 'system', chatId = null } = {}) {
  const tid = normalizeTelegramId(telegramId);
  if (!tid) return { queued: 0, groups: 0 };
  const groupIds = await resolveConfiguredMemberTagGroups(chatId);
  let queued = 0;
  for (const groupId of groupIds) {
    if (await upsertTarget(tid, groupId, { source, mode: 'sync' })) queued += 1;
  }
  return { queued, groups: groupIds.length };
}

async function enqueueTelegramMemberTagReconcile({ source = 'manual_reconcile', chatId = null } = {}) {
  await ensureTelegramMemberTagQueueIndexes();
  const groupIds = await resolveConfiguredMemberTagGroups(chatId);
  if (!groupIds.length) return { queued: 0, users: 0, groups: 0 };
  const users = await User.find({ telegramId: { $type: 'string', $ne: '' } }, 'telegramId').lean();
  const ids = [...new Set(users.map((user) => normalizeTelegramId(user.telegramId)).filter(Boolean))];
  if (!ids.length) return { queued: 0, users: 0, groups: groupIds.length };

  const now = new Date();
  const cooldownByGroup = new Map();
  for (const groupId of groupIds) {
    cooldownByGroup.set(groupId, await activeGroupRateLimitUntil(groupId, now));
  }
  const operations = [];
  for (const telegramId of ids) {
    for (const groupId of groupIds) {
      const cooldownUntil = cooldownByGroup.get(groupId);
      const rateLimited = Boolean(cooldownUntil);
      operations.push({ updateOne: {
        filter: { telegramId, chatId: groupId },
        update: {
          $set: {
            mode: 'sync', cleanupTag: '',
            status: rateLimited ? 'retry_wait' : 'pending', requestedAt: now,
            nextAttemptAt: cooldownUntil || now, source: cleanString(source), completedAt: null,
            attempts: 0,
            lastErrorCode: rateLimited ? '429' : '',
            lastError: rateLimited ? 'Telegram flood control: waiting for active group cooldown' : '',
          },
          $inc: { requestedRevision: 1 },
        },
        upsert: true,
      } });
    }
  }
  await TelegramMemberTagSync.bulkWrite(operations, { ordered: false });
  return { queued: operations.length, users: ids.length, groups: groupIds.length };
}

async function enqueueShopMemberTagSync(shopId, { source = 'shop_name_changed' } = {}) {
  const id = cleanString(shopId).trim();
  if (!id) return { queued: 0, users: 0 };
  const users = await User.find({ shopId: id }, 'telegramId').lean();
  const ids = [...new Set(users.map((user) => normalizeTelegramId(user.telegramId)).filter(Boolean))];
  let queued = 0;
  for (const telegramId of ids) queued += (await enqueueTelegramMemberTagSync(telegramId, { source })).queued;
  return { queued, users: ids.length };
}

async function enqueueTelegramGroupTagCleanup(chatId, { source = 'telegram_group_removed' } = {}) {
  const gid = normalizeChatId(chatId);
  if (!gid) return { queued: 0 };
  await ensureTelegramMemberTagQueueIndexes();
  const owned = await TelegramMemberTagSync.find({
    chatId: gid,
    desiredTag: { $ne: '' },
    lastResult: { $in: ['updated', 'unchanged'] },
  }).select('telegramId desiredTag').lean();
  let queued = 0;
  for (const row of owned) {
    if (await upsertTarget(row.telegramId, gid, { source, mode: 'cleanup', cleanupTag: row.desiredTag })) queued += 1;
  }
  return { queued };
}

function nextRetryAt(classification, attempt) {
  const delay = retryDelayMs(classification, attempt);
  return new Date(Date.now() + Math.max(1000, delay));
}

async function finishClaim(row, patch) {
  const filter = { _id: row._id, requestedRevision: row.processingRevision };
  return TelegramMemberTagSync.updateOne(filter, { $set: patch });
}

async function processTelegramMemberTagSync(row) {
  const telegramId = normalizeTelegramId(row.telegramId);
  const chatId = normalizeChatId(row.chatId);
  const revision = Number(row.processingRevision || row.requestedRevision || 0);
  const source = cleanString(row.source || 'worker');
  const mode = row.mode === 'cleanup' ? 'cleanup' : 'sync';
  const state = await loadDesiredState(telegramId);
  const base = {
    telegramId,
    userId: state.user?._id ? String(state.user._id) : '',
    shopId: state.shop?._id ? String(state.shop._id) : '',
    shopName: cleanString(state.shop?.name),
    chatId,
    desiredTag: mode === 'cleanup' ? '' : state.desiredTag,
    source,
    requestedRevision: revision,
  };

  if (!telegramId || !chatId) {
    const event = await writeEvent({ ...base, result: 'failed', errorCode: 'invalid_queue_target' });
    await finishClaim(row, { status: 'failed', completedAt: new Date(), lastResult: event.result, lastErrorCode: event.errorCode });
    return event;
  }

  if (mode === 'sync') {
    const groups = await getTelegramMemberTagGroupIds();
    if (!groups.includes(chatId)) {
      const event = await writeEvent({ ...base, result: 'skipped_group_removed' });
      await finishClaim(row, { status: 'skipped', completedAt: new Date(), lastResult: event.result, lastErrorCode: '', lastError: '' });
      return event;
    }
    if (hasEmoji(state.desiredTag)) {
      const event = await writeEvent({ ...base, result: 'invalid_tag', errorCode: 'telegram_tag_emoji_not_allowed' });
      await finishClaim(row, {
        status: 'failed', completedAt: new Date(), lastResult: event.result,
        lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
        desiredTag: event.desiredTag, lastErrorCode: event.errorCode, lastError: '',
      });
      return event;
    }
  }

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    const classification = { kind: 'bot_unavailable', retryAfterSeconds: 5 };
    const attempt = Math.max(1, Number(row.attempts || 0));
    const event = await writeEvent({ ...base, result: 'retry_wait', errorCode: 'bot_unavailable', error: 'Telegram bot is not initialized' });
    await finishClaim(row, {
      status: 'retry_wait', nextAttemptAt: nextRetryAt(classification, attempt), lastResult: event.result,
      lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
      desiredTag: event.desiredTag, lastErrorCode: event.errorCode, lastError: event.error,
    });
    return event;
  }

  try {
    const applied = mode === 'cleanup'
      ? await cleanupManagedTag({ bot, chatId, telegramId, cleanupTag: cleanString(row.cleanupTag) })
      : await applyTelegramMemberTag({ bot, chatId, telegramId, desiredTag: state.desiredTag });
    const event = await writeEvent({ ...base, ...applied, result: applied.result });
    const skipped = applied.result.includes('skipped_') || applied.result.includes('not_in_group');
    await finishClaim(row, {
      status: skipped ? 'skipped' : 'synced', completedAt: new Date(), nextAttemptAt: new Date(),
      mode, cleanupTag: mode === 'cleanup' ? cleanString(row.cleanupTag) : '',
      lastResult: event.result, lastUserId: event.userId, lastShopId: event.shopId,
      lastShopName: event.shopName, telegramStatus: event.telegramStatus,
      previousTag: event.previousTag, desiredTag: mode === 'cleanup' ? '' : event.desiredTag,
      lastErrorCode: '', lastError: '',
    });
    return event;
  } catch (error) {
    // User may become admin between the read and write; re-read once and never
    // touch admin/creator titles even under that race.
    if (rightsError(error)) {
      try {
        const latest = await bot.getChatMember(chatId, Number(telegramId));
        if (latest?.status === 'administrator' || latest?.status === 'creator') {
          const result = latest.status === 'creator' ? 'skipped_creator' : 'skipped_admin';
          const event = await writeEvent({ ...base, telegramStatus: latest.status, previousTag: cleanString(latest.tag), result });
          await finishClaim(row, {
            status: 'skipped', completedAt: new Date(), lastResult: result,
            lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
            telegramStatus: latest.status, previousTag: event.previousTag, desiredTag: event.desiredTag,
            lastErrorCode: '', lastError: '',
          });
          return event;
        }
      } catch (_) {}
    }

    const classification = classifyTelegramSendError(error);
    const attempt = Math.max(1, Number(row.attempts || 0));
    const retryable = classification.retryable && !rightsError(error) && attempt < MAX_AUTOMATIC_ATTEMPTS;
    const exhausted = classification.retryable && attempt >= MAX_AUTOMATIC_ATTEMPTS;
    const retryAt = retryable
      ? (classification.rateLimited ? rateLimitRetryAt(classification) : nextRetryAt(classification, attempt))
      : null;
    if (classification.rateLimited && retryAt) {
      // Flood control is a chat-level operational condition, not N independent
      // user failures. Persist one cooldown for every queued target in this group
      // and stop subsequent rows from immediately generating more 429 responses.
      await deferGroupAfterRateLimit(chatId, retryAt);
    }
    const event = await writeEvent({
      ...base,
      result: retryable ? 'retry_wait' : 'failed',
      errorCode: exhausted ? `retry_exhausted:${telegramErrorCode(error) || classification.kind}` : (telegramErrorCode(error) || classification.kind),
      error: telegramErrorDescription(error),
      retryAfterSeconds: classification.retryAfterSeconds,
      retryAt,
    });
    await finishClaim(row, {
      status: retryable ? 'retry_wait' : 'failed',
      ...(retryable ? { nextAttemptAt: retryAt } : { completedAt: new Date() }),
      lastResult: event.result, lastUserId: event.userId, lastShopId: event.shopId,
      lastShopName: event.shopName, desiredTag: event.desiredTag,
      lastErrorCode: event.errorCode, lastError: event.error,
    });
    return event;
  }
}

function dueFilter(now = new Date()) {
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  return { $or: [
    { status: { $in: ['pending', 'retry_wait'] }, nextAttemptAt: { $lte: now } },
    { status: 'processing', lastAttemptAt: { $lte: staleBefore } },
  ] };
}

async function claimNextDue(readyChatIds) {
  const now = new Date();
  const filter = dueFilter(now);
  if (Array.isArray(readyChatIds)) filter.chatId = { $in: readyChatIds };
  return TelegramMemberTagSync.findOneAndUpdate(
    filter,
    { $set: { status: 'processing', lastAttemptAt: now }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1, requestedAt: 1, _id: 1 }, new: true },
  ).lean();
}

async function drainDueTelegramMemberTagSync({ limit = DEFAULT_BATCH_LIMIT } = {}) {
  await ensureTelegramMemberTagQueueIndexes();
  const max = Math.max(1, Math.min(100, Number(limit) || DEFAULT_BATCH_LIMIT));
  const now = new Date();
  const due = dueFilter(now);
  const configuredGroupIds = await getTelegramMemberTagGroupIds();

  // V3/V4 incorrectly used telegram.allowedGroupIds as tag targets. After the
  // settings split, stale ordinary sync rows must not keep touching those chats.
  // Cleanup rows are intentionally exempt because they may target a group just
  // removed from the dedicated member-tag list.
  await TelegramMemberTagSync.updateMany(
    { ...due, mode: { $ne: 'cleanup' }, chatId: { $nin: configuredGroupIds } },
    {
      $set: {
        status: 'skipped', completedAt: now, lastResult: 'skipped_group_removed',
        lastErrorCode: '', lastError: '',
      },
    },
  );

  const eligibleDue = {
    ...due,
    $and: [
      { $or: [{ mode: 'cleanup' }, { chatId: { $in: configuredGroupIds } }] },
    ],
  };
  const chatIds = (await TelegramMemberTagSync.distinct('chatId', eligibleDue)).map(normalizeChatId).filter(Boolean);
  if (!chatIds.length) return { processed: 0, results: [] };

  // Preflight once per due group. A group without permission is delayed as a
  // group, not multiplied into N user failures, and does not block healthy groups.
  const health = await Promise.all(chatIds.map((chatId) => getTelegramMemberTagGroupHealth(chatId, { live: true })));
  const readyChatIds = health.filter((row) => row.ok).map((row) => row.groupId);
  const blockedChatIds = health.filter((row) => !row.ok).map((row) => row.groupId);
  if (blockedChatIds.length) {
    await TelegramMemberTagSync.updateMany(
      { ...due, chatId: { $in: blockedChatIds } },
      { $set: { nextAttemptAt: new Date(Date.now() + BLOCKED_GROUP_RECHECK_MS) } },
    );
  }
  if (!readyChatIds.length) return { processed: 0, results: [], blocked: true, health };

  const results = [];
  for (let i = 0; i < max; i += 1) {
    const row = await claimNextDue(readyChatIds);
    if (!row) break;
    // `claimNextDue()` already atomically owns this row by setting status=processing.
    // The revision fence used by finishClaim() only needs the claimed revision in
    // memory: it compares the CURRENT requestedRevision in Mongo with this value.
    // Persisting processingRevision here was redundant, added one write per row,
    // and — because it happened before the per-row try/catch — one local Mongoose
    // failure could abort the whole scheduler drain. Keep the exact same CAS
    // semantics without that extra failure surface / Mongo round-trip.
    row.processingRevision = Number(row.requestedRevision || 0);
    try {
      results.push(await processTelegramMemberTagSync(row));
    } catch (error) {
      // Failure-isolated per (telegramId, chatId): one user/group target never
      // stops other users or other configured Telegram groups.
      const event = await writeEvent({
        telegramId: row.telegramId, chatId: row.chatId, result: 'failed',
        source: row.source || 'worker', requestedRevision: row.processingRevision,
        errorCode: cleanString(error?.code || 'internal_error'), error: telegramErrorDescription(error),
      });
      await finishClaim(row, { status: 'failed', completedAt: new Date(), lastResult: 'failed', lastErrorCode: event.errorCode, lastError: event.error }).catch(() => {});
      results.push(event);
    }
  }
  return { processed: results.length, results, health };
}

async function getTelegramMemberTagSyncSummary() {
  await ensureTelegramMemberTagQueueIndexes();
  const configuredGroupIds = await getTelegramMemberTagGroupIds();
  const queueMatch = configuredGroupIds.length ? { chatId: { $in: configuredGroupIds } } : { _id: null };
  const eventMatch = configuredGroupIds.length ? { chatId: { $in: configuredGroupIds } } : { _id: null };
  const [health, counts, recent] = await Promise.all([
    getTelegramMemberTagHealth({ live: true }),
    TelegramMemberTagSync.aggregate([{ $match: queueMatch }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
    TelegramMemberTagSyncEvent.find(eventMatch).sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  return {
    health,
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
    recent: recent.map((row) => ({
      id: String(row._id), createdAt: row.createdAt, telegramId: row.telegramId,
      userId: row.userId || '', shopId: row.shopId || '', shopName: row.shopName || '',
      chatId: row.chatId || '', telegramStatus: row.telegramStatus || '',
      previousTag: row.previousTag || '', desiredTag: row.desiredTag || '',
      result: row.result, source: row.source || '', errorCode: row.errorCode || '', error: row.error || '',
      retryAfterSeconds: row.retryAfterSeconds == null ? null : Number(row.retryAfterSeconds),
      retryAt: row.retryAt || null,
    })),
  };
}

module.exports = {
  MAX_TAG_CHARACTERS,
  formatTelegramMemberTag,
  hasEmoji,
  applyTelegramMemberTag,
  cleanupManagedTag,
  getTelegramMemberTagGroupHealth,
  getTelegramMemberTagHealth,
  enqueueTelegramMemberTagSync,
  enqueueTelegramMemberTagReconcile,
  enqueueShopMemberTagSync,
  enqueueTelegramGroupTagCleanup,
  ensureTelegramMemberTagQueueIndexes,
  drainDueTelegramMemberTagSync,
  getTelegramMemberTagSyncSummary,
  participantAbsentError,
  rightsError,
  rateLimitRetryAt,
  activeGroupRateLimitUntil,
  deferGroupAfterRateLimit,
};

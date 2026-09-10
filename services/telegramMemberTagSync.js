'use strict';

const User = require('../models/User');
const Shop = require('../models/Shop');
const TelegramMemberTagSync = require('../models/TelegramMemberTagSync');
const TelegramMemberTagSyncEvent = require('../models/TelegramMemberTagSyncEvent');
const { getMainTelegramGroupId } = require('../utils/telegramGroupSettings');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');

const {
  MAX_TAG_CHARACTERS,
  formatTelegramMemberTag,
  hasEmoji,
  decideTelegramMemberTagAction,
} = require('../utils/telegramMemberTagPolicy');

const DEFAULT_BATCH_LIMIT = 25;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const MAX_AUTOMATIC_ATTEMPTS = 8;

function cleanString(value) {
  return value == null ? '' : String(value);
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
    || text.includes('need administrator rights');
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
  };

  try { await TelegramMemberTagSyncEvent.create(event); } catch (_) {}
  try { console.info('[telegram-member-tag-sync]', JSON.stringify(event)); } catch (_) {}
  return event;
}

/**
 * Telegram-only decision layer. It never reads or writes ERP state.
 * Exported for unit tests so every admin/member/status rule is contract-tested.
 */
async function applyTelegramMemberTag({ bot, chatId, telegramId, desiredTag }) {
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
    return {
      result: decision.result,
      telegramStatus: status || 'unknown',
      previousTag,
      writePerformed: false,
    };
  }

  await bot.setChatMemberTag(chatId, Number(telegramId), { tag: desiredTag });
  return {
    result: decision.result,
    telegramStatus: status,
    previousTag,
    writePerformed: true,
  };
}

async function loadDesiredState(telegramId) {
  const user = await User.findOne({ telegramId: cleanString(telegramId) })
    .select('_id telegramId shopId accountState')
    .lean();

  if (!user) {
    return { user: null, shop: null, desiredTag: '' };
  }

  let shop = null;
  if (user.shopId) {
    shop = await Shop.findById(user.shopId).select('_id name').lean();
  }

  return {
    user,
    shop,
    desiredTag: shop ? formatTelegramMemberTag(shop.name) : '',
  };
}

async function getTelegramMemberTagHealth({ live = true } = {}) {
  const mainGroupId = await getMainTelegramGroupId();
  const base = {
    configured: Boolean(mainGroupId),
    mainGroupId: mainGroupId || '',
    botAvailable: false,
    chatReachable: false,
    chatType: '',
    chatTitle: '',
    botStatus: '',
    canManageTags: false,
    sdkSupportsMemberTags: false,
    ok: false,
    error: '',
  };
  if (!mainGroupId || !live) return base;

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) return { ...base, error: 'bot_unavailable' };
  base.botAvailable = true;
  base.sdkSupportsMemberTags = typeof bot.setChatMemberTag === 'function';
  if (!base.sdkSupportsMemberTags) {
    return { ...base, error: 'telegram_sdk_set_chat_member_tag_unavailable' };
  }

  try {
    const [me, chat] = await Promise.all([
      bot.getMe(),
      bot.getChat(mainGroupId),
    ]);
    base.chatReachable = Boolean(chat?.id);
    base.chatType = cleanString(chat?.type);
    base.chatTitle = cleanString(chat?.title);

    if (!['group', 'supergroup'].includes(base.chatType)) {
      return { ...base, error: 'main_chat_not_group' };
    }

    const botMember = await bot.getChatMember(mainGroupId, Number(me.id));
    base.botStatus = cleanString(botMember?.status);
    const explicit = botMember?.can_manage_tags;
    // Fail closed: can_manage_tags is its own Telegram permission. Never infer it
    // from legacy/adjacent rights such as can_pin_messages.
    base.canManageTags = base.botStatus === 'creator' || explicit === true;
    base.ok = base.chatReachable
      && ['administrator', 'creator'].includes(base.botStatus)
      && base.canManageTags;
    if (!base.ok && !base.error) base.error = 'can_manage_tags_required';
    return base;
  } catch (error) {
    return {
      ...base,
      error: telegramErrorDescription(error).slice(0, 500),
    };
  }
}

async function enqueueTelegramMemberTagSync(telegramId, { source = 'system' } = {}) {
  const tid = cleanString(telegramId).trim();
  if (!/^\d+$/.test(tid)) return null;
  const now = new Date();
  return TelegramMemberTagSync.findOneAndUpdate(
    { telegramId: tid },
    {
      $set: {
        status: 'pending',
        requestedAt: now,
        nextAttemptAt: now,
        source: cleanString(source || 'system'),
        completedAt: null,
        attempts: 0,
        lastErrorCode: '',
        lastError: '',
      },
      $inc: { requestedRevision: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
}

async function enqueueTelegramMemberTagReconcile({ source = 'manual_reconcile' } = {}) {
  const users = await User.find({ telegramId: { $type: 'string', $ne: '' } }, 'telegramId').lean();
  const ids = [...new Set(users.map((user) => cleanString(user.telegramId).trim()).filter((id) => /^\d+$/.test(id)))];
  if (!ids.length) return { queued: 0 };

  const now = new Date();
  const operations = ids.map((telegramId) => ({
    updateOne: {
      filter: { telegramId },
      update: {
        $set: {
          status: 'pending',
          requestedAt: now,
          nextAttemptAt: now,
          source: cleanString(source),
          completedAt: null,
          attempts: 0,
          lastErrorCode: '',
          lastError: '',
        },
        $inc: { requestedRevision: 1 },
      },
      upsert: true,
    },
  }));

  await TelegramMemberTagSync.bulkWrite(operations, { ordered: false });
  return { queued: ids.length };
}

async function enqueueShopMemberTagSync(shopId, { source = 'shop_name_changed' } = {}) {
  const id = cleanString(shopId).trim();
  if (!id) return { queued: 0 };
  const users = await User.find({ shopId: id }, 'telegramId').lean();
  const ids = [...new Set(users.map((user) => cleanString(user.telegramId).trim()).filter((tid) => /^\d+$/.test(tid)))];
  for (const telegramId of ids) await enqueueTelegramMemberTagSync(telegramId, { source });
  return { queued: ids.length };
}

function nextRetryAt(classification, attempt) {
  const delay = retryDelayMs(classification, attempt);
  return new Date(Date.now() + Math.max(1000, delay));
}

async function finishClaim(row, patch) {
  const filter = { _id: row._id, requestedRevision: row.processingRevision };
  return TelegramMemberTagSync.updateOne(filter, { $set: patch });
}


async function cleanupPreviousMainGroupTag({ bot, row, telegramId, currentMainGroupId, base }) {
  const previousChatId = cleanString(row.lastChatId).trim();
  const previouslyManagedTag = cleanString(row.desiredTag);
  const previousResult = cleanString(row.lastResult);

  if (!previousChatId || previousChatId === currentMainGroupId || !previouslyManagedTag) return null;
  if (!['updated', 'unchanged'].includes(previousResult)) return null;

  try {
    const member = await bot.getChatMember(previousChatId, Number(telegramId));
    const status = cleanString(member?.status);
    const currentTag = cleanString(member?.tag);

    // The administrator/creator immutability rule applies to migration cleanup too.
    if (status === 'administrator' || status === 'creator') {
      return writeEvent({
        ...base,
        chatId: previousChatId,
        telegramStatus: status,
        previousTag: currentTag,
        desiredTag: '',
        result: status === 'creator' ? 'migration_skipped_creator' : 'migration_skipped_admin',
        source: 'main_group_migration_cleanup',
      });
    }

    // Strict user contract: restricted/left/kicked users are not managed.
    if (status !== 'member') {
      return writeEvent({
        ...base,
        chatId: previousChatId,
        telegramStatus: status,
        previousTag: currentTag,
        desiredTag: '',
        result: 'migration_skipped_non_member',
        source: 'main_group_migration_cleanup',
      });
    }

    // Ownership guard: never erase a tag that no longer equals the last tag
    // observed/managed by this ERP projection.
    if (currentTag !== previouslyManagedTag) {
      return writeEvent({
        ...base,
        chatId: previousChatId,
        telegramStatus: status,
        previousTag: currentTag,
        desiredTag: '',
        result: 'migration_skipped_tag_changed',
        source: 'main_group_migration_cleanup',
      });
    }

    await bot.setChatMemberTag(previousChatId, Number(telegramId), { tag: '' });
    return writeEvent({
      ...base,
      chatId: previousChatId,
      telegramStatus: status,
      previousTag: currentTag,
      desiredTag: '',
      result: 'migration_cleared',
      source: 'main_group_migration_cleanup',
    });
  } catch (error) {
    const absent = participantAbsentError(error);
    return writeEvent({
      ...base,
      chatId: previousChatId,
      desiredTag: '',
      result: absent ? 'migration_not_in_group' : 'migration_cleanup_failed',
      source: 'main_group_migration_cleanup',
      errorCode: telegramErrorCode(error) || (absent ? 'user_not_participant' : 'migration_cleanup_failed'),
      error: telegramErrorDescription(error),
    });
  }
}

async function processTelegramMemberTagSync(row) {
  const telegramId = cleanString(row.telegramId);
  const revision = Number(row.processingRevision || row.requestedRevision || 0);
  const source = cleanString(row.source || 'worker');
  const mainGroupId = await getMainTelegramGroupId();

  const state = await loadDesiredState(telegramId);
  const base = {
    telegramId,
    userId: state.user?._id ? String(state.user._id) : '',
    shopId: state.shop?._id ? String(state.shop._id) : '',
    shopName: cleanString(state.shop?.name),
    chatId: mainGroupId || '',
    desiredTag: state.desiredTag,
    source,
    requestedRevision: revision,
  };

  if (!mainGroupId) {
    const event = await writeEvent({ ...base, result: 'config_missing', errorCode: 'telegram_main_group_not_configured' });
    await finishClaim(row, {
      status: 'failed', completedAt: new Date(), lastResult: event.result,
      lastChatId: '', lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
      telegramStatus: '', previousTag: '', desiredTag: event.desiredTag,
      lastErrorCode: event.errorCode, lastError: '',
    });
    return event;
  }

  if (hasEmoji(state.desiredTag)) {
    const event = await writeEvent({ ...base, result: 'invalid_tag', errorCode: 'telegram_tag_emoji_not_allowed' });
    await finishClaim(row, {
      status: 'failed', completedAt: new Date(), lastResult: event.result,
      lastChatId: mainGroupId, lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
      telegramStatus: '', previousTag: '', desiredTag: event.desiredTag,
      lastErrorCode: event.errorCode, lastError: '',
    });
    return event;
  }

  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    const classification = { kind: 'bot_unavailable', retryAfterSeconds: 5 };
    const attempt = Math.max(1, Number(row.attempts || 0));
    const event = await writeEvent({ ...base, result: 'retry_wait', errorCode: 'bot_unavailable', error: 'Telegram bot is not initialized' });
    await finishClaim(row, {
      status: 'retry_wait', nextAttemptAt: nextRetryAt(classification, attempt), lastResult: event.result,
      lastChatId: mainGroupId, lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
      telegramStatus: '', previousTag: '', desiredTag: event.desiredTag,
      lastErrorCode: event.errorCode, lastError: event.error,
    });
    return event;
  }

  try {
    // If MAIN group changed, clean only the old tag that this projection still
    // owns. Cleanup is best-effort and must never block convergence in the new
    // main group; failures remain visible in the structured event journal.
    await cleanupPreviousMainGroupTag({
      bot, row, telegramId, currentMainGroupId: mainGroupId, base,
    });

    const applied = await applyTelegramMemberTag({
      bot,
      chatId: mainGroupId,
      telegramId,
      desiredTag: state.desiredTag,
    });
    const event = await writeEvent({
      ...base,
      ...applied,
      result: applied.result,
    });
    const skipped = applied.result.startsWith('skipped_') || applied.result === 'not_in_group';
    await finishClaim(row, {
      status: skipped ? 'skipped' : 'synced',
      completedAt: new Date(),
      nextAttemptAt: new Date(),
      lastResult: event.result,
      lastChatId: mainGroupId,
      lastUserId: event.userId,
      lastShopId: event.shopId,
      lastShopName: event.shopName,
      telegramStatus: event.telegramStatus,
      previousTag: event.previousTag,
      desiredTag: event.desiredTag,
      lastErrorCode: '',
      lastError: '',
    });
    return event;
  } catch (error) {
    // A target can become admin between getChatMember and setChatMemberTag.
    // Re-read once: if that race happened, respect the DO-NOT-TOUCH rule.
    if (rightsError(error)) {
      try {
        const latest = await bot.getChatMember(mainGroupId, Number(telegramId));
        if (latest?.status === 'administrator' || latest?.status === 'creator') {
          const result = latest.status === 'creator' ? 'skipped_creator' : 'skipped_admin';
          const event = await writeEvent({
            ...base,
            telegramStatus: latest.status,
            previousTag: cleanString(latest.tag),
            result,
          });
          await finishClaim(row, {
            status: 'skipped', completedAt: new Date(), lastResult: result,
            lastChatId: mainGroupId, lastUserId: event.userId, lastShopId: event.shopId, lastShopName: event.shopName,
            telegramStatus: latest.status, previousTag: event.previousTag, desiredTag: event.desiredTag,
            lastErrorCode: '', lastError: '',
          });
          return event;
        }
      } catch (_) {}
    }

    const classification = classifyTelegramSendError(error);
    const attempt = Math.max(1, Number(row.attempts || 0));
    const retryable = classification.retryable
      && !rightsError(error)
      && attempt < MAX_AUTOMATIC_ATTEMPTS;
    const exhausted = classification.retryable && attempt >= MAX_AUTOMATIC_ATTEMPTS;
    const event = await writeEvent({
      ...base,
      result: retryable ? 'retry_wait' : 'failed',
      errorCode: exhausted
        ? `retry_exhausted:${telegramErrorCode(error) || classification.kind}`
        : (telegramErrorCode(error) || classification.kind),
      error: telegramErrorDescription(error),
    });

    await finishClaim(row, {
      status: retryable ? 'retry_wait' : 'failed',
      ...(retryable ? { nextAttemptAt: nextRetryAt(classification, attempt) } : { completedAt: new Date() }),
      lastResult: event.result,
      lastChatId: mainGroupId,
      lastUserId: event.userId,
      lastShopId: event.shopId,
      lastShopName: event.shopName,
      telegramStatus: '', previousTag: '', desiredTag: event.desiredTag,
      lastErrorCode: event.errorCode, lastError: event.error,
    });
    return event;
  }
}

async function claimNextDue() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  return TelegramMemberTagSync.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ['pending', 'retry_wait'] }, nextAttemptAt: { $lte: now } },
        // Process restart/crash recovery. Telegram transport timeout is 45 s, so
        // a 2-minute processing row is no longer a legitimate in-flight call.
        { status: 'processing', lastAttemptAt: { $lte: staleBefore } },
      ],
    },
    {
      $set: { status: 'processing', lastAttemptAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { nextAttemptAt: 1, requestedAt: 1, _id: 1 }, new: true },
  ).lean();
}

async function drainDueTelegramMemberTagSync({ limit = DEFAULT_BATCH_LIMIT } = {}) {
  const max = Math.max(1, Math.min(100, Number(limit) || DEFAULT_BATCH_LIMIT));
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const hasDue = await TelegramMemberTagSync.exists({
    $or: [
      { status: { $in: ['pending', 'retry_wait'] }, nextAttemptAt: { $lte: now } },
      { status: 'processing', lastAttemptAt: { $lte: staleBefore } },
    ],
  });
  if (!hasDue) return { processed: 0, results: [] };

  // Infrastructure preflight is deliberately once per batch, not once per user.
  // Missing permission / old Telegram SDK must not turn a recoverable global
  // configuration problem into N permanent per-user failures.
  const health = await getTelegramMemberTagHealth({ live: true });
  if (!health.ok) {
    return { processed: 0, results: [], blocked: true, health };
  }

  const results = [];
  for (let i = 0; i < max; i += 1) {
    const row = await claimNextDue();
    if (!row) break;
    // Snapshot the revision claimed by this worker. If another event dirties the
    // same user while Telegram is in flight, its $inc changes requestedRevision;
    // finishClaim then cannot overwrite the newer pending request.
    row.processingRevision = Number(row.requestedRevision || 0);
    await TelegramMemberTagSync.updateOne(
      { _id: row._id, status: 'processing', requestedRevision: row.processingRevision },
      { $set: { processingRevision: row.processingRevision } },
    );
    try {
      results.push(await processTelegramMemberTagSync(row));
    } catch (error) {
      // Reconcile is failure-isolated: one malformed DB row / transient internal
      // error must never prevent the remaining ERP users from being checked.
      const event = await writeEvent({
        telegramId: row.telegramId,
        result: 'failed',
        source: row.source || 'worker',
        requestedRevision: row.processingRevision,
        errorCode: cleanString(error?.code || 'internal_error'),
        error: telegramErrorDescription(error),
      });
      await finishClaim(row, {
        status: 'failed',
        completedAt: new Date(),
        lastResult: 'failed',
        lastErrorCode: event.errorCode,
        lastError: event.error,
      }).catch(() => {});
      results.push(event);
    }
  }
  return { processed: results.length, results };
}

async function getTelegramMemberTagSyncSummary() {
  const [health, counts, recent] = await Promise.all([
    getTelegramMemberTagHealth({ live: true }),
    TelegramMemberTagSync.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    TelegramMemberTagSyncEvent.find({}).sort({ createdAt: -1 }).limit(25).lean(),
  ]);
  return {
    health,
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
    recent: recent.map((row) => ({
      id: String(row._id),
      createdAt: row.createdAt,
      telegramId: row.telegramId,
      userId: row.userId || '',
      shopId: row.shopId || '',
      shopName: row.shopName || '',
      chatId: row.chatId || '',
      telegramStatus: row.telegramStatus || '',
      previousTag: row.previousTag || '',
      desiredTag: row.desiredTag || '',
      result: row.result,
      source: row.source || '',
      errorCode: row.errorCode || '',
      error: row.error || '',
    })),
  };
}

module.exports = {
  MAX_TAG_CHARACTERS,
  formatTelegramMemberTag,
  hasEmoji,
  applyTelegramMemberTag,
  getTelegramMemberTagHealth,
  enqueueTelegramMemberTagSync,
  enqueueTelegramMemberTagReconcile,
  enqueueShopMemberTagSync,
  drainDueTelegramMemberTagSync,
  getTelegramMemberTagSyncSummary,
  participantAbsentError,
  rightsError,
};

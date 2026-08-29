'use strict';

const crypto = require('crypto');
const ReceiptItem = require('../models/ReceiptItem');
const AppSetting = require('../models/AppSetting');
const { normalizePhotoComments } = require('../utils/receiptPhotoMeta');
const { normalizeReceiptItemRouting } = require('../utils/receiptRouting');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');
const { withLock } = require('../utils/lock');

const NEW_PRODUCTS_GROUP_KEY = 'telegram.newProductsGroupId';
const SEND_LEASE_MS = 90 * 1000;
const MAX_ATTEMPTS = 5;
const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;

function normalizeGroupId(value) {
  const groupId = String(value ?? '').trim();
  if (!groupId) return '';
  if (!/^-?\d+$/.test(groupId)) throw new Error('telegram_new_products_group_invalid');
  return groupId;
}

async function getNewProductsGroupId() {
  const row = await AppSetting.findOne({ key: NEW_PRODUCTS_GROUP_KEY }).lean();
  return row ? normalizeGroupId(row.value) : '';
}

async function setNewProductsGroupId(value) {
  const groupId = normalizeGroupId(value);
  await AppSetting.findOneAndUpdate(
    { key: NEW_PRODUCTS_GROUP_KEY },
    { $set: { value: groupId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return groupId;
}

function stableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function displayNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(n);
}

function buildCaption(snapshot) {
  const head = [
    `Ціна: ${displayNumber(snapshot.price)} zł`,
    `Кількість: ${displayNumber(snapshot.qtyPerPackage)} шт`,
  ];
  const routeLine = String(snapshot.routeLabel || '');
  const commentsLine = Array.isArray(snapshot.comments)
    ? snapshot.comments.map((value) => String(value || '').trim()).filter(Boolean).join(', ')
    : '';

  // Telegram photo captions are limited to 1024 characters. Never let a long
  // receiving comment make the whole publication fail. Price, package quantity
  // and the business route marker have priority; only the comment portion is shortened.
  const prefix = `${head.join('\n')}${commentsLine ? '\n' : ''}`;
  const suffix = routeLine ? `\n${routeLine}` : '';
  if (!commentsLine) return `${head.join('\n')}${routeLine ? `\n${routeLine}` : ''}`
    .slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT);

  const available = Math.max(0, TELEGRAM_PHOTO_CAPTION_LIMIT - prefix.length - suffix.length);
  let renderedComment = commentsLine;
  if (renderedComment.length > available) {
    renderedComment = available <= 1
      ? renderedComment.slice(0, available)
      : `${renderedComment.slice(0, available - 1)}…`;
  }
  return `${prefix}${renderedComment}${suffix}`.slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT);
}

function buildSnapshot(item, receipt = null) {
  const routing = normalizeReceiptItemRouting(item, receipt || {});
  // The route validator forbids mayNotReachAllShops together with warehouse, so
  // these two labels cannot contradict one another in a valid current row.
  const routeLabel = routing.warehouse
    ? 'Буде на лайках'
    : (routing.mandatory && routing.mayNotReachAllShops ? 'Приїде не всім' : '');
  const comments = normalizePhotoComments(item?.photoMeta).map((row) => row.text);
  return {
    photoUrl: String(item?.originalPhotoUrl || '').trim(),
    price: stableNumber(item?.price),
    qtyPerPackage: stableNumber(item?.qtyPerPackage),
    comments,
    routeLabel,
  };
}

function hashSnapshot(snapshot) {
  // Hash the exact Bot API-visible payload, not the whole ReceiptItem. Canvas
  // positions, updatedAt and any other internal edits are therefore irrelevant.
  const payload = {
    photoUrl: String(snapshot?.photoUrl || ''),
    caption: buildCaption(snapshot || {}),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildDesired(item, receipt = null) {
  const snapshot = buildSnapshot(item, receipt);
  const caption = buildCaption(snapshot);
  return {
    snapshot,
    hash: hashSnapshot(snapshot),
    caption,
  };
}

function publicState(item, { groupId = '', desired = null } = {}) {
  const state = item?.telegramNewProduct || {};
  const wanted = desired || buildDesired(item);
  const hasMessage = Number.isFinite(Number(state.messageId)) && Number(state.messageId) > 0 && !!String(state.chatId || '');
  const persistedStatus = String(state.status || 'not_sent');
  // Legacy rows may still contain status='expired' from the removed 14-day TTL feature.
  // Treat them as normal existing publications; no time-based lifecycle exists anymore.
  const status = persistedStatus === 'expired' ? (hasMessage ? 'sent' : 'not_sent') : persistedStatus;
  const appliedHash = String(state.appliedHash || '');
  const queuedHash = String(state.desiredHash || '');
  const relevantChanged = !!appliedHash && appliedHash !== wanted.hash;
  const firstPublish = !appliedHash && !hasMessage;
  const active = ['queued', 'sending', 'retry_wait'].includes(status);
  const problem = ['failed', 'unknown'].includes(status);
  const pendingPayloadChanged = active && queuedHash !== wanted.hash;
  const lastDecisionHash = String(state.lastDecisionHash || '');
  const lastDecision = String(state.lastDecision || '');
  const alreadyDecidedForCurrent = lastDecisionHash === wanted.hash;
  // A deliberate skip is harmless for the first publication (there is no stale
  // Telegram object yet). If a post/create pipeline already exists and the
  // skipped canonical payload differs from what Telegram has/is sending, the
  // item is intentionally OUT OF SYNC. This is an attention state, not a
  // transport failure: the card may offer a situational "Sync Telegram" action.
  const skippedCurrent = lastDecision === 'skip' && alreadyDecidedForCurrent;
  const persistedTargetChatId = String(state.chatId || '');
  const createTargetAvailable = !!groupId || (active && !!persistedTargetChatId) || (status === 'unknown' && !!persistedTargetChatId);
  const canCreate = createTargetAvailable && !!wanted.snapshot.photoUrl;
  const canUpdate = hasMessage && !!wanted.snapshot.photoUrl;

  let action = 'none';
  if (status === 'unknown') action = 'unknown';
  else if (status === 'failed') action = 'failed';
  else if (active && pendingPayloadChanged) action = 'update';
  else if (active) action = status;
  else if (hasMessage && relevantChanged) action = 'update';
  else if (!hasMessage && firstPublish) action = 'publish';

  // A save performed while an older Telegram request is still in flight may
  // contain newer publication data. Ask for that newer canonical version too:
  // recordDecision() can replace a queued payload atomically, or—if sendPhoto is
  // already in flight—store the new desired hash so the worker converges by
  // editing the resulting message after the create finishes.
  const outOfSync = skippedCurrent && action === 'update';

  const shouldPrompt = !problem
    && (action === 'publish' || action === 'update')
    && !alreadyDecidedForCurrent
    && (hasMessage ? canUpdate : canCreate);

  return {
    status,
    action,
    shouldPrompt,
    configured: !!groupId,
    canPublish: hasMessage ? canUpdate : canCreate,
    hasMessage,
    hasRelevantChanges: action === 'update',
    outOfSync,
    caption: wanted.caption,
    desiredHash: wanted.hash,
    queuedHash,
    lastDecision,
    lastDecisionHash,
    lastDecisionAt: state.lastDecisionAt || null,
    lastDecisionBy: String(state.lastDecisionBy || ''),
    chatId: String(state.chatId || ''),
    messageId: Number(state.messageId) || null,
    sentAt: state.sentAt || null,
    editedAt: state.editedAt || null,
    requestedAt: state.requestedAt || null,
    lastError: state.lastError || {},
    possibleDuplicate: status === 'unknown' || !!state.possibleDuplicate,
  };
}

async function getPublicationState(receiptId, itemId) {
  const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
  if (!item) return null;
  const groupId = await getNewProductsGroupId();
  return publicState(item, { groupId });
}

async function recordDecision({ receiptId, itemId, decision, actorId = '', forceUnknownRetry = false }) {
  const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
  if (!item) return null;
  const groupId = await getNewProductsGroupId();
  const desired = buildDesired(item);
  const state = item.telegramNewProduct || {};
  const status = String(state.status || 'not_sent');
  const hasMessage = Number.isFinite(Number(state.messageId)) && Number(state.messageId) > 0 && !!String(state.chatId || '');
  if (decision === 'skip') {
    const updated = await ReceiptItem.findOneAndUpdate(
      { _id: itemId, receiptId },
      {
        $set: {
          'telegramNewProduct.lastDecision': 'skip',
          'telegramNewProduct.lastDecisionHash': desired.hash,
          'telegramNewProduct.lastDecisionAt': new Date(),
          'telegramNewProduct.lastDecisionBy': String(actorId || ''),
        },
      },
      { new: true },
    ).lean();
    return publicState(updated, { groupId, desired });
  }

  if (decision !== 'publish') throw new Error('telegram_new_products_decision_invalid');
  if (!desired.snapshot.photoUrl) throw new Error('telegram_new_products_original_photo_missing');
  if (status === 'unknown' && !forceUnknownRetry) {
    throw new Error('telegram_new_products_delivery_unknown');
  }

  // Once a live message exists it stays tied to its original chat. While a first
  // create is already queued/sending/ambiguous we also keep that persisted target.
  // A failed create has no live Telegram object, so after an admin fixes Settings
  // a manual retry is allowed to use the new configured group.
  const keepPersistedTarget = hasMessage || ['queued', 'sending', 'retry_wait', 'unknown'].includes(status);
  const targetChatId = keepPersistedTarget ? String(state.chatId || '') : String(groupId || '');
  if (!targetChatId) throw new Error('telegram_new_products_group_not_configured');

  const now = new Date();
  const decisionFields = {
    'telegramNewProduct.lastDecision': 'publish',
    'telegramNewProduct.lastDecisionHash': desired.hash,
    'telegramNewProduct.lastDecisionAt': now,
    'telegramNewProduct.lastDecisionBy': String(actorId || ''),
  };

  // Pure idempotency: if Telegram already has exactly this canonical payload,
  // only remember the decision. Never write status='sent' here: a concurrent
  // worker may already be sending a newer version and must not be cancelled by
  // a stale second click from another tab.
  if (String(state.appliedHash || '') === desired.hash && hasMessage) {
    const updated = await ReceiptItem.findOneAndUpdate(
      { _id: itemId, receiptId },
      { $set: decisionFields },
      { new: true },
    ).lean();
    return publicState(updated, { groupId, desired });
  }

  const queueFields = {
    ...decisionFields,
    'telegramNewProduct.status': 'queued',
    'telegramNewProduct.chatId': targetChatId,
    'telegramNewProduct.desiredHash': desired.hash,
    'telegramNewProduct.desiredSnapshot': desired.snapshot,
    'telegramNewProduct.desiredCaption': desired.caption,
    'telegramNewProduct.requestedAt': now,
    'telegramNewProduct.requestedBy': String(actorId || ''),
    'telegramNewProduct.nextAttemptAt': now,
    'telegramNewProduct.leaseUntil': null,
    'telegramNewProduct.attempts': 0,
    ...(forceUnknownRetry ? { 'telegramNewProduct.possibleDuplicate': true } : {}),
    'telegramNewProduct.lastError': {},
  };

  // Critical race guard: never turn an atomically claimed `sending` row back into
  // `queued`. Two tabs can click Publish at the same time; whichever operation
  // loses the race to the worker may update only the DESIRED payload while the
  // current Bot API call remains in flight. markSuccess() will then notice that
  // desiredHash changed and queue exactly one converging edit.
  let updated = await ReceiptItem.findOneAndUpdate(
    { _id: itemId, receiptId, 'telegramNewProduct.status': { $ne: 'sending' } },
    { $set: queueFields },
    { new: true },
  ).lean();

  if (!updated) {
    updated = await ReceiptItem.findOneAndUpdate(
      { _id: itemId, receiptId, 'telegramNewProduct.status': 'sending' },
      {
        $set: {
          ...decisionFields,
          'telegramNewProduct.desiredHash': desired.hash,
          'telegramNewProduct.desiredSnapshot': desired.snapshot,
          'telegramNewProduct.desiredCaption': desired.caption,
          'telegramNewProduct.requestedAt': now,
          'telegramNewProduct.requestedBy': String(actorId || ''),
        },
      },
      { new: true },
    ).lean();
  }

  // The worker may have completed between the two atomic updates above. Re-read
  // rather than manufacturing state from the stale pre-decision document.
  if (!updated) updated = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
  return publicState(updated, { groupId, desired });
}

async function recoverExpiredSending(now = new Date()) {
  const expired = await ReceiptItem.find({
    'telegramNewProduct.status': 'sending',
    'telegramNewProduct.leaseUntil': { $lte: now },
  }, '_id telegramNewProduct').limit(50).lean();

  for (const item of expired) {
    const state = item.telegramNewProduct || {};
    const hasMessage = Number.isFinite(Number(state.messageId)) && Number(state.messageId) > 0;
    if (hasMessage) {
      // editMessageCaption/editMessageMedia are safe to retry for the same target.
      await ReceiptItem.updateOne(
        { _id: item._id, 'telegramNewProduct.status': 'sending', 'telegramNewProduct.leaseUntil': { $lte: now } },
        { $set: { 'telegramNewProduct.status': 'queued', 'telegramNewProduct.nextAttemptAt': now, 'telegramNewProduct.leaseUntil': null } },
      );
    } else {
      // A crashed/timed-out create may already exist in Telegram, but Bot API has
      // no client idempotency key or history lookup. Never blind-resend it.
      await ReceiptItem.updateOne(
        { _id: item._id, 'telegramNewProduct.status': 'sending', 'telegramNewProduct.leaseUntil': { $lte: now } },
        {
          $set: {
            'telegramNewProduct.status': 'unknown',
            'telegramNewProduct.possibleDuplicate': true,
            'telegramNewProduct.leaseUntil': null,
            'telegramNewProduct.nextAttemptAt': null,
            'telegramNewProduct.lastError': {
              at: now,
              description: 'Процес завершився під час створення повідомлення; результат Telegram невідомий',
              ambiguous: true,
            },
          },
        },
      );
    }
  }
}

async function claimDue(now = new Date()) {
  return ReceiptItem.findOneAndUpdate(
    {
      'telegramNewProduct.status': { $in: ['queued', 'retry_wait'] },
      'telegramNewProduct.nextAttemptAt': { $lte: now },
      'telegramNewProduct.desiredHash': { $nin: ['', null] },
      'telegramNewProduct.chatId': { $nin: ['', null] },
    },
    {
      $set: {
        'telegramNewProduct.status': 'sending',
        'telegramNewProduct.lastAttemptAt': now,
        'telegramNewProduct.leaseUntil': new Date(now.getTime() + SEND_LEASE_MS),
      },
      $inc: { 'telegramNewProduct.attempts': 1 },
    },
    { sort: { 'telegramNewProduct.nextAttemptAt': 1, updatedAt: 1 }, new: true },
  ).lean();
}

function telegramPhotoFileId(message) {
  const rows = Array.isArray(message?.photo) ? message.photo : [];
  return String(rows[rows.length - 1]?.file_id || '');
}

async function markSuccess(item, sentHash, sentSnapshot, sentCaption, message, operation, now = new Date()) {
  const messageId = Number(message?.message_id) || Number(item.telegramNewProduct?.messageId) || null;
  const chatId = String(item.telegramNewProduct?.chatId || '');
  const fileId = telegramPhotoFileId(message) || String(item.telegramNewProduct?.telegramPhotoFileId || '');
  const common = {
    'telegramNewProduct.appliedHash': sentHash,
    'telegramNewProduct.appliedSnapshot': sentSnapshot,
    'telegramNewProduct.appliedCaption': sentCaption,
    'telegramNewProduct.messageId': messageId,
    'telegramNewProduct.chatId': chatId,
    'telegramNewProduct.telegramPhotoFileId': fileId,
    'telegramNewProduct.leaseUntil': null,
    'telegramNewProduct.nextAttemptAt': null,
    'telegramNewProduct.lastError': {},
    'telegramNewProduct.possibleDuplicate': !!item.telegramNewProduct?.possibleDuplicate,
  };
  if (operation === 'create') common['telegramNewProduct.sentAt'] = now;
  else common['telegramNewProduct.editedAt'] = now;

  const exact = await ReceiptItem.updateOne(
    { _id: item._id, 'telegramNewProduct.desiredHash': sentHash },
    { $set: { ...common, 'telegramNewProduct.status': 'sent' } },
  );
  if (exact.modifiedCount > 0) return;

  // Desired data changed while this request was in flight. Preserve the newer
  // desired payload and immediately queue one converging update.
  await ReceiptItem.updateOne(
    { _id: item._id },
    {
      $set: {
        ...common,
        'telegramNewProduct.status': 'queued',
        'telegramNewProduct.nextAttemptAt': now,
      },
    },
  );
}

async function markFailure(item, error, operation, now = new Date()) {
  const classification = classifyTelegramSendError(error);
  const attempts = Number(item.telegramNewProduct?.attempts || 1);
  const lastError = {
    at: now,
    statusCode: classification.statusCode,
    libraryCode: classification.libraryCode,
    description: classification.description,
    retryable: classification.retryable,
    ambiguous: classification.ambiguous,
  };

  // Creating a Telegram message is not idempotent. For an ambiguous network/5xx
  // failure we stop instead of risking a duplicate. A 429 is explicit rejection,
  // therefore it is safe to retry. Updates target a known message_id and are safe
  // to retry after transient transport failures.
  if (operation === 'create' && classification.ambiguous && !classification.rateLimited) {
    await ReceiptItem.updateOne({ _id: item._id }, {
      $set: {
        'telegramNewProduct.status': 'unknown',
        'telegramNewProduct.possibleDuplicate': true,
        'telegramNewProduct.leaseUntil': null,
        'telegramNewProduct.nextAttemptAt': null,
        'telegramNewProduct.lastError': lastError,
      },
    });
    return;
  }

  const canRetry = classification.rateLimited
    || (classification.retryable && attempts < MAX_ATTEMPTS);
  await ReceiptItem.updateOne({ _id: item._id }, {
    $set: {
      'telegramNewProduct.status': canRetry ? 'retry_wait' : 'failed',
      'telegramNewProduct.nextAttemptAt': canRetry
        ? new Date(now.getTime() + retryDelayMs(classification, attempts))
        : null,
      'telegramNewProduct.leaseUntil': null,
      'telegramNewProduct.lastError': lastError,
    },
  });
}

async function sendClaimed(item) {
  const state = item.telegramNewProduct || {};
  const snapshot = state.desiredSnapshot || {};
  const caption = String(state.desiredCaption || buildCaption(snapshot));
  const sentHash = String(state.desiredHash || '');
  const chatId = String(state.chatId || '');
  const messageId = Number(state.messageId) || null;
  const operation = messageId ? 'update' : 'create';
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    const error = new Error('telegram bot is not initialized');
    await markFailure(item, error, operation);
    return { sent: false, operation };
  }

  try {
    let message;
    if (!messageId) {
      message = await bot.sendPhoto(chatId, snapshot.photoUrl, { caption });
    } else {
      const appliedPhotoUrl = String(state.appliedSnapshot?.photoUrl || '');
      if (appliedPhotoUrl !== String(snapshot.photoUrl || '')) {
        message = await bot.editMessageMedia(
          { type: 'photo', media: snapshot.photoUrl, caption },
          { chat_id: chatId, message_id: messageId },
        );
      } else {
        message = await bot.editMessageCaption(caption, { chat_id: chatId, message_id: messageId });
      }
    }
    await markSuccess(item, sentHash, snapshot, caption, message, operation, new Date());
    return { sent: true, operation };
  } catch (error) {
    await markFailure(item, error, operation, new Date());
    return { sent: false, operation };
  }
}

async function drainDueReceiptNewProductPublications({ limit = 20 } = {}) {
  return withLock('telegram:delivery:send-lane', async () => {
    await recoverExpiredSending(new Date());
    let processed = 0;
    let sent = 0;
    while (processed < limit) {
      const item = await claimDue(new Date());
      if (!item) break;
      const result = await sendClaimed(item);
      processed += 1;
      if (result.sent) sent += 1;
    }
    return { processed, sent };
  }, { ttlMs: 10 * 60 * 1000, waitMs: 1_000 });
}

module.exports = {
  NEW_PRODUCTS_GROUP_KEY,
  SEND_LEASE_MS,
  MAX_ATTEMPTS,
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  getNewProductsGroupId,
  setNewProductsGroupId,
  buildSnapshot,
  buildDesired,
  buildCaption,
  hashSnapshot,
  publicState,
  getPublicationState,
  recordDecision,
  recoverExpiredSending,
  drainDueReceiptNewProductPublications,
};

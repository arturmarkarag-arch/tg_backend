'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ReceiptItem = require('../models/ReceiptItem');
const Receipt = require('../models/Receipt');
const AppSetting = require('../models/AppSetting');
const TelegramDestination = require('../models/TelegramDestination');
const TelegramPublication = require('../models/TelegramPublication');
const TelegramPublicationBinding = require('../models/TelegramPublicationBinding');
const TelegramPublicationEvent = require('../models/TelegramPublicationEvent');
const TelegramMessageCleanup = require('../models/TelegramMessageCleanup');
const { normalizePhotoComments } = require('../utils/receiptPhotoMeta');
const { normalizeReceiptItemRouting } = require('../utils/receiptRouting');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');
const { withLock } = require('../utils/lock');
const { formatCompactDecimal } = require('../utils/decimalDisplay');
const {
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TELEGRAM_DELIVERY_LANE_TTL_MS,
  telegramBatchBudgetExceeded,
} = require('../utils/telegramTransportPolicy');

const NEW_PRODUCTS_GROUP_KEY = 'telegram.newProductsGroupId'; // legacy mirror only
const NEW_PRODUCTS_DESTINATION_KEY = 'new_products';
const SEND_LEASE_MS = 90 * 1000;
const ITEM_LOCK_TTL_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const TELEGRAM_PHOTO_CAPTION_LIMIT = 1024;

function normalizeGroupId(value) {
  const groupId = String(value ?? '').trim();
  if (!groupId) return '';
  if (!/^-?\d+$/.test(groupId)) throw new Error('telegram_new_products_group_invalid');
  return groupId;
}

function sessionQuery(query, session) {
  return session ? query.session(session) : query;
}

async function appendEvent(payload, { session = null } = {}) {
  const doc = {
    destinationKey: NEW_PRODUCTS_DESTINATION_KEY,
    ...payload,
  };
  if (session) {
    const [created] = await TelegramPublicationEvent.create([doc], { session });
    return created;
  }
  return TelegramPublicationEvent.create(doc);
}

async function runMongoTransaction(fn) {
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    session.endSession();
  }
}

function disabledGroupHealth(groupId = '') {
  return {
    ok: false,
    enabled: false,
    groupId: String(groupId || ''),
    code: 'not_configured',
    checkedAt: new Date().toISOString(),
  };
}

const CREATE_BLOCKING_DESTINATION_HEALTH = new Set([
  'bot_unavailable',
  'forbidden',
  'unauthorized',
  'chat_not_found',
  'missing_post_permission',
]);

function destinationCreateHealthBlocked(destination, targetChatId = '') {
  const currentChatId = String(destination?.chatId || '');
  const target = String(targetChatId || currentChatId);
  if (!destination?.enabled || !currentChatId || !target || target !== currentChatId) return false;
  return CREATE_BLOCKING_DESTINATION_HEALTH.has(String(destination?.healthCode || ''));
}

async function resumeDestinationHealthPausedCreates(groupId) {
  const chatId = String(groupId || '');
  if (!chatId) return 0;
  const result = await TelegramPublication.updateMany(
    {
      sourceState: 'confirmed',
      status: 'queued',
      targetChatId: chatId,
      nextAttemptAt: null,
      'lastError.kind': 'destination_unhealthy',
    },
    { $set: { nextAttemptAt: new Date(), lastError: {} } },
  );
  return Number(result.modifiedCount || 0);
}

async function ensureDestination({ session = null } = {}) {
  let row = await sessionQuery(
    TelegramDestination.findOne({ key: NEW_PRODUCTS_DESTINATION_KEY }),
    session,
  ).lean();
  if (row) return row;

  const legacy = await sessionQuery(AppSetting.findOne({ key: NEW_PRODUCTS_GROUP_KEY }), session).lean();
  const chatId = legacy ? normalizeGroupId(legacy.value) : '';
  const now = new Date();
  try {
    const payload = {
      key: NEW_PRODUCTS_DESTINATION_KEY,
      chatId,
      enabled: !!chatId,
      healthCode: chatId ? 'not_checked' : 'not_configured',
      changedAt: now,
      migratedFromAppSettingAt: now,
    };
    if (session) {
      const [created] = await TelegramDestination.create([payload], { session });
      row = created.toObject();
    } else {
      row = (await TelegramDestination.create(payload)).toObject();
    }
    await appendEvent({
      sourceType: 'telegram_destination',
      sourceId: NEW_PRODUCTS_DESTINATION_KEY,
      eventType: 'destination_migrated',
      operation: 'config',
      actorType: 'system',
      chatId,
      details: { legacyKey: NEW_PRODUCTS_GROUP_KEY },
    }, { session });
    return row;
  } catch (error) {
    if (Number(error?.code) === 11000) {
      return sessionQuery(TelegramDestination.findOne({ key: NEW_PRODUCTS_DESTINATION_KEY }), session).lean();
    }
    throw error;
  }
}

async function getNewProductsDestination() {
  return ensureDestination();
}

async function getNewProductsGroupId() {
  const row = await ensureDestination();
  return row?.enabled ? normalizeGroupId(row.chatId) : '';
}

async function inspectNewProductsGroup(value, { persist = true } = {}) {
  const groupId = normalizeGroupId(value);
  if (!groupId) return disabledGroupHealth();
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  let health;
  if (!bot) {
    health = { ...disabledGroupHealth(groupId), enabled: true, code: 'bot_unavailable' };
  } else {
    try {
      const [chat, me] = await Promise.all([bot.getChat(groupId), bot.getMe()]);
      const member = await bot.getChatMember(groupId, me.id);
      const status = String(member?.status || '');
      const isAdmin = status === 'creator' || status === 'administrator';
      const channel = String(chat?.type || '') === 'channel';
      const canPost = isAdmin && (!channel || status === 'creator' || member?.can_post_messages === true);
      const canEdit = status === 'creator' || member?.can_edit_messages === true;
      // deleteMessage can remove the bot's own outgoing channel posts when it
      // can post there; can_delete_messages is only needed for broader deletion.
      const canDelete = canPost || status === 'creator' || member?.can_delete_messages === true;
      health = {
        ok: canPost,
        enabled: true,
        groupId,
        title: String(chat?.title || chat?.username || groupId),
        type: String(chat?.type || ''),
        botStatus: status,
        canPost,
        canEdit,
        canDelete,
        code: canPost ? 'ok' : 'missing_post_permission',
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const classification = classifyTelegramSendError(error);
      health = {
        ok: false,
        enabled: true,
        groupId,
        code: classification.kind,
        description: classification.description,
        statusCode: classification.statusCode,
        migrateToChatId: classification.migrateToChatId,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  if (persist) {
    await TelegramDestination.updateOne(
      { key: NEW_PRODUCTS_DESTINATION_KEY, chatId: groupId },
      {
        $set: {
          title: String(health.title || ''),
          chatType: String(health.type || ''),
          botStatus: String(health.botStatus || ''),
          canPost: health.canPost === true,
          canEdit: health.canEdit === true,
          canDelete: health.canDelete === true,
          healthCode: String(health.code || ''),
          healthDescription: String(health.description || ''),
          lastHealthCheckAt: new Date(),
        },
      },
    );
    if (health.ok) await resumeDestinationHealthPausedCreates(groupId);
  }
  return health;
}

async function setNewProductsGroupId(value, { actorId = '' } = {}) {
  const groupId = normalizeGroupId(value);
  const health = groupId ? await inspectNewProductsGroup(groupId, { persist: false }) : disabledGroupHealth();
  if (groupId && !health.ok) {
    const error = new Error('telegram_new_products_group_unavailable');
    error.health = health;
    throw error;
  }

  const mongoSession = await mongoose.connection.startSession();
  try {
    let result = null;
    await mongoSession.withTransaction(async () => {
      const current = await ensureDestination({ session: mongoSession });
      const previousGroupId = String(current?.chatId || '');
      const changed = previousGroupId !== groupId || Boolean(current?.enabled) !== Boolean(groupId);
      const now = new Date();

      const destination = await TelegramDestination.findOneAndUpdate(
        { key: NEW_PRODUCTS_DESTINATION_KEY },
        {
          $set: {
            chatId: groupId,
            enabled: !!groupId,
            title: String(health.title || ''),
            chatType: String(health.type || ''),
            botStatus: String(health.botStatus || ''),
            canPost: health.canPost === true,
            canEdit: health.canEdit === true,
            canDelete: health.canDelete === true,
            healthCode: String(health.code || (groupId ? 'ok' : 'not_configured')),
            healthDescription: String(health.description || ''),
            lastHealthCheckAt: groupId ? now : null,
            changedAt: changed ? now : current?.changedAt || now,
            changedBy: changed ? String(actorId || '') : String(current?.changedBy || ''),
          },
          ...(changed ? { $inc: { configRevision: 1 } } : {}),
        },
        { new: true, session: mongoSession },
      ).lean();

      // Legacy compatibility mirror. It is no longer read by the lifecycle.
      await AppSetting.findOneAndUpdate(
        { key: NEW_PRODUCTS_GROUP_KEY },
        { $set: { value: groupId } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session: mongoSession },
      );

      // Only unsent CREATE work may move to a newly configured destination.
      // A live message/update remains bound to the chat where that physical
      // Telegram message actually exists. A prepared create after a semantic
      // rejection/429 is also safe to retarget because it has no message_id.
      let retargetedCount = 0;
      if (groupId && groupId !== previousGroupId) {
        const candidates = await TelegramPublication.find({
          destinationKey: NEW_PRODUCTS_DESTINATION_KEY,
          status: { $in: ['queued', 'retry_wait'] },
          targetChatId: { $ne: groupId },
        }).session(mongoSession).lean();
        for (const publication of candidates) {
          let safeToRetarget = !publication.currentBindingId;
          let binding = null;
          if (publication.currentBindingId) {
            binding = await TelegramPublicationBinding.findById(publication.currentBindingId).session(mongoSession).lean();
            safeToRetarget = binding?.state === 'creating' && !Number(binding?.messageId);
          }
          if (!safeToRetarget) continue;
          await TelegramPublication.updateOne(
            { _id: publication._id },
            { $set: { targetChatId: groupId, targetConfigRevision: Number(destination?.configRevision || 0) } },
            { session: mongoSession },
          );
          if (binding) {
            await TelegramPublicationBinding.updateOne(
              { _id: binding._id, state: 'creating', messageId: null },
              { $set: { chatId: groupId, destinationConfigRevision: Number(destination?.configRevision || 0) } },
              { session: mongoSession },
            );
          }
          retargetedCount += 1;
        }
      }

      if (changed) {
        await appendEvent({
          sourceType: 'telegram_destination',
          sourceId: NEW_PRODUCTS_DESTINATION_KEY,
          eventType: groupId ? 'destination_changed' : 'destination_disabled',
          operation: 'config',
          actorType: actorId ? 'user' : 'system',
          actorId: String(actorId || ''),
          chatId: groupId,
          details: { previousGroupId, groupId, retargetedCount, configRevision: destination?.configRevision || 0 },
        }, { session: mongoSession });
      }
      result = { groupId, health, previousGroupId, retargetedCount, configRevision: destination?.configRevision || 0 };
    });
    if (groupId && health.ok) await resumeDestinationHealthPausedCreates(groupId);
    return result;
  } finally {
    mongoSession.endSession();
  }
}

async function handleNewProductsMyChatMember(update) {
  const payload = update?.my_chat_member || update || {};
  const chatId = String(payload.chat?.id || payload.chat_id || '');
  if (!chatId) return false;

  const destination = await ensureDestination();
  const affectedBindings = await TelegramPublicationBinding.find({
    chatId,
    state: { $in: ['live', 'unknown', 'manual_required', 'creating'] },
  }).select('_id publicationId sourceId receiptId generation messageId payloadHash').lean();
  const isCurrentDestination = destination?.enabled && String(destination.chatId || '') === chatId;
  if (!isCurrentDestination && affectedBindings.length === 0) return false;

  const member = payload.new_chat_member || {};
  const status = String(member.status || payload.new_chat_member_status || '');
  const isAdmin = status === 'creator' || status === 'administrator';
  const channel = String(payload.chat?.type || '') === 'channel';
  const canPost = isAdmin && (!channel || status === 'creator' || member.can_post_messages === true);
  const canEdit = status === 'creator' || member.can_edit_messages === true;
  const canDelete = canPost || status === 'creator' || member.can_delete_messages === true;
  const removed = ['kicked', 'left'].includes(status);
  const code = removed ? 'forbidden' : (canPost ? 'ok' : 'missing_post_permission');
  const now = new Date();

  if (isCurrentDestination) {
    await TelegramDestination.updateOne(
      { key: NEW_PRODUCTS_DESTINATION_KEY, chatId },
      {
        $set: {
          botStatus: status,
          canPost,
          canEdit,
          canDelete,
          healthCode: code,
          healthDescription: removed ? 'Бота видалено з Telegram-групи' : '',
          lastMembershipEventAt: now,
          lastHealthCheckAt: now,
        },
      },
    );
    if (canPost) await resumeDestinationHealthPausedCreates(chatId);
  }

  if (affectedBindings.length) {
    await TelegramPublicationBinding.updateMany(
      { _id: { $in: affectedBindings.map((row) => row._id) } },
      { $set: { accessCode: code, canEdit, canDelete, lastMembershipEventAt: now } },
    );
    await TelegramPublicationEvent.insertMany(affectedBindings.map((binding) => ({
      publicationId: binding.publicationId,
      bindingId: binding._id,
      destinationKey: NEW_PRODUCTS_DESTINATION_KEY,
      sourceType: 'receipt_new_product',
      sourceId: String(binding.sourceId || ''),
      receiptId: String(binding.receiptId || ''),
      eventType: 'binding_membership_changed',
      operation: 'membership',
      actorType: 'telegram',
      chatId,
      messageId: Number(binding.messageId) || null,
      generation: Number(binding.generation) || null,
      payloadHash: String(binding.payloadHash || ''),
      details: { status, canPost, canEdit, canDelete, isCurrentDestination },
    })));
  }

  await appendEvent({
    sourceType: 'telegram_destination',
    sourceId: NEW_PRODUCTS_DESTINATION_KEY,
    eventType: 'telegram_chat_membership_changed',
    operation: 'membership',
    actorType: 'telegram',
    chatId,
    details: { status, canPost, canEdit, canDelete, isCurrentDestination, affectedBindingCount: affectedBindings.length },
  });
  return true;
}

function stableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function displayNumber(value) {
  return formatCompactDecimal(value, '');
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
  const prefix = `${head.join('\n')}${commentsLine ? '\n' : ''}`;
  const suffix = routeLine ? `\n${routeLine}` : '';
  if (!commentsLine) return `${head.join('\n')}${routeLine ? `\n${routeLine}` : ''}`.slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT);
  const available = Math.max(0, TELEGRAM_PHOTO_CAPTION_LIMIT - prefix.length - suffix.length);
  let renderedComment = commentsLine;
  if (renderedComment.length > available) {
    renderedComment = available <= 1 ? renderedComment.slice(0, available) : `${renderedComment.slice(0, available - 1)}…`;
  }
  return `${prefix}${renderedComment}${suffix}`.slice(0, TELEGRAM_PHOTO_CAPTION_LIMIT);
}

function buildSnapshot(item, receipt = null) {
  const routing = normalizeReceiptItemRouting(item, receipt || {});
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
    // Full business route participates in synchronization even when the compact
    // Telegram caption intentionally renders the same human label.
    routeSignature: {
      warehouse: routing.warehouse === true,
      mandatory: routing.mandatory === true,
      supplement: routing.supplement === true,
      mayNotReachAllShops: routing.mayNotReachAllShops === true,
      supplementDeliveryGroupId: String(routing.supplementDeliveryGroupId || ''),
    },
  };
}

function hashSnapshot(snapshot) {
  const payload = {
    photoUrl: String(snapshot?.photoUrl || ''),
    caption: buildCaption(snapshot || {}),
    routeSignature: snapshot?.routeSignature || {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildDesired(item, receipt = null) {
  const snapshot = buildSnapshot(item, receipt);
  return { snapshot, hash: hashSnapshot(snapshot), caption: buildCaption(snapshot) };
}

async function buildDesiredForItem(item) {
  if (Number(item?.routingVersion || 0) >= 1) return buildDesired(item);
  const receiptId = String(item?.receiptId || '');
  if (!receiptId) return buildDesired(item);
  const receipt = await Receipt.findById(receiptId).select('type targetDeliveryGroupId').lean();
  return buildDesired(item, receipt || null);
}

function normalizeLegacyStatus(state = {}) {
  const raw = String(state.status || 'not_sent');
  if (raw !== 'expired') return raw;
  return Number(state.messageId) > 0 ? 'sent' : 'not_sent';
}

function normalizeLegacyMigrationState(legacy = {}) {
  const status = normalizeLegacyStatus(legacy);
  if (status !== 'sending') {
    return {
      status,
      nextAttemptAt: legacy.nextAttemptAt || null,
      leaseUntil: legacy.leaseUntil || null,
      possibleDuplicate: legacy.possibleDuplicate === true || status === 'unknown',
    };
  }

  // After a process restart the old in-flight request can no longer be observed.
  // Known message_id => it was an UPDATE and can be retried safely.
  // No message_id => it was a CREATE and Telegram may already have accepted it.
  if (Number(legacy.messageId) > 0 && String(legacy.chatId || '')) {
    return {
      status: 'retry_wait',
      nextAttemptAt: new Date(),
      leaseUntil: null,
      possibleDuplicate: legacy.possibleDuplicate === true,
    };
  }

  return {
    status: 'unknown',
    nextAttemptAt: null,
    leaseUntil: null,
    possibleDuplicate: true,
  };
}

async function createLegacyBindings(publication, item, legacy, { session = null } = {}) {
  const status = String(publication?.status || normalizeLegacyStatus(legacy));
  const chatId = String(legacy.chatId || '');
  const messageId = Number(legacy.messageId) || null;
  const hasKnown = !!chatId && !!messageId;
  const possibleDuplicate = publication?.possibleDuplicate === true || legacy.possibleDuplicate === true;
  let generation = 0;
  let currentBinding = null;

  const createOne = async (data) => {
    generation += 1;
    const payload = {
      publicationId: publication._id,
      sourceId: String(item._id),
      receiptId: String(item.receiptId || ''),
      generation,
      chatId: data.chatId,
      destinationConfigRevision: 0,
      messageId: data.messageId ?? null,
      state: data.state,
      telegramPhotoFileId: data.fileId || '',
      payloadHash: data.hash || '',
      snapshot: data.snapshot || null,
      caption: data.caption || '',
      createAttemptAt: legacy.requestedAt || item.createdAt || new Date(),
      confirmedAt: data.messageId ? (legacy.sentAt || item.updatedAt || new Date()) : null,
      unknownAt: data.state === 'unknown' ? (legacy.lastAttemptAt || item.updatedAt || new Date()) : null,
      missingAt: data.state === 'missing' ? (legacy.missingAt || item.updatedAt || new Date()) : null,
      lastError: legacy.lastError || {},
    };
    let created;
    if (session) [created] = await TelegramPublicationBinding.create([payload], { session });
    else created = await TelegramPublicationBinding.create(payload);
    return created;
  };

  if (possibleDuplicate && hasKnown) {
    await createOne({
      chatId,
      messageId: null,
      state: 'unknown',
      hash: String(legacy.appliedHash || legacy.desiredHash || ''),
      snapshot: legacy.appliedSnapshot || legacy.desiredSnapshot || null,
      caption: String(legacy.appliedCaption || legacy.desiredCaption || ''),
    });
  }

  if (status === 'unknown' && chatId) {
    currentBinding = await createOne({
      chatId,
      messageId: null,
      state: 'unknown',
      hash: String(legacy.desiredHash || ''),
      snapshot: legacy.desiredSnapshot || null,
      caption: String(legacy.desiredCaption || ''),
    });
  } else if (hasKnown) {
    currentBinding = await createOne({
      chatId,
      messageId,
      state: status === 'missing' ? 'missing' : 'live',
      fileId: String(legacy.telegramPhotoFileId || ''),
      hash: String(legacy.appliedHash || ''),
      snapshot: legacy.appliedSnapshot || null,
      caption: String(legacy.appliedCaption || ''),
    });
  }

  if (generation || currentBinding) {
    await TelegramPublication.updateOne(
      { _id: publication._id },
      {
        $set: {
          generation,
          currentBindingId: currentBinding?._id || null,
          unresolvedBindingCount: 0,
          possibleDuplicate: possibleDuplicate || status === 'unknown',
        },
      },
      session ? { session } : undefined,
    );
    await refreshUnresolvedBindingCount(publication._id, { session });
  }
}

async function legacyMigrationNeedsBindings(legacy = {}) {
  const migration = normalizeLegacyMigrationState(legacy);
  const chatId = String(legacy.chatId || '');
  const hasKnown = !!chatId && Number(legacy.messageId) > 0;
  return (migration.status === 'unknown' && !!chatId)
    || hasKnown
    || (migration.possibleDuplicate === true && hasKnown);
}

async function ensurePublicationForItem(item, { session = null } = {}) {
  const sourceId = String(item?._id || '');
  if (!sourceId) return null;
  let publication = await sessionQuery(
    TelegramPublication.findOne({ sourceType: 'receipt_new_product', sourceId }),
    session,
  ).lean();

  // First-time legacy migration is one atomic unit. A Publication document must
  // never become a false marker that migration completed before its Bindings/Event.
  if (!publication && !session) {
    const mongoSession = await mongoose.startSession();
    try {
      let result = null;
      await mongoSession.withTransaction(async () => {
        result = await ensurePublicationForItem(item, { session: mongoSession });
      });
      return result;
    } catch (error) {
      // Another instance may have won the unique sourceId race while this
      // transaction was starting. Its committed migration is authoritative.
      if (Number(error?.code) === 11000) {
        return TelegramPublication.findOne({ sourceType: 'receipt_new_product', sourceId }).lean();
      }
      throw error;
    } finally {
      mongoSession.endSession();
    }
  }

  if (publication) {
    const legacy = item.telegramNewProduct || {};
    const expectedSourceState = item.status === 'confirmed' ? 'confirmed' : 'draft';
    const needsLegacyRepair = !!publication.legacyMigratedAt
      && Number(publication.generation || 0) === 0
      && await legacyMigrationNeedsBindings(legacy);

    // Repair a partial migration left by an older process/version. When called
    // outside a transaction, re-enter through one so Bindings + Event commit together.
    if (needsLegacyRepair && !session) {
      const mongoSession = await mongoose.startSession();
      try {
        let result = null;
        await mongoSession.withTransaction(async () => {
          result = await ensurePublicationForItem(item, { session: mongoSession });
        });
        return result;
      } finally {
        mongoSession.endSession();
      }
    }

    if (needsLegacyRepair) {
      await createLegacyBindings(publication, item, legacy, { session });
      await appendEvent({
        publicationId: publication._id,
        sourceId,
        receiptId: String(item.receiptId || publication.receiptId || ''),
        eventType: 'publication_migration_repaired',
        operation: 'migration',
        actorType: 'system',
        fromStatus: String(publication.status || ''),
        toStatus: String(publication.status || ''),
        details: { repairedPartialLegacyMigration: true },
      }, { session });
      publication = await sessionQuery(TelegramPublication.findById(publication._id), session).lean();
    }

    if (publication.sourceState !== expectedSourceState && publication.sourceState !== 'deleted') {
      const previousSourceState = publication.sourceState;
      await TelegramPublication.updateOne(
        { _id: publication._id },
        { $set: { sourceState: expectedSourceState } },
        session ? { session } : undefined,
      );
      await appendEvent({
        publicationId: publication._id,
        sourceId,
        receiptId: String(item.receiptId || publication.receiptId || ''),
        eventType: 'source_state_reconciled',
        operation: 'source_sync',
        actorType: 'system',
        fromStatus: previousSourceState,
        toStatus: expectedSourceState,
        details: { receiptItemStatus: item.status },
      }, { session });
      publication = { ...publication, sourceState: expectedSourceState };
    }
    return publication;
  }

  const legacy = item.telegramNewProduct || {};
  const legacyMigration = normalizeLegacyMigrationState(legacy);
  const legacyStatus = legacyMigration.status;
  const now = new Date();
  const payload = {
    sourceType: 'receipt_new_product',
    sourceId,
    receiptId: String(item.receiptId || ''),
    destinationKey: NEW_PRODUCTS_DESTINATION_KEY,
    status: legacyStatus,
    sourceState: item.status === 'confirmed' ? 'confirmed' : 'draft',
    targetChatId: String(legacy.chatId || ''),
    targetConfigRevision: 0,
    desiredHash: String(legacy.desiredHash || ''),
    desiredSnapshot: legacy.desiredSnapshot || null,
    desiredCaption: String(legacy.desiredCaption || ''),
    appliedHash: String(legacy.appliedHash || ''),
    appliedSnapshot: legacy.appliedSnapshot || null,
    appliedCaption: String(legacy.appliedCaption || ''),
    requestedAt: legacy.requestedAt || null,
    requestedBy: String(legacy.requestedBy || ''),
    sentAt: legacy.sentAt || null,
    editedAt: legacy.editedAt || null,
    missingAt: legacy.missingAt || null,
    attempts: Number(legacy.attempts || 0),
    nextAttemptAt: legacyMigration.nextAttemptAt,
    leaseUntil: legacyMigration.leaseUntil,
    lastAttemptAt: legacy.lastAttemptAt || null,
    lastError: legacy.lastError || {},
    lastDecision: String(legacy.lastDecision || ''),
    lastDecisionHash: String(legacy.lastDecisionHash || ''),
    lastDecisionAt: legacy.lastDecisionAt || null,
    lastDecisionBy: String(legacy.lastDecisionBy || ''),
    possibleDuplicate: legacyMigration.possibleDuplicate,
    legacyMigratedAt: now,
  };

  try {
    let created;
    if (session) [created] = await TelegramPublication.create([payload], { session });
    else created = await TelegramPublication.create(payload);
    publication = created.toObject();
    await createLegacyBindings(publication, item, legacy, { session });
    await appendEvent({
      publicationId: publication._id,
      sourceId,
      receiptId: String(item.receiptId || ''),
      eventType: 'publication_migrated',
      operation: 'migration',
      actorType: 'system',
      fromStatus: legacyStatus,
      toStatus: legacyStatus,
      details: { fromEmbeddedReceiptItem: true, legacyRawStatus: String(legacy.status || 'not_sent'), migratedStatus: legacyStatus },
    }, { session });
    return sessionQuery(TelegramPublication.findById(publication._id), session).lean();
  } catch (error) {
    if (Number(error?.code) === 11000) {
      if (session) throw error;
      return TelegramPublication.findOne({ sourceType: 'receipt_new_product', sourceId }).lean();
    }
    throw error;
  }
}

async function currentBinding(publication, { session = null } = {}) {
  if (!publication?.currentBindingId) return null;
  return sessionQuery(TelegramPublicationBinding.findById(publication.currentBindingId), session).lean();
}

async function bindingIssueCounts(publicationId, { session = null } = {}) {
  const unresolvedQuery = TelegramPublicationBinding.countDocuments({
    publicationId,
    state: { $in: ['unknown', 'manual_required'] },
  });
  const ambiguousQuery = TelegramPublicationBinding.countDocuments({
    publicationId,
    state: { $in: ['unknown', 'manual_required'] },
    messageId: null,
  });
  const [unresolvedCount, ambiguousCount] = await Promise.all([
    sessionQuery(unresolvedQuery, session),
    sessionQuery(ambiguousQuery, session),
  ]);
  return { unresolvedCount, ambiguousCount };
}

async function refreshUnresolvedBindingCount(publicationId, { session = null } = {}) {
  const { unresolvedCount, ambiguousCount } = await bindingIssueCounts(publicationId, { session });
  await TelegramPublication.updateOne(
    { _id: publicationId },
    { $set: { unresolvedBindingCount: unresolvedCount, ambiguousBindingCount: ambiguousCount, possibleDuplicate: ambiguousCount > 0 } },
    session ? { session } : undefined,
  );
  return unresolvedCount;
}

async function openAmbiguousBindingCount(publicationId, { session = null, excludeBindingId = null } = {}) {
  const filter = {
    publicationId,
    state: { $in: ['unknown', 'manual_required'] },
    messageId: null,
  };
  if (excludeBindingId) filter._id = { $ne: excludeBindingId };
  return sessionQuery(TelegramPublicationBinding.countDocuments(filter), session);
}

async function openCleanupCount(publicationId, { session = null } = {}) {
  const query = TelegramMessageCleanup.countDocuments({
    publicationId,
    status: { $in: ['pending', 'sending', 'retry_wait', 'manual_required', 'failed'] },
  });
  return sessionQuery(query, session);
}

function legacyProjection(publication, binding, desired, destination, cleanupCount = 0) {
  const state = publication || {};
  const status = String(state.status || 'not_sent');
  const hasMessage = binding?.state === 'live' && Number(binding.messageId) > 0 && !!String(binding.chatId || '');
  const wanted = desired || { hash: '', caption: '', snapshot: {} };
  const appliedHash = String(state.appliedHash || '');
  const queuedHash = String(state.desiredHash || '');
  const relevantChanged = !!appliedHash && appliedHash !== wanted.hash;
  const firstPublish = !appliedHash && !hasMessage;
  const active = ['queued', 'sending', 'retry_wait'].includes(status);
  const problem = ['failed', 'unknown', 'missing'].includes(status);
  const pendingPayloadChanged = active && queuedHash !== wanted.hash;
  const alreadyDecidedForCurrent = String(state.lastDecisionHash || '') === wanted.hash;
  const skippedCurrent = state.lastDecision === 'skip' && alreadyDecidedForCurrent;
  const configured = destination?.enabled === true && !!String(destination.chatId || '');
  const reusableFileId = !!String(binding?.telegramPhotoFileId || '')
    && String(binding?.snapshot?.photoUrl || '') === String(wanted.snapshot?.photoUrl || '');
  const createHealthBlocked = destinationCreateHealthBlocked(destination, String(state.targetChatId || destination?.chatId || ''));
  const canCreate = configured && !createHealthBlocked && (!!wanted.snapshot?.photoUrl || reusableFileId);
  // can_post_messages belongs to Destination/CREATE health. Do not block an
  // UPDATE of an already-known physical post merely because CREATE permission
  // was lost; Telegram's edit call is authoritative for that Binding.
  const bindingAccessBlocked = !!binding && ['forbidden', 'unauthorized', 'chat_not_found'].includes(String(binding.accessCode || ''));
  const canUpdate = configured && hasMessage && !!wanted.snapshot?.photoUrl && !bindingAccessBlocked;

  let action = 'none';
  if (status === 'missing') action = 'missing';
  else if (status === 'unknown') action = 'unknown';
  else if (status === 'failed') action = 'failed';
  else if (status === 'retired' && state.sourceState === 'confirmed' && !hasMessage) action = 'publish';
  else if (active && pendingPayloadChanged) action = 'update';
  else if (active) action = status;
  else if (hasMessage && relevantChanged) action = 'update';
  else if (!hasMessage && firstPublish) action = 'publish';

  const outOfSync = skippedCurrent && action === 'update';
  const currentUnknownIsAmbiguous = status === 'unknown' && !!binding && !Number(binding.messageId);
  const historicalAmbiguousCount = Math.max(0, Number(state.ambiguousBindingCount || 0) - (currentUnknownIsAmbiguous ? 1 : 0));
  // Exact cleanup obligations and historical ambiguous CREATE generations block
  // creation of another physical post, but never freeze a known live update.
  const reconciliationBlocked = historicalAmbiguousCount > 0 && !hasMessage;
  const cleanupBlocked = (cleanupCount > 0 || reconciliationBlocked) && !hasMessage;
  const shouldPrompt = !problem && !cleanupBlocked
    && (action === 'publish' || action === 'update')
    && !alreadyDecidedForCurrent
    && (hasMessage ? canUpdate : canCreate);

  return {
    status,
    action,
    shouldPrompt,
    configured,
    canPublish: !cleanupBlocked && (hasMessage ? canUpdate : canCreate),
    canPublishExplicitly: !cleanupBlocked && configured && ['not_sent', 'failed', 'missing', 'sent', 'retired'].includes(status),
    publishBlockReason: reconciliationBlocked
      ? 'binding_reconciliation_pending'
      : cleanupCount > 0 && !hasMessage
        ? 'cleanup_pending'
      : !configured
        ? 'destination_disabled'
        : (!hasMessage && createHealthBlocked)
          ? 'destination_unhealthy'
          : bindingAccessBlocked
            ? 'binding_access'
            : (!(hasMessage ? canUpdate : canCreate) ? 'photo_missing' : ''),
    canRecreate: !cleanupBlocked && status === 'missing' && canCreate,
    canVerify: configured && hasMessage,
    hasMessage,
    hasRelevantChanges: action === 'update',
    outOfSync,
    cleanupBlocked,
    reconciliationBlocked,
    cleanupCount,
    ambiguousBindingCount: Number(state.ambiguousBindingCount || 0),
    caption: wanted.caption,
    desiredHash: wanted.hash,
    queuedHash,
    appliedHash,
    lastDecision: String(state.lastDecision || ''),
    lastDecisionHash: String(state.lastDecisionHash || ''),
    lastDecisionAt: state.lastDecisionAt || null,
    lastDecisionBy: String(state.lastDecisionBy || ''),
    chatId: String(binding?.chatId || state.targetChatId || ''),
    messageId: Number(binding?.messageId) || null,
    bindingId: binding?._id ? String(binding._id) : '',
    generation: Number(binding?.generation || state.generation || 0),
    targetConfigRevision: Number(state.targetConfigRevision || 0),
    bindingDestinationConfigRevision: Number(binding?.destinationConfigRevision || 0),
    bindingAccessCode: String(binding?.accessCode || ''),
    bindingCanEdit: binding?.canEdit ?? null,
    bindingCanDelete: binding?.canDelete ?? null,
    sentAt: state.sentAt || null,
    editedAt: state.editedAt || null,
    missingAt: state.missingAt || null,
    requestedAt: state.requestedAt || null,
    lastError: state.lastError || {},
    possibleDuplicate: state.possibleDuplicate === true || status === 'unknown',
    unresolvedBindingCount: Number(state.unresolvedBindingCount || 0),
  };
}

async function normalizeLegacyMissing(publication, binding) {
  if (!publication || publication.status !== 'failed' || !binding?.messageId) return publication;
  const description = String(publication.lastError?.description || '');
  if (classifyTelegramSendError({ response: { statusCode: publication.lastError?.statusCode || 400, body: { description } } }).kind !== 'message_not_found') {
    return publication;
  }
  const now = new Date();
  await Promise.all([
    TelegramPublication.updateOne({ _id: publication._id }, { $set: { status: 'missing', missingAt: now } }),
    TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { state: 'missing', missingAt: now } }),
    appendEvent({
      publicationId: publication._id,
      bindingId: binding._id,
      sourceId: publication.sourceId,
      receiptId: publication.receiptId,
      eventType: 'message_missing_normalized',
      operation: 'recovery',
      actorType: 'system',
      fromStatus: 'failed',
      toStatus: 'missing',
      chatId: binding.chatId,
      messageId: binding.messageId,
      generation: binding.generation,
      details: { description },
    }),
  ]);
  return TelegramPublication.findById(publication._id).lean();
}

async function getPublicationState(receiptId, itemId) {
  const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
  if (!item) return null;
  const [destination, initialPublication] = await Promise.all([
    ensureDestination(),
    ensurePublicationForItem(item),
  ]);
  let publication = initialPublication;
  let binding = await currentBinding(publication);
  publication = await normalizeLegacyMissing(publication, binding);
  if (publication !== initialPublication) binding = await currentBinding(publication);
  const cleanupCount = await openCleanupCount(publication._id);
  return legacyProjection(publication, binding, await buildDesiredForItem(item), destination, cleanupCount);
}

async function assertNoOldLifecycleBlockers(publication, { allowAmbiguousBindingId = null } = {}) {
  const [cleanupCount, ambiguousCount] = await Promise.all([
    openCleanupCount(publication._id),
    openAmbiguousBindingCount(publication._id, { excludeBindingId: allowAmbiguousBindingId }),
  ]);
  if (cleanupCount > 0) throw new Error('telegram_new_products_cleanup_pending');
  if (ambiguousCount > 0) throw new Error('telegram_new_products_reconciliation_pending');
}

async function recordDecision({ receiptId, itemId, decision, actorId = '', forceUnknownRetry = false }) {
  return withReceiptTelegramPublicationLock(itemId, async () => {
    const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
    if (!item) return null;
    if (item.status !== 'confirmed') throw new Error('receipt_item_not_confirmed_yet');
    const destination = await ensureDestination();
    let publication = await ensurePublicationForItem(item);
    let binding = await currentBinding(publication);
    publication = await normalizeLegacyMissing(publication, binding);
    binding = await currentBinding(publication);
    const desired = await buildDesiredForItem(item);
    const now = new Date();

    if (decision === 'skip') {
      const updated = await runMongoTransaction(async (session) => {
        const row = await TelegramPublication.findOneAndUpdate(
          { _id: publication._id },
          {
            $set: {
              sourceState: 'confirmed',
              lastDecision: 'skip',
              lastDecisionHash: desired.hash,
              lastDecisionAt: now,
              lastDecisionBy: String(actorId || ''),
            },
          },
          { new: true, session },
        ).lean();
        await appendEvent({
          publicationId: publication._id,
          bindingId: binding?._id || null,
          sourceId: publication.sourceId,
          receiptId: publication.receiptId,
          eventType: 'publication_skipped',
          operation: 'decision',
          actorType: 'user',
          actorId: String(actorId || ''),
          fromStatus: publication.status,
          toStatus: row.status,
          chatId: binding?.chatId || '',
          messageId: binding?.messageId || null,
          generation: binding?.generation || null,
          payloadHash: desired.hash,
        }, { session });
        return row;
      });
      return legacyProjection(updated, binding, desired, destination, await openCleanupCount(publication._id));
    }

    if (decision !== 'publish') throw new Error('telegram_new_products_decision_invalid');
    const hasLiveBinding = binding?.state === 'live' && Number(binding.messageId) > 0;
    if (publication.status === 'unknown' && !forceUnknownRetry) throw new Error('telegram_new_products_delivery_unknown');
    // Open cleanup obligations and historical ambiguous CREATE generations block
    // another physical message generation. The one explicit exception is the
    // current UNKNOWN binding when the operator consciously chooses force retry.
    // Any older unresolved ambiguity still blocks that retry.
    if (!hasLiveBinding) {
      await assertNoOldLifecycleBlockers(publication, {
        allowAmbiguousBindingId: publication.status === 'unknown' && forceUnknownRetry ? binding?._id : null,
      });
    }
    if (!destination?.enabled || !destination.chatId) throw new Error('telegram_new_products_group_not_configured');
    if (!hasLiveBinding && destinationCreateHealthBlocked(destination, destination.chatId)) {
      const error = new Error('telegram_new_products_destination_unhealthy');
      error.healthCode = String(destination.healthCode || '');
      throw error;
    }
    const canReuseFileId = publication.status === 'missing'
      && !!String(binding?.telegramPhotoFileId || '')
      && String(binding?.snapshot?.photoUrl || '') === String(desired.snapshot.photoUrl || '');
    if (!desired.snapshot.photoUrl && !canReuseFileId) throw new Error('telegram_new_products_original_photo_missing');
    const hasPreparedCreate = binding?.state === 'creating' && !Number(binding.messageId);
    if (String(publication.appliedHash || '') === desired.hash && hasLiveBinding) {
      const updated = await runMongoTransaction(async (session) => {
        const row = await TelegramPublication.findOneAndUpdate(
          { _id: publication._id },
          { $set: { lastDecision: 'publish', lastDecisionHash: desired.hash, lastDecisionAt: now, lastDecisionBy: String(actorId || ''), sourceState: 'confirmed' } },
          { new: true, session },
        ).lean();
        await appendEvent({
          publicationId: publication._id,
          bindingId: binding?._id || null,
          sourceId: publication.sourceId,
          receiptId: publication.receiptId,
          eventType: 'publication_already_current',
          operation: 'decision',
          actorType: 'user',
          actorId: String(actorId || ''),
          fromStatus: publication.status,
          toStatus: row.status,
          chatId: binding?.chatId || '',
          messageId: binding?.messageId || null,
          generation: binding?.generation || null,
          payloadHash: desired.hash,
        }, { session });
        return row;
      });
      return legacyProjection(updated, binding, desired, destination, await openCleanupCount(publication._id));
    }

    const keepOriginalChat = hasLiveBinding || ['queued', 'sending', 'retry_wait', 'unknown'].includes(publication.status);
    let targetChatId = keepOriginalChat ? String(binding?.chatId || publication.targetChatId || '') : String(destination.chatId || '');
    if (publication.status === 'missing') targetChatId = String(destination.chatId || '');
    if (!targetChatId) targetChatId = String(destination.chatId || '');

    const decisionFields = {
      sourceState: 'confirmed',
      lastDecision: 'publish',
      lastDecisionHash: desired.hash,
      lastDecisionAt: now,
      lastDecisionBy: String(actorId || ''),
      desiredHash: desired.hash,
      desiredSnapshot: desired.snapshot,
      desiredCaption: desired.caption,
      requestedAt: now,
      requestedBy: String(actorId || ''),
    };

    if (publication.status === 'sending') {
      const updated = await runMongoTransaction(async (session) => {
        const row = await TelegramPublication.findOneAndUpdate(
          { _id: publication._id, status: 'sending' },
          { $set: decisionFields },
          { new: true, session },
        ).lean();
        await appendEvent({
          publicationId: publication._id,
          bindingId: publication.sendingBindingId || binding?._id || null,
          sourceId: publication.sourceId,
          receiptId: publication.receiptId,
          eventType: 'desired_payload_changed_in_flight',
          operation: 'decision',
          actorType: 'user',
          actorId: String(actorId || ''),
          fromStatus: 'sending',
          toStatus: 'sending',
          payloadHash: desired.hash,
        }, { session });
        return row;
      });
      return legacyProjection(updated, binding, desired, destination, await openCleanupCount(publication._id));
    }

    // A missing/unknown binding is historical evidence. A recreate starts a new
    // generation; never erase the old binding or its chat/message uncertainty.
    const creatingNewBinding = (!hasLiveBinding && !hasPreparedCreate) || publication.status === 'missing' || publication.status === 'unknown';
    const updated = await runMongoTransaction(async (session) => {
      const row = await TelegramPublication.findOneAndUpdate(
        { _id: publication._id, status: { $ne: 'sending' } },
        {
          $set: {
            ...decisionFields,
            status: 'queued',
            targetChatId,
            targetConfigRevision: creatingNewBinding || !publication.targetConfigRevision
              ? Number(destination.configRevision || 0)
              : Number(publication.targetConfigRevision || 0),
            nextAttemptAt: now,
            leaseUntil: null,
            attempts: 0,
            lastError: {},
            missingAt: publication.status === 'missing' ? null : publication.missingAt,
            ...(creatingNewBinding ? { currentBindingId: null } : {}),
            ...(forceUnknownRetry ? { possibleDuplicate: true } : {}),
          },
        },
        { new: true, session },
      ).lean();
      await appendEvent({
        publicationId: publication._id,
        bindingId: binding?._id || null,
        sourceId: publication.sourceId,
        receiptId: publication.receiptId,
        eventType: forceUnknownRetry ? 'publication_recreate_after_unknown_requested' : (creatingNewBinding ? 'publication_create_requested' : 'publication_update_requested'),
        operation: creatingNewBinding ? 'create' : 'update',
        actorType: 'user',
        actorId: String(actorId || ''),
        fromStatus: publication.status,
        toStatus: 'queued',
        chatId: targetChatId,
        messageId: binding?.messageId || null,
        generation: binding?.generation || null,
        payloadHash: desired.hash,
        details: { forceUnknownRetry },
      }, { session });
      return row;
    });
    return legacyProjection(updated, creatingNewBinding ? null : binding, desired, destination, await openCleanupCount(publication._id));
  });
}

async function recoverExpiredSending(now = new Date()) {
  const expired = await TelegramPublication.find({ status: 'sending', leaseUntil: { $lte: now } }).limit(50).lean();
  for (const publication of expired) {
    await withReceiptTelegramPublicationLock(publication.sourceId, async () => {
      const fresh = await TelegramPublication.findOne({ _id: publication._id, status: 'sending', leaseUntil: { $lte: now } }).lean();
      if (!fresh) return;

      let binding = fresh.sendingBindingId
        ? await TelegramPublicationBinding.findById(fresh.sendingBindingId).lean()
        : null;
      if (!binding && fresh.currentBindingId) {
        binding = await TelegramPublicationBinding.findById(fresh.currentBindingId).lean();
      }

      const persistedKnownMessage = binding?.state === 'live'
        && Number(binding.messageId) > 0
        && !!String(binding.chatId || '');
      const operation = fresh.sendingOperation === 'update' || fresh.sendingOperation === 'create'
        ? fresh.sendingOperation
        : (persistedKnownMessage ? 'update' : 'create');

      // Crash after Telegram success but after the physical message reference was
      // already persisted: recover from our own durable Binding instead of turning
      // a known message into an "unknown" create.
      if (operation === 'create' && persistedKnownMessage) {
        const sentHash = String(binding.payloadHash || fresh.desiredHash || '');
        const exact = sentHash && sentHash === String(fresh.desiredHash || '');
        const mongoSession = await mongoose.connection.startSession();
        try {
          await mongoSession.withTransaction(async () => {
            await TelegramPublication.updateOne(
              { _id: fresh._id, status: 'sending' },
              { $set: {
                currentBindingId: binding._id,
                appliedHash: sentHash,
                appliedSnapshot: binding.snapshot || fresh.desiredSnapshot || null,
                appliedCaption: String(binding.caption || fresh.desiredCaption || ''),
                status: exact ? 'sent' : 'queued',
                nextAttemptAt: exact ? null : now,
                leaseUntil: null,
                sendingOperation: '',
                sendingBindingId: null,
                lastError: {},
                sentAt: fresh.sentAt || binding.confirmedAt || now,
              } },
              { session: mongoSession },
            );
            await appendEvent({
              publicationId: fresh._id,
              bindingId: binding._id,
              sourceId: fresh.sourceId,
              receiptId: fresh.receiptId,
              eventType: 'sending_recovered_from_binding',
              operation: 'create',
              actorType: 'system',
              fromStatus: 'sending',
              toStatus: exact ? 'sent' : 'queued',
              chatId: binding.chatId,
              messageId: binding.messageId,
              generation: binding.generation,
              payloadHash: sentHash,
            }, { session: mongoSession });
          });
        } finally {
          mongoSession.endSession();
        }
        await refreshUnresolvedBindingCount(fresh._id);
        return;
      }

      if (operation === 'create') {
        const mongoSession = await mongoose.connection.startSession();
        try {
          await mongoSession.withTransaction(async () => {
            let ambiguousBinding = binding;
            if (!ambiguousBinding) {
              const nextGeneration = Number(fresh.generation || 0) + 1;
              [ambiguousBinding] = await TelegramPublicationBinding.create([{
                publicationId: fresh._id,
                sourceId: fresh.sourceId,
                receiptId: fresh.receiptId,
                generation: nextGeneration,
                chatId: String(fresh.targetChatId || ''),
                destinationConfigRevision: Number(fresh.targetConfigRevision || 0),
                messageId: null,
                state: 'unknown',
                payloadHash: String(fresh.desiredHash || ''),
                snapshot: fresh.desiredSnapshot || null,
                caption: String(fresh.desiredCaption || ''),
                createAttemptAt: fresh.lastAttemptAt || now,
                unknownAt: now,
                lastError: { at: now, description: 'Create lease expired; Telegram result is unknown', ambiguous: true },
              }], { session: mongoSession });
              await TelegramPublication.updateOne(
                { _id: fresh._id, status: 'sending' },
                { $set: { generation: nextGeneration, currentBindingId: ambiguousBinding._id } },
                { session: mongoSession },
              );
            } else {
              await TelegramPublicationBinding.updateOne(
                { _id: ambiguousBinding._id },
                { $set: { state: 'unknown', unknownAt: now, lastError: { at: now, description: 'Create lease expired; Telegram result is unknown', ambiguous: true } } },
                { session: mongoSession },
              );
            }
            await TelegramPublication.updateOne(
              { _id: fresh._id, status: 'sending' },
              { $set: {
                status: 'unknown',
                possibleDuplicate: true,
                leaseUntil: null,
                nextAttemptAt: null,
                sendingOperation: '',
                sendingBindingId: null,
                lastError: { at: now, description: 'Процес завершився під час створення повідомлення; результат Telegram невідомий', ambiguous: true },
              } },
              { session: mongoSession },
            );
            await appendEvent({
              publicationId: fresh._id,
              bindingId: ambiguousBinding?._id || null,
              sourceId: fresh.sourceId,
              receiptId: fresh.receiptId,
              eventType: 'sending_lease_expired',
              operation: 'create',
              actorType: 'system',
              fromStatus: 'sending',
              toStatus: 'unknown',
              chatId: ambiguousBinding?.chatId || fresh.targetChatId,
              generation: ambiguousBinding?.generation || null,
              payloadHash: String(fresh.desiredHash || ''),
            }, { session: mongoSession });
          });
        } finally {
          mongoSession.endSession();
        }
        await refreshUnresolvedBindingCount(fresh._id);
      } else {
        const mongoSession = await mongoose.connection.startSession();
        try {
          await mongoSession.withTransaction(async () => {
            await TelegramPublication.updateOne(
              { _id: fresh._id, status: 'sending' },
              { $set: { status: 'retry_wait', leaseUntil: null, nextAttemptAt: now, sendingOperation: '', sendingBindingId: null, lastError: { at: now, description: 'Update lease expired; safe retry queued' } } },
              { session: mongoSession },
            );
            await appendEvent({
              publicationId: fresh._id,
              bindingId: binding?._id || null,
              sourceId: fresh.sourceId,
              receiptId: fresh.receiptId,
              eventType: 'sending_lease_expired',
              operation: 'update',
              actorType: 'system',
              fromStatus: 'sending',
              toStatus: 'retry_wait',
              chatId: binding?.chatId || fresh.targetChatId,
              messageId: binding?.messageId || null,
              generation: binding?.generation || null,
            }, { session: mongoSession });
          });
        } finally {
          mongoSession.endSession();
        }
      }
    });
  }
}

async function claimDue(now = new Date()) {
  return TelegramPublication.findOneAndUpdate(
    {
      sourceState: 'confirmed',
      status: { $in: ['queued', 'retry_wait'] },
      nextAttemptAt: { $lte: now },
      desiredHash: { $nin: ['', null] },
      targetChatId: { $nin: ['', null] },
    },
    { $set: { status: 'sending', lastAttemptAt: now, leaseUntil: new Date(now.getTime() + SEND_LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1, updatedAt: 1 }, new: true },
  ).lean();
}

function telegramPhotoFileId(message) {
  const rows = Array.isArray(message?.photo) ? message.photo : [];
  return String(rows[rows.length - 1]?.file_id || '');
}

async function beginSendingBinding(publication, operation, existingBinding) {
  if (operation === 'update') {
    await TelegramPublication.updateOne(
      { _id: publication._id, status: 'sending' },
      { $set: { sendingOperation: 'update', sendingBindingId: existingBinding._id } },
    );
    return existingBinding;
  }

  // A rate-limit/retryable semantic rejection did not create a Telegram message.
  // Reuse the prepared generation, but persist the operation marker before the API call.
  if (existingBinding?.state === 'creating' && !existingBinding.messageId) {
    await TelegramPublication.updateOne(
      { _id: publication._id, status: 'sending' },
      { $set: { sendingOperation: 'create', sendingBindingId: existingBinding._id } },
    );
    return existingBinding;
  }

  const nextGeneration = Number(publication.generation || 0) + 1;
  const mongoSession = await mongoose.connection.startSession();
  try {
    let createdBinding = null;
    await mongoSession.withTransaction(async () => {
      [createdBinding] = await TelegramPublicationBinding.create([{
        publicationId: publication._id,
        sourceId: publication.sourceId,
        receiptId: publication.receiptId,
        generation: nextGeneration,
        chatId: String(publication.targetChatId || ''),
        destinationConfigRevision: Number(publication.targetConfigRevision || 0),
        state: 'creating',
        payloadHash: publication.desiredHash,
        snapshot: publication.desiredSnapshot,
        caption: publication.desiredCaption,
        createAttemptAt: new Date(),
      }], { session: mongoSession });

      const linked = await TelegramPublication.updateOne(
        { _id: publication._id, status: 'sending' },
        { $set: {
          generation: nextGeneration,
          currentBindingId: createdBinding._id,
          sendingOperation: 'create',
          sendingBindingId: createdBinding._id,
        } },
        { session: mongoSession },
      );
      if (linked.modifiedCount !== 1) throw new Error('telegram_publication_claim_lost');

      await appendEvent({
        publicationId: publication._id,
        bindingId: createdBinding._id,
        sourceId: publication.sourceId,
        receiptId: publication.receiptId,
        eventType: 'binding_create_started',
        operation: 'create',
        actorType: 'worker',
        fromStatus: 'sending',
        toStatus: 'sending',
        chatId: createdBinding.chatId,
        generation: createdBinding.generation,
        payloadHash: publication.desiredHash,
      }, { session: mongoSession });
    });
    return createdBinding.toObject();
  } finally {
    mongoSession.endSession();
  }
}

async function markSuccess(publication, binding, sentHash, sentSnapshot, sentCaption, message, operation, now = new Date()) {
  const messageId = Number(message?.message_id) || Number(binding?.messageId) || null;
  const fileId = telegramPhotoFileId(message) || String(binding?.telegramPhotoFileId || '');
  const mongoSession = await mongoose.connection.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      const fresh = await TelegramPublication.findById(publication._id).session(mongoSession).lean();
      if (!fresh) return;

      await TelegramPublicationBinding.updateOne(
        { _id: binding._id },
        {
          $set: {
            state: 'live',
            messageId,
            telegramPhotoFileId: fileId,
            payloadHash: sentHash,
            snapshot: sentSnapshot,
            caption: sentCaption,
            confirmedAt: operation === 'create' ? now : (binding.confirmedAt || now),
            lastEditedAt: operation === 'update' ? now : binding.lastEditedAt,
            lastVerifiedAt: now,
            lastError: {},
          },
        },
        { session: mongoSession },
      );

      const currentAttempt = String(fresh.currentBindingId || fresh.sendingBindingId || '') === String(binding._id);
      const sourceStillConfirmed = fresh.sourceState === 'confirmed';

      if (currentAttempt && sourceStillConfirmed) {
        const exact = String(fresh.desiredHash || '') === String(sentHash || '');
        const { unresolvedCount, ambiguousCount } = await bindingIssueCounts(fresh._id, { session: mongoSession });
        await TelegramPublication.updateOne(
          { _id: fresh._id },
          {
            $set: {
              appliedHash: sentHash,
              appliedSnapshot: sentSnapshot,
              appliedCaption: sentCaption,
              currentBindingId: binding._id,
              status: exact ? 'sent' : 'queued',
              nextAttemptAt: exact ? null : now,
              leaseUntil: null,
              lastError: {},
              sendingOperation: '',
              sendingBindingId: null,
              unresolvedBindingCount: unresolvedCount,
              ambiguousBindingCount: ambiguousCount,
              possibleDuplicate: ambiguousCount > 0,
              ...(operation === 'create' ? { sentAt: now } : { editedAt: now }),
            },
          },
          { session: mongoSession },
        );
        await appendEvent({
          publicationId: fresh._id,
          bindingId: binding._id,
          sourceId: fresh.sourceId,
          receiptId: fresh.receiptId,
          eventType: operation === 'create' ? 'message_created' : 'message_updated',
          operation,
          actorType: 'worker',
          fromStatus: fresh.status,
          toStatus: exact ? 'sent' : 'queued',
          chatId: binding.chatId,
          messageId,
          generation: binding.generation,
          payloadHash: sentHash,
        }, { session: mongoSession });
        return;
      }

      // The source was retired or a newer binding generation became current while
      // this Bot API request was in flight. Never resurrect stale state. Preserve
      // the now-known Telegram message as exact cleanup work.
      if (messageId && binding.chatId) {
        const existingCleanup = await TelegramMessageCleanup.findOne({
          bindingId: binding._id,
          status: { $in: ['pending', 'sending', 'retry_wait', 'manual_required', 'failed'] },
        }).session(mongoSession).lean();
        const reason = fresh.sourceState === 'deleted' ? 'receipt_item_deleted'
          : fresh.sourceState === 'draft' ? 'receipt_item_unconfirmed'
            : 'duplicate_resolution';
        if (existingCleanup) {
          await TelegramMessageCleanup.updateOne(
            { _id: existingCleanup._id },
            { $set: {
              kind: 'exact_message',
              chatId: String(binding.chatId),
              messageId,
              reason,
              status: 'pending',
              attempts: 0,
              nextAttemptAt: now,
              leaseUntil: null,
              lastError: {},
            } },
            { session: mongoSession },
          );
        } else {
          await TelegramMessageCleanup.findOneAndUpdate(
            { dedupeKey: `receipt-new-product:${fresh._id}:${binding._id}:late-success:${reason}` },
            { $setOnInsert: {
              dedupeKey: `receipt-new-product:${fresh._id}:${binding._id}:late-success:${reason}`,
              sourceType: 'receipt_new_product',
              sourceId: String(fresh.sourceId || ''),
              receiptId: String(fresh.receiptId || ''),
              publicationId: fresh._id,
              bindingId: binding._id,
              generation: binding.generation,
              kind: 'exact_message',
              chatId: String(binding.chatId),
              messageId,
              captionSnapshot: sentCaption,
              payloadHash: sentHash,
              reason,
              status: 'pending',
              attempts: 0,
              maxAttempts: 5,
              nextAttemptAt: now,
              lastError: {},
            } },
            { upsert: true, new: true, setDefaultsOnInsert: true, session: mongoSession },
          );
        }
      }

      const { unresolvedCount, ambiguousCount } = await bindingIssueCounts(fresh._id, { session: mongoSession });
      await TelegramPublication.updateOne(
        { _id: fresh._id },
        { $set: {
          unresolvedBindingCount: unresolvedCount,
          ambiguousBindingCount: ambiguousCount,
          possibleDuplicate: ambiguousCount > 0,
          leaseUntil: null,
          sendingOperation: '',
          sendingBindingId: null,
        } },
        { session: mongoSession },
      );
      await appendEvent({
        publicationId: fresh._id,
        bindingId: binding._id,
        sourceId: fresh.sourceId,
        receiptId: fresh.receiptId,
        eventType: 'late_delivery_success_cleanup_queued',
        operation,
        actorType: 'worker',
        fromStatus: fresh.status,
        toStatus: fresh.status,
        chatId: binding.chatId,
        messageId,
        generation: binding.generation,
        payloadHash: sentHash,
        details: { sourceState: fresh.sourceState, currentBindingId: String(fresh.currentBindingId || '') },
      }, { session: mongoSession });
    });
  } finally {
    mongoSession.endSession();
  }
}

async function applyTelegramChatMigration(oldChatIdValue, newChatIdValue, { actorType = 'telegram', actorId = '' } = {}) {
  const oldChatId = normalizeGroupId(oldChatIdValue);
  const newChatId = normalizeGroupId(newChatIdValue);
  if (!oldChatId || !newChatId || oldChatId === newChatId) return { changed: false, oldChatId, newChatId };

  const mongoSession = await mongoose.connection.startSession();
  try {
    let result = null;
    await mongoSession.withTransaction(async () => {
      const destination = await ensureDestination({ session: mongoSession });
      const destinationWasCurrent = String(destination?.chatId || '') === oldChatId;
      let configRevision = Number(destination?.configRevision || 0);
      if (destinationWasCurrent) {
        const updatedDestination = await TelegramDestination.findOneAndUpdate(
          { key: NEW_PRODUCTS_DESTINATION_KEY, chatId: oldChatId },
          {
            $set: {
              chatId: newChatId,
              changedAt: new Date(),
              changedBy: String(actorId || ''),
              healthCode: 'not_checked',
              healthDescription: 'Telegram переніс чат на новий chat_id',
            },
            $inc: { configRevision: 1 },
          },
          { new: true, session: mongoSession },
        ).lean();
        configRevision = Number(updatedDestination?.configRevision || configRevision + 1);
        await AppSetting.updateOne(
          { key: NEW_PRODUCTS_GROUP_KEY, value: oldChatId },
          { $set: { value: newChatId } },
          { session: mongoSession },
        );
      }

      const publicationUpdate = await TelegramPublication.updateMany(
        { targetChatId: oldChatId },
        { $set: {
          targetChatId: newChatId,
          ...(destinationWasCurrent ? { targetConfigRevision: configRevision } : {}),
        } },
        { session: mongoSession },
      );
      const bindingUpdate = await TelegramPublicationBinding.updateMany(
        { chatId: oldChatId },
        { $set: { chatId: newChatId } },
        { session: mongoSession },
      );
      const cleanupUpdate = await TelegramMessageCleanup.updateMany(
        { chatId: oldChatId },
        { $set: { chatId: newChatId } },
        { session: mongoSession },
      );

      await appendEvent({
        sourceType: 'telegram_destination',
        sourceId: NEW_PRODUCTS_DESTINATION_KEY,
        eventType: 'chat_id_migrated',
        operation: 'migration',
        actorType,
        actorId: String(actorId || ''),
        chatId: newChatId,
        details: {
          oldChatId,
          newChatId,
          destinationWasCurrent,
          configRevision,
          publicationsUpdated: Number(publicationUpdate.modifiedCount || 0),
          bindingsUpdated: Number(bindingUpdate.modifiedCount || 0),
          cleanupsUpdated: Number(cleanupUpdate.modifiedCount || 0),
        },
      }, { session: mongoSession });
      result = {
        changed: true,
        oldChatId,
        newChatId,
        destinationWasCurrent,
        configRevision,
        publicationsUpdated: Number(publicationUpdate.modifiedCount || 0),
        bindingsUpdated: Number(bindingUpdate.modifiedCount || 0),
        cleanupsUpdated: Number(cleanupUpdate.modifiedCount || 0),
      };
    });
    return result;
  } finally {
    mongoSession.endSession();
  }
}

async function markFailure(publication, binding, error, operation, now = new Date()) {
  const classification = classifyTelegramSendError(error);
  const attempts = Number(publication.attempts || 1);
  const lastError = { at: now, kind: classification.kind, statusCode: classification.statusCode, libraryCode: classification.libraryCode, description: classification.description, retryable: classification.retryable, ambiguous: classification.ambiguous, migrateToChatId: classification.migrateToChatId };

  if (classification.migrateToChatId) {
    const newChatId = String(classification.migrateToChatId);
    const oldChatId = String(binding?.chatId || publication.targetChatId || '');
    await applyTelegramChatMigration(oldChatId, newChatId);
    await runMongoTransaction(async (session) => {
      await TelegramPublication.updateOne(
        { _id: publication._id },
        { $set: { targetChatId: newChatId, status: 'retry_wait', nextAttemptAt: now, leaseUntil: null, lastError, sendingOperation: '', sendingBindingId: null } },
        { session },
      );
      await appendEvent({ publicationId: publication._id, bindingId: binding?._id || null, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'delivery_chat_migrated', operation, actorType: 'telegram', fromStatus: 'sending', toStatus: 'retry_wait', chatId: newChatId, messageId: binding?.messageId || null, generation: binding?.generation || null, details: { oldChatId, newChatId } }, { session });
    });
    return;
  }

  if (operation === 'update' && classification.kind === 'message_not_found') {
    await runMongoTransaction(async (session) => {
      if (binding) await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { state: 'missing', missingAt: now, lastError } }, { session });
      await TelegramPublication.updateOne({ _id: publication._id }, { $set: { status: 'missing', missingAt: now, leaseUntil: null, nextAttemptAt: null, lastError, sendingOperation: '', sendingBindingId: null } }, { session });
      await refreshUnresolvedBindingCount(publication._id, { session });
      await appendEvent({ publicationId: publication._id, bindingId: binding?._id || null, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'message_missing', operation, actorType: 'telegram', fromStatus: 'sending', toStatus: 'missing', chatId: binding?.chatId || '', messageId: binding?.messageId || null, generation: binding?.generation || null, details: lastError }, { session });
    });
    return;
  }

  if (operation === 'create' && classification.ambiguous && !classification.rateLimited) {
    await runMongoTransaction(async (session) => {
      if (binding) await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { state: 'unknown', unknownAt: now, lastError } }, { session });
      await TelegramPublication.updateOne({ _id: publication._id }, { $set: { status: 'unknown', possibleDuplicate: true, leaseUntil: null, nextAttemptAt: null, lastError, sendingOperation: '', sendingBindingId: null } }, { session });
      await refreshUnresolvedBindingCount(publication._id, { session });
      await appendEvent({ publicationId: publication._id, bindingId: binding?._id || null, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'create_result_unknown', operation, actorType: 'worker', fromStatus: 'sending', toStatus: 'unknown', chatId: binding?.chatId || publication.targetChatId, generation: binding?.generation || null, payloadHash: publication.desiredHash, details: lastError }, { session });
    });
    return;
  }

  const canRetry = classification.rateLimited || (classification.retryable && attempts < MAX_ATTEMPTS);
  await runMongoTransaction(async (session) => {
    const bindingAccessFailure = ['forbidden', 'unauthorized', 'chat_not_found', 'message_cannot_edit'].includes(classification.kind);
    const destinationAccessFailure = ['forbidden', 'unauthorized', 'chat_not_found'].includes(classification.kind);
    if (destinationAccessFailure) {
      const destination = await ensureDestination({ session });
      const failedChatId = String(binding?.chatId || publication.targetChatId || '');
      const affectsCurrentDestination = classification.kind === 'unauthorized'
        || (!!failedChatId && destination?.enabled && String(destination.chatId || '') === failedChatId);
      if (affectsCurrentDestination) {
        await TelegramDestination.updateOne(
          { key: NEW_PRODUCTS_DESTINATION_KEY },
          { $set: {
            healthCode: classification.kind,
            healthDescription: classification.description,
            canPost: false,
            lastHealthCheckAt: now,
          } },
          { session },
        );
      }
    }

    await TelegramPublication.updateOne(
      { _id: publication._id },
      { $set: { status: canRetry ? 'retry_wait' : 'failed', nextAttemptAt: canRetry ? new Date(now.getTime() + retryDelayMs(classification, attempts)) : null, leaseUntil: null, lastError, sendingOperation: '', sendingBindingId: null } },
      { session },
    );
    if (binding) {
      await TelegramPublicationBinding.updateOne(
        { _id: binding._id },
        { $set: {
          lastError,
          ...(bindingAccessFailure ? { accessCode: classification.kind, canEdit: false } : {}),
          ...(!canRetry && operation === 'create' && binding.state === 'creating' ? { state: 'resolved', resolvedAt: now, resolutionNote: 'create_rejected' } : {}),
        } },
        { session },
      );
    }
    await refreshUnresolvedBindingCount(publication._id, { session });
    await appendEvent({ publicationId: publication._id, bindingId: binding?._id || null, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: canRetry ? 'delivery_retry_scheduled' : 'delivery_failed', operation, actorType: 'worker', fromStatus: 'sending', toStatus: canRetry ? 'retry_wait' : 'failed', chatId: binding?.chatId || publication.targetChatId, messageId: binding?.messageId || null, generation: binding?.generation || null, details: lastError }, { session });
  });
}

async function sendClaimed(claimed) {
  return withReceiptTelegramPublicationLock(claimed.sourceId, async () => {
    const [publication, item, destination] = await Promise.all([
      TelegramPublication.findOne({ _id: claimed._id, status: 'sending' }).lean(),
      ReceiptItem.findOne({ _id: claimed.sourceId, receiptId: claimed.receiptId }).lean(),
      ensureDestination(),
    ]);
    if (!publication) return { sent: false, skipped: true, operation: 'none' };
    if (!item || item.status !== 'confirmed') {
      await TelegramPublication.updateOne({ _id: publication._id }, { $set: { sourceState: item ? 'draft' : 'deleted', status: 'retired', leaseUntil: null, nextAttemptAt: null, sendingOperation: '', sendingBindingId: null, sourceRetiredAt: new Date() } });
      await appendEvent({ publicationId: publication._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'stale_delivery_cancelled', operation: 'none', actorType: 'worker', fromStatus: 'sending', toStatus: 'retired', details: { sourceExists: !!item, sourceStatus: item?.status || 'deleted' } });
      return { sent: false, skipped: true, operation: 'none' };
    }
    // Full pause semantics: re-check destination immediately before every Bot API call.
    if (!destination?.enabled || !destination.chatId) {
      await TelegramPublication.updateOne({ _id: publication._id }, { $set: { status: 'queued', leaseUntil: null, nextAttemptAt: new Date(), sendingOperation: '', sendingBindingId: null } });
      return { sent: false, skipped: true, paused: true, operation: 'none' };
    }

    let binding = await currentBinding(publication);
    const operation = binding?.state === 'live' && Number(binding.messageId) > 0 ? 'update' : 'create';
    if (operation === 'create' && destinationCreateHealthBlocked(destination, String(publication.targetChatId || binding?.chatId || ''))) {
      const now = new Date();
      const lastError = {
        at: now,
        kind: 'destination_unhealthy',
        description: String(destination.healthDescription || destination.healthCode || 'Telegram destination is unavailable'),
        healthCode: String(destination.healthCode || ''),
        retryable: true,
        ambiguous: false,
      };
      await TelegramPublication.updateOne(
        { _id: publication._id, status: 'sending' },
        {
          $set: { status: 'queued', nextAttemptAt: null, leaseUntil: null, lastError, sendingOperation: '', sendingBindingId: null },
          $inc: { attempts: -1 },
        },
      );
      await appendEvent({
        publicationId: publication._id,
        bindingId: binding?._id || null,
        sourceId: publication.sourceId,
        receiptId: publication.receiptId,
        eventType: 'delivery_paused_destination_unhealthy',
        operation: 'create',
        actorType: 'worker',
        fromStatus: 'sending',
        toStatus: 'queued',
        chatId: String(publication.targetChatId || ''),
        generation: binding?.generation || null,
        details: lastError,
      });
      return { sent: false, skipped: true, paused: true, operation };
    }
    binding = await beginSendingBinding(publication, operation, binding);
    const freshPublication = await TelegramPublication.findById(publication._id).lean();
    const snapshot = freshPublication.desiredSnapshot || {};
    const caption = String(freshPublication.desiredCaption || buildCaption(snapshot));
    const sentHash = String(freshPublication.desiredHash || '');
    const { getBot } = require('../telegramBot');
    const bot = getBot();
    if (!bot) {
      const error = new Error('telegram bot is not initialized');
      error.code = 'EBOTUNAVAILABLE';
      await markFailure(freshPublication, binding, error, operation);
      return { sent: false, operation };
    }

    try {
      let message;
      if (operation === 'create') {
        const previousMedia = await TelegramPublicationBinding.findOne({
          publicationId: publication._id,
          telegramPhotoFileId: { $nin: ['', null] },
          _id: { $ne: binding._id },
        }).sort({ generation: -1 }).lean();
        const reusableFileId = String(previousMedia?.telegramPhotoFileId || '');
        const unchangedPhoto = String(previousMedia?.snapshot?.photoUrl || '') === String(snapshot.photoUrl || '');
        let photoInput = reusableFileId && unchangedPhoto ? reusableFileId : snapshot.photoUrl;
        try {
          message = await bot.sendPhoto(binding.chatId, photoInput, { caption });
        } catch (error) {
          const classification = classifyTelegramSendError(error);
          // A rejected cached file_id is safe to replace with the canonical URL once;
          // Telegram did not create a message for this semantic 400 failure.
          if (reusableFileId && photoInput === reusableFileId && classification.kind === 'photo_source_unavailable' && snapshot.photoUrl) {
            await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { telegramPhotoFileId: '' } });
            photoInput = snapshot.photoUrl;
            message = await bot.sendPhoto(binding.chatId, photoInput, { caption });
          } else {
            throw error;
          }
        }
      } else {
        const appliedPhotoUrl = String(binding.snapshot?.photoUrl || '');
        if (appliedPhotoUrl !== String(snapshot.photoUrl || '')) {
          message = await bot.editMessageMedia({ type: 'photo', media: snapshot.photoUrl, caption }, { chat_id: binding.chatId, message_id: binding.messageId });
        } else {
          message = await bot.editMessageCaption(caption, { chat_id: binding.chatId, message_id: binding.messageId });
        }
      }
      await markSuccess(freshPublication, binding, sentHash, snapshot, caption, message, operation, new Date());
      return { sent: true, operation };
    } catch (error) {
      const classification = classifyTelegramSendError(error);
      if (operation === 'update' && classification.kind === 'message_not_modified') {
        await markSuccess(freshPublication, binding, sentHash, snapshot, caption, null, operation, new Date());
        return { sent: true, operation };
      }
      await markFailure(freshPublication, binding, error, operation, new Date());
      return { sent: false, operation };
    }
  });
}

async function verifyPublication({ receiptId, itemId, actorId = '' }) {
  return withReceiptTelegramPublicationLock(itemId, async () => {
    const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
    if (!item) return null;
    const destination = await ensureDestination();
    const publication = await ensurePublicationForItem(item);
    const binding = await currentBinding(publication);
    if (!destination?.enabled || !destination.chatId) return { ...(legacyProjection(publication, binding, await buildDesiredForItem(item), destination, await openCleanupCount(publication._id))), verifySkipped: 'group_disabled' };
    if (!binding || binding.state !== 'live' || !binding.messageId) return legacyProjection(publication, binding, await buildDesiredForItem(item), destination, await openCleanupCount(publication._id));
    const { getBot } = require('../telegramBot');
    const bot = getBot();
    if (!bot) throw new Error('telegram_bot_unavailable');
    const caption = String(binding.caption || publication.appliedCaption || publication.desiredCaption || '');
    const now = new Date();
    try {
      await bot.editMessageCaption(caption, { chat_id: binding.chatId, message_id: binding.messageId });
      await runMongoTransaction(async (session) => {
        await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { lastVerifiedAt: now } }, { session });
        await appendEvent({ publicationId: publication._id, bindingId: binding._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'message_verified', operation: 'verify', actorType: 'user', actorId: String(actorId || ''), fromStatus: publication.status, toStatus: publication.status, chatId: binding.chatId, messageId: binding.messageId, generation: binding.generation, details: { probeResult: 'caption_restored_or_verified' } }, { session });
      });
    } catch (error) {
      const classification = classifyTelegramSendError(error);
      if (classification.kind === 'message_not_modified') {
        await runMongoTransaction(async (session) => {
          await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { lastVerifiedAt: now } }, { session });
          await appendEvent({ publicationId: publication._id, bindingId: binding._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'message_verified', operation: 'verify', actorType: 'user', actorId: String(actorId || ''), fromStatus: publication.status, toStatus: publication.status, chatId: binding.chatId, messageId: binding.messageId, generation: binding.generation, details: { probeResult: 'message_not_modified' } }, { session });
        });
      } else if (classification.kind === 'message_not_found') {
        const lastError = { at: now, kind: classification.kind, statusCode: classification.statusCode, description: classification.description };
        await runMongoTransaction(async (session) => {
          await TelegramPublicationBinding.updateOne({ _id: binding._id }, { $set: { state: 'missing', missingAt: now, lastVerifiedAt: now, lastError } }, { session });
          await TelegramPublication.updateOne({ _id: publication._id }, { $set: { status: 'missing', missingAt: now, lastError } }, { session });
          await appendEvent({ publicationId: publication._id, bindingId: binding._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'message_missing', operation: 'verify', actorType: 'telegram', actorId: String(actorId || ''), fromStatus: publication.status, toStatus: 'missing', chatId: binding.chatId, messageId: binding.messageId, generation: binding.generation, details: lastError }, { session });
        });
      } else {
        await appendEvent({ publicationId: publication._id, bindingId: binding._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'message_verify_failed', operation: 'verify', actorType: 'telegram', actorId: String(actorId || ''), fromStatus: publication.status, toStatus: publication.status, chatId: binding.chatId, messageId: binding.messageId, generation: binding.generation, details: { kind: classification.kind, description: classification.description } });
        throw error;
      }
    }
    return getPublicationState(receiptId, itemId);
  });
}

async function attachExistingUnknownMessage({ receiptId, itemId, messageId, chatId = '', actorId = '' }) {
  return withReceiptTelegramPublicationLock(itemId, async () => {
    const item = await ReceiptItem.findOne({ _id: itemId, receiptId }).lean();
    if (!item) return null;
    if (item.status !== 'confirmed') throw new Error('receipt_item_not_confirmed_yet');
    const publication = await ensurePublicationForItem(item);
    const unknown = await TelegramPublicationBinding.findOne({ publicationId: publication._id, state: 'unknown' }).sort({ generation: -1 }).lean();
    if (!unknown) throw new Error('telegram_new_products_unknown_binding_not_found');
    const resolvedChatId = normalizeGroupId(chatId || unknown.chatId || publication.targetChatId);
    const resolvedMessageId = Number(messageId);
    if (!resolvedChatId || !Number.isInteger(resolvedMessageId) || resolvedMessageId <= 0) throw new Error('telegram_new_products_message_reference_invalid');
    const { getBot } = require('../telegramBot');
    const bot = getBot();
    if (!bot) throw new Error('telegram_bot_unavailable');
    const desired = await buildDesiredForItem(item);
    const attachedHash = String(unknown.payloadHash || publication.desiredHash || desired.hash);
    const attachedSnapshot = unknown.snapshot || publication.desiredSnapshot || desired.snapshot;
    const attachedCaption = String(unknown.caption || publication.desiredCaption || buildCaption(attachedSnapshot));
    try {
      // Probe the exact generation we are attaching. The current ReceiptItem may
      // already have newer data; convergence happens only AFTER the physical
      // unknown post has been identified.
      await bot.editMessageCaption(attachedCaption, { chat_id: resolvedChatId, message_id: resolvedMessageId });
    } catch (error) {
      const classification = classifyTelegramSendError(error);
      if (classification.kind !== 'message_not_modified') throw error;
    }
    const now = new Date();
    const needsConvergence = attachedHash !== desired.hash;
    await runMongoTransaction(async (session) => {
      await TelegramPublicationBinding.updateOne(
        { _id: unknown._id, state: 'unknown', messageId: null },
        { $set: { chatId: resolvedChatId, messageId: resolvedMessageId, state: 'live', payloadHash: attachedHash, snapshot: attachedSnapshot, caption: attachedCaption, confirmedAt: now, lastVerifiedAt: now, resolvedAt: now, resolvedBy: String(actorId || ''), resolutionNote: 'attached_after_unknown' } },
        { session },
      );
      await TelegramPublication.updateOne({ _id: publication._id }, { $set: {
        status: needsConvergence ? 'queued' : 'sent',
        currentBindingId: unknown._id,
        targetChatId: resolvedChatId,
        appliedHash: attachedHash,
        appliedSnapshot: attachedSnapshot,
        appliedCaption: attachedCaption,
        desiredHash: desired.hash,
        desiredSnapshot: desired.snapshot,
        desiredCaption: desired.caption,
        nextAttemptAt: needsConvergence ? now : null,
        sentAt: publication.sentAt || now,
        lastError: {},
      } }, { session });
      await refreshUnresolvedBindingCount(publication._id, { session });
      await appendEvent({ publicationId: publication._id, bindingId: unknown._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: 'unknown_message_attached', operation: 'recovery', actorType: 'user', actorId: String(actorId || ''), fromStatus: 'unknown', toStatus: needsConvergence ? 'queued' : 'sent', chatId: resolvedChatId, messageId: resolvedMessageId, generation: unknown.generation, payloadHash: attachedHash, details: { needsConvergence } }, { session });
    });
    return getPublicationState(receiptId, itemId);
  });
}

async function retirePublicationForReceiptItem(item, reason, { session = null, actorId = '' } = {}) {
  const publication = await ensurePublicationForItem(item, { session });
  if (!publication) return null;
  const toSourceState = reason === 'receipt_item_deleted' ? 'deleted' : 'draft';
  await TelegramPublication.updateOne(
    { _id: publication._id },
    { $set: { sourceState: toSourceState, status: 'retired', sourceRetiredAt: new Date(), nextAttemptAt: null, leaseUntil: null, sendingOperation: '', sendingBindingId: null } },
    session ? { session } : undefined,
  );
  await appendEvent({ publicationId: publication._id, sourceId: publication.sourceId, receiptId: publication.receiptId, eventType: reason === 'receipt_item_deleted' ? 'source_deleted' : 'source_unconfirmed', operation: 'retire', actorType: actorId ? 'user' : 'system', actorId: String(actorId || ''), fromStatus: publication.status, toStatus: 'retired', details: { reason } }, { session });
  return sessionQuery(TelegramPublication.findById(publication._id), session).lean();
}

async function publicationBindingsForCleanup(publicationId, { session = null, includeCreating = false } = {}) {
  const states = ['live', 'unknown', 'manual_required'];
  if (includeCreating) states.push('creating');
  return sessionQuery(
    TelegramPublicationBinding.find({ publicationId, state: { $in: states } }).sort({ generation: 1 }),
    session,
  ).lean();
}

function withReceiptTelegramPublicationLock(itemId, fn) {
  return withLock(`telegram:new-product:item:${String(itemId)}`, fn, { ttlMs: ITEM_LOCK_TTL_MS, waitMs: 55 * 1000 });
}

async function drainDueReceiptNewProductPublications({ limit = 20 } = {}) {
  return withLock('telegram:delivery:send-lane', async () => {
    if (!(await getNewProductsGroupId())) return { processed: 0, sent: 0, paused: true };
    await recoverExpiredSending(new Date());
    const startedAtMs = Date.now();
    let processed = 0;
    let sent = 0;
    while (processed < limit && !telegramBatchBudgetExceeded(startedAtMs)) {
      // Re-read the switch between every item. Disabling the destination while a
      // batch is running stops the next Bot API call instead of only the next tick.
      if (!(await getNewProductsGroupId())) break;
      const publication = await claimDue(new Date());
      if (!publication) break;
      const result = await sendClaimed(publication);
      processed += 1;
      if (result.sent) sent += 1;
    }
    return { processed, sent, budgetExhausted: telegramBatchBudgetExceeded(startedAtMs) };
  }, { ttlMs: TELEGRAM_DELIVERY_LANE_TTL_MS, waitMs: 1_000 });
}


async function publicationStateMapForItems(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const sourceIds = rows.map((item) => String(item?._id || '')).filter(Boolean);
  if (!sourceIds.length) return new Map();
  const destination = await ensureDestination();
  const legacyReceiptIds = [...new Set(rows
    .filter((item) => Number(item?.routingVersion || 0) < 1 && item?.receiptId)
    .map((item) => String(item.receiptId)))];
  const legacyReceipts = legacyReceiptIds.length
    ? await Receipt.find({ _id: { $in: legacyReceiptIds } }).select('_id type targetDeliveryGroupId').lean()
    : [];
  const receiptById = new Map(legacyReceipts.map((row) => [String(row._id), row]));
  const publications = await TelegramPublication.find({ sourceType: 'receipt_new_product', sourceId: { $in: sourceIds } }).lean();
  const publicationBySource = new Map(publications.map((row) => [String(row.sourceId), row]));
  const bindingIds = publications.map((row) => row.currentBindingId).filter(Boolean);
  const bindings = bindingIds.length ? await TelegramPublicationBinding.find({ _id: { $in: bindingIds } }).lean() : [];
  const bindingById = new Map(bindings.map((row) => [String(row._id), row]));
  const cleanupRows = publications.length ? await TelegramMessageCleanup.aggregate([
    { $match: { publicationId: { $in: publications.map((row) => row._id) }, status: { $in: ['pending', 'sending', 'retry_wait', 'manual_required', 'failed'] } } },
    { $group: { _id: '$publicationId', count: { $sum: 1 } } },
  ]) : [];
  const cleanupByPublication = new Map(cleanupRows.map((row) => [String(row._id), Number(row.count || 0)]));
  const out = new Map();
  for (const item of rows) {
    const publication = publicationBySource.get(String(item?._id || ''));
    if (!publication) {
      const legacy = item?.telegramNewProduct || {};
      const synthetic = {
        status: normalizeLegacyStatus(legacy),
        targetChatId: String(legacy.chatId || ''),
        desiredHash: String(legacy.desiredHash || ''),
        appliedHash: String(legacy.appliedHash || ''),
        lastDecision: String(legacy.lastDecision || ''),
        lastDecisionHash: String(legacy.lastDecisionHash || ''),
        lastDecisionAt: legacy.lastDecisionAt || null,
        lastDecisionBy: String(legacy.lastDecisionBy || ''),
        lastError: legacy.lastError || {},
        possibleDuplicate: legacy.possibleDuplicate === true,
      };
      const syntheticBinding = Number(legacy.messageId) > 0 && legacy.chatId ? {
        state: synthetic.status === 'missing' ? 'missing' : 'live',
        chatId: String(legacy.chatId),
        messageId: Number(legacy.messageId),
        telegramPhotoFileId: String(legacy.telegramPhotoFileId || ''),
        snapshot: legacy.appliedSnapshot || null,
        generation: 1,
      } : null;
      out.set(String(item._id), legacyProjection(synthetic, syntheticBinding, buildDesired(item, receiptById.get(String(item?.receiptId || '')) || null), destination, 0));
      continue;
    }
    const binding = publication.currentBindingId ? bindingById.get(String(publication.currentBindingId)) : null;
    out.set(String(item._id), legacyProjection(
      publication,
      binding,
      buildDesired(item, receiptById.get(String(item?.receiptId || '')) || null),
      destination,
      cleanupByPublication.get(String(publication._id)) || 0,
    ));
  }
  return out;
}

async function getPublicationHistory(receiptId, itemId, { limit = 100 } = {}) {
  const item = await ReceiptItem.findOne({ _id: itemId, receiptId }, '_id receiptId telegramNewProduct status').lean();
  let publication;
  if (item) {
    publication = await ensurePublicationForItem(item);
  } else {
    publication = await TelegramPublication.findOne({
      sourceType: 'receipt_new_product',
      sourceId: String(itemId || ''),
      receiptId: String(receiptId || ''),
    }).lean();
  }
  if (!publication) return null;
  const [bindings, events, cleanups] = await Promise.all([
    TelegramPublicationBinding.find({ publicationId: publication._id }).sort({ generation: 1 }).lean(),
    TelegramPublicationEvent.find({ publicationId: publication._id }).sort({ createdAt: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 100))).lean(),
    TelegramMessageCleanup.find({ publicationId: publication._id }).sort({ createdAt: -1 }).lean(),
  ]);
  return { publication, bindings, events, cleanups, sourceExists: !!item };
}

// Kept only so older route code does not mutate/remove embedded history by
// accident. New lifecycle state lives in TelegramPublication/Binding/Event.
function resetPublicationState(item) {
  if (item) item.telegramNewProduct = item.telegramNewProduct || {};
  return item;
}

async function migrateLegacyTelegramNewProducts({ batchSize = 250 } = {}) {
  await ensureDestination();
  const query = ReceiptItem.find({
    $or: [
      { 'telegramNewProduct.status': { $exists: true, $ne: 'not_sent' } },
      { 'telegramNewProduct.messageId': { $ne: null } },
      { 'telegramNewProduct.lastDecision': { $in: ['publish', 'skip'] } },
    ],
  }).select('_id receiptId status telegramNewProduct createdAt updatedAt').lean().cursor({ batchSize });
  let migrated = 0;
  for await (const item of query) {
    const before = await TelegramPublication.exists({ sourceType: 'receipt_new_product', sourceId: String(item._id) });
    await ensurePublicationForItem(item);
    if (!before) migrated += 1;
  }

  // One-time compatibility repair for publications created by the first ledger
  // rollout, before ambiguousBindingCount existed. Never infer ambiguity from
  // possibleDuplicate/unresolved counts; derive it from physical Bindings.
  const repairCursor = TelegramPublication.find({
    $or: [
      { ambiguousBindingCount: { $exists: false } },
      { unresolvedBindingCount: { $exists: false } },
    ],
  }).select('_id').lean().cursor({ batchSize });
  let issueCountersRepaired = 0;
  for await (const publication of repairCursor) {
    await refreshUnresolvedBindingCount(publication._id);
    issueCountersRepaired += 1;
  }
  return { migrated, issueCountersRepaired };
}

module.exports = {
  NEW_PRODUCTS_GROUP_KEY,
  NEW_PRODUCTS_DESTINATION_KEY,
  SEND_LEASE_MS,
  ITEM_LOCK_TTL_MS,
  TELEGRAM_REQUEST_TIMEOUT_MS,
  TELEGRAM_DELIVERY_LANE_TTL_MS,
  MAX_ATTEMPTS,
  TELEGRAM_PHOTO_CAPTION_LIMIT,
  getNewProductsDestination,
  getNewProductsGroupId,
  setNewProductsGroupId,
  inspectNewProductsGroup,
  handleNewProductsMyChatMember,
  applyTelegramChatMigration,
  buildSnapshot,
  buildDesired,
  buildCaption,
  hashSnapshot,
  resetPublicationState,
  ensurePublicationForItem,
  getPublicationState,
  recordDecision,
  verifyPublication,
  attachExistingUnknownMessage,
  retirePublicationForReceiptItem,
  publicationBindingsForCleanup,
  recoverExpiredSending,
  drainDueReceiptNewProductPublications,
  withReceiptTelegramPublicationLock,
  migrateLegacyTelegramNewProducts,
  legacyProjection,
  publicationStateMapForItems,
  getPublicationHistory,
};

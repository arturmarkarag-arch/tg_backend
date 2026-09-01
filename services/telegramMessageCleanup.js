'use strict';

const mongoose = require('mongoose');
const TelegramMessageCleanup = require('../models/TelegramMessageCleanup');
const TelegramPublication = require('../models/TelegramPublication');
const TelegramPublicationBinding = require('../models/TelegramPublicationBinding');
const TelegramPublicationEvent = require('../models/TelegramPublicationEvent');
const { classifyTelegramSendError, retryDelayMs } = require('../utils/telegramDeliveryPolicy');
const { withLock } = require('../utils/lock');
const { TELEGRAM_DELIVERY_LANE_TTL_MS, telegramBatchBudgetExceeded } = require('../utils/telegramTransportPolicy');
const {
  ensurePublicationForItem,
  publicationBindingsForCleanup,
  retirePublicationForReceiptItem,
  applyTelegramChatMigration,
  attachExistingUnknownMessage,
  withReceiptTelegramPublicationLock,
} = require('./receiptNewProductTelegram');

const CLEANUP_LEASE_MS = 90 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

async function runMongoTransaction(fn) {
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); });
    return result;
  } finally {
    session.endSession();
  }
}

async function refreshPublicationIssues(publicationId, { session = null } = {}) {
  if (!publicationId) return 0;
  let countQuery = TelegramPublicationBinding.countDocuments({
    publicationId,
    state: { $in: ['unknown', 'manual_required'] },
  });
  let ambiguousQuery = TelegramPublicationBinding.countDocuments({
    publicationId,
    state: { $in: ['unknown', 'manual_required'] },
    messageId: null,
  });
  if (session) { countQuery = countQuery.session(session); ambiguousQuery = ambiguousQuery.session(session); }
  const [count, ambiguousCount] = await Promise.all([countQuery, ambiguousQuery]);
  await TelegramPublication.updateOne(
    { _id: publicationId },
    { $set: { unresolvedBindingCount: count, ambiguousBindingCount: ambiguousCount, possibleDuplicate: ambiguousCount > 0 } },
    session ? { session } : undefined,
  );
  return count;
}

async function appendCleanupEvent(publication, binding, eventType, details = {}, { session = null, actorId = '' } = {}) {
  const payload = {
    publicationId: publication?._id || null,
    bindingId: binding?._id || null,
    destinationKey: 'new_products',
    sourceType: 'receipt_new_product',
    sourceId: String(publication?.sourceId || binding?.sourceId || ''),
    receiptId: String(publication?.receiptId || binding?.receiptId || ''),
    eventType,
    operation: 'delete',
    actorType: actorId ? 'user' : 'system',
    actorId: String(actorId || ''),
    chatId: String(binding?.chatId || ''),
    messageId: Number(binding?.messageId) || null,
    generation: Number(binding?.generation) || null,
    payloadHash: String(binding?.payloadHash || ''),
    details,
  };
  if (session) {
    await TelegramPublicationEvent.create([payload], { session });
  } else {
    await TelegramPublicationEvent.create(payload);
  }
}

async function enqueueOne(publication, binding, reason, { session = null, now = new Date(), allowCreatingAmbiguity = false } = {}) {
  const exact = binding.state === 'live' && Number(binding.messageId) > 0;
  const ambiguousState = ['unknown', 'manual_required'].includes(String(binding.state || ''))
    || (allowCreatingAmbiguity && binding.state === 'creating');
  const ambiguous = ambiguousState && !Number(binding.messageId);
  if (!exact && !ambiguous) return null;
  const kind = exact ? 'exact_message' : 'ambiguous_create';
  const dedupeKey = `receipt-new-product:${publication._id}:${binding._id}:${kind}:${reason}`;
  const status = exact ? 'pending' : 'manual_required';
  const update = {
    $setOnInsert: {
      dedupeKey,
      sourceType: 'receipt_new_product',
      sourceId: String(publication.sourceId || ''),
      receiptId: String(publication.receiptId || ''),
      publicationId: publication._id,
      bindingId: binding._id,
      generation: binding.generation,
      kind,
      chatId: String(binding.chatId || ''),
      messageId: exact ? Number(binding.messageId) : null,
      captionSnapshot: String(binding.caption || ''),
      payloadHash: String(binding.payloadHash || ''),
      reason,
      status,
      attempts: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      nextAttemptAt: exact ? now : null,
      lastError: ambiguous ? {
        at: now,
        kind: 'ambiguous_create',
        description: 'Telegram міг створити цей пост, але server не отримав message_id. Потрібна ручна перевірка каналу.',
        ambiguous: true,
      } : {},
    },
  };
  const query = TelegramMessageCleanup.findOneAndUpdate(
    { dedupeKey },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (session) query.session(session);
  const row = await query;
  if (ambiguous) {
    const bindingUpdate = TelegramPublicationBinding.updateOne(
      { _id: binding._id },
      { $set: { state: 'manual_required' } },
      session ? { session } : undefined,
    );
    await bindingUpdate;
  }
  await appendCleanupEvent(publication, binding, ambiguous ? 'cleanup_manual_required' : 'cleanup_queued', { reason, kind }, { session });
  return row;
}

async function enqueueReceiptNewProductCleanup(item, reason, { session = null, now = new Date(), actorId = '' } = {}) {
  const publication = await ensurePublicationForItem(item, { session });
  if (!publication) return { queued: 0, manualRequired: 0, publicationId: null, jobs: [] };
  const inFlightCreateMayBeAmbiguous = publication.status === 'sending'
    && (publication.sendingOperation === 'create' || !publication.sendingOperation);
  const bindings = await publicationBindingsForCleanup(publication._id, {
    session,
    includeCreating: inFlightCreateMayBeAmbiguous,
  });
  const jobs = [];
  for (const binding of bindings) {
    const row = await enqueueOne(publication, binding, reason, {
      session,
      now,
      allowCreatingAmbiguity: inFlightCreateMayBeAmbiguous,
    });
    if (row) jobs.push(row.toObject ? row.toObject() : row);
  }
  await retirePublicationForReceiptItem(item, reason, { session, actorId });
  return {
    publicationId: String(publication._id),
    queued: jobs.filter((row) => row.status === 'pending').length,
    manualRequired: jobs.filter((row) => row.status === 'manual_required').length,
    jobs,
  };
}

async function claimDue(now = new Date()) {
  const fresh = await TelegramMessageCleanup.findOneAndUpdate(
    { kind: 'exact_message', status: { $in: ['pending', 'retry_wait'] }, nextAttemptAt: { $lte: now } },
    { $set: { status: 'sending', lastAttemptAt: now, leaseUntil: new Date(now.getTime() + CLEANUP_LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true },
  ).lean();
  if (fresh) return fresh;
  return TelegramMessageCleanup.findOneAndUpdate(
    { kind: 'exact_message', status: 'sending', leaseUntil: { $lte: now } },
    { $set: { status: 'sending', lastAttemptAt: now, leaseUntil: new Date(now.getTime() + CLEANUP_LEASE_MS) }, $inc: { attempts: 1 } },
    { sort: { leaseUntil: 1 }, new: true },
  ).lean();
}

async function markDone(row, now = new Date(), lastError = {}) {
  await runMongoTransaction(async (session) => {
    await TelegramMessageCleanup.updateOne({ _id: row._id }, { $set: { status: 'done', completedAt: now, nextAttemptAt: null, leaseUntil: null, lastError } }, { session });
    if (row.bindingId) {
      await TelegramPublicationBinding.updateOne({ _id: row.bindingId }, { $set: { state: 'deleted', deletedAt: now, lastError } }, { session });
    }
    await refreshPublicationIssues(row.publicationId, { session });
    const publication = row.publicationId ? await TelegramPublication.findById(row.publicationId).session(session).lean() : null;
    const binding = row.bindingId ? await TelegramPublicationBinding.findById(row.bindingId).session(session).lean() : null;
    await appendCleanupEvent(publication, binding, 'cleanup_done', { cleanupId: String(row._id), lastError }, { session });
  });
}

async function markFailed(row, error, now = new Date()) {
  const classification = classifyTelegramSendError(error);
  const lastError = {
    at: now,
    kind: classification.kind,
    statusCode: classification.statusCode,
    libraryCode: classification.libraryCode,
    description: classification.description,
    retryable: classification.retryable,
    migrateToChatId: classification.migrateToChatId,
  };
  if (classification.migrateToChatId) {
    const newChatId = String(classification.migrateToChatId);
    const oldChatId = String(row.chatId || '');
    await applyTelegramChatMigration(oldChatId, newChatId);
    await runMongoTransaction(async (session) => {
      await TelegramMessageCleanup.updateOne(
        { _id: row._id },
        { $set: { chatId: newChatId, status: 'retry_wait', nextAttemptAt: now, leaseUntil: null, lastError } },
        { session },
      );
      const publication = row.publicationId ? await TelegramPublication.findById(row.publicationId).session(session).lean() : null;
      const binding = row.bindingId ? await TelegramPublicationBinding.findById(row.bindingId).session(session).lean() : null;
      await appendCleanupEvent(publication, binding, 'cleanup_chat_migrated', { cleanupId: String(row._id), oldChatId, newChatId, lastError }, { session });
    });
    return { done: false, classification };
  }
  if (classification.kind === 'message_not_found') {
    await markDone(row, now, lastError);
    return { done: true, classification };
  }
  const attempts = Number(row.attempts || 1);
  const canRetry = classification.rateLimited || (classification.retryable && attempts < Number(row.maxAttempts || DEFAULT_MAX_ATTEMPTS));
  const terminalStatus = ['message_cannot_delete', 'forbidden', 'unauthorized', 'chat_not_found'].includes(classification.kind)
    ? 'manual_required'
    : 'failed';
  const nextStatus = canRetry ? 'retry_wait' : terminalStatus;
  await runMongoTransaction(async (session) => {
    await TelegramMessageCleanup.updateOne({ _id: row._id }, {
      $set: {
        status: nextStatus,
        nextAttemptAt: canRetry ? new Date(now.getTime() + retryDelayMs(classification, attempts)) : null,
        leaseUntil: null,
        lastError,
      },
    }, { session });
    if (!canRetry && row.bindingId) {
      await TelegramPublicationBinding.updateOne({ _id: row.bindingId }, { $set: { state: 'manual_required', lastError } }, { session });
    }
    await refreshPublicationIssues(row.publicationId, { session });
    const publication = row.publicationId ? await TelegramPublication.findById(row.publicationId).session(session).lean() : null;
    const binding = row.bindingId ? await TelegramPublicationBinding.findById(row.bindingId).session(session).lean() : null;
    await appendCleanupEvent(
      publication,
      binding,
      canRetry ? 'cleanup_retry_scheduled' : (nextStatus === 'manual_required' ? 'cleanup_manual_required' : 'cleanup_failed'),
      { cleanupId: String(row._id), attempts, nextStatus, lastError },
      { session },
    );
  });
  return { done: false, classification };
}

async function sendClaimed(row) {
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) {
    const error = new Error('telegram bot is not initialized');
    error.code = 'EBOTUNAVAILABLE';
    await markFailed(row, error);
    return { done: false };
  }
  try {
    await bot.deleteMessage(row.chatId, row.messageId);
    await markDone(row);
    return { done: true };
  } catch (error) {
    return markFailed(row, error);
  }
}

async function drainDueTelegramMessageCleanups({ limit = 20 } = {}) {
  return withLock('telegram:delivery:send-lane', async () => {
    const startedAtMs = Date.now();
    let processed = 0;
    let done = 0;
    while (processed < limit && !telegramBatchBudgetExceeded(startedAtMs)) {
      const row = await claimDue(new Date());
      if (!row) break;
      const result = await sendClaimed(row);
      processed += 1;
      if (result.done) done += 1;
    }
    return { processed, done, budgetExhausted: telegramBatchBudgetExceeded(startedAtMs) };
  }, { ttlMs: TELEGRAM_DELIVERY_LANE_TTL_MS, waitMs: 1_000 });
}

async function getTelegramMessageCleanupHealth({ limit = 10 } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 10));
  const [pending, manualRequired, failed, latestProblems, unresolvedBindings] = await Promise.all([
    TelegramMessageCleanup.countDocuments({ status: { $in: ['pending', 'sending', 'retry_wait'] } }),
    TelegramMessageCleanup.countDocuments({ status: 'manual_required' }),
    TelegramMessageCleanup.countDocuments({ status: 'failed' }),
    TelegramMessageCleanup.find({ status: { $in: ['manual_required', 'failed'] } })
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .select('sourceId receiptId publicationId bindingId generation kind chatId messageId captionSnapshot payloadHash reason status lastError updatedAt')
      .lean(),
    TelegramPublicationBinding.find({
      state: { $in: ['unknown', 'manual_required'] },
      messageId: null,
    })
      .sort({ updatedAt: -1 })
      .limit(safeLimit)
      .select('publicationId sourceId receiptId generation chatId messageId state caption payloadHash unknownAt lastError updatedAt')
      .lean(),
  ]);

  const publicationIds = [...new Set(unresolvedBindings.map((row) => String(row.publicationId || '')).filter(Boolean))];
  const publications = publicationIds.length
    ? await TelegramPublication.find({ _id: { $in: publicationIds } }).select('_id status sourceState currentBindingId possibleDuplicate unresolvedBindingCount').lean()
    : [];
  const publicationById = new Map(publications.map((row) => [String(row._id), row]));
  const unresolved = unresolvedBindings.map((row) => {
    const publication = publicationById.get(String(row.publicationId || '')) || {};
    return {
      ...row,
      publicationStatus: String(publication.status || ''),
      sourceState: String(publication.sourceState || ''),
      isCurrentBinding: String(publication.currentBindingId || '') === String(row._id || ''),
    };
  });
  return { pending, manualRequired, failed, latestProblems, unresolvedBindings: unresolved };
}

async function resolveAmbiguousTelegramBinding(bindingId, { actorId = '', note = '' } = {}) {
  const binding = await TelegramPublicationBinding.findOne({
    _id: bindingId,
    state: { $in: ['unknown', 'manual_required'] },
    messageId: null,
  }).lean();
  if (!binding) return null;

  return withReceiptTelegramPublicationLock(binding.sourceId, async () => runMongoTransaction(async (session) => {
    const [freshBinding, publication] = await Promise.all([
      TelegramPublicationBinding.findOne({ _id: binding._id, state: { $in: ['unknown', 'manual_required'] }, messageId: null }).session(session).lean(),
      TelegramPublication.findById(binding.publicationId).session(session).lean(),
    ]);
    if (!freshBinding || !publication) return null;
    const now = new Date();
    const resolutionNote = String(note || 'manual_check_no_post');

    await TelegramPublicationBinding.updateOne(
      { _id: freshBinding._id },
      { $set: { state: 'resolved', resolvedAt: now, resolvedBy: String(actorId || ''), resolutionNote } },
      { session },
    );
    await TelegramMessageCleanup.updateMany(
      { bindingId: freshBinding._id, kind: 'ambiguous_create', status: { $in: ['pending', 'sending', 'retry_wait', 'manual_required', 'failed'] } },
      { $set: { status: 'done', completedAt: now, manuallyResolvedAt: now, manuallyResolvedBy: String(actorId || ''), resolutionNote, nextAttemptAt: null, leaseUntil: null } },
      { session },
    );

    if (String(publication.currentBindingId || '') === String(freshBinding._id) && publication.status === 'unknown') {
      await TelegramPublication.updateOne(
        { _id: publication._id, currentBindingId: freshBinding._id, status: 'unknown' },
        { $set: {
          currentBindingId: null,
          status: publication.sourceState === 'confirmed' ? 'not_sent' : 'retired',
          possibleDuplicate: false,
          nextAttemptAt: null,
          leaseUntil: null,
          lastError: {},
          sendingOperation: '',
          sendingBindingId: null,
        } },
        { session },
      );
    }
    await refreshPublicationIssues(publication._id, { session });
    await appendCleanupEvent(publication, freshBinding, 'ambiguous_binding_resolved_absent', { note: resolutionNote }, { session, actorId });
    return TelegramPublicationBinding.findById(freshBinding._id).session(session).lean();
  }));
}

async function identifyAmbiguousTelegramBinding(bindingId, { chatId = '', messageId = null, actorId = '' } = {}) {
  const numericMessageId = Number(messageId);
  if (!Number.isInteger(numericMessageId) || numericMessageId <= 0) {
    const error = new Error('telegram_new_products_message_reference_invalid');
    throw error;
  }
  const binding = await TelegramPublicationBinding.findOne({
    _id: bindingId,
    state: { $in: ['unknown', 'manual_required'] },
    messageId: null,
  }).lean();
  if (!binding) return null;

  const publication = await TelegramPublication.findById(binding.publicationId).lean();
  if (!publication) return null;
  const resolvedChatId = String(chatId || binding.chatId || '').trim();
  if (!resolvedChatId) {
    const error = new Error('telegram_new_products_message_reference_invalid');
    throw error;
  }

  // If this is still the CURRENT unknown generation, identifying it means the
  // original create actually succeeded; restore that message as the live binding
  // rather than treating it as a duplicate to delete.
  if (publication.status === 'unknown' && String(publication.currentBindingId || '') === String(binding._id)) {
    const state = await attachExistingUnknownMessage({
      receiptId: publication.receiptId,
      itemId: publication.sourceId,
      chatId: resolvedChatId,
      messageId: numericMessageId,
      actorId,
    });
    return { mode: 'attached_current', state };
  }

  return withReceiptTelegramPublicationLock(binding.sourceId, async () => {
    const fresh = await TelegramPublicationBinding.findOne({
      _id: binding._id,
      state: { $in: ['unknown', 'manual_required'] },
      messageId: null,
    }).lean();
    if (!fresh) return null;
    const { getBot } = require('../telegramBot');
    const bot = getBot();
    if (!bot) {
      const error = new Error('telegram bot is not initialized');
      error.code = 'EBOTUNAVAILABLE';
      throw error;
    }
    const caption = String(fresh.caption || '');
    try {
      await bot.editMessageCaption(caption, { chat_id: resolvedChatId, message_id: numericMessageId });
    } catch (error) {
      const classification = classifyTelegramSendError(error);
      if (classification.kind !== 'message_not_modified') throw error;
    }

    const now = new Date();
    return runMongoTransaction(async (session) => {
      await TelegramPublicationBinding.updateOne(
        { _id: fresh._id, state: { $in: ['unknown', 'manual_required'] }, messageId: null },
        { $set: { chatId: resolvedChatId, messageId: numericMessageId, state: 'live', confirmedAt: now, lastVerifiedAt: now, resolvedBy: String(actorId || ''), resolutionNote: 'historical_unknown_identified_for_cleanup' } },
        { session },
      );
      const liveBinding = await TelegramPublicationBinding.findById(fresh._id).session(session).lean();

      const existingAmbiguous = await TelegramMessageCleanup.findOne({
        bindingId: fresh._id,
        kind: 'ambiguous_create',
        status: { $in: ['pending', 'sending', 'retry_wait', 'manual_required', 'failed'] },
      }).session(session).lean();
      let cleanup;
      if (existingAmbiguous) {
        cleanup = await TelegramMessageCleanup.findOneAndUpdate(
          { _id: existingAmbiguous._id },
          { $set: { kind: 'exact_message', chatId: resolvedChatId, messageId: numericMessageId, status: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null, lastError: {} } },
          { new: true, session },
        ).lean();
      } else {
        cleanup = await enqueueOne(publication, liveBinding, 'duplicate_resolution', { now, session });
        cleanup = cleanup?.toObject ? cleanup.toObject() : cleanup;
      }
      await appendCleanupEvent(publication, liveBinding, 'ambiguous_binding_identified_for_cleanup', { cleanupId: String(cleanup?._id || '') }, { session, actorId });
      await refreshPublicationIssues(publication._id, { session });
      return { mode: 'cleanup_queued', binding: liveBinding, cleanup };
    });
  });
}

async function resolveTelegramMessageCleanup(cleanupId, { actorId = '', note = '' } = {}) {
  const row = await TelegramMessageCleanup.findOne({ _id: cleanupId, status: { $in: ['manual_required', 'failed'] } }).lean();
  if (!row) return null;
  return runMongoTransaction(async (session) => {
    const fresh = await TelegramMessageCleanup.findOne({ _id: row._id, status: { $in: ['manual_required', 'failed'] } }).session(session).lean();
    if (!fresh) return null;
    const now = new Date();
    await TelegramMessageCleanup.updateOne({ _id: fresh._id }, { $set: { status: 'done', completedAt: now, manuallyResolvedAt: now, manuallyResolvedBy: String(actorId || ''), resolutionNote: String(note || ''), nextAttemptAt: null, leaseUntil: null } }, { session });
    if (fresh.bindingId) {
      await TelegramPublicationBinding.updateOne({ _id: fresh.bindingId }, { $set: { state: 'resolved', resolvedAt: now, resolvedBy: String(actorId || ''), resolutionNote: String(note || 'manual_cleanup_confirmed') } }, { session });
    }
    await refreshPublicationIssues(fresh.publicationId, { session });
    const publication = fresh.publicationId ? await TelegramPublication.findById(fresh.publicationId).session(session).lean() : null;
    const binding = fresh.bindingId ? await TelegramPublicationBinding.findById(fresh.bindingId).session(session).lean() : null;
    await appendCleanupEvent(publication, binding, 'cleanup_manually_resolved', { cleanupId: String(fresh._id), note: String(note || '') }, { session, actorId });
    return TelegramMessageCleanup.findById(fresh._id).session(session).lean();
  });
}

async function retryTelegramMessageCleanup(cleanupId, { actorId = '' } = {}) {
  const row = await TelegramMessageCleanup.findOne({ _id: cleanupId, kind: 'exact_message', status: { $in: ['manual_required', 'failed'] }, messageId: { $ne: null } }).lean();
  if (!row) return null;
  return runMongoTransaction(async (session) => {
    const fresh = await TelegramMessageCleanup.findOne({ _id: row._id, kind: 'exact_message', status: { $in: ['manual_required', 'failed'] }, messageId: { $ne: null } }).session(session).lean();
    if (!fresh) return null;
    const now = new Date();
    await TelegramMessageCleanup.updateOne({ _id: fresh._id }, { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, leaseUntil: null, completedAt: null, lastError: {} } }, { session });
    const publication = fresh.publicationId ? await TelegramPublication.findById(fresh.publicationId).session(session).lean() : null;
    const binding = fresh.bindingId ? await TelegramPublicationBinding.findById(fresh.bindingId).session(session).lean() : null;
    await appendCleanupEvent(publication, binding, 'cleanup_retry_requested', { cleanupId: String(fresh._id) }, { session, actorId });
    return TelegramMessageCleanup.findById(fresh._id).session(session).lean();
  });
}

module.exports = {
  CLEANUP_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  enqueueReceiptNewProductCleanup,
  drainDueTelegramMessageCleanups,
  getTelegramMessageCleanupHealth,
  resolveAmbiguousTelegramBinding,
  identifyAmbiguousTelegramBinding,
  resolveTelegramMessageCleanup,
  retryTelegramMessageCleanup,
};

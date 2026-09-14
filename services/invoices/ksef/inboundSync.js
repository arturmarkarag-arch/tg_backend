'use strict';

const mongoose = require('mongoose');
const KsefInboundSyncState = require('../../../models/KsefInboundSyncState');
const { appError } = require('../../../utils/errors');
const { resolveLegalEntity } = require('../legalEntityService');
const { normalizeEnvironment } = require('./config');
const { ksefRequest } = require('./http');
const { validateInboundAuthBinding, resolveInboundAccessToken } = require('./inboundAuth');
const { errorSnapshot, upsertInboundMetadata } = require('./inboundDocuments');
const { queueInboundExportForSync, publicExport } = require('./inboundExports');
const {
  SUBJECT_TYPE,
  PAGE_SIZE,
  MIN_SYNC_INTERVAL_MS,
  PAGE_CONTINUE_MS,
  SYNC_LEASE_MS,
  asDate,
  buildRequestedWindowEnd,
  effectiveWindowEnd,
  buildMetadataFilters,
  retryDelayMs,
  syncKey,
} = require('./inboundPolicy');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function objectId(value, code = 'legal_entity_id_invalid') {
  const id = clean(value, 64);
  if (!mongoose.isValidObjectId(id)) throw appError(code);
  return id;
}
function publicInboundSync(row) { return row?.toObject ? row.toObject() : { ...row }; }

async function createInboundSync(input = {}) {
  const legalEntityId = objectId(input.legalEntityId);
  const entity = await resolveLegalEntity(legalEntityId, { allowDefault: false, requireActive: true });
  if (entity.countryCode !== 'PL' || entity.taxIdType !== 'nip' || !entity.taxId) throw appError('ksef_legal_entity_nip_required');
  const environment = normalizeEnvironment(input.environment || 'test');
  const authMethod = clean(input.authMethod, 32);
  const authRefId = clean(input.authRefId, 128);
  if (!authRefId) throw appError('ksef_inbound_auth_ref_required');
  const from = asDate(input.fromPermanentStorageDate);
  if (!from) throw appError('ksef_inbound_cursor_invalid');
  if (from.getTime() > Date.now() + 5 * 60_000) throw appError('ksef_inbound_cursor_invalid');
  await validateInboundAuthBinding({ legalEntityId, environment, authMethod, authRefId });
  const syncId = syncKey(legalEntityId, environment);
  try {
    const sync = await KsefInboundSyncState.create({
      syncId,
      provider: 'ksef',
      legalEntityId,
      environment,
      subjectType: SUBJECT_TYPE,
      enabled: input.enabled !== false,
      authMethod,
      authRefId,
      state: 'idle',
      cursorFrom: from,
      activeWindowTo: null,
      pageOffset: 0,
      pageSize: PAGE_SIZE,
      nextSyncAt: new Date(),
    });
    return publicInboundSync(sync);
  } catch (error) {
    if (Number(error?.code) === 11000) throw appError('ksef_inbound_sync_exists');
    throw error;
  }
}

async function getInboundSync(syncId, { requireEnabled = false } = {}) {
  const id = clean(syncId, 64);
  if (!id) throw appError('ksef_inbound_sync_id_required');
  const sync = await KsefInboundSyncState.findOne({ syncId: id });
  if (!sync) throw appError('ksef_inbound_sync_not_found');
  if (requireEnabled && sync.enabled !== true) throw appError('ksef_inbound_sync_disabled');
  return sync;
}

async function listInboundSyncs({ legalEntityId = '', environment = '', includeDisabled = true } = {}) {
  const filter = { provider: 'ksef', subjectType: SUBJECT_TYPE };
  if (legalEntityId) filter.legalEntityId = objectId(legalEntityId);
  if (environment) filter.environment = normalizeEnvironment(environment);
  if (!includeDisabled) filter.enabled = true;
  const rows = await KsefInboundSyncState.find(filter).sort({ legalEntityId: 1, environment: 1 }).lean();
  return rows.map(publicInboundSync);
}

async function updateInboundSync(syncId, patch = {}) {
  const sync = await getInboundSync(syncId);
  const nextAuthMethod = patch.authMethod !== undefined ? clean(patch.authMethod, 32) : sync.authMethod;
  const nextAuthRefId = patch.authRefId !== undefined ? clean(patch.authRefId, 128) : sync.authRefId;
  if (!nextAuthRefId) throw appError('ksef_inbound_auth_ref_required');
  await validateInboundAuthBinding({
    legalEntityId: sync.legalEntityId,
    environment: sync.environment,
    authMethod: nextAuthMethod,
    authRefId: nextAuthRefId,
  });
  sync.authMethod = nextAuthMethod;
  sync.authRefId = nextAuthRefId;
  if (patch.enabled !== undefined) sync.enabled = patch.enabled === true;
  if (sync.enabled && !sync.nextSyncAt) sync.nextSyncAt = new Date();
  await sync.save();
  return publicInboundSync(sync);
}

async function resetInboundCursor(syncId, fromPermanentStorageDate) {
  const sync = await getInboundSync(syncId);
  const from = asDate(fromPermanentStorageDate);
  if (!from || from.getTime() > Date.now() + 5 * 60_000) throw appError('ksef_inbound_cursor_invalid');
  if (sync.state === 'running' && sync.leaseUntil && sync.leaseUntil.getTime() > Date.now()) throw appError('ksef_inbound_sync_busy');
  if (sync.state === 'export_wait') throw appError('ksef_inbound_export_active');
  sync.cursorFrom = from;
  sync.activeWindowTo = null;
  sync.pageOffset = 0;
  sync.lastPermanentStorageHwmDate = null;
  sync.state = 'idle';
  sync.nextSyncAt = new Date();
  sync.leaseUntil = null;
  sync.lastError = null;
  await sync.save();
  return publicInboundSync(sync);
}

function dueSyncQuery(now = new Date()) {
  return {
    provider: 'ksef',
    subjectType: SUBJECT_TYPE,
    enabled: true,
    $and: [
      { $or: [{ state: { $in: ['idle', 'retry_wait'] } }, { state: 'running', leaseUntil: { $lte: now } }] },
      { $or: [{ nextSyncAt: null }, { nextSyncAt: { $exists: false } }, { nextSyncAt: { $lte: now } }] },
      { $or: [{ leaseUntil: null }, { leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] },
    ],
  };
}

async function claimInboundSync(syncId = '', now = new Date()) {
  const filter = dueSyncQuery(now);
  if (syncId) filter.syncId = clean(syncId, 64);
  return KsefInboundSyncState.findOneAndUpdate(filter, {
    $set: { state: 'running', leaseUntil: new Date(now.getTime() + SYNC_LEASE_MS), lastAttemptAt: now, lastError: null },
    $inc: { attempts: 1 },
  }, { sort: { nextSyncAt: 1, updatedAt: 1, _id: 1 }, new: true });
}

function parseMetadataResponse(body) {
  if (!body || !Array.isArray(body.invoices) || typeof body.hasMore !== 'boolean' || typeof body.isTruncated !== 'boolean') throw appError('ksef_inbound_metadata_response_invalid');
  const hwm = asDate(body.permanentStorageHwmDate);
  if (!hwm) throw appError('ksef_inbound_hwm_missing');
  return { invoices: body.invoices, hasMore: body.hasMore, isTruncated: body.isTruncated, hwm };
}

async function processInboundSyncClaim(sync) {
  if (!sync) return null;
  try {
    const auth = await resolveInboundAccessToken(sync);
    const from = asDate(sync.cursorFrom);
    if (!from) throw appError('ksef_inbound_cursor_invalid');
    const requestedTo = sync.activeWindowTo ? asDate(sync.activeWindowTo) : buildRequestedWindowEnd(from, new Date());
    if (!requestedTo || requestedTo.getTime() < from.getTime()) throw appError('ksef_inbound_cursor_invalid');
    const filters = buildMetadataFilters({ from, to: requestedTo });
    const pageOffset = Math.max(0, Number(sync.pageOffset) || 0);
    const pageSize = PAGE_SIZE;
    const response = await ksefRequest(sync.environment,
      `/invoices/query/metadata?sortOrder=Asc&pageOffset=${pageOffset}&pageSize=${pageSize}`,
      { method: 'POST', token: auth.accessToken, body: filters, timeoutMs: 30_000 });
    const parsed = parseMetadataResponse(response.body);
    if (parsed.isTruncated) {
      const exportWindowEnd = sync.activeWindowTo ? asDate(sync.activeWindowTo) : effectiveWindowEnd(requestedTo, parsed.hwm);
      if (!exportWindowEnd || exportWindowEnd.getTime() < from.getTime()) throw appError('ksef_inbound_hwm_invalid');
      const exportJob = await queueInboundExportForSync(sync, { from, to: exportWindowEnd, reason: 'metadata_truncated' });
      const fresh = await getInboundSync(sync.syncId);
      return {
        ok: true,
        exportQueued: true,
        sync: publicInboundSync(fresh),
        export: publicExport(exportJob),
        page: { pageOffset, pageSize, count: 0, hasMore: false, truncated: true },
        imported: { created: 0, updated: 0, conflicts: 0 },
      };
    }
    const windowEnd = sync.activeWindowTo ? asDate(sync.activeWindowTo) : effectiveWindowEnd(requestedTo, parsed.hwm);
    if (!windowEnd) throw appError('ksef_inbound_hwm_invalid');
    if (windowEnd.getTime() < from.getTime()) {
      // PermanentStorage HWM may temporarily trail an already persisted cursor.
      // That is a normal no-progress cycle, provided KSeF did not return rows or
      // pagination for a range that is supposedly still behind the cursor.
      if (sync.activeWindowTo || parsed.hasMore || parsed.invoices.length) throw appError('ksef_inbound_hwm_invalid');
      const now = new Date();
      await KsefInboundSyncState.updateOne({ _id: sync._id, state: 'running' }, { $set: {
        state: 'idle',
        activeWindowTo: null,
        pageOffset: 0,
        lastPermanentStorageHwmDate: parsed.hwm,
        nextSyncAt: new Date(now.getTime() + MIN_SYNC_INTERVAL_MS),
        leaseUntil: null,
        lastSuccessAt: now,
        lastError: null,
      } });
      const fresh = await getInboundSync(sync.syncId);
      return {
        ok: true,
        sync: publicInboundSync(fresh),
        page: { pageOffset, pageSize, count: 0, hasMore: false },
        imported: { created: 0, updated: 0, conflicts: 0 },
        noProgress: 'permanent_storage_hwm_before_cursor',
      };
    }

    let created = 0;
    let updated = 0;
    let conflicts = 0;
    for (const item of parsed.invoices) {
      const outcome = await upsertInboundMetadata(sync, item);
      if (outcome.status === 'created') created += 1;
      else if (outcome.status === 'conflict') conflicts += 1;
      else updated += 1;
    }

    const now = new Date();
    const inc = {
      'stats.metadataSeen': parsed.invoices.length,
      'stats.documentsCreated': created,
      'stats.metadataUpdated': updated,
      'stats.conflicts': conflicts,
    };
    if (parsed.hasMore) {
      await KsefInboundSyncState.updateOne({ _id: sync._id, state: 'running' }, {
        $set: {
          state: 'idle',
          activeWindowTo: windowEnd,
          pageOffset: pageOffset + 1,
          lastPermanentStorageHwmDate: parsed.hwm,
          nextSyncAt: new Date(now.getTime() + PAGE_CONTINUE_MS),
          leaseUntil: null,
          lastSuccessAt: now,
          lastError: null,
        },
        $inc: inc,
      });
    } else {
      const nextCursor = windowEnd.getTime() > from.getTime() ? windowEnd : from;
      await KsefInboundSyncState.updateOne({ _id: sync._id, state: 'running' }, {
        $set: {
          state: 'idle',
          cursorFrom: nextCursor,
          activeWindowTo: null,
          pageOffset: 0,
          lastPermanentStorageHwmDate: parsed.hwm,
          nextSyncAt: new Date(now.getTime() + MIN_SYNC_INTERVAL_MS),
          leaseUntil: null,
          lastSuccessAt: now,
          lastError: null,
        },
        $inc: inc,
      });
    }
    const fresh = await getInboundSync(sync.syncId);
    return {
      ok: true,
      sync: publicInboundSync(fresh),
      page: { pageOffset, pageSize, count: parsed.invoices.length, hasMore: parsed.hasMore },
      imported: { created, updated, conflicts },
    };
  } catch (error) {
    const now = new Date();
    const attempt = Number(sync.attempts || 1);
    const delay = retryDelayMs(attempt, error, { floorMs: PAGE_CONTINUE_MS });
    await KsefInboundSyncState.updateOne({ _id: sync._id, state: 'running' }, { $set: {
      state: 'retry_wait',
      nextSyncAt: new Date(now.getTime() + delay),
      leaseUntil: null,
      lastError: errorSnapshot(error),
    } });
    throw error;
  }
}

async function runInboundSync(syncId) {
  const sync = await getInboundSync(syncId, { requireEnabled: true });
  const now = new Date();
  if (sync.nextSyncAt && sync.nextSyncAt.getTime() > now.getTime()) {
    throw appError('ksef_inbound_sync_not_due', { nextSyncAt: sync.nextSyncAt.toISOString() });
  }
  const claim = await claimInboundSync(sync.syncId, now);
  if (!claim) throw appError('ksef_inbound_sync_busy');
  return processInboundSyncClaim(claim);
}

module.exports = {
  publicInboundSync,
  createInboundSync,
  getInboundSync,
  listInboundSyncs,
  updateInboundSync,
  resetInboundCursor,
  dueSyncQuery,
  claimInboundSync,
  parseMetadataResponse,
  processInboundSyncClaim,
  runInboundSync,
};

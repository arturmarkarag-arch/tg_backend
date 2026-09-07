'use strict';

const { appError } = require('../utils/errors');
const { callBaseLinkerWithToken, makeBaseLinkerAccountCaller } = require('./baseLinkerClient');
const { getTokenForAccount, getBaseLinkerAccount, recordAccountMetadata, tokenFingerprint } = require('./baseLinkerAccounts');

const metadataInFlight = new Map();
const DEFAULT_METADATA_MAX_AGE_MS = Math.min(24 * 60 * 60_000, Math.max(60_000, Number(process.env.BASELINKER_METADATA_REFRESH_MS) || (30 * 60_000)));

function normalizeMetadata(statusesPayload, sourcesPayload, inventoriesPayload) {
  const statuses = Array.isArray(statusesPayload?.statuses) ? statusesPayload.statuses.map((row) => ({
    id: Number(row?.id),
    name: String(row?.name || ''),
    color: String(row?.color || ''),
  })).filter((row) => Number.isSafeInteger(row.id) && row.id > 0) : [];
  const sources = sourcesPayload?.sources && typeof sourcesPayload.sources === 'object' ? sourcesPayload.sources : {};
  const inventories = Array.isArray(inventoriesPayload?.inventories) ? inventoriesPayload.inventories.map((row) => ({
    inventory_id: Number(row?.inventory_id),
    name: String(row?.name || ''),
    description: String(row?.description || ''),
  })).filter((row) => Number.isSafeInteger(row.inventory_id) && row.inventory_id > 0) : [];
  return { statuses, sources, inventories };
}

function sourceCounts(sources = {}) {
  const byType = {};
  let total = 0;
  for (const [type, values] of Object.entries(sources && typeof sources === 'object' ? sources : {})) {
    const count = values && typeof values === 'object' ? Object.keys(values).length : 0;
    byType[type] = count;
    total += count;
  }
  return { total, byType };
}

async function loadMetadata(callApi) {
  const [statusesPayload, sourcesPayload, inventoriesPayload] = await Promise.all([
    callApi('getOrderStatusList', {}),
    callApi('getOrderSources', {}),
    callApi('getInventories', {}),
  ]);
  const metadata = normalizeMetadata(statusesPayload, sourcesPayload, inventoriesPayload);
  return {
    metadata,
    summary: {
      statusCount: metadata.statuses.length,
      inventoryCount: metadata.inventories.length,
      sources: sourceCounts(metadata.sources),
    },
  };
}

async function validateBaseLinkerToken(token) {
  const raw = String(token || '').trim();
  if (!raw) throw appError('baselinker_token_required');
  // Fingerprint is HMACed with the server encryption secret: validation cannot
  // proceed on a server that would be unable to store the token securely.
  const validationKey = `validation-${tokenFingerprint(raw).slice(0, 24)}`;
  return loadMetadata((method, parameters) => callBaseLinkerWithToken(method, parameters, raw, { accountId: validationKey, usageStage: 'metadata_validation' }));
}

async function refreshBaseLinkerAccountMetadata(accountId, { allowDisabled = false } = {}) {
  const requireEnabled = allowDisabled !== true;
  const { account } = await getTokenForAccount(accountId, { requireEnabled });
  try {
    const result = await loadMetadata(makeBaseLinkerAccountCaller(accountId, { requireEnabled, usageStage: 'metadata_refresh' }));
    await recordAccountMetadata(account.accountId, result.metadata, { connectionError: '' });
    return result;
  } catch (error) {
    await recordAccountMetadata(account.accountId, null, {
      connectionError: error?.code || error?.message || 'baselinker_metadata_refresh_failed',
    }).catch(() => null);
    throw error;
  }
}


async function ensureBaseLinkerAccountMetadataFresh(accountId, { maxAgeMs = DEFAULT_METADATA_MAX_AGE_MS, force = false } = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  const account = await getBaseLinkerAccount(id, { requireEnabled: true, lean: true });
  const fetchedAtMs = account?.metadataFetchedAt ? new Date(account.metadataFetchedAt).getTime() : 0;
  if (!force && fetchedAtMs > 0 && (Date.now() - fetchedAtMs) < maxAgeMs && account.metadataSnapshot && typeof account.metadataSnapshot === 'object') {
    return { metadata: account.metadataSnapshot, cached: true };
  }
  if (metadataInFlight.has(id)) return metadataInFlight.get(id);
  const promise = refreshBaseLinkerAccountMetadata(id).then((result) => ({ ...result, cached: false })).finally(() => metadataInFlight.delete(id));
  metadataInFlight.set(id, promise);
  return promise;
}

module.exports = { normalizeMetadata, sourceCounts, validateBaseLinkerToken, refreshBaseLinkerAccountMetadata, ensureBaseLinkerAccountMetadataFresh, DEFAULT_METADATA_MAX_AGE_MS };

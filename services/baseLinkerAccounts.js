'use strict';

const crypto = require('crypto');
const BaseLinkerAccount = require('../models/BaseLinkerAccount');
const { appError } = require('../utils/errors');

const MASTER_KEY_ENV = 'BASELINKER_TOKEN_ENCRYPTION_KEY';

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function positiveStatusId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}


function statusMap(statuses = []) {
  return new Map((Array.isArray(statuses) ? statuses : [])
    .map((status) => [positiveStatusId(status?.id), status])
    .filter(([id]) => id));
}

function isDuplicateKeyError(error) {
  return Number(error?.code) === 11000;
}

function getMasterKey({ required = false } = {}) {
  const raw = clean(process.env[MASTER_KEY_ENV], 4096);
  if (!raw) {
    if (required) throw appError('baselinker_token_encryption_not_configured');
    return null;
  }
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function tokenFingerprint(token) {
  const value = clean(token, 8192);
  if (!value) return '';
  const key = getMasterKey({ required: true });
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function tokenHint(token) {
  const value = clean(token, 8192);
  return value ? `••••${value.slice(-4)}` : '';
}

function encryptToken(token, accountId) {
  const value = clean(token, 8192);
  if (!value) throw appError('baselinker_token_required');
  const id = clean(accountId, 64);
  if (!id) throw appError('baselinker_account_id_required');
  const key = getMasterKey({ required: true });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(id, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptToken(payload, accountId) {
  if (!payload || Number(payload.version) !== 1 || !payload.iv || !payload.tag || !payload.ciphertext) {
    throw appError('baselinker_token_decrypt_failed');
  }
  const id = clean(accountId, 64);
  if (!id) throw appError('baselinker_account_id_required');
  const key = getMasterKey({ required: true });
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(payload.iv), 'base64'));
    decipher.setAAD(Buffer.from(id, 'utf8'));
    decipher.setAuthTag(Buffer.from(String(payload.tag), 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(String(payload.ciphertext), 'base64')),
      decipher.final(),
    ]).toString('utf8').trim();
    if (!out) throw new Error('empty token');
    return out;
  } catch (_) {
    throw appError('baselinker_token_decrypt_failed');
  }
}

function publicAccount(account) {
  const plain = typeof account?.toObject === 'function' ? account.toObject() : (account || {});
  const queue = plain.queue || {};
  const metadata = plain.metadataSnapshot && typeof plain.metadataSnapshot === 'object' ? plain.metadataSnapshot : {};
  const byId = statusMap(metadata.statuses);
  const ids = [positiveStatusId(queue.intakeStatusId), positiveStatusId(queue.sentStatusId), positiveStatusId(queue.cancelledStatusId)];
  const resolved = ids.map((id) => byId.get(id));
  return {
    accountId: clean(plain.accountId, 64),
    name: clean(plain.name, 160),
    color: clean(plain.color, 32),
    enabled: plain.enabled === true,
    tokenHint: clean(plain.tokenHint, 16),
    queueConfigured: ids.every(Boolean) && new Set(ids).size === 3 && resolved.every(Boolean),
    queue: {
      intakeStatusId: ids[0], intakeStatusName: clean(resolved[0]?.name, 160),
      sentStatusId: ids[1], sentStatusName: clean(resolved[1]?.name, 160),
      cancelledStatusId: ids[2], cancelledStatusName: clean(resolved[2]?.name, 160),
    },
    metadataFetchedAt: plain.metadataFetchedAt || null,
    metadataSnapshot: metadata,
    lastSuccessfulSyncAt: plain.lastSuccessfulSyncAt || null,
    lastSyncError: clean(plain.lastSyncError, 500),
    lastConnectionCheckAt: plain.lastConnectionCheckAt || null,
    lastConnectionError: clean(plain.lastConnectionError, 500),
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
}

async function listBaseLinkerAccounts({ includeDisabled = true } = {}) {
  const query = includeDisabled ? {} : { enabled: true };
  const rows = await BaseLinkerAccount.find(query).sort({ createdAt: 1, accountId: 1 }).lean();
  return rows.map(publicAccount);
}

async function getBaseLinkerAccount(accountId, { requireEnabled = false, lean = false } = {}) {
  const id = clean(accountId, 64);
  if (!id) throw appError('baselinker_account_id_required');
  const query = BaseLinkerAccount.findOne({ accountId: id });
  const account = lean ? await query.lean() : await query;
  if (!account) throw appError('baselinker_account_not_found');
  if (requireEnabled && account.enabled !== true) throw appError('baselinker_account_disabled');
  return account;
}

async function getTokenForAccount(accountId, { requireEnabled = true } = {}) {
  const account = await getBaseLinkerAccount(accountId, { requireEnabled });
  const token = decryptToken(account.tokenEncrypted, account.accountId);
  if (!token) throw appError('baselinker_not_configured');
  return { account, token };
}

function buildValidatedQueue({ intakeStatusId, sentStatusId, cancelledStatusId } = {}, statuses = []) {
  const ids = [positiveStatusId(intakeStatusId), positiveStatusId(sentStatusId), positiveStatusId(cancelledStatusId)];
  if (ids.some((id) => !id) || new Set(ids).size !== 3) throw appError('baselinker_queue_settings_invalid');
  const byId = statusMap(statuses);
  const resolved = ids.map((id) => byId.get(id));
  if (resolved.some((row) => !row)) throw appError('baselinker_queue_status_unknown');
  return {
    intakeStatusId: ids[0],
    sentStatusId: ids[1],
    cancelledStatusId: ids[2],
    revision: crypto.randomUUID(),
  };
}

async function createBaseLinkerAccount({ name, color = '', token, queue, statuses = [], metadataSnapshot = {} } = {}) {
  const normalizedName = clean(name, 160);
  const rawToken = clean(token, 8192);
  if (!normalizedName) throw appError('baselinker_account_name_required');
  if (!rawToken) throw appError('baselinker_token_required');
  const validatedQueue = buildValidatedQueue(queue, statuses);
  const fingerprint = tokenFingerprint(rawToken);
  if (await BaseLinkerAccount.exists({ tokenFingerprint: fingerprint })) throw appError('baselinker_token_already_connected');
  const accountId = crypto.randomUUID();
  try {
    const doc = await BaseLinkerAccount.create({
      accountId,
      name: normalizedName,
      color: clean(color, 32),
      enabled: true,
      tokenEncrypted: encryptToken(rawToken, accountId),
      tokenFingerprint: fingerprint,
      tokenHint: tokenHint(rawToken),
      queue: validatedQueue,
      metadataSnapshot,
      metadataFetchedAt: new Date(),
      lastConnectionCheckAt: new Date(),
      lastConnectionError: '',
    });
    return publicAccount(doc);
  } catch (error) {
    if (isDuplicateKeyError(error)) throw appError('baselinker_token_already_connected');
    throw error;
  }
}

async function updateBaseLinkerAccount(accountId, patch = {}, { allowEnable = false } = {}) {
  const account = await getBaseLinkerAccount(accountId);
  if (patch.name !== undefined) {
    const name = clean(patch.name, 160);
    if (!name) throw appError('baselinker_account_name_required');
    account.name = name;
  }
  if (patch.color !== undefined) account.color = clean(patch.color, 32);
  if (patch.enabled !== undefined) {
    const nextEnabled = patch.enabled === true;
    if (nextEnabled && account.enabled !== true && allowEnable !== true) {
      throw appError('baselinker_account_enable_validation_required');
    }
    account.enabled = nextEnabled;
  }
  await account.save();
  return publicAccount(account);
}

async function rotateBaseLinkerToken(accountId, token, { confirmSameAccount = false, metadataSnapshot = {} } = {}) {
  if (confirmSameAccount !== true) throw appError('baselinker_token_rotation_confirmation_required');
  const account = await getBaseLinkerAccount(accountId);
  const rawToken = clean(token, 8192);
  if (!rawToken) throw appError('baselinker_token_required');
  const fingerprint = tokenFingerprint(rawToken);
  const duplicate = await BaseLinkerAccount.findOne({ tokenFingerprint: fingerprint, accountId: { $ne: account.accountId } }).lean();
  if (duplicate) throw appError('baselinker_token_already_connected');
  account.tokenEncrypted = encryptToken(rawToken, account.accountId);
  account.tokenFingerprint = fingerprint;
  account.tokenHint = tokenHint(rawToken);
  account.metadataSnapshot = metadataSnapshot;
  account.metadataFetchedAt = new Date();
  account.lastConnectionCheckAt = new Date();
  account.lastConnectionError = '';
  try {
    await account.save();
  } catch (error) {
    if (isDuplicateKeyError(error)) throw appError('baselinker_token_already_connected');
    throw error;
  }
  return publicAccount(account);
}

async function saveAccountQueue(accountId, { intakeStatusId, sentStatusId, cancelledStatusId, statuses = [] } = {}) {
  const account = await getBaseLinkerAccount(accountId);
  account.queue = buildValidatedQueue({ intakeStatusId, sentStatusId, cancelledStatusId }, statuses);
  await account.save();
  return publicAccount(account);
}

async function recordAccountMetadata(accountId, metadataSnapshot, { connectionError = '' } = {}) {
  const now = new Date();
  await BaseLinkerAccount.updateOne({ accountId: clean(accountId, 64) }, {
    $set: {
      ...(metadataSnapshot ? { metadataSnapshot, metadataFetchedAt: now } : {}),
      lastConnectionCheckAt: now,
      lastConnectionError: clean(connectionError, 500),
    },
  });
}

async function recordAccountSync(accountId, error = null) {
  await BaseLinkerAccount.updateOne({ accountId: clean(accountId, 64) }, {
    $set: error
      ? { lastSyncError: clean(error?.code || error?.message || error, 500) }
      : { lastSuccessfulSyncAt: new Date(), lastSyncError: '' },
  });
}

module.exports = {
  MASTER_KEY_ENV,
  listBaseLinkerAccounts,
  getBaseLinkerAccount,
  getTokenForAccount,
  publicAccount,
  createBaseLinkerAccount,
  updateBaseLinkerAccount,
  rotateBaseLinkerToken,
  saveAccountQueue,
  recordAccountMetadata,
  recordAccountSync,
  encryptToken,
  decryptToken,
  tokenFingerprint,
  buildValidatedQueue,
};

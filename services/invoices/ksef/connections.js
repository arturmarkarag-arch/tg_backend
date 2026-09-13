'use strict';

const crypto = require('crypto');
const KsefConnection = require('../../../models/KsefConnection');
const LegalEntity = require('../../../models/LegalEntity');
const { appError } = require('../../../utils/errors');
const { normalizeEnvironment } = require('./config');
const { encryptSecret, decryptSecret, fingerprint, hint } = require('./secretStore');

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }

function publicConnection(value) {
  const row = typeof value?.toObject === 'function' ? value.toObject() : (value || {});
  return {
    connectionId: clean(row.connectionId, 64),
    legalEntityId: row.legalEntityId ? String(row.legalEntityId) : '',
    environment: clean(row.environment, 20),
    enabled: row.enabled === true,
    authMethod: row.authMethod || 'token',
    tokenHint: row.tokenHint || '',
    lastAuthAt: row.lastAuthAt || null,
    lastConnectionCheckAt: row.lastConnectionCheckAt || null,
    lastConnectionError: row.lastConnectionError || '',
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function assertLegalEntity(legalEntityId) {
  const entity = await LegalEntity.findById(legalEntityId);
  if (!entity) throw appError('legal_entity_not_found');
  if (!entity.isActive) throw appError('legal_entity_inactive');
  if (entity.countryCode !== 'PL' || entity.taxIdType !== 'nip' || !entity.taxId) throw appError('ksef_legal_entity_nip_required');
  return entity;
}

async function createConnection({ legalEntityId, environment, token, enabled = true } = {}) {
  const env = normalizeEnvironment(environment);
  const entity = await assertLegalEntity(legalEntityId);
  const rawToken = clean(token, 16384);
  if (!rawToken) throw appError('ksef_token_required');
  const connectionId = crypto.randomUUID();
  try {
    const doc = await KsefConnection.create({
      connectionId,
      legalEntityId: entity._id,
      environment: env,
      enabled: enabled !== false,
      authMethod: 'token',
      tokenEncrypted: encryptSecret(rawToken, connectionId, 'ksef-token'),
      tokenFingerprint: fingerprint(rawToken),
      tokenHint: hint(rawToken),
    });
    return publicConnection(doc);
  } catch (error) {
    if (Number(error?.code) === 11000) throw appError('ksef_connection_already_exists');
    throw error;
  }
}

async function getConnection(connectionId, { includeSecrets = false, requireEnabled = false } = {}) {
  const id = clean(connectionId, 64);
  if (!id) throw appError('ksef_connection_id_required');
  let query = KsefConnection.findOne({ connectionId: id });
  if (includeSecrets) query = query.select('+tokenEncrypted +tokenFingerprint +accessTokenEncrypted +accessTokenValidUntil +refreshTokenEncrypted +refreshTokenValidUntil');
  const connection = await query;
  if (!connection) throw appError('ksef_connection_not_found');
  if (requireEnabled && connection.enabled !== true) throw appError('ksef_connection_disabled');
  return connection;
}

async function getConnectionForLegalEntity(legalEntityId, environment, { includeSecrets = false, requireEnabled = true } = {}) {
  const env = normalizeEnvironment(environment);
  let query = KsefConnection.findOne({ legalEntityId, environment: env });
  if (includeSecrets) query = query.select('+tokenEncrypted +tokenFingerprint +accessTokenEncrypted +accessTokenValidUntil +refreshTokenEncrypted +refreshTokenValidUntil');
  const connection = await query;
  if (!connection) throw appError('ksef_connection_not_found');
  if (requireEnabled && connection.enabled !== true) throw appError('ksef_connection_disabled');
  return connection;
}

async function listConnections({ legalEntityId = '', includeDisabled = true } = {}) {
  const filter = {};
  if (legalEntityId) filter.legalEntityId = legalEntityId;
  if (!includeDisabled) filter.enabled = true;
  const rows = await KsefConnection.find(filter).sort({ legalEntityId: 1, environment: 1 }).lean();
  return rows.map(publicConnection);
}

async function updateConnection(connectionId, patch = {}) {
  const connection = await getConnection(connectionId);
  if (patch.enabled !== undefined) connection.enabled = patch.enabled === true;
  await connection.save();
  return publicConnection(connection);
}

async function rotateToken(connectionId, token) {
  const connection = await getConnection(connectionId, { includeSecrets: true });
  const rawToken = clean(token, 16384);
  if (!rawToken) throw appError('ksef_token_required');
  connection.tokenEncrypted = encryptSecret(rawToken, connection.connectionId, 'ksef-token');
  connection.tokenFingerprint = fingerprint(rawToken);
  connection.tokenHint = hint(rawToken);
  connection.accessTokenEncrypted = undefined;
  connection.accessTokenValidUntil = null;
  connection.refreshTokenEncrypted = undefined;
  connection.refreshTokenValidUntil = null;
  connection.lastAuthAt = null;
  connection.lastConnectionError = '';
  await connection.save();
  return publicConnection(connection);
}

function decryptKsefToken(connection) { return decryptSecret(connection.tokenEncrypted, connection.connectionId, 'ksef-token'); }
function decryptAccessToken(connection) { return connection.accessTokenEncrypted ? decryptSecret(connection.accessTokenEncrypted, connection.connectionId, 'access-token') : ''; }
function decryptRefreshToken(connection) { return connection.refreshTokenEncrypted ? decryptSecret(connection.refreshTokenEncrypted, connection.connectionId, 'refresh-token') : ''; }

async function saveSessionTokens(connection, { accessToken, accessTokenValidUntil, refreshToken = '', refreshTokenValidUntil = null } = {}) {
  if (!accessToken) throw appError('ksef_auth_response_invalid');
  connection.accessTokenEncrypted = encryptSecret(accessToken, connection.connectionId, 'access-token');
  connection.accessTokenValidUntil = accessTokenValidUntil ? new Date(accessTokenValidUntil) : null;
  if (refreshToken) {
    connection.refreshTokenEncrypted = encryptSecret(refreshToken, connection.connectionId, 'refresh-token');
    connection.refreshTokenValidUntil = refreshTokenValidUntil ? new Date(refreshTokenValidUntil) : null;
  }
  connection.lastAuthAt = new Date();
  connection.lastConnectionCheckAt = new Date();
  connection.lastConnectionError = '';
  await connection.save();
}

async function recordConnectionError(connectionId, error) {
  await KsefConnection.updateOne({ connectionId }, { $set: { lastConnectionCheckAt: new Date(), lastConnectionError: clean(error?.message || error, 1000) } });
}

module.exports = {
  publicConnection, createConnection, getConnection, getConnectionForLegalEntity, listConnections, updateConnection, rotateToken,
  decryptKsefToken, decryptAccessToken, decryptRefreshToken, saveSessionTokens, recordConnectionError,
};

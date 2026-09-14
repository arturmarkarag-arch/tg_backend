'use strict';

const { appError } = require('../../../utils/errors');
const { getAccessToken } = require('./auth');
const { getConnection } = require('./connections');
const { getXadesAccessToken } = require('./xadesAuth');
const { getXadesCredential } = require('./xadesCredentials');

function idsEqual(left, right) { return String(left || '') === String(right || ''); }

async function validateInboundAuthBinding({ legalEntityId, environment, authMethod, authRefId }) {
  if (authMethod === 'token_connection') {
    const connection = await getConnection(authRefId, { requireEnabled: true });
    if (!idsEqual(connection.legalEntityId, legalEntityId) || connection.environment !== environment) {
      throw appError('ksef_inbound_auth_scope_mismatch');
    }
    return { authMethod, authRefId: connection.connectionId, environment: connection.environment };
  }
  if (authMethod === 'xades') {
    const credential = await getXadesCredential(authRefId, { requireEnabled: true, requireUsable: true });
    if (credential.environment !== environment) throw appError('ksef_inbound_auth_scope_mismatch');
    return { authMethod, authRefId: credential.credentialId, environment: credential.environment };
  }
  throw appError('ksef_inbound_auth_method_invalid');
}

async function resolveInboundAccessToken(sync) {
  if (!sync) throw appError('ksef_inbound_sync_not_found');
  await validateInboundAuthBinding(sync);
  if (sync.authMethod === 'token_connection') {
    const result = await getAccessToken(sync.authRefId);
    return { accessToken: result.accessToken, environment: result.connection.environment, authMethod: sync.authMethod };
  }
  if (sync.authMethod === 'xades') {
    const result = await getXadesAccessToken(sync.authRefId, sync.legalEntityId);
    return { accessToken: result.accessToken, environment: result.credential.environment, authMethod: sync.authMethod };
  }
  throw appError('ksef_inbound_auth_method_invalid');
}

module.exports = { validateInboundAuthBinding, resolveInboundAccessToken };

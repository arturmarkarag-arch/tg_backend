'use strict';

const { appError } = require('../utils/errors');
const {
  listBaseLinkerAccounts,
  getBaseLinkerAccount,
  saveAccountQueue,
} = require('./baseLinkerAccounts');
const { makeBaseLinkerAccountCaller } = require('./baseLinkerClient');

const HISTORY_RETENTION_DAYS = 14;

function positiveStatusId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function queueScopeFromSettings(value = {}, _now = Date.now(), account = {}) {
  const intakeStatusId = positiveStatusId(value.intakeStatusId);
  const sentStatusId = positiveStatusId(value.sentStatusId);
  const cancelledStatusId = positiveStatusId(value.cancelledStatusId);
  const ids = [intakeStatusId, sentStatusId, cancelledStatusId];
  const distinct = new Set(ids.filter(Boolean)).size === 3;
  const statusById = new Map((Array.isArray(account?.metadataSnapshot?.statuses) ? account.metadataSnapshot.statuses : [])
    .map((status) => [positiveStatusId(status?.id), status])
    .filter(([id]) => id));
  const resolved = ids.map((id) => statusById.get(id));
  const configured = Boolean(ids.every(Boolean) && distinct && resolved.every(Boolean));
  const accountId = String(account?.accountId || '').trim();
  if (!accountId) throw appError('baselinker_account_id_required');

  return {
    baseLinkerAccountId: accountId,
    accountName: String(account?.name || ''),
    accountEnabled: account?.enabled === true,
    configured,
    intakeStatusId,
    intakeStatusName: String(resolved[0]?.name || ''),
    sentStatusId,
    sentStatusName: String(resolved[1]?.name || ''),
    cancelledStatusId,
    cancelledStatusName: String(resolved[2]?.name || ''),
    historyRetentionDays: HISTORY_RETENTION_DAYS,
    scopeKey: configured
      ? `${accountId}|${intakeStatusId}|${sentStatusId}|${cancelledStatusId}|${value.revision || ''}`
      : null,
  };
}

async function getQueueScope(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  const account = await getBaseLinkerAccount(id, { lean: true });
  return queueScopeFromSettings(account.queue || {}, Date.now(), account);
}

async function getAllQueueScopes({ enabledOnly = true } = {}) {
  const accounts = await listBaseLinkerAccounts({ includeDisabled: !enabledOnly });
  return accounts.map((account) => queueScopeFromSettings(account.queue || {}, Date.now(), account));
}

function orderInIntakeScope(order, scope) {
  return scope?.configured && Number(order?.order_status_id) === scope.intakeStatusId;
}
function orderInSentScope(order, scope) {
  return scope?.configured && Number(order?.order_status_id) === scope.sentStatusId;
}
function orderInCancelledScope(order, scope) {
  return scope?.configured && Number(order?.order_status_id) === scope.cancelledStatusId;
}
function orderInQueueScope(order, scope) {
  return orderInIntakeScope(order, scope) || orderInSentScope(order, scope) || orderInCancelledScope(order, scope);
}
function classifyUpstreamOrder(order, scope) {
  const statusId = Number(order?.order_status_id);
  if (!scope?.configured || !Number.isSafeInteger(statusId)) return 'other';
  if (statusId === scope.cancelledStatusId) return 'cancelled';
  if (statusId === scope.sentStatusId) return 'sent';
  if (statusId === scope.intakeStatusId) return 'intake';
  return 'other';
}

async function getQueueStatusOptions(accountId) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  const payload = await makeBaseLinkerAccountCaller(id)('getOrderStatusList', {});
  if (!Array.isArray(payload.statuses)) throw appError('baselinker_invalid_response', { upstreamMethod: 'getOrderStatusList' });
  return payload.statuses.map((status) => ({ id: Number(status.id), name: String(status.name || ''), color: String(status.color || '') }))
    .filter((status) => Number.isSafeInteger(status.id) && status.id > 0);
}

async function saveQueueSettings(accountId, { intakeStatusId, sentStatusId, cancelledStatusId } = {}) {
  const id = String(accountId || '').trim();
  if (!id) throw appError('baselinker_account_id_required');
  // Queue changes are rare admin operations. Refresh all API-derived metadata so
  // the selected status IDs and future source/inventory labels share one snapshot.
  const { refreshBaseLinkerAccountMetadata } = require('./baseLinkerAccountValidation');
  const validation = await refreshBaseLinkerAccountMetadata(id);
  await saveAccountQueue(id, {
    intakeStatusId,
    sentStatusId,
    cancelledStatusId,
    statuses: validation.metadata.statuses,
  });
  const updated = await getBaseLinkerAccount(id, { lean: true });
  return queueScopeFromSettings(updated.queue || {}, Date.now(), updated);
}

module.exports = {
  HISTORY_RETENTION_DAYS,
  queueScopeFromSettings,
  getQueueScope,
  getAllQueueScopes,
  orderInIntakeScope,
  orderInSentScope,
  orderInCancelledScope,
  orderInQueueScope,
  classifyUpstreamOrder,
  getQueueStatusOptions,
  saveQueueSettings,
};

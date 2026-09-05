'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const { callBaseLinker } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');
const {
  getBaseLinkerAccountScope,
  scopedSettingKey,
} = require('./baseLinkerAccount');

const QUEUE_SETTINGS_KEY = 'baselinker.queueSettings.v1';
const SENT_LOOKBACK_DAYS = 30;

function positiveStatusId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function queueScopeFromSettings(value = {}, now = Date.now(), accountScope = getBaseLinkerAccountScope()) {
  // Backward compatibility: the former single statusId becomes the intake
  // status after deployment. Sent/cancelled must still be chosen explicitly.
  const intakeStatusId = positiveStatusId(value.intakeStatusId ?? value.statusId);
  const sentStatusId = positiveStatusId(value.sentStatusId);
  const cancelledStatusId = positiveStatusId(value.cancelledStatusId);
  const distinct = new Set([intakeStatusId, sentStatusId, cancelledStatusId].filter(Boolean)).size === 3;
  const configured = Boolean(intakeStatusId && sentStatusId && cancelledStatusId && distinct);
  const sentDateConfirmedFrom = Math.floor(now / 1000) - SENT_LOOKBACK_DAYS * 86400;

  return {
    accountScope,
    configured,
    intakeStatusId,
    intakeStatusName: String(value.intakeStatusName ?? value.statusName ?? ''),
    sentStatusId,
    sentStatusName: String(value.sentStatusName || ''),
    cancelledStatusId,
    cancelledStatusName: String(value.cancelledStatusName || ''),
    sentLookbackDays: SENT_LOOKBACK_DAYS,
    sentDateConfirmedFrom,
    scopeKey: configured
      ? `${accountScope}|${intakeStatusId}:all|${sentStatusId}:${SENT_LOOKBACK_DAYS}|${cancelledStatusId}:${value.revision || 'settings-v2'}`
      : null,
  };
}

async function getQueueScope() {
  const accountScope = getBaseLinkerAccountScope();
  const row = await AppSetting.findOne({ key: scopedSettingKey(QUEUE_SETTINGS_KEY, accountScope) }).lean();
  return queueScopeFromSettings(row?.value || {}, Date.now(), accountScope);
}

function orderIsConfirmed(order) {
  return order?.confirmed !== false;
}

function orderInIntakeScope(order, scope) {
  return scope.configured
    && Number(order?.order_status_id) === scope.intakeStatusId;
}

function orderInSentScope(order, scope) {
  return scope.configured
    && Number(order?.order_status_id) === scope.sentStatusId
    && orderIsConfirmed(order)
    && Number(order?.date_confirmed) >= scope.sentDateConfirmedFrom;
}

function orderInQueueScope(order, scope) {
  return orderInIntakeScope(order, scope) || orderInSentScope(order, scope);
}

function classifyUpstreamOrder(order, scope) {
  const statusId = Number(order?.order_status_id);
  if (!scope?.configured || !Number.isSafeInteger(statusId)) return 'other';
  if (statusId === scope.cancelledStatusId) return 'cancelled';
  if (statusId === scope.sentStatusId) return 'sent';
  if (statusId === scope.intakeStatusId) return 'intake';
  return 'other';
}

async function getQueueStatusOptions() {
  const payload = await callBaseLinker('getOrderStatusList', {});
  if (!Array.isArray(payload.statuses)) throw appError('baselinker_invalid_response', { upstreamMethod: 'getOrderStatusList' });
  return payload.statuses.map((status) => ({ id: Number(status.id), name: String(status.name || '') }))
    .filter((status) => Number.isSafeInteger(status.id) && status.id > 0);
}

async function saveQueueSettings({ intakeStatusId, sentStatusId, cancelledStatusId } = {}) {
  const accountScope = getBaseLinkerAccountScope();
  const ids = [positiveStatusId(intakeStatusId), positiveStatusId(sentStatusId), positiveStatusId(cancelledStatusId)];
  if (ids.some((id) => !id) || new Set(ids).size !== 3) throw appError('baselinker_queue_settings_invalid');

  const options = await getQueueStatusOptions();
  const byId = new Map(options.map((option) => [option.id, option]));
  const [intake, sent, cancelled] = ids.map((id) => byId.get(id));
  if (!intake || !sent || !cancelled) throw appError('baselinker_queue_status_unknown');

  const value = {
    intakeStatusId: intake.id,
    intakeStatusName: intake.name,
    sentStatusId: sent.id,
    sentStatusName: sent.name,
    cancelledStatusId: cancelled.id,
    cancelledStatusName: cancelled.name,
    sentLookbackDays: SENT_LOOKBACK_DAYS,
    revision: crypto.randomUUID(),
  };
  await AppSetting.findOneAndUpdate(
    { key: scopedSettingKey(QUEUE_SETTINGS_KEY, accountScope) },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return queueScopeFromSettings(value, Date.now(), accountScope);
}

module.exports = {
  QUEUE_SETTINGS_KEY,
  SENT_LOOKBACK_DAYS,
  queueScopeFromSettings,
  getQueueScope,
  orderInIntakeScope,
  orderInSentScope,
  orderInQueueScope,
  classifyUpstreamOrder,
  getQueueStatusOptions,
  saveQueueSettings,
};

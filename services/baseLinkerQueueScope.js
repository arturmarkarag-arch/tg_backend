'use strict';

const crypto = require('crypto');
const AppSetting = require('../models/AppSetting');
const { callBaseLinker } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');

const QUEUE_SETTINGS_KEY = 'baselinker.queueSettings.v1';
const HISTORY_LOOKBACK_DAYS = 14;
const SENT_LOOKBACK_DAYS = HISTORY_LOOKBACK_DAYS;
const CANCELLED_LOOKBACK_DAYS = HISTORY_LOOKBACK_DAYS;

function positiveStatusId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function queueScopeFromSettings(value = {}, now = Date.now()) {
  // Backward compatibility: the former single statusId becomes the intake
  // status after deployment. Sent/cancelled must still be chosen explicitly.
  const intakeStatusId = positiveStatusId(value.intakeStatusId ?? value.statusId);
  const sentStatusId = positiveStatusId(value.sentStatusId);
  const cancelledStatusId = positiveStatusId(value.cancelledStatusId);
  const distinct = new Set([intakeStatusId, sentStatusId, cancelledStatusId].filter(Boolean)).size === 3;
  const configured = Boolean(intakeStatusId && sentStatusId && cancelledStatusId && distinct);
  const sentDateInStatusFrom = Math.floor(now / 1000) - SENT_LOOKBACK_DAYS * 86400;
  const cancelledDateInStatusFrom = Math.floor(now / 1000) - CANCELLED_LOOKBACK_DAYS * 86400;

  return {
    configured,
    intakeStatusId,
    intakeStatusName: String(value.intakeStatusName ?? value.statusName ?? ''),
    sentStatusId,
    sentStatusName: String(value.sentStatusName || ''),
    cancelledStatusId,
    cancelledStatusName: String(value.cancelledStatusName || ''),
    historyLookbackDays: HISTORY_LOOKBACK_DAYS,
    sentLookbackDays: SENT_LOOKBACK_DAYS,
    cancelledLookbackDays: CANCELLED_LOOKBACK_DAYS,
    sentDateInStatusFrom,
    cancelledDateInStatusFrom,
    scopeKey: configured
      ? `${intakeStatusId}:confirmed|${sentStatusId}:${SENT_LOOKBACK_DAYS}|${cancelledStatusId}:${CANCELLED_LOOKBACK_DAYS}|${value.revision || 'settings-v3'}`
      : null,
  };
}

async function getQueueScope() {
  const row = await AppSetting.findOne({ key: QUEUE_SETTINGS_KEY }).lean();
  return queueScopeFromSettings(row?.value || {}, Date.now());
}

function orderIsConfirmed(order) {
  return order?.confirmed !== false;
}

function orderInIntakeScope(order, scope) {
  return scope.configured
    && orderIsConfirmed(order)
    && Number(order?.order_status_id) === scope.intakeStatusId;
}

function orderInSentScope(order, scope) {
  return scope.configured
    && orderIsConfirmed(order)
    && Number(order?.order_status_id) === scope.sentStatusId
    && Number(order?.date_in_status) >= scope.sentDateInStatusFrom;
}

function orderInCancelledScope(order, scope) {
  return scope.configured
    && orderIsConfirmed(order)
    && Number(order?.order_status_id) === scope.cancelledStatusId
    && Number(order?.date_in_status) >= scope.cancelledDateInStatusFrom;
}

function orderInQueueScope(order, scope) {
  return orderInIntakeScope(order, scope)
    || orderInSentScope(order, scope)
    || orderInCancelledScope(order, scope);
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
    historyLookbackDays: HISTORY_LOOKBACK_DAYS,
    sentLookbackDays: SENT_LOOKBACK_DAYS,
    cancelledLookbackDays: CANCELLED_LOOKBACK_DAYS,
    revision: crypto.randomUUID(),
  };
  await AppSetting.findOneAndUpdate(
    { key: QUEUE_SETTINGS_KEY },
    { $set: { value } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return queueScopeFromSettings(value, Date.now());
}

module.exports = {
  QUEUE_SETTINGS_KEY,
  HISTORY_LOOKBACK_DAYS,
  SENT_LOOKBACK_DAYS,
  CANCELLED_LOOKBACK_DAYS,
  queueScopeFromSettings,
  getQueueScope,
  orderInIntakeScope,
  orderInSentScope,
  orderInCancelledScope,
  orderInQueueScope,
  classifyUpstreamOrder,
  getQueueStatusOptions,
  saveQueueSettings,
};

'use strict';

const { callBaseLinker } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');

function positiveInt(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw appError(code);
  return parsed;
}

async function setBaseLinkerOrderStatus({ orderId, statusId }, callApi = callBaseLinker) {
  const order = positiveInt(orderId, 'baselinker_order_id_invalid');
  const status = positiveInt(statusId, 'baselinker_status_id_invalid');
  await callApi('setOrderStatus', { order_id: order, status_id: status });
  return { orderId: order, statusId: status };
}

module.exports = { setBaseLinkerOrderStatus };

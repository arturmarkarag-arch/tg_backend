const { callBaseLinker } = require('./baseLinkerClient');
const { appError } = require('../utils/errors');

const MAX_LABEL_BYTES = Math.max(1024 * 1024, Number(process.env.BASELINKER_MAX_LABEL_BYTES) || (20 * 1024 * 1024));
const LABEL_CONTENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  gif: 'image/gif',
  html: 'text/html; charset=utf-8',
  zpl: 'text/plain; charset=utf-8',
  epl: 'text/plain; charset=utf-8',
  dpl: 'text/plain; charset=utf-8',
};

function positiveInt(value, errorCode) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw appError(errorCode);
  return parsed;
}

function courierCode(value) {
  const code = String(value || '').trim();
  if (!code || code.length > 64) throw appError('baselinker_courier_code_invalid');
  return code;
}

async function fetchBaseLinkerOrderPackages(orderId, callApi = callBaseLinker) {
  const id = positiveInt(orderId, 'baselinker_order_id_invalid');
  const payload = await callApi('getOrderPackages', { order_id: id });
  return {
    orderId: id,
    packages: Array.isArray(payload?.packages) ? payload.packages : [],
  };
}

async function fetchBaseLinkerPackageDetails(packageId, callApi = callBaseLinker) {
  const id = positiveInt(packageId, 'baselinker_package_id_invalid');
  const payload = await callApi('getPackageDetails', { package_id: id });
  return {
    packageId: id,
    packageDetails: Array.isArray(payload?.package_details) ? payload.package_details : [],
  };
}

async function fetchBaseLinkerLabel({ packageId, courierCode: rawCourierCode }, callApi = callBaseLinker) {
  const id = positiveInt(packageId, 'baselinker_package_id_invalid');
  const code = courierCode(rawCourierCode);
  const payload = await callApi('getLabel', {
    courier_code: code,
    package_id: id,
  });

  const extension = String(payload?.extension || '').trim().toLowerCase();
  const base64 = String(payload?.label || '').trim();
  if (!extension || !base64) throw appError('baselinker_label_invalid');

  // A base64 payload is ~4/3 of the decoded bytes. Reject obviously oversized
  // upstream responses before allocating the decoded Buffer.
  const estimatedBytes = Math.floor((base64.length * 3) / 4);
  if (estimatedBytes > MAX_LABEL_BYTES) throw appError('baselinker_label_too_large');

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    throw appError('baselinker_label_invalid');
  }
  if (!buffer.length) throw appError('baselinker_label_invalid');
  if (buffer.length > MAX_LABEL_BYTES) throw appError('baselinker_label_too_large');

  return {
    packageId: id,
    courierCode: code,
    extension,
    contentType: LABEL_CONTENT_TYPES[extension] || 'application/octet-stream',
    buffer,
  };
}

module.exports = {
  fetchBaseLinkerOrderPackages,
  fetchBaseLinkerPackageDetails,
  fetchBaseLinkerLabel,
};

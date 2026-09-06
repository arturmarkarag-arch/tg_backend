'use strict';

const { appError } = require('../utils/errors');
const { redis, isReady: isRedisReady } = require('../utils/redis');

const BASELINKER_API_URL = process.env.BASELINKER_API_URL || 'https://api.baselinker.com/connector.php';
const BASELINKER_TIMEOUT_MS = Math.min(30000, Math.max(3000, Number(process.env.BASELINKER_TIMEOUT_MS) || 15000));
// Official BaseLinker limit is 100 requests/minute/token. Keep headroom for
// retries and manual operations. Budget is isolated by OUR account UUID.
const BASELINKER_REQUEST_BUDGET_PER_MINUTE = Math.min(95, Math.max(30, Number(process.env.BASELINKER_REQUEST_BUDGET_PER_MINUTE) || 90));
const localBudget = new Map();

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

async function reserveApiBudget(accountId) {
  const identity = clean(accountId, 96);
  if (!identity) throw appError('baselinker_account_id_required');
  const bucket = Math.floor(Date.now() / 60_000);
  const retryAfterMs = Math.max(1000, ((bucket + 1) * 60_000) - Date.now());

  if (isRedisReady()) {
    const key = `baselinker:api-budget:${identity}:${bucket}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.pexpire(key, 70_000);
    if (count > BASELINKER_REQUEST_BUDGET_PER_MINUTE) throw appError('baselinker_rate_budget_exhausted', { retryAfterMs });
    return;
  }

  const current = localBudget.get(identity);
  if (!current || current.bucket !== bucket) {
    localBudget.set(identity, { bucket, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > BASELINKER_REQUEST_BUDGET_PER_MINUTE) throw appError('baselinker_rate_budget_exhausted', { retryAfterMs });
}

async function callBaseLinkerWithToken(method, parameters = {}, token, { accountId } = {}) {
  const secret = String(token || '').trim();
  const id = clean(accountId, 96);
  if (!secret) throw appError('baselinker_not_configured');
  if (!id) throw appError('baselinker_account_id_required');
  await reserveApiBudget(id);

  const upstreamMethod = clean(method, 80) || 'unknown';
  const body = new URLSearchParams();
  body.set('method', upstreamMethod);
  body.set('parameters', JSON.stringify(parameters || {}));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BASELINKER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(BASELINKER_API_URL, {
      method: 'POST',
      headers: {
        'X-BLToken': secret,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw appError('baselinker_timeout', { upstreamMethod });
    throw appError('baselinker_network_error', { upstreamMethod, upstreamMessage: clean(error?.message) });
  } finally {
    clearTimeout(timer);
  }

  let rawText = '';
  let payload = null;
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch (_) {
    payload = null;
  }

  if (!response.ok) {
    throw appError('baselinker_http_error', {
      upstreamMethod,
      upstreamStatus: response.status,
      upstreamCode: clean(payload?.error_code, 120),
      upstreamMessage: clean(payload?.error_message || rawText),
    });
  }
  if (!payload || typeof payload !== 'object') throw appError('baselinker_invalid_response', { upstreamMethod, upstreamStatus: response.status });
  if (payload.status !== 'SUCCESS') {
    throw appError('baselinker_api_error', {
      upstreamMethod,
      upstreamCode: clean(payload?.error_code, 120),
      upstreamMessage: clean(payload?.error_message),
    });
  }
  return payload;
}

async function callBaseLinkerForAccount(accountId, method, parameters = {}, options = {}) {
  const id = clean(accountId, 96);
  if (!id) throw appError('baselinker_account_id_required');
  const { getTokenForAccount } = require('./baseLinkerAccounts');
  const { token } = await getTokenForAccount(id, { requireEnabled: options.requireEnabled !== false });
  return callBaseLinkerWithToken(method, parameters, token, { accountId: id });
}

function makeBaseLinkerAccountCaller(accountId, options = {}) {
  const id = clean(accountId, 96);
  if (!id) throw appError('baselinker_account_id_required');
  return (method, parameters = {}) => callBaseLinkerForAccount(id, method, parameters, options);
}

module.exports = {
  BASELINKER_REQUEST_BUDGET_PER_MINUTE,
  callBaseLinkerWithToken,
  callBaseLinkerForAccount,
  makeBaseLinkerAccountCaller,
};

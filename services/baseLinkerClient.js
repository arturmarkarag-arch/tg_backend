'use strict';

const crypto = require('crypto');
const { appError } = require('../utils/errors');
const { redis, isReady: isRedisReady } = require('../utils/redis');

const BASELINKER_API_URL = process.env.BASELINKER_API_URL || 'https://api.baselinker.com/connector.php';
const BASELINKER_TIMEOUT_MS = Math.min(30000, Math.max(3000, Number(process.env.BASELINKER_TIMEOUT_MS) || 15000));
// BaseLinker documents 100 requests/minute/token. Keep explicit headroom for
// retries/manual actions and enforce it over a TRUE rolling 60-second window.
const BASELINKER_REQUEST_BUDGET_PER_MINUTE = Math.min(95, Math.max(30, Number(process.env.BASELINKER_REQUEST_BUDGET_PER_MINUTE) || 90));
const USAGE_WINDOW_MS = 60_000;
const USAGE_RETENTION_MS = 120_000;
const localUsageByAccount = new Map();

const RESERVE_ROLLING_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 1000
  if oldest[2] then retryAfter = math.max(1000, tonumber(oldest[2]) + 60000 - now) end
  return {0, count, retryAfter}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, ttl)
return {1, count + 1, 0}
`;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}
function usageKey(accountId) { return `baselinker:api-usage:v1:${clean(accountId, 96)}`; }
function usageMember({ now, method, stage }) {
  return `${now}|${crypto.randomUUID()}|${encodeURIComponent(clean(method, 80) || 'unknown')}|${encodeURIComponent(clean(stage, 100) || 'other')}`;
}
function parseUsageMember(member) {
  const parts = String(member || '').split('|');
  return {
    at: Number(parts[0] || 0),
    method: decodeURIComponent(parts[2] || 'unknown'),
    stage: decodeURIComponent(parts[3] || 'other'),
  };
}
function pruneLocalUsage(accountId, now = Date.now()) {
  const id = clean(accountId, 96);
  const cutoff = now - USAGE_WINDOW_MS;
  const current = (localUsageByAccount.get(id) || []).filter((event) => Number(event.at || 0) > cutoff);
  if (current.length) localUsageByAccount.set(id, current); else localUsageByAccount.delete(id);
  return current;
}

async function reserveApiBudget(accountId, { method = 'unknown', usageStage = 'other' } = {}) {
  const identity = clean(accountId, 96);
  if (!identity) throw appError('baselinker_account_id_required');
  const now = Date.now();
  const stage = clean(usageStage, 100) || 'other';
  const upstreamMethod = clean(method, 80) || 'unknown';

  if (isRedisReady()) {
    const member = usageMember({ now, method: upstreamMethod, stage });
    const result = await redis.eval(
      RESERVE_ROLLING_SCRIPT,
      1,
      usageKey(identity),
      now,
      now - USAGE_WINDOW_MS,
      member,
      BASELINKER_REQUEST_BUDGET_PER_MINUTE,
      USAGE_RETENTION_MS,
    );
    if (Number(result?.[0] || 0) !== 1) {
      throw appError('baselinker_rate_budget_exhausted', { retryAfterMs: Number(result?.[2] || 1000) });
    }
    return Number(result?.[1] || 0);
  }

  const current = pruneLocalUsage(identity, now);
  if (current.length >= BASELINKER_REQUEST_BUDGET_PER_MINUTE) {
    const oldestAt = Number(current[0]?.at || now);
    throw appError('baselinker_rate_budget_exhausted', { retryAfterMs: Math.max(1000, oldestAt + USAGE_WINDOW_MS - now) });
  }
  current.push({ at: now, method: upstreamMethod, stage });
  localUsageByAccount.set(identity, current);
  return current.length;
}

function summarizeUsage(events) {
  const byMethod = {};
  const byStage = {};
  for (const event of events) {
    const method = clean(event?.method, 80) || 'unknown';
    const stage = clean(event?.stage, 100) || 'other';
    byMethod[method] = Number(byMethod[method] || 0) + 1;
    byStage[stage] = Number(byStage[stage] || 0) + 1;
  }
  return { count: events.length, byMethod, byStage };
}

async function getBaseLinkerApiUsage(accountIds = []) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((value) => clean(value, 96)).filter(Boolean))];
  const now = Date.now();
  const cutoff = now - USAGE_WINDOW_MS;
  const accounts = [];
  for (const accountId of ids) {
    let events = [];
    if (isRedisReady()) {
      const members = await redis.zrangebyscore(usageKey(accountId), cutoff + 1, now);
      events = members.map(parseUsageMember).filter((event) => Number(event.at || 0) > cutoff);
    } else {
      events = pruneLocalUsage(accountId, now);
    }
    accounts.push({
      baseLinkerAccountId: accountId,
      budget: BASELINKER_REQUEST_BUDGET_PER_MINUTE,
      windowSeconds: 60,
      ...summarizeUsage(events),
    });
  }
  return { windowSeconds: 60, budgetPerAccount: BASELINKER_REQUEST_BUDGET_PER_MINUTE, accounts, measuredAt: new Date(now).toISOString() };
}

async function callBaseLinkerWithToken(method, parameters = {}, token, { accountId, usageStage = 'other' } = {}) {
  const secret = String(token || '').trim();
  const id = clean(accountId, 96);
  if (!secret) throw appError('baselinker_not_configured');
  if (!id) throw appError('baselinker_account_id_required');

  const upstreamMethod = clean(method, 80) || 'unknown';
  await reserveApiBudget(id, { method: upstreamMethod, usageStage });

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
  return callBaseLinkerWithToken(method, parameters, token, { accountId: id, usageStage: options.usageStage || 'other' });
}

function makeBaseLinkerAccountCaller(accountId, options = {}) {
  const id = clean(accountId, 96);
  if (!id) throw appError('baselinker_account_id_required');
  return (method, parameters = {}, callOptions = {}) => callBaseLinkerForAccount(id, method, parameters, { ...options, ...callOptions });
}

module.exports = {
  BASELINKER_REQUEST_BUDGET_PER_MINUTE,
  USAGE_WINDOW_MS,
  reserveApiBudget,
  getBaseLinkerApiUsage,
  callBaseLinkerWithToken,
  callBaseLinkerForAccount,
  makeBaseLinkerAccountCaller,
};

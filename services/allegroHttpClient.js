'use strict';

const { parseOptionalNonNegativeNumber, retryDelayMs } = require('./allegroRuntimePolicy');

const crypto = require('crypto');
const AllegroAccount = require('../models/AllegroAccount');
const AllegroApiErrorLog = require('../models/AllegroApiErrorLog');
const { appError } = require('../utils/errors');
const { redis, isReady: isRedisReady } = require('../utils/redis');
const { oauthConfiguration } = require('./allegroOAuth');

const OFFICIAL_APP_LIMIT_PER_MINUTE = 9000;
const APP_REQUEST_BUDGET_PER_MINUTE = Math.min(
  8950,
  Math.max(100, Number(process.env.ALLEGRO_REQUEST_BUDGET_PER_MINUTE) || 8500),
);
const HTTP_TIMEOUT_MS = Math.min(60_000, Math.max(3_000, Number(process.env.ALLEGRO_HTTP_TIMEOUT_MS) || 15_000));
const ACCOUNT_MAX_CONCURRENCY = Math.min(20, Math.max(1, Number(process.env.ALLEGRO_ACCOUNT_MAX_CONCURRENCY) || 4));
const LOCAL_FALLBACK_BUDGET_PER_MINUTE = Math.min(APP_REQUEST_BUDGET_PER_MINUTE, Math.max(100, Number(process.env.ALLEGRO_LOCAL_FALLBACK_BUDGET_PER_MINUTE) || 1000));
const MAX_INLINE_RETRY_DELAY_MS = Math.min(10_000, Math.max(0, Number(process.env.ALLEGRO_MAX_INLINE_RETRY_DELAY_MS) || 2_500));
const ERROR_RETENTION_DAYS = Math.min(90, Math.max(1, Number(process.env.ALLEGRO_ERROR_RETENTION_DAYS) || 14));
const USAGE_WINDOW_MS = 60_000;
const USAGE_RETENTION_MS = 120_000;
const CONCURRENCY_TTL_MS = Math.max(HTTP_TIMEOUT_MS * 3, 45_000);

const localUsage = new Map();
const localConcurrency = new Map();

const RESERVE_ROLLING_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local cutoff = tonumber(ARGV[2])
local member = ARGV[3]
local limit = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local window = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 1000
  if oldest[2] then retryAfter = math.max(1000, tonumber(oldest[2]) + window - now) end
  return {0, count, retryAfter}
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, ttl)
return {1, count + 1, 0}
`;

const ACQUIRE_CONCURRENCY_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', key) or '0')
if current >= limit then return {0, current} end
current = redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl)
return {1, current}
`;

const RELEASE_CONCURRENCY_SCRIPT = `
local key = KEYS[1]
local current = tonumber(redis.call('GET', key) or '0')
if current <= 1 then
  redis.call('DEL', key)
  return 0
end
return redis.call('DECR', key)
`;

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    timer.unref?.();
  });
}

function appIdentity() {
  const clientId = clean(oauthConfiguration().clientId, 512) || 'unconfigured';
  return crypto.createHash('sha256').update(clientId, 'utf8').digest('hex').slice(0, 24);
}

function globalUsageKey() {
  return `allegro:api-usage:v1:app:${appIdentity()}`;
}

function accountUsageKey(accountId) {
  return `allegro:api-usage:v1:account:${clean(accountId, 64)}`;
}

function endpointUsageKey(accountId, policyKey) {
  return `allegro:api-usage:v1:endpoint:${clean(accountId, 64)}:${crypto.createHash('sha1').update(clean(policyKey, 300)).digest('hex').slice(0, 16)}`;
}

function concurrencyKey(accountId) {
  return `allegro:concurrency:v1:${clean(accountId, 64)}`;
}

function usageMember({ now, accountId, method, path, stage, requestId }) {
  return [
    now,
    requestId || crypto.randomUUID(),
    encodeURIComponent(clean(accountId, 64)),
    encodeURIComponent(clean(method, 16) || 'GET'),
    encodeURIComponent(clean(path, 300) || '/'),
    encodeURIComponent(clean(stage, 100) || 'other'),
  ].join('|');
}

function parseUsageMember(member) {
  const parts = String(member || '').split('|');
  return {
    at: Number(parts[0] || 0),
    requestId: parts[1] || '',
    accountId: decodeURIComponent(parts[2] || ''),
    method: decodeURIComponent(parts[3] || 'GET'),
    path: decodeURIComponent(parts[4] || '/'),
    stage: decodeURIComponent(parts[5] || 'other'),
  };
}

function pruneLocalUsage(key, now = Date.now(), windowMs = USAGE_WINDOW_MS) {
  const cutoff = now - windowMs;
  const current = (localUsage.get(key) || []).filter((event) => Number(event.at || 0) > cutoff);
  if (current.length) localUsage.set(key, current); else localUsage.delete(key);
  return current;
}

async function reserveRollingBudget(key, limit, windowMs, event, errorCode) {
  const now = Date.now();
  const member = usageMember({ ...event, now });
  if (isRedisReady()) {
    const result = await redis.eval(
      RESERVE_ROLLING_SCRIPT,
      1,
      key,
      now,
      now - windowMs,
      member,
      limit,
      Math.max(windowMs * 2, USAGE_RETENTION_MS),
      windowMs,
    );
    if (Number(result?.[0] || 0) !== 1) {
      throw appError(errorCode, { retryAfterMs: Number(result?.[2] || 1000) });
    }
    return Number(result?.[1] || 0);
  }

  const effectiveLocalLimit = key === globalUsageKey() ? Math.min(limit, LOCAL_FALLBACK_BUDGET_PER_MINUTE) : limit;
  const current = pruneLocalUsage(key, now, windowMs);
  if (current.length >= effectiveLocalLimit) {
    const oldest = Number(current[0]?.at || now);
    throw appError(errorCode, { retryAfterMs: Math.max(1000, oldest + windowMs - now) });
  }
  current.push({ ...event, now, at: now, requestId: event.requestId || crypto.randomUUID() });
  localUsage.set(key, current);
  return current.length;
}

async function reserveApiBudget(accountId, { method, path, stage, requestId, ratePolicy = null } = {}) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  const event = { accountId: id, method, path, stage, requestId };

  // Allegro's documented main limit is shared by Client ID, therefore this
  // reservation is intentionally global across all connected seller accounts.
  const globalCount = await reserveRollingBudget(
    globalUsageKey(),
    APP_REQUEST_BUDGET_PER_MINUTE,
    USAGE_WINDOW_MS,
    event,
    'allegro_rate_budget_exhausted',
  );
  await reserveRollingBudget(
    accountUsageKey(id),
    APP_REQUEST_BUDGET_PER_MINUTE,
    USAGE_WINDOW_MS,
    event,
    'allegro_rate_budget_exhausted',
  );

  // Endpoint-specific Allegro limits vary by resource. Callers opt into a
  // documented policy instead of assuming a fake universal per-seller RPM.
  if (ratePolicy?.key && Number(ratePolicy?.limit) > 0) {
    await reserveRollingBudget(
      endpointUsageKey(id, ratePolicy.key),
      Math.max(1, Number(ratePolicy.limit)),
      Math.max(1000, Number(ratePolicy.windowMs) || USAGE_WINDOW_MS),
      event,
      'allegro_endpoint_rate_budget_exhausted',
    );
  }
  return globalCount;
}

async function acquireAccountConcurrency(accountId) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  const key = concurrencyKey(id);
  if (isRedisReady()) {
    const result = await redis.eval(ACQUIRE_CONCURRENCY_SCRIPT, 1, key, ACCOUNT_MAX_CONCURRENCY, CONCURRENCY_TTL_MS);
    if (Number(result?.[0] || 0) !== 1) {
      throw appError('allegro_account_concurrency_exhausted', { retryAfterMs: 250 });
    }
    return async () => {
      try { await redis.eval(RELEASE_CONCURRENCY_SCRIPT, 1, key); } catch (_) { /* TTL is fail-safe */ }
    };
  }
  const current = Number(localConcurrency.get(id) || 0);
  if (current >= ACCOUNT_MAX_CONCURRENCY) throw appError('allegro_account_concurrency_exhausted', { retryAfterMs: 250 });
  localConcurrency.set(id, current + 1);
  return async () => {
    const next = Math.max(0, Number(localConcurrency.get(id) || 1) - 1);
    if (next) localConcurrency.set(id, next); else localConcurrency.delete(id);
  };
}

function normalizePath(path) {
  const raw = clean(path, 2048);
  if (!raw.startsWith('/')) throw appError('allegro_api_path_invalid');
  if (/^\/\//.test(raw) || /:\/\//.test(raw)) throw appError('allegro_api_path_invalid');
  return raw;
}

function urlFor(path, query) {
  const config = oauthConfiguration();
  const base = config.apiBaseUrl;
  if (!base) throw appError('allegro_oauth_not_configured', { missing: config.missing || [] });
  const url = new URL(normalizePath(path), `${base}/`);
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function safeMetadata(value) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > 4000) return undefined;
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
}

async function readPayload(response) {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { rawText: clean(text, 1000) }; }
}

function responseTraceId(response) {
  return clean(response?.headers?.get?.('trace-id') || response?.headers?.get?.('x-trace-id'), 256);
}

function parseRetryAfterMs(response) {
  const value = clean(response?.headers?.get?.('retry-after'), 128);
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function normalizeAllegroErrorItem(source = {}) {
  return {
    code: clean(source.code, 200),
    message: clean(source.message, 1500),
    userMessage: clean(source.userMessage, 1500),
    details: clean(source.details, 1500),
    fieldPath: clean(source.path ?? source.fieldPath, 500),
    metadata: safeMetadata(source.metadata),
  };
}

function normalizedAllegroErrors(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    return payload.errors.slice(0, 20).map(normalizeAllegroErrorItem);
  }
  return [normalizeAllegroErrorItem({
    code: payload?.error || payload?.code,
    message: payload?.error_description || payload?.message || payload?.rawText,
    userMessage: payload?.userMessage,
    details: payload?.details,
    path: payload?.path,
    metadata: payload?.metadata,
  })];
}

function firstAllegroError(payload) {
  return normalizedAllegroErrors(payload)[0] || normalizeAllegroErrorItem();
}

function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function operationIsRetryable(method, retryPolicy) {
  if (retryPolicy === 'never') return false;
  if (retryPolicy === 'idempotent') return true;
  return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(String(method || '').toUpperCase());
}

function exposedStatus(upstreamStatus) {
  if (upstreamStatus === 429) return 503;
  if ([400, 403, 404, 409, 422].includes(upstreamStatus)) return upstreamStatus;
  if (upstreamStatus === 408) return 504;
  if (upstreamStatus >= 500) return 502;
  return 502;
}

async function recordErrorLog(entry) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ERROR_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    await AllegroApiErrorLog.create({
      eventId: crypto.randomUUID(),
      accountId: clean(entry.accountId, 64),
      method: clean(entry.method, 16) || 'GET',
      path: clean(entry.path, 500) || '/',
      stage: clean(entry.stage, 100) || 'other',
      httpStatus: Number(entry.httpStatus) || 0,
      code: clean(entry.code, 200),
      message: clean(entry.message, 1500),
      userMessage: clean(entry.userMessage, 1500),
      details: clean(entry.details, 1500),
      fieldPath: clean(entry.fieldPath, 500),
      metadata: safeMetadata(entry.metadata),
      upstreamErrors: Array.isArray(entry.upstreamErrors)
        ? entry.upstreamErrors.slice(0, 20).map(normalizeAllegroErrorItem)
        : [],
      traceId: clean(entry.traceId, 256),
      retryable: entry.retryable === true,
      retryAfterMs: parseOptionalNonNegativeNumber(entry.retryAfterMs),
      attempt: Math.max(1, Number(entry.attempt) || 1),
      requestId: clean(entry.requestId, 64),
      occurredAt: now,
      expiresAt,
    });
  } catch (_) {
    // Diagnostics must never turn an Allegro failure into a second application
    // failure. The original upstream error stays authoritative.
  }
}

function makeApiError({ accountId, method, path, stage, status, payload, response, attempt, requestId, fallbackCode = '' }) {
  const upstreamErrors = normalizedAllegroErrors(payload);
  const upstream = upstreamErrors[0] || firstAllegroError(payload);
  const traceId = responseTraceId(response);
  const retryAfterMs = parseRetryAfterMs(response) ?? (Number(status) === 429 ? 60_000 : null);
  const args = {
    upstreamStatus: Number(status) || 0,
    upstreamCode: upstream.code || fallbackCode,
    userMessage: upstream.userMessage || '',
    fieldPath: upstream.fieldPath || '',
    traceId,
    retryable: retryableStatus(Number(status) || 0),
    retryAfterMs,
  };
  const err = appError(status === 429 ? 'allegro_api_rate_limited' : 'allegro_api_error', args, exposedStatus(Number(status) || 0));
  err.allegroDiagnostic = {
    accountId, method, path, stage, httpStatus: status,
    code: upstream.code || fallbackCode,
    message: upstream.message,
    userMessage: upstream.userMessage,
    details: upstream.details,
    fieldPath: upstream.fieldPath,
    metadata: upstream.metadata,
    upstreamErrors,
    traceId,
    retryable: args.retryable,
    retryAfterMs,
    attempt,
    requestId,
  };
  return err;
}

function networkError({ accountId, method, path, stage, attempt, requestId, error }) {
  const timeout = error?.name === 'AbortError';
  const err = appError(timeout ? 'allegro_upstream_timeout' : 'allegro_upstream_unavailable', {
    retryable: true,
    upstreamCode: timeout ? 'timeout' : 'network_error',
  });
  err.allegroDiagnostic = {
    accountId, method, path, stage, httpStatus: 0,
    code: timeout ? 'timeout' : 'network_error',
    message: clean(error?.message, 1500),
    retryable: true,
    attempt,
    requestId,
  };
  return err;
}

async function markFreshTokenRejected(accountId) {
  await AllegroAccount.updateOne({ accountId: clean(accountId, 64) }, {
    $set: {
      authState: 'revoked',
      enabled: false,
      lastConnectionCheckAt: new Date(),
      lastConnectionError: 'Allegro rejected a freshly refreshed access token.',
    },
  }).catch(() => {});
}

async function allegroRequest(accountId, options = {}) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  const method = clean(options.method || 'GET', 16).toUpperCase();
  const path = normalizePath(options.path || '/');
  const stage = clean(options.stage || 'other', 100) || 'other';
  const retryPolicy = clean(options.retryPolicy || 'safe', 32) || 'safe';
  const retryableOperation = operationIsRetryable(method, retryPolicy);
  const maxAttempts = Math.min(5, Math.max(1, Number(options.maxAttempts) || 3));
  const requestId = crypto.randomUUID();
  const accept = clean(options.accept || 'application/vnd.allegro.public.v1+json', 256);
  const contentType = clean(options.contentType || 'application/vnd.allegro.public.v1+json', 256);

  // Dynamic require avoids a module cycle during OAuth module initialization.
  const { getValidAccessToken } = require('./allegroOAuth');
  let credential = await getValidAccessToken(id, { requireEnabled: options.requireEnabled !== false });
  let refreshedAfter401 = false;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let releaseConcurrency;
    try {
      releaseConcurrency = await acquireAccountConcurrency(id);
    } catch (concurrencyError) {
      if (attempt < maxAttempts && retryableOperation) {
        await sleep(retryDelayMs({ attempt, retryAfterMs: concurrencyError?.args?.retryAfterMs }));
        continue;
      }
      throw concurrencyError;
    }

    try {
      await reserveApiBudget(id, { method, path, stage, requestId, ratePolicy: options.ratePolicy });
    } catch (budgetError) {
      if (releaseConcurrency) await releaseConcurrency();
      budgetError.args = { ...(budgetError.args || {}), requestId };
      throw budgetError;
    }

    const url = urlFor(path, options.query);
    const headers = {
      ...(options.headers && typeof options.headers === 'object' ? options.headers : {}),
      Authorization: `Bearer ${credential.accessToken}`,
      Accept: accept,
      'Accept-Language': clean(options.acceptLanguage || 'pl-PL', 32),
      'User-Agent': clean(oauthConfiguration().userAgent, 512),
    };
    let body;
    if (options.body !== undefined && options.body !== null) {
      headers['Content-Type'] = contentType;
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(60_000, Math.max(1000, Number(options.timeoutMs) || HTTP_TIMEOUT_MS)));
    timer.unref?.();
    let response;
    let payload;
    try {
      response = await fetch(url, { method, headers, body, signal: controller.signal });
      payload = await readPayload(response);
    } catch (error) {
      const err = networkError({ accountId: id, method, path, stage, attempt, requestId, error });
      await recordErrorLog(err.allegroDiagnostic);
      lastError = err;
      if (attempt < maxAttempts && retryableOperation) {
        await sleep(retryDelayMs({ attempt }));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (releaseConcurrency) await releaseConcurrency();
    }

    if (response.ok) {
      return {
        status: response.status,
        payload,
        traceId: responseTraceId(response),
        requestId,
        pending: response.status === 202,
        location: clean(response.headers.get('location'), 2048),
        retryAfterMs: parseRetryAfterMs(response),
        warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
      };
    }

    const err = makeApiError({ accountId: id, method, path, stage, status: response.status, payload, response, attempt, requestId });
    await recordErrorLog(err.allegroDiagnostic);
    lastError = err;

    // A 401 response means Allegro rejected authorization before processing the
    // protected operation, so exactly one refresh+retry is safe even for POST.
    if (response.status === 401 && !refreshedAfter401) {
      credential = await getValidAccessToken(id, {
        requireEnabled: options.requireEnabled !== false,
        forceRefresh: true,
        rejectedTokenRevision: Number(credential?.account?.tokenRevision || 0),
      });
      refreshedAfter401 = true;
      continue;
    }
    if (response.status === 401 && refreshedAfter401) {
      await markFreshTokenRejected(id);
      throw appError('allegro_api_authorization_lost', {
        traceId: err.args?.traceId || '',
        upstreamStatus: 401,
        upstreamCode: err.args?.upstreamCode || '',
      });
    }

    const retryable = retryableOperation && retryableStatus(response.status) && attempt < maxAttempts;
    if (retryable) {
      const delayMs = retryDelayMs({ attempt, retryAfterMs: err.args?.retryAfterMs });
      // Do not pin an HTTP worker for a long Allegro cooldown. Queue/scheduler
      // layers can retry later using retryAfterMs from the normalized error.
      if (delayMs <= MAX_INLINE_RETRY_DELAY_MS) {
        await sleep(delayMs);
        continue;
      }
    }
    throw err;
  }
  throw lastError || appError('allegro_api_error');
}

async function getUsageEvents(key, now = Date.now()) {
  const cutoff = now - USAGE_WINDOW_MS;
  if (isRedisReady()) {
    const members = await redis.zrangebyscore(key, cutoff + 1, now);
    return members.map(parseUsageMember).filter((event) => Number(event.at || 0) > cutoff);
  }
  return pruneLocalUsage(key, now, USAGE_WINDOW_MS);
}

function summarizeUsage(events) {
  const byMethod = {};
  const byStage = {};
  const byPath = {};
  for (const event of events) {
    const method = clean(event.method, 16) || 'GET';
    const stage = clean(event.stage, 100) || 'other';
    const path = clean(event.path, 300) || '/';
    byMethod[method] = Number(byMethod[method] || 0) + 1;
    byStage[stage] = Number(byStage[stage] || 0) + 1;
    byPath[path] = Number(byPath[path] || 0) + 1;
  }
  return { count: events.length, byMethod, byStage, byPath };
}

async function getAllegroApiUsage(accountIds = []) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map((value) => clean(value, 64)).filter(Boolean))];
  const now = Date.now();
  const globalEvents = await getUsageEvents(globalUsageKey(), now);
  const accounts = [];
  for (const accountId of ids) {
    const events = await getUsageEvents(accountUsageKey(accountId), now);
    accounts.push({ accountId, windowSeconds: 60, ...summarizeUsage(events) });
  }
  return {
    officialLimitPerMinute: OFFICIAL_APP_LIMIT_PER_MINUTE,
    configuredBudgetPerMinute: APP_REQUEST_BUDGET_PER_MINUTE,
    effectiveBudgetPerMinute: isRedisReady() ? APP_REQUEST_BUDGET_PER_MINUTE : LOCAL_FALLBACK_BUDGET_PER_MINUTE,
    coordinationMode: isRedisReady() ? 'redis' : 'process_local',
    windowSeconds: 60,
    global: summarizeUsage(globalEvents),
    accountMaxConcurrency: ACCOUNT_MAX_CONCURRENCY,
    accounts,
    measuredAt: new Date(now).toISOString(),
  };
}

function publicErrorLog(row) {
  const value = typeof row?.toObject === 'function' ? row.toObject() : (row || {});
  return {
    eventId: clean(value.eventId, 64),
    accountId: clean(value.accountId, 64),
    method: clean(value.method, 16),
    path: clean(value.path, 500),
    stage: clean(value.stage, 100),
    httpStatus: Number(value.httpStatus) || 0,
    code: clean(value.code, 200),
    message: clean(value.message, 1500),
    userMessage: clean(value.userMessage, 1500),
    details: clean(value.details, 1500),
    fieldPath: clean(value.fieldPath, 500),
    metadata: safeMetadata(value.metadata),
    upstreamErrors: Array.isArray(value.upstreamErrors)
      ? value.upstreamErrors.slice(0, 20).map(normalizeAllegroErrorItem)
      : [],
    traceId: clean(value.traceId, 256),
    retryable: value.retryable === true,
    retryAfterMs: parseOptionalNonNegativeNumber(value.retryAfterMs),
    attempt: Math.max(1, Number(value.attempt) || 1),
    requestId: clean(value.requestId, 64),
    occurredAt: value.occurredAt || null,
  };
}

async function listAllegroApiErrors({ accountId = '', limit = 30 } = {}) {
  const query = {};
  const id = clean(accountId, 64);
  if (id) query.accountId = id;
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 30));
  const rows = await AllegroApiErrorLog.find(query).sort({ occurredAt: -1 }).limit(safeLimit).lean();
  return rows.map(publicErrorLog);
}

async function checkAllegroApiConnection(accountId) {
  const id = clean(accountId, 64);
  const result = await allegroRequest(id, {
    method: 'GET',
    path: '/me',
    stage: 'connection_check',
    requireEnabled: false,
    retryPolicy: 'safe',
    maxAttempts: 2,
  });
  const identity = {
    id: clean(result.payload?.id, 128),
    login: clean(result.payload?.login, 160),
    baseMarketplaceId: clean(result.payload?.baseMarketplace?.id, 80),
    traceId: result.traceId,
  };
  if (!identity.id || !identity.login) throw appError('allegro_identity_response_invalid', { traceId: result.traceId });

  const row = await AllegroAccount.findOne({ accountId: id });
  if (!row) throw appError('allegro_account_not_found');
  if (clean(row.allegroUserId, 128) && clean(row.allegroUserId, 128) !== identity.id) {
    row.authState = 'error';
    row.enabled = false;
    row.lastConnectionCheckAt = new Date();
    row.lastConnectionError = 'Allegro identity changed unexpectedly.';
    await row.save();
    throw appError('allegro_oauth_identity_mismatch', {
      expectedLogin: clean(row.login, 160),
      receivedLogin: identity.login,
    });
  }
  row.allegroUserId = identity.id;
  row.login = identity.login;
  row.marketplaceIds = identity.baseMarketplaceId ? [identity.baseMarketplaceId] : [];
  row.authState = 'connected';
  row.lastConnectionCheckAt = new Date();
  row.lastConnectionError = '';
  await row.save();
  return { account: row, identity, requestId: result.requestId };
}

module.exports = {
  OFFICIAL_APP_LIMIT_PER_MINUTE,
  APP_REQUEST_BUDGET_PER_MINUTE,
  HTTP_TIMEOUT_MS,
  ACCOUNT_MAX_CONCURRENCY,
  LOCAL_FALLBACK_BUDGET_PER_MINUTE,
  MAX_INLINE_RETRY_DELAY_MS,
  reserveApiBudget,
  allegroRequest,
  getAllegroApiUsage,
  listAllegroApiErrors,
  checkAllegroApiConnection,
};

'use strict';

const { readTelegramSessionCookie } = require('../utils/sessionCookie');
const { readTelegramSessionSlot } = require('../utils/telegramRequestIdentity');

const TELEGRAM_BOOTSTRAP_PATH = '/api/v1/auth/telegram/bootstrap';
const TELEGRAM_PROFILE_PATH = '/api/v1/telegram/me';
const DIAGNOSTIC_PATHS = new Set([TELEGRAM_BOOTSTRAP_PATH, TELEGRAM_PROFILE_PATH]);
const MAX_HEADER_LENGTH = 512;

function header(req, name) {
  const value = req?.get?.(name) || req?.headers?.[String(name).toLowerCase()] || '';
  return String(value).slice(0, MAX_HEADER_LENGTH);
}

function safeReferer(req) {
  const value = header(req, 'referer');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, MAX_HEADER_LENGTH);
  } catch (_) {
    return '';
  }
}

function diagnosticPath(req) {
  const path = String(req?.path || String(req?.originalUrl || '').split('?')[0]);
  return DIAGNOSTIC_PATHS.has(path) ? path : '';
}

function isTelegramAuthRequest(req) {
  return Boolean(diagnosticPath(req));
}

function clientIp(req) {
  const cloudflareIp = header(req, 'cf-connecting-ip');
  if (cloudflareIp) return cloudflareIp;

  const forwardedFor = header(req, 'x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',')[0].trim();

  return String(req?.socket?.remoteAddress || req?.ip || '').slice(0, 128);
}

function requestContext(req) {
  const body = req?.body && typeof req.body === 'object' ? req.body : null;
  const initDataLength = body ? String(body.initData || '').length : 0;
  const sessionSlot = readTelegramSessionSlot(req);

  return {
    method: String(req?.method || ''),
    path: diagnosticPath(req),
    origin: header(req, 'origin'),
    referer: safeReferer(req),
    userAgent: header(req, 'user-agent'),
    clientIp: clientIp(req),
    cfRay: header(req, 'cf-ray'),
    contentType: header(req, 'content-type'),
    contentLength: header(req, 'content-length'),
    accessControlRequestMethod: header(req, 'access-control-request-method'),
    accessControlRequestHeaders: header(req, 'access-control-request-headers'),
    hasCookie: Boolean(header(req, 'cookie')),
    hasTelegramContext: header(req, 'x-auth-context').toLowerCase() === 'telegram',
    hasTelegramClientId: Boolean(header(req, 'x-telegram-client-id')),
    hasSessionSlotHeader: Boolean(sessionSlot),
    hasSelectedTelegramSessionCookie: Boolean(readTelegramSessionCookie(req, sessionSlot)),
    // Never log the signed Telegram payload or the session slot. Presence and
    // length are enough to prove whether the request reached Express intact.
    hasInitData: initDataLength > 0,
    initDataLength,
    hasSessionSlot: Boolean(body && String(body.sessionSlot || '').trim()),
  };
}

function write(level, payload) {
  const message = `[telegram-auth-diagnostic] ${JSON.stringify(payload)}`;
  if (level === 'error') console.error(message);
  else console.log(message);
}

function safeClientString(value, max = 240) {
  if (value == null) return '';
  return String(value).slice(0, max);
}

function sanitizeClientDiagnostic(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const payload = {};
  const stringKeys = [
    'flowId', 'stage', 'clientBuild', 'telegramVersion', 'telegramPlatform',
    'visibilityState', 'operation', 'errorName', 'errorCode', 'errorMessage', 'authStage',
  ];
  const booleanKeys = [
    'online', 'responseOk', 'jsonParsed', 'telegramIdPresent', 'sessionSlotPresent',
    'identityMatch', 'sessionSlotMatch', 'cancelled',
  ];
  const numberKeys = ['seq', 'at', 'httpStatus', 'attempt'];

  for (const key of stringKeys) {
    if (source[key] != null && source[key] !== '') {
      payload[key] = safeClientString(source[key], key === 'errorMessage' ? 500 : 160);
    }
  }
  for (const key of booleanKeys) {
    if (typeof source[key] === 'boolean') payload[key] = source[key];
  }
  for (const key of numberKeys) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) payload[key] = value;
  }
  return payload;
}

function telegramAuthClientDiagnostic(req, rawPayload) {
  write('info', {
    event: 'CLIENT',
    ...requestContext(req),
    client: sanitizeClientDiagnostic(rawPayload),
  });
}

function telegramAuthRequestDiagnostics(req, res, next) {
  if (!isTelegramAuthRequest(req)) return next();

  const startedAt = Date.now();
  write('info', { event: 'START', ...requestContext(req) });

  res.once('finish', () => {
    write('info', {
      event: 'FINISH',
      ...requestContext(req),
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    });
  });

  return next();
}

// eslint-disable-next-line no-unused-vars -- Express error middleware signature
function telegramAuthErrorDiagnostics(err, req, res, next) {
  if (isTelegramAuthRequest(req)) {
    write('error', {
      event: 'ERROR',
      ...requestContext(req),
      status: Number(err?.status || err?.statusCode || 500),
      errorName: String(err?.name || 'Error').slice(0, 128),
      errorCode: String(err?.code || '').slice(0, 128),
      errorMessage: String(err?.message || 'Unknown error').slice(0, 1000),
      stack: String(err?.stack || '').slice(0, 4000),
    });
  }
  return next(err);
}

module.exports = {
  TELEGRAM_BOOTSTRAP_PATH,
  TELEGRAM_PROFILE_PATH,
  isTelegramAuthRequest,
  telegramAuthRequestDiagnostics,
  telegramAuthErrorDiagnostics,
  telegramAuthClientDiagnostic,
  sanitizeClientDiagnostic,
};

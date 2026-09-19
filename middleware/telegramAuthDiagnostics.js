'use strict';

const TELEGRAM_BOOTSTRAP_PATH = '/api/v1/auth/telegram/bootstrap';
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

function isTelegramBootstrapRequest(req) {
  return req?.path === TELEGRAM_BOOTSTRAP_PATH
    || String(req?.originalUrl || '').split('?')[0] === TELEGRAM_BOOTSTRAP_PATH;
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

  return {
    method: String(req?.method || ''),
    path: TELEGRAM_BOOTSTRAP_PATH,
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

function telegramAuthRequestDiagnostics(req, res, next) {
  if (!isTelegramBootstrapRequest(req)) return next();

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
  if (isTelegramBootstrapRequest(req)) {
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
  isTelegramBootstrapRequest,
  telegramAuthRequestDiagnostics,
  telegramAuthErrorDiagnostics,
};

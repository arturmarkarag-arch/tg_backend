'use strict';

const RETRYABLE_NETWORK_CODES = new Set([
  'EFATAL',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
]);

function statusCodeOf(error) {
  const raw = error?.response?.statusCode
    ?? error?.response?.status
    ?? error?.response?.body?.error_code
    ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function descriptionOf(error) {
  return String(
    error?.response?.body?.description
    || error?.message
    || error?.code
    || 'telegram_send_failed',
  ).trim();
}

function retryAfterSecondsOf(error) {
  const raw = error?.response?.body?.parameters?.retry_after
    ?? error?.response?.headers?.['retry-after']
    ?? error?.response?.headers?.['Retry-After'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

function classifyTelegramSendError(error) {
  const statusCode = statusCodeOf(error);
  const libraryCode = String(error?.code || '').trim();
  const description = descriptionOf(error);
  const lower = description.toLowerCase();

  const botBlocked = (statusCode === 403 || statusCode === 400) && (
    lower.includes('bot was blocked')
    || lower.includes('user is deactivated')
    || lower.includes('chat not found')
    || lower.includes("bot can't initiate conversation")
    || lower.includes('bot cannot initiate conversation')
  );

  const rateLimited = statusCode === 429;
  const serverError = statusCode !== null && statusCode >= 500 && statusCode <= 599;
  const networkError = RETRYABLE_NETWORK_CODES.has(libraryCode);
  const permanent = !rateLimited && !serverError && !networkError && (
    statusCode === 400
    || statusCode === 401
    || statusCode === 403
    || statusCode === 404
  );
  const retryable = rateLimited || serverError || networkError;

  // A timeout/reset/5xx may happen after Telegram accepted the request but before
  // our process received the response. Bot API has no client idempotency key, so
  // a retry can theoretically create a duplicate. Persist this uncertainty.
  const ambiguous = networkError || serverError;

  return {
    statusCode,
    libraryCode,
    description,
    retryAfterSeconds: retryAfterSecondsOf(error),
    rateLimited,
    serverError,
    networkError,
    retryable,
    permanent,
    ambiguous,
    botBlocked,
  };
}

function retryDelayMs(classification, attempt) {
  const retryAfter = Number(classification?.retryAfterSeconds || 0);
  if (retryAfter > 0) return retryAfter * 1000;
  const safeAttempt = Math.max(1, Number(attempt) || 1);
  return Math.min(60_000, 1000 * (2 ** Math.min(5, safeAttempt - 1)));
}

module.exports = {
  RETRYABLE_NETWORK_CODES,
  classifyTelegramSendError,
  retryDelayMs,
  statusCodeOf,
  descriptionOf,
  retryAfterSecondsOf,
};

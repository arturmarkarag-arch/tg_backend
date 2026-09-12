// MUST be the first local module loaded by index.js. Sentry's Node SDK patches
// HTTP/Express/database clients at module-load time, so observability has to be
// initialized before those libraries are required.
const path = require('path');
const dotenv = require('dotenv');

// Keep the existing local-env contract: server/index.js historically loaded the
// monorepo-level ../.env before the rest of the application.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}

const Sentry = require('@sentry/node');


function stripUrlDetails(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl, 'http://sentry.local');
    url.search = '';
    url.hash = '';
    return rawUrl.startsWith('http') ? url.toString() : `${url.pathname}`;
  } catch (_) {
    return String(rawUrl).split(/[?#]/, 1)[0];
  }
}

function scrubServerEvent(event) {
  if (!event?.request) return event;

  event.request.url = stripUrlDetails(event.request.url);
  event.request.query_string = undefined;
  event.request.cookies = undefined;
  // Request bodies can contain order/customer/Telegram data. Error events only
  // need safe request context; bodies are never sent to Sentry.
  event.request.data = undefined;

  if (event.request.headers && typeof event.request.headers === 'object') {
    const headers = { ...event.request.headers };
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (
        lower === 'authorization'
        || lower === 'cookie'
        || lower === 'set-cookie'
        || lower === 'x-telegram-initdata'
        || lower === 'x-telegram-bot-api-secret-token'
      ) {
        delete headers[key];
      }
    }
    event.request.headers = headers;
  }

  return event;
}

const dsn = String(process.env.SENTRY_DSN || '').trim();
const explicitlyDisabled = String(process.env.SENTRY_ENABLED || '').toLowerCase() === 'false';
const sentryEnabled = Boolean(dsn) && !explicitlyDisabled;

if (sentryEnabled) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE || process.env.RENDER_GIT_COMMIT || undefined,
    sendDefaultPii: false,
    // Errors-only contract. Performance tracing is intentionally disabled.
    // Re-enabling transaction sampling requires a separate bandwidth review.
    beforeSendTransaction: () => null,
    beforeSend: scrubServerEvent,
  });
}

module.exports = { Sentry, sentryEnabled };

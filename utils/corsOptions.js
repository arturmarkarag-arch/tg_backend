/**
 * CORS origin policy, driven by the CORS_ALLOWED_ORIGINS env var.
 *
 *   CORS_ALLOWED_ORIGINS="https://app.example.com,https://admin.example.com"
 *
 * When the var is set, only those origins are allowed (requests with no Origin
 * header — curl, server-to-server, same-origin — are still allowed).
 *
 * When it is NOT set, behaviour is permissive (reflect any origin) so nothing
 * breaks today, but a one-time warning is logged in production so a wide-open
 * CORS policy is never shipped silently. Set the env var before going public.
 *
 * Shared by Express (`cors`) and Socket.IO — both accept this (origin, cb) form.
 */
let warnedOnce = false;

function getAllowedOrigins() {
  const raw = process.env.CORS_ALLOWED_ORIGINS;
  if (!raw) return null; // null → permissive
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function corsOrigin(origin, callback) {
  const allowed = getAllowedOrigins();

  if (!allowed) {
    if (process.env.NODE_ENV === 'production' && !warnedOnce) {
      warnedOnce = true;
      console.warn(
        '[cors] CORS_ALLOWED_ORIGINS is not set — ALL origins are allowed. '
        + 'Set it to a comma-separated allowlist before exposing this publicly.',
      );
    }
    return callback(null, true);
  }

  // No Origin header → non-browser or same-origin request: allow.
  if (!origin) return callback(null, true);
  if (allowed.includes(origin)) return callback(null, true);
  return callback(new Error('Not allowed by CORS'));
}

// `maxAge` lets the browser cache the preflight result instead of sending an
// OPTIONS before (almost) every request. The front-end is on app.zlotoweczka
// and the API on api.zlotoweczka — same-site but cross-ORIGIN, and every call
// carries Authorization or x-telegram-initdata, so none of them is a "simple"
// request. 7200s is Chrome's hard cap; Safari/WKWebView (i.e. the Telegram
// mini-app on iOS) silently clamps this to ~600s, so expect a smaller win there.
const expressCorsOptions = { origin: corsOrigin, credentials: true, maxAge: 7200 };

module.exports = { getAllowedOrigins, corsOrigin, expressCorsOptions };

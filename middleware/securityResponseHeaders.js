'use strict';

const HSTS_VALUE = 'max-age=31536000';

function securityResponseHeaders(req, res, next) {
  // Prevent MIME sniffing on API/JSON responses.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // HSTS is a production-only browser transport policy. We intentionally do
  // not add includeSubDomains/preload until every affected hostname is audited.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', HSTS_VALUE);
  }

  return next();
}

module.exports = {
  HSTS_VALUE,
  securityResponseHeaders,
};

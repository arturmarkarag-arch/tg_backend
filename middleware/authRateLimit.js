'use strict';

const { consumeRateLimit } = require('./rateLimitCore');
const { getClientNetworkIdentity } = require('../utils/clientNetworkIdentity');
const { appError } = require('../utils/errors');

function createAuthRateLimit({ name, max = 300, windowMs = 5 * 60 * 1000 } = {}) {
  const namespace = `auth:${String(name || 'default')}`;

  return async function authRateLimit(req, res, next) {
    try {
      const { clientIp } = getClientNetworkIdentity(req);
      const result = await consumeRateLimit({
        namespace,
        identity: clientIp,
        windows: [{ name: 'window', max, windowMs }],
      });
      const window = result.windows[0];

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(window?.remaining ?? max));

      if (result.limited) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        return next(appError('auth_rate_limited'));
      }
      return next();
    } catch (_) {
      // Rate limiting is a protective layer, not an availability dependency.
      return next();
    }
  };
}

module.exports = { createAuthRateLimit };

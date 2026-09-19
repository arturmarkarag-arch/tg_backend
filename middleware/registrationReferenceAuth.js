'use strict';

const { telegramAuth } = require('./telegramAuth');
const { telegramIdentity } = require('./telegramIdentity');

// Registration reference endpoints have two legitimate callers:
// - a not-yet-registered Telegram user with a bootstrapped Telegram proof;
// - an already-registered user browsing through a Google/browser session.
// Select the authoritative middleware from the explicit transport context.
// A caller cannot use the header to gain access: choosing Telegram without the
// matching Telegram cookie only makes the request fail closed.
function registrationReferenceAuth(req, res, next) {
  const isTelegramContext = String(req.get('x-auth-context') || '').toLowerCase() === 'telegram';
  return isTelegramContext
    ? telegramIdentity(req, res, next)
    : telegramAuth(req, res, next);
}

module.exports = { registrationReferenceAuth };

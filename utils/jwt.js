const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || '';
const EXPIRES_IN = process.env.JWT_EXPIRY || '7d';

if (!SECRET) {
  console.warn('[jwt] JWT_SECRET is not set — browser auth will reject all tokens until it is configured');
}

// The session token carries only the telegramId. Role and all profile data are
// always re-read from the DB on each request, so a role change takes effect
// immediately and a stolen token cannot embed an elevated role.
function signSession(telegramId) {
  if (!SECRET) throw new Error('JWT_SECRET not configured');
  return jwt.sign({ sub: String(telegramId) }, SECRET, { expiresIn: EXPIRES_IN });
}

function verifySession(token) {
  if (!SECRET || !token) return null;
  try {
    const payload = jwt.verify(token, SECRET);
    const telegramId = String(payload.sub || '');
    // `iat` (issued-at, seconds) lets callers reject tokens minted before a
    // logout (see User.sessionsValidFrom).
    return telegramId ? { telegramId, iat: Number(payload.iat) || 0 } : null;
  } catch {
    return null;
  }
}

// True when a token issued at `iatSeconds` is still valid for `user` — i.e. it
// was issued at/after the user's last logout. A null sessionsValidFrom (never
// logged out) always passes.
function isSessionNotRevoked(iatSeconds, user) {
  const cutoff = user?.sessionsValidFrom;
  if (!cutoff) return true;
  // `iat` is floored to whole seconds, so allow a 1s grace — otherwise a
  // logout immediately followed by re-login could reject the fresh token.
  // A genuinely old stolen token is still rejected (its iat is far older).
  return (Number(iatSeconds) || 0) * 1000 + 1000 >= new Date(cutoff).getTime();
}

module.exports = { signSession, verifySession, isSessionNotRevoked };

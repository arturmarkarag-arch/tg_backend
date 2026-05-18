const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || '';
const EXPIRES_IN = process.env.JWT_EXPIRY || '30d';

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
    return telegramId ? { telegramId } : null;
  } catch {
    return null;
  }
}

module.exports = { signSession, verifySession };

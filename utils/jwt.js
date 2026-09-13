const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || '';
const EXPIRES_IN = process.env.JWT_EXPIRY || '7d';
const TELEGRAM_EXPIRES_IN = process.env.TELEGRAM_SESSION_EXPIRY || '12h';
const ALGORITHM = 'HS256';

function assertJwtConfigured() {
  if (!SECRET) throw new Error('JWT_SECRET not configured');
}

// Session claims stay deliberately small: account identity + monotonic session
// version. Role/profile are always re-read from Mongo on every request.
function signSession(telegramId, sessionVersion = 0) {
  assertJwtConfigured();
  return jwt.sign(
    { sub: String(telegramId), sv: Number(sessionVersion) || 0, kind: 'browser' },
    SECRET,
    { expiresIn: EXPIRES_IN, algorithm: ALGORITHM },
  );
}

function verifySession(token) {
  if (!SECRET || !token) return null;
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: [ALGORITHM] });
    if (payload.kind !== 'browser') return null;
    const telegramId = String(payload.sub || '');
    if (!telegramId) return null;
    const rawVersion = Number(payload.sv);
    return {
      telegramId,
      sessionVersion: Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : null,
      iat: Number(payload.iat) || 0,
    };
  } catch {
    return null;
  }
}


function signTelegramSession(telegramId) {
  assertJwtConfigured();
  return jwt.sign(
    { sub: String(telegramId), kind: 'telegram' },
    SECRET,
    { expiresIn: TELEGRAM_EXPIRES_IN, algorithm: ALGORITHM },
  );
}

function verifyTelegramSession(token) {
  if (!SECRET || !token) return null;
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: [ALGORITHM] });
    if (payload.kind !== 'telegram') return null;
    const telegramId = String(payload.sub || '');
    if (!telegramId) return null;
    return { telegramId, iat: Number(payload.iat) || 0, exp: Number(payload.exp) || 0 };
  } catch {
    return null;
  }
}

// Every browser token carries an exact integer sessionVersion. Logout/unlink
// increments the DB version, instantly invalidating every older session. Tokens
// without `sv` are legacy credentials and are rejected.
function isSessionNotRevoked(session, user) {
  if (!session || session.sessionVersion === null || session.sessionVersion === undefined) return false;
  const currentVersion = Number(user?.sessionVersion) || 0;
  return Number(session.sessionVersion) === currentVersion;
}

module.exports = {
  signSession,
  verifySession,
  signTelegramSession,
  verifyTelegramSession,
  isSessionNotRevoked,
  assertJwtConfigured,
  ALGORITHM,
};

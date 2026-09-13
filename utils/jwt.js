const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || '';
const EXPIRES_IN = process.env.JWT_EXPIRY || '7d';
const ALGORITHM = 'HS256';

function assertJwtConfigured() {
  if (!SECRET) throw new Error('JWT_SECRET not configured');
}

// Session claims stay deliberately small: account identity + monotonic session
// version. Role/profile are always re-read from Mongo on every request.
function signSession(telegramId, sessionVersion = 0) {
  assertJwtConfigured();
  return jwt.sign(
    { sub: String(telegramId), sv: Number(sessionVersion) || 0 },
    SECRET,
    { expiresIn: EXPIRES_IN, algorithm: ALGORITHM },
  );
}

function verifySession(token) {
  if (!SECRET || !token) return null;
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: [ALGORITHM] });
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

// New tokens use an exact integer sessionVersion — logout/unlink increments the
// DB value, instantly invalidating every older browser session without clock
// precision or grace windows. Legacy tokens (without `sv`) are accepted only
// through the old timestamp cutoff during the migration window.
function isSessionNotRevoked(session, user) {
  if (!session) return false;
  const currentVersion = Number(user?.sessionVersion) || 0;
  if (session.sessionVersion !== null && session.sessionVersion !== undefined) {
    return Number(session.sessionVersion) === currentVersion;
  }

  const cutoff = user?.sessionsValidFrom;
  if (!cutoff) return true;
  return (Number(session.iat) || 0) * 1000 >= new Date(cutoff).getTime();
}

module.exports = {
  signSession,
  verifySession,
  isSessionNotRevoked,
  assertJwtConfigured,
  ALGORITHM,
};

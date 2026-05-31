const { OAuth2Client } = require('google-auth-library');
const { normalizeEmail } = require('./email');

const CLIENT_ID = process.env.GOOGLE_AUTH_CLIENT_ID || '';

if (!CLIENT_ID) {
  console.warn('[googleAuth] GOOGLE_AUTH_CLIENT_ID is not set — Google browser login will reject all attempts until it is configured');
}

// One client instance; it caches Google's signing certs internally and
// refreshes them on rotation, so verification stays local (no per-login
// round trip to Google's tokeninfo endpoint).
const client = CLIENT_ID ? new OAuth2Client(CLIENT_ID) : null;

function isConfigured() {
  return !!client;
}

// Verifies the ID token (signature, issuer, expiry, and that `aud` is OUR
// client id). Returns the Google subject id (`sub` — the stable identity key),
// normalized email, and whether Google says it's verified, or null on any
// failure. `sub` is what callers MUST key on; email is display-only.
async function verifyGoogleIdToken(credential) {
  if (!client || !credential) return null;
  try {
    const ticket = await client.verifyIdToken({
      idToken: String(credential),
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload?.email) return null;
    return {
      sub: String(payload.sub),
      email: normalizeEmail(payload.email),
      emailVerified: payload.email_verified === true,
    };
  } catch {
    return null;
  }
}

module.exports = { verifyGoogleIdToken, isConfigured };

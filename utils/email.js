// Email normalization + validation shared by the registration, profile, and
// Google-login paths. Mongoose lowercases/trims on SAVE via schema setters,
// but queries are NOT auto-normalized — so any lookup by googleEmail must run
// the value through normalizeEmail first to match what was stored.

function normalizeEmail(raw) {
  if (!raw) return '';
  return String(raw).trim().toLowerCase();
}

// Deliberately permissive: just enough to reject obvious garbage. The real
// proof of ownership is the signed Google ID token, not a regex.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 254 && EMAIL_RE.test(e);
}

module.exports = { normalizeEmail, isValidEmail };

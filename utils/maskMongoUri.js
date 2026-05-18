/**
 * Redacts credentials from a MongoDB connection string for safe logging.
 * `mongodb+srv://user:pass@cluster/db` → `mongodb+srv://***:***@cluster/db`.
 * Returns a placeholder for empty/non-string input. Never logs raw creds.
 */
function maskMongoUri(uri) {
  if (!uri || typeof uri !== 'string') return '(unset)';
  // Mask everything between `//` and the LAST `@` before the path, so a
  // password containing a literal `@` is still fully redacted.
  return uri.replace(/\/\/[^/]*@/, '//***:***@');
}

module.exports = { maskMongoUri };

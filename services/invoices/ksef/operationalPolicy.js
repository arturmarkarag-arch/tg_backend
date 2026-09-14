'use strict';

function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function sanitizeOperationalPath(value) {
  const raw = clean(value, 512).split('?')[0];
  return raw
    .replace(/[0-9a-f]{24}/gi, '{objectId}')
    .replace(/[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}/gi, '{uuid}')
    .replace(/[A-Z0-9-]{30,}/gi, '{providerId}');
}
function restartExportDisposition(referenceNumber) {
  return clean(referenceNumber, 256) ? 'processing' : 'ambiguous_submit';
}
function retryIsSafe(kind, row = {}) {
  switch (String(kind || '')) {
    case 'fiscal_submission': return Boolean(row.providerData?.sessionReferenceNumber);
    case 'inbound_sync': return row.state === 'manual_review' && row.enabled !== false;
    case 'inbound_document': return row.artifactState === 'manual_review' || row.fetch?.state === 'manual_review';
    case 'inbound_export': return row.state === 'manual_review' && Boolean(clean(row.referenceNumber, 256));
    case 'certificate_enrollment': return row.state !== 'ambiguous_submit' && Boolean(clean(row.referenceNumber, 256));
    case 'technical_correction': return Boolean(row.providerData?.sessionReferenceNumber);
    default: return false;
  }
}
function readinessStatus(blockers = [], warnings = []) {
  if (Array.isArray(blockers) && blockers.length) return 'blocked';
  if (Array.isArray(warnings) && warnings.length) return 'degraded';
  return 'ready';
}

module.exports = { sanitizeOperationalPath, restartExportDisposition, retryIsSafe, readinessStatus };

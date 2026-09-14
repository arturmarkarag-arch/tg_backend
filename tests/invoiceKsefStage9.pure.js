'use strict';

const assert = require('assert');
const {
  sanitizeOperationalPath, restartExportDisposition, retryIsSafe, readinessStatus,
} = require('../services/invoices/ksef/operationalPolicy');

assert.strictEqual(readinessStatus([], []), 'ready');
assert.strictEqual(readinessStatus([], ['manual_review_present']), 'degraded');
assert.strictEqual(readinessStatus(['stale_leases_present'], ['manual_review_present']), 'blocked');

assert.strictEqual(restartExportDisposition('EXP-REF-123'), 'processing');
assert.strictEqual(restartExportDisposition(''), 'ambiguous_submit');

assert.strictEqual(retryIsSafe('inbound_export', { state: 'manual_review', referenceNumber: 'REF-1' }), true);
assert.strictEqual(retryIsSafe('inbound_export', { state: 'ambiguous_submit', referenceNumber: '' }), false);
assert.strictEqual(retryIsSafe('certificate_enrollment', { state: 'manual_review', referenceNumber: 'REF-2' }), true);
assert.strictEqual(retryIsSafe('certificate_enrollment', { state: 'ambiguous_submit', referenceNumber: '' }), false);
assert.strictEqual(retryIsSafe('fiscal_submission', { providerData: { sessionReferenceNumber: 'SESSION-1' } }), true);
assert.strictEqual(retryIsSafe('fiscal_submission', { providerData: {} }), false);
assert.strictEqual(retryIsSafe('inbound_document', { artifactState: 'manual_review', fetch: { state: 'manual_review' } }), true);

const sanitized = sanitizeOperationalPath('/sessions/1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ/invoices/507f1f77bcf86cd799439011?token=SECRET');
assert(!sanitized.includes('SECRET'));
assert(!sanitized.includes('507f1f77bcf86cd799439011'));
assert(sanitized.includes('{objectId}'));
assert(sanitized.includes('{providerId}'));

console.log('Invoice KSeF Stage 9 pure operational policy passed');

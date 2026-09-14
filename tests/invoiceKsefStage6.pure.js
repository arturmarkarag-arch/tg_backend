'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  SUBJECT_TYPE,
  PAGE_SIZE,
  MAX_WINDOW_MS,
  MIN_SYNC_INTERVAL_MS,
  PAGE_CONTINUE_MS,
  FETCH_TICK_MS,
  FETCH_LEASE_MS,
  SYNC_LEASE_MS,
  MAX_RETRY_MS,
  asDate,
  minDate,
  buildRequestedWindowEnd,
  effectiveWindowEnd,
  buildMetadataFilters,
  normalizeKsefNumber,
  normalizeHashBase64,
  sha256Base64,
  sha256Hex,
  isFa3Xml,
  retryAfterMs,
  retryDelayMs,
  syncKey,
} = require('../services/invoices/ksef/inboundPolicy');

assert.equal(SUBJECT_TYPE, 'Subject2');
assert.equal(PAGE_SIZE, 250);
assert.equal(MAX_WINDOW_MS, 90 * 24 * 60 * 60 * 1000);
assert.equal(MIN_SYNC_INTERVAL_MS, 15 * 60 * 1000);
assert.equal(PAGE_CONTINUE_MS, 4 * 60 * 1000);
assert.equal(FETCH_TICK_MS, 90 * 1000);
assert.equal(FETCH_LEASE_MS, 60 * 1000);
assert.equal(SYNC_LEASE_MS, 2 * 60 * 1000);
assert.equal(MAX_RETRY_MS, 15 * 60 * 1000);

const from = new Date('2026-01-01T00:00:00.000Z');
const farNow = new Date('2026-06-01T00:00:00.000Z');
const bounded = buildRequestedWindowEnd(from, farNow);
assert.equal(bounded.toISOString(), new Date(from.getTime() + MAX_WINDOW_MS).toISOString(), 'query window must be capped');
assert.equal(buildRequestedWindowEnd(from, new Date('2026-01-05T00:00:00.000Z')).toISOString(), '2026-01-05T00:00:00.000Z');
assert.equal(asDate('not-a-date'), null);
assert.equal(minDate('2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z').toISOString(), '2026-01-02T00:00:00.000Z');
assert.equal(effectiveWindowEnd('2026-01-10T00:00:00Z', '2026-01-07T00:00:00Z').toISOString(), '2026-01-07T00:00:00.000Z');

const filters = buildMetadataFilters({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
assert.deepEqual(filters, {
  subjectType: 'Subject2',
  dateRange: {
    dateType: 'PermanentStorage',
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-02T00:00:00.000Z',
    restrictToPermanentStorageHwmDate: true,
  },
});
assert.throws(() => buildMetadataFilters({ from: '2026-01-02', to: '2026-01-01' }), /Invalid PermanentStorage window/);

const validKsefNumber = '5265877635-20250626-010080DD2B5E-26';
assert.equal(normalizeKsefNumber(validKsefNumber.toLowerCase()), validKsefNumber);
assert.equal(normalizeKsefNumber(`${validKsefNumber}\r\nX-Evil: 1`), '');
assert.equal(normalizeKsefNumber('x'.repeat(35)), '');

const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('<Faktura>\r\n<Fa>1</Fa>\r\n</Faktura>', 'utf8')]);
const expectedB64 = crypto.createHash('sha256').update(bytes).digest('base64');
const expectedHex = crypto.createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256Base64(bytes), expectedB64, 'hash must use exact raw bytes including BOM/CRLF');
assert.equal(sha256Hex(bytes), expectedHex);
assert.equal(normalizeHashBase64(expectedB64), expectedB64);
assert.equal(normalizeHashBase64(expectedB64.replace(/=+$/, '')), expectedB64);
assert.equal(normalizeHashBase64(Buffer.alloc(31).toString('base64')), '');
assert.equal(normalizeHashBase64('not base64'), '');

assert.equal(isFa3Xml('<Faktura kodSystemowy="FA (3)"></Faktura>'), true);
assert.equal(isFa3Xml('<Faktura xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"></Faktura>'), true);
assert.equal(isFa3Xml('<Faktura kodSystemowy="FA (2)"></Faktura>'), false);

assert.equal(retryAfterMs({ args: { retryAfter: '7' } }), 7000);
assert.equal(retryAfterMs({ ksef: { retryAfter: '99999' } }), MAX_RETRY_MS);
assert.equal(retryAfterMs({}), 0);
assert.equal(retryDelayMs(1, {}, { floorMs: 1000 }), 1000);
assert.equal(retryDelayMs(2, {}, { floorMs: 1000 }), 2000);
assert.equal(retryDelayMs(20, {}, { floorMs: 1000 }), 32000);
assert.equal(retryDelayMs(1, { args: { retryAfter: '20' } }, { floorMs: 1000 }), 20000);

const key1 = syncKey('legal-1', 'test');
const key2 = syncKey('legal-1', 'test');
assert.equal(key1.length, 64);
assert.equal(key1, key2);
assert.notEqual(key1, syncKey('legal-2', 'test'));
assert.notEqual(key1, syncKey('legal-1', 'prod'));

console.log('Invoice KSeF Stage 6 pure inbound/HWM contract passed');

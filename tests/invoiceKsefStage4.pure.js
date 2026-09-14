'use strict';

const assert = require('assert');
const {
  normalizedHash,
  sessionStatusCode,
  isTerminalSessionStatus,
  selectInvoiceHashMatches,
  retryAfterMs,
  retryDelayMs,
  buildSessionInvoicesRequest,
} = require('../services/invoices/ksef/reconciliationPolicy');
const { ksefRequest } = require('../services/invoices/ksef/http');

async function run() {
  assert.equal(normalizedHash('  abc\n123  '), 'abc123');
  assert.equal(sessionStatusCode({ status: { code: 150 } }), 150);
  assert.equal(isTerminalSessionStatus({ status: { code: 150 } }), false);
  assert.equal(isTerminalSessionStatus({ status: { code: 200 } }), true);
  assert.equal(isTerminalSessionStatus({ status: { code: 440 } }), true);

  const invoices = [
    { referenceNumber: 'ref-a', invoiceHash: 'AAAA' },
    { referenceNumber: 'ref-b', invoiceHash: ' BBBB\n' },
    { referenceNumber: 'ref-c', invoiceHash: 'CCCC' },
  ];
  assert.deepEqual(selectInvoiceHashMatches(invoices, 'BBBB').map((row) => row.referenceNumber), ['ref-b']);
  assert.deepEqual(selectInvoiceHashMatches(invoices, ''), []);

  assert.equal(retryAfterMs({ args: { retryAfter: '12' } }, 0), 12_000);
  assert.equal(retryAfterMs({ args: { retryAfter: 'Thu, 01 Jan 1970 00:00:30 GMT' } }, 10_000), 20_000);
  assert.equal(retryDelayMs(1, null, { tickMs: 15_000, maxBackoffMs: 300_000, nowMs: 0 }), 15_000);
  assert.equal(retryDelayMs(7, null, { tickMs: 15_000, maxBackoffMs: 300_000, nowMs: 0 }), 300_000);
  assert.equal(retryDelayMs(1, { args: { retryAfter: '45' } }, { tickMs: 15_000, maxBackoffMs: 300_000, nowMs: 0 }), 45_000);

  const originalFetch = global.fetch;

  const firstPage = buildSessionInvoicesRequest('session/ref', '');
  assert(firstPage.path.includes('/sessions/session%2Fref/invoices?pageSize=1000'));
  assert.deepEqual(firstPage.headers, {});
  assert(!firstPage.path.includes('continuationToken'));
  const nextPage = buildSessionInvoicesRequest('session/ref', 'next token');
  assert.equal(nextPage.headers['x-continuation-token'], 'next token');
  assert(!nextPage.path.includes('continuationToken'));

  const rawUpo = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), // Keep BOM to prove byte-exact transport.
    Buffer.from('<UPO>signed</UPO>\r\n', 'utf8'),
  ]);
  global.fetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => rawUpo.buffer.slice(rawUpo.byteOffset, rawUpo.byteOffset + rawUpo.byteLength),
    text: async () => rawUpo.toString('utf8'),
    headers: { get: (name) => String(name).toLowerCase() === 'x-ms-meta-hash' ? 'provider-hash' : null },
  });
  try {
    const bufferResponse = await ksefRequest('test', '/fake-upo', { responseType: 'buffer' });
    assert(Buffer.isBuffer(bufferResponse.body));
    assert.deepEqual(bufferResponse.body, rawUpo);
    assert.equal(bufferResponse.headers.get('x-ms-meta-hash'), 'provider-hash');

    const textResponse = await ksefRequest('test', '/fake-upo-text', { responseType: 'text' });
    assert.equal(textResponse.body, rawUpo.toString('utf8'));
  } finally {
    global.fetch = originalFetch;
  }

  console.log('Invoice KSeF Stage 4 pure lifecycle contract passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

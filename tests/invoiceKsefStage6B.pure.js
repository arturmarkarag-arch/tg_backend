'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  EXPORT_COMPRESSION,
  EXPORT_POLL_MS,
  EXPORT_RETRY_MS,
  EXPORT_LEASE_MS,
  exportKey,
  normalizeExportReference,
  parseExportStatus,
  continuationFromPackage,
  buildMetadataHashIndex,
} = require('../services/invoices/ksef/inboundExportPolicy');
const {
  safeExportUrl,
  decryptExportPart,
  tarHeaderInfo,
  forEachTarGzEntry,
} = require('../services/invoices/ksef/inboundExportArchive');

assert.equal(EXPORT_COMPRESSION, 'TarGz');
assert.equal(EXPORT_POLL_MS, 30_000);
assert.equal(EXPORT_RETRY_MS, 120_000);
assert.equal(EXPORT_LEASE_MS, 15 * 60_000);

const from = new Date('2026-01-01T00:00:00.000Z');
const to = new Date('2026-01-02T00:00:00.000Z');
assert.equal(exportKey('sync-1', from, to), exportKey('sync-1', from, to));
assert.notEqual(exportKey('sync-1', from, to), exportKey('sync-2', from, to));
assert.throws(() => exportKey('sync-1', to, from), /Invalid export identity/);
assert.equal(normalizeExportReference('20260806-EH-229E18A000-B8513A6D11-32'), '20260806-EH-229E18A000-B8513A6D11-32');
assert.equal(normalizeExportReference('bad'), '');

const processing = parseExportStatus({ status: { code: 100, description: 'processing' } });
assert.equal(processing.code, 100);
assert.equal(processing.completed, false);

const hashA = crypto.createHash('sha256').update('a').digest('base64');
const hashB = crypto.createHash('sha256').update('b').digest('base64');
const status200 = parseExportStatus({
  status: { code: 200, description: 'ok' },
  completedDate: '2026-01-02T00:02:00Z',
  packageExpirationDate: '2026-01-09T00:00:00Z',
  package: {
    invoiceCount: 1,
    size: 123,
    isTruncated: false,
    permanentStorageHwmDate: '2026-01-02T00:00:00Z',
    parts: [{
      partName: 'part-0001',
      partSize: 1,
      partHash: hashA,
      encryptedPartSize: 16,
      encryptedPartHash: hashB,
      expirationDate: '2026-01-02T00:10:00Z',
      url: 'https://example.invalid/signed-part',
    }],
  },
});
assert.equal(status200.completed, true);
assert.equal(status200.package.invoiceCount, 1);
assert.equal(status200.package.parts[0].partHash, hashA);
assert.equal(status200.package.completedDate.toISOString(), '2026-01-02T00:02:00.000Z');
assert.equal(status200.package.packageExpirationDate.toISOString(), '2026-01-09T00:00:00.000Z');
assert.equal(continuationFromPackage(status200.package, from).toISOString(), '2026-01-02T00:00:00.000Z');

const emptyStatus = parseExportStatus({
  status: { code: 200, description: 'ok' },
  package: {
    invoiceCount: 0,
    size: 0,
    isTruncated: false,
    permanentStorageHwmDate: '2026-01-02T00:00:00Z',
    parts: [],
  },
});
assert.equal(emptyStatus.package.invoiceCount, 0);
assert.equal(emptyStatus.package.parts.length, 0);
assert.equal(continuationFromPackage(emptyStatus.package, from).toISOString(), '2026-01-02T00:00:00.000Z');

const truncated = parseExportStatus({
  status: { code: 200, description: 'ok' },
  package: {
    invoiceCount: 10000,
    size: 123,
    isTruncated: true,
    lastPermanentStorageDate: '2026-01-01T12:00:00Z',
    permanentStorageHwmDate: '2026-01-02T00:00:00Z',
    parts: [{
      partName: 'part-0001', partSize: 1, partHash: hashA,
      encryptedPartSize: 16, encryptedPartHash: hashB,
      expirationDate: '2026-01-02T00:10:00Z', url: 'https://example.invalid/signed-part',
    }],
  },
});
assert.equal(continuationFromPackage(truncated.package, from).toISOString(), '2026-01-01T12:00:00.000Z');
assert.throws(() => parseExportStatus({
  status: { code: 200 },
  package: { invoiceCount: 1, size: 1, isTruncated: true, permanentStorageHwmDate: '2026-01-02T00:00:00Z', parts: [] },
}), /Missing truncated continuation/);

assert.equal(safeExportUrl('https://storage.example.invalid/path?q=x'), 'https://storage.example.invalid/path?q=x');
for (const unsafe of [
  'http://storage.example.invalid/x',
  'https://user:pass@storage.example.invalid/x',
  'https://localhost/x',
  'https://127.0.0.1/x',
  'https://[::1]/x',
]) assert.throws(() => safeExportUrl(unsafe), /KSeF|export|URL|wewnętrzny/i);

const key = crypto.randomBytes(32);
const iv = crypto.randomBytes(16);
const plain = Buffer.from('hello-export-part\n', 'utf8');
const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
const part = {
  partSize: plain.length,
  partHash: crypto.createHash('sha256').update(plain).digest('base64'),
  encryptedPartSize: encrypted.length,
  encryptedPartHash: crypto.createHash('sha256').update(encrypted).digest('base64'),
};
assert.deepEqual(decryptExportPart(encrypted, key, iv, part), plain);
assert.throws(() => decryptExportPart(Buffer.concat([encrypted.subarray(0, -1), Buffer.from([encrypted.at(-1) ^ 1])]), key, iv, part));
assert.throws(() => decryptExportPart(encrypted, key, iv, { ...part, partHash: hashA }));

const invoiceHash = crypto.createHash('sha256').update('<xml/>').digest('base64');
const idx = buildMetadataHashIndex([
  { ksefNumber: '5265877635-20250626-010080DD2B5E-26', invoiceHash },
]);
assert.equal(idx.get(invoiceHash).length, 1);
assert.equal(idx.get(invoiceHash)[0].ksefNumber, '5265877635-20250626-010080DD2B5E-26');

function tarOctal(value, width) {
  const oct = Math.max(0, value).toString(8);
  return `${'0'.repeat(Math.max(0, width - oct.length - 1))}${oct}\0`;
}
function tarEntry(name, bytes) {
  const data = Buffer.from(bytes);
  const header = Buffer.alloc(512);
  header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(tarOctal(data.length, 12), 124, 12, 'ascii');
  header.write(tarOctal(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header[156] = '0'.charCodeAt(0);
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(tarOctal(sum, 8), 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, padding]);
}
function tarGz(entries) {
  return zlib.gzipSync(Buffer.concat([
    ...entries.map(([name, bytes]) => tarEntry(name, bytes)),
    Buffer.alloc(1024),
  ]));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ksef-stage6b-pure-'));
(async () => {
  try {
    const archive = path.join(tmp, 'package.tar.gz');
    fs.writeFileSync(archive, tarGz([
      ['_metadata.json', Buffer.from(JSON.stringify({ invoices: [] }))],
      ['5265877635-20250626-010080DD2B5E-26.xml', Buffer.from('<Faktura/>')],
    ]));
    const names = [];
    const result = await forEachTarGzEntry(archive, async ({ name, bytes }) => {
      names.push([name, bytes.length]);
    });
    assert.deepEqual(names.map((x) => x[0]), ['_metadata.json', '5265877635-20250626-010080DD2B5E-26.xml']);
    assert.equal(result.entries, 2);

    const badHeader = tarEntry('../evil.xml', Buffer.from('x')).subarray(0, 512);
    assert.throws(() => tarHeaderInfo(badHeader));

    console.log('Invoice KSeF Stage 6B pure export/TarGz contract passed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

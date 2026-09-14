'use strict';

const crypto = require('crypto');

function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let n = length; n > 0; n >>>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag, value) {
  const body = Buffer.from(value || []);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
function seq(...items) { return tlv(0x30, Buffer.concat(items.map(Buffer.from))); }
function set(...items) { return tlv(0x31, Buffer.concat(items.map(Buffer.from))); }
function nullValue() { return Buffer.from([0x05, 0x00]); }
function utf8(value) { return tlv(0x0c, Buffer.from(String(value), 'utf8')); }
function bitString(value) { return tlv(0x03, Buffer.concat([Buffer.from([0x00]), Buffer.from(value)])); }
function integerBytes(value) {
  let bytes = Buffer.from(value);
  while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] & 0x80) === 0) bytes = bytes.subarray(1);
  if (!bytes.length) bytes = Buffer.from([0]);
  if ((bytes[0] & 0x80) !== 0) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return tlv(0x02, bytes);
}
function oidPart(value) {
  let n = BigInt(value);
  const out = [Number(n & 0x7fn)];
  n >>= 7n;
  while (n > 0n) { out.unshift(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  return out;
}
function oid(value) {
  const parts = String(value).split('.').map((part) => BigInt(part));
  const bytes = [Number(parts[0] * 40n + parts[1])];
  for (let i = 2; i < parts.length; i += 1) bytes.push(...oidPart(parts[i]));
  return tlv(0x06, Buffer.from(bytes));
}
function utcTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, '0');
  const text = `${yy}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}
function name(commonName) { return seq(set(seq(oid('2.5.4.3'), utf8(commonName)))); }
function signatureAlgorithm(algorithm) {
  return algorithm === 'ec'
    ? seq(oid('1.2.840.10045.4.3.2'))
    : seq(oid('1.2.840.113549.1.1.11'), nullValue());
}
function signTbs(tbs, privateKey, algorithm) {
  return algorithm === 'ec'
    ? crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' })
    : crypto.sign('sha256', tbs, privateKey);
}

function generateEphemeralCertificate(algorithm) {
  const kind = String(algorithm || '').toLowerCase();
  let pair;
  if (kind === 'ec') pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  else if (kind === 'rsa') pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  else throw new Error('unsupported ephemeral certificate algorithm');

  const now = Date.now();
  const serial = crypto.randomBytes(8);
  serial[0] &= 0x7f;
  if (serial[0] === 0) serial[0] = 1;
  const alg = signatureAlgorithm(kind);
  const subject = name(`KSeF Stage5B TEST ${kind.toUpperCase()}`);
  const validity = seq(utcTime(new Date(now - 60 * 60 * 1000)), utcTime(new Date(now + 24 * 60 * 60 * 1000)));
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const versionV3 = tlv(0xa0, integerBytes(Buffer.from([2])));
  const tbs = seq(versionV3, integerBytes(serial), alg, subject, validity, subject, spki);
  const signature = signTbs(tbs, pair.privateKey, kind);
  const certificateDer = seq(tbs, alg, bitString(signature));
  const certificate = new crypto.X509Certificate(certificateDer);
  const privateKeyPem = String(pair.privateKey.export({ format: 'pem', type: 'pkcs8' }));

  return { certificate, certificateBase64: certificate.raw.toString('base64'), privateKeyPem };
}

module.exports = { generateEphemeralCertificate };

'use strict';

const crypto = require('crypto');
const { appError } = require('../../../utils/errors');

const MASTER_KEY_ENV = 'KSEF_CREDENTIAL_ENCRYPTION_KEY';

function clean(value, max = 16384) { return String(value ?? '').trim().slice(0, max); }
function masterKey() {
  const raw = clean(process.env[MASTER_KEY_ENV], 4096);
  if (!raw || Buffer.byteLength(raw, 'utf8') < 32) throw appError('ksef_credential_encryption_not_configured');
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}
function aad(connectionId, kind) { return Buffer.from(`ksef:${clean(connectionId, 64)}:${clean(kind, 40)}`, 'utf8'); }
function encryptSecret(value, connectionId, kind) {
  const input = clean(value);
  if (!input) throw appError('ksef_secret_required');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(aad(connectionId, kind));
  const ciphertext = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decryptSecret(payload, connectionId, kind) {
  if (!payload || Number(payload.version) !== 1 || !payload.iv || !payload.tag || !payload.ciphertext) throw appError('ksef_secret_decrypt_failed');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(String(payload.iv), 'base64'));
    decipher.setAAD(aad(connectionId, kind));
    decipher.setAuthTag(Buffer.from(String(payload.tag), 'base64'));
    const out = Buffer.concat([decipher.update(Buffer.from(String(payload.ciphertext), 'base64')), decipher.final()]).toString('utf8').trim();
    if (!out) throw new Error('empty secret');
    return out;
  } catch (error) {
    if (error?.code === 'ksef_credential_encryption_not_configured') throw error;
    throw appError('ksef_secret_decrypt_failed');
  }
}
function fingerprint(value) { return crypto.createHmac('sha256', masterKey()).update(clean(value), 'utf8').digest('hex'); }
function hint(value) { const v = clean(value); return v ? `••••${v.slice(-4)}` : ''; }

module.exports = { MASTER_KEY_ENV, encryptSecret, decryptSecret, fingerprint, hint };

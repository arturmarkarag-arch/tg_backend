'use strict';

const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const { appError } = require('../../../utils/errors');
const { normalizeHashBase64, sha256Base64 } = require('./inboundPolicy');
const { MAX_PART_BYTES, MAX_ENTRY_BYTES, MAX_EXTRACTED_BYTES } = require('./inboundExportPolicy');

function safeExportUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { throw appError('ksef_inbound_export_url_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.hostname === 'localhost') {
    throw appError('ksef_inbound_export_url_invalid');
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.includes(':')) {
    throw appError('ksef_inbound_export_url_invalid');
  }
  return url.toString();
}

function verifyHashSize(bytes, expectedSize, expectedHash, errorCode) {
  const size = Number(expectedSize);
  const hash = normalizeHashBase64(expectedHash);
  if (!Buffer.isBuffer(bytes) || !Number.isInteger(size) || size < 0 || !hash || bytes.length !== size || sha256Base64(bytes) !== hash) {
    throw appError(errorCode);
  }
}

function decryptExportPart(encryptedBytes, key, iv, part) {
  verifyHashSize(encryptedBytes, part.encryptedPartSize, part.encryptedPartHash, 'ksef_inbound_export_encrypted_part_mismatch');
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(iv) || iv.length !== 16) throw appError('ksef_inbound_export_secret_invalid');
  let decrypted;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(true);
    decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
  } catch (_) { throw appError('ksef_inbound_export_decrypt_failed'); }
  verifyHashSize(decrypted, part.partSize, part.partHash, 'ksef_inbound_export_plain_part_mismatch');
  return decrypted;
}

async function downloadExportPart(url, { timeoutMs = 60_000, maxBytes = MAX_PART_BYTES } = {}) {
  const safeUrl = safeExportUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(safeUrl, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Accept: 'application/octet-stream,*/*;q=0.1' } });
    if (!response.ok) throw appError('ksef_inbound_export_part_download_failed', { httpStatus: response.status });
    const length = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(length) && length > maxBytes) throw appError('ksef_inbound_export_part_too_large');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes) throw appError('ksef_inbound_export_part_too_large');
    return bytes;
  } catch (error) {
    if (error?.name === 'AbortError') throw appError('ksef_inbound_export_part_timeout');
    if (error?.code && String(error.code).startsWith('ksef_')) throw error;
    throw appError('ksef_inbound_export_part_download_failed');
  } finally { clearTimeout(timer); }
}

function parseOctal(buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw appError('ksef_inbound_export_tar_invalid');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw appError('ksef_inbound_export_tar_invalid');
  return value;
}

function tarHeaderInfo(header) {
  if (!Buffer.isBuffer(header) || header.length !== 512) throw appError('ksef_inbound_export_tar_invalid');
  if (header.every((byte) => byte === 0)) return { zero: true };
  const storedChecksum = parseOctal(header.subarray(148, 156));
  let computed = 0;
  for (let i = 0; i < 512; i += 1) computed += (i >= 148 && i < 156) ? 32 : header[i];
  if (storedChecksum !== computed) throw appError('ksef_inbound_export_tar_checksum_invalid');
  const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
  const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
  const fullName = prefix ? `${prefix}/${name}` : name;
  const type = String.fromCharCode(header[156] || 0);
  const size = parseOctal(header.subarray(124, 136));
  if (!fullName || fullName.startsWith('/') || fullName.includes('\\') || fullName.split('/').some((part) => part === '..')) {
    throw appError('ksef_inbound_export_tar_path_invalid');
  }
  return { zero: false, name: fullName, type, size };
}

async function forEachTarGzEntry(filePath, onEntry, {
  maxEntryBytes = MAX_ENTRY_BYTES,
  maxExtractedBytes = MAX_EXTRACTED_BYTES,
} = {}) {
  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(filePath).pipe(gunzip);
  let pending = Buffer.alloc(0);
  let current = null;
  let paddingRemaining = 0;
  let zeroBlocks = 0;
  let extracted = 0;
  let entries = 0;

  async function finishCurrent() {
    const bytes = Buffer.concat(current.chunks, current.size);
    const type = current.type;
    const name = current.name;
    current = null;
    if (type === '0' || type === '\0' || type === '') {
      entries += 1;
      await onEntry({ name, bytes });
    }
  }

  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (true) {
        if (paddingRemaining > 0) {
          if (pending.length < paddingRemaining) {
            paddingRemaining -= pending.length;
            pending = Buffer.alloc(0);
            break;
          }
          pending = pending.subarray(paddingRemaining);
          paddingRemaining = 0;
        }

        if (current) {
          if (!pending.length) break;
          const need = current.size - current.received;
          const take = Math.min(need, pending.length);
          if (take > 0) {
            current.chunks.push(pending.subarray(0, take));
            current.received += take;
            pending = pending.subarray(take);
          }
          if (current.received < current.size) break;
          const size = current.size;
          await finishCurrent();
          paddingRemaining = (512 - (size % 512)) % 512;
          continue;
        }

        if (pending.length < 512) break;
        const header = Buffer.from(pending.subarray(0, 512));
        pending = pending.subarray(512);
        const info = tarHeaderInfo(header);
        if (info.zero) {
          zeroBlocks += 1;
          if (zeroBlocks >= 2) return { entries, extractedBytes: extracted };
          continue;
        }
        zeroBlocks = 0;
        if (info.size > maxEntryBytes) throw appError('ksef_inbound_export_entry_too_large', { name: info.name, size: info.size });
        extracted += info.size;
        if (extracted > maxExtractedBytes) throw appError('ksef_inbound_export_archive_too_large');
        current = { ...info, received: 0, chunks: [] };
        if (current.size === 0) {
          await finishCurrent();
          continue;
        }
      }
    }
  } catch (error) {
    if (error?.code && String(error.code).startsWith('ksef_')) throw error;
    throw appError('ksef_inbound_export_archive_invalid', { cause: String(error?.message || error).slice(0, 300) });
  }
  if (current || paddingRemaining || pending.length >= 512) throw appError('ksef_inbound_export_tar_invalid');
  return { entries, extractedBytes: extracted };
}

module.exports = {
  safeExportUrl,
  verifyHashSize,
  decryptExportPart,
  downloadExportPart,
  parseOctal,
  tarHeaderInfo,
  forEachTarGzEntry,
};

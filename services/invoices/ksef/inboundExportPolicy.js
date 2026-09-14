'use strict';

const crypto = require('crypto');
const { asDate, normalizeHashBase64, normalizeKsefNumber } = require('./inboundPolicy');

const EXPORT_COMPRESSION = 'TarGz';
const EXPORT_POLL_MS = 30 * 1000;
const EXPORT_RETRY_MS = 2 * 60 * 1000;
const EXPORT_LEASE_MS = 15 * 60 * 1000;
const EXPORT_MAX_RETRY_MS = 30 * 60 * 1000;
const MAX_PART_BYTES = 55 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

function exportKey(syncId, from, to) {
  const start = asDate(from);
  const end = asDate(to);
  if (!syncId || !start || !end || end.getTime() < start.getTime()) throw new TypeError('Invalid export identity');
  return crypto.createHash('sha256')
    .update(`ksef|${String(syncId)}|Subject2|PermanentStorage|${start.toISOString()}|${end.toISOString()}`, 'utf8')
    .digest('hex');
}

function normalizeExportReference(value) {
  const text = String(value || '').trim().toUpperCase();
  return /^[0-9A-Z-]{20,64}$/.test(text) ? text : '';
}

function parseExportStatus(body = {}) {
  const code = Number(body?.status?.code);
  const description = String(body?.status?.description || '').trim().slice(0, 1000);
  if (!Number.isInteger(code)) throw new TypeError('Invalid export status');
  if (code !== 200) return { code, description, completed: false, package: null };
  const pkg = body.package;
  if (!pkg || !Array.isArray(pkg.parts)) throw new TypeError('Missing export package');
  const invoiceCount = Number(pkg.invoiceCount);
  const packageSize = Number(pkg.size);
  if (!Number.isInteger(invoiceCount) || invoiceCount < 0 || invoiceCount > 10_000) throw new TypeError('Invalid export invoice count');
  if (!Number.isInteger(packageSize) || packageSize < 0 || packageSize > 1_073_741_824) throw new TypeError('Invalid export package size');
  if (typeof pkg.isTruncated !== 'boolean') throw new TypeError('Invalid export truncation flag');
  const parts = pkg.parts.map((part) => {
    const partHash = normalizeHashBase64(part.partHash);
    const encryptedPartHash = normalizeHashBase64(part.encryptedPartHash);
    const partSize = Number(part.partSize);
    const encryptedPartSize = Number(part.encryptedPartSize);
    const expirationDate = asDate(part.expirationDate);
    const url = String(part.url || '').trim();
    const partName = String(part.partName || '').trim();
    if (!partHash || !encryptedPartHash || !Number.isInteger(partSize) || partSize < 0 ||
        !Number.isInteger(encryptedPartSize) || encryptedPartSize < 1 || !expirationDate || !url || !partName) {
      throw new TypeError('Invalid export part');
    }
    return { partName, partSize, partHash, encryptedPartSize, encryptedPartHash, expirationDate, url };
  });
  const permanentStorageHwmDate = asDate(pkg.permanentStorageHwmDate);
  const isTruncated = pkg.isTruncated === true;
  const lastPermanentStorageDate = asDate(pkg.lastPermanentStorageDate);
  if (!permanentStorageHwmDate) throw new TypeError('Missing export HWM');
  if (isTruncated && !lastPermanentStorageDate) throw new TypeError('Missing truncated continuation');
  return {
    code,
    description,
    completed: true,
    package: {
      invoiceCount,
      size: packageSize,
      isTruncated,
      lastPermanentStorageDate,
      permanentStorageHwmDate,
      packageExpirationDate: asDate(pkg.packageExpirationDate || body.packageExpirationDate),
      completedDate: asDate(pkg.completedDate || body.completedDate),
      parts,
    },
  };
}

function continuationFromPackage(pkg, currentFrom) {
  const from = asDate(currentFrom);
  if (!from || !pkg) return null;
  const next = pkg.isTruncated ? asDate(pkg.lastPermanentStorageDate) : asDate(pkg.permanentStorageHwmDate);
  if (!next || next.getTime() < from.getTime()) return null;
  if (pkg.isTruncated && next.getTime() <= from.getTime()) return null;
  return next;
}

function metadataIdentity(item = {}) {
  const ksefNumber = normalizeKsefNumber(item.ksefNumber);
  const fileHash = normalizeHashBase64(item.invoiceHash || item.fileHash);
  if (!ksefNumber || !fileHash) return null;
  return { ksefNumber, fileHash };
}

function buildMetadataHashIndex(invoices = []) {
  const map = new Map();
  for (const item of invoices) {
    const identity = metadataIdentity(item);
    if (!identity) throw new TypeError('Invalid export metadata identity');
    const bucket = map.get(identity.fileHash) || [];
    bucket.push({ item, ...identity });
    map.set(identity.fileHash, bucket);
  }
  return map;
}

module.exports = {
  EXPORT_COMPRESSION,
  EXPORT_POLL_MS,
  EXPORT_RETRY_MS,
  EXPORT_LEASE_MS,
  EXPORT_MAX_RETRY_MS,
  MAX_PART_BYTES,
  MAX_ENTRY_BYTES,
  MAX_EXTRACTED_BYTES,
  exportKey,
  normalizeExportReference,
  parseExportStatus,
  continuationFromPackage,
  metadataIdentity,
  buildMetadataHashIndex,
};

'use strict';

function stableClone(value) {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableClone);
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
      out[key] = stableClone(item);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableClone(value));
}

module.exports = { stableClone, stableStringify };

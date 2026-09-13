'use strict';

const { appError } = require('../../../utils/errors');
const { ksefRequest } = require('./http');
const { certificateDerToPublicKey } = require('./crypto');

const cache = new Map();
const CACHE_MS = 15 * 60 * 1000;
function invalidatePublicKeys(environment) { if (environment) cache.delete(String(environment)); else cache.clear(); }
async function loadPublicKeys(environment, { force = false } = {}) {
  const current = cache.get(environment);
  if (!force && current && current.expiresAt > Date.now()) return current.items;
  const response = await ksefRequest(environment, '/security/public-key-certificates');
  const items = Array.isArray(response.body) ? response.body : [];
  if (!items.length) throw appError('ksef_public_keys_unavailable');
  cache.set(environment, { items, expiresAt: Date.now() + CACHE_MS });
  return items;
}
async function getPublicKey(environment, usage, { force = false, now = new Date() } = {}) {
  const items = await loadPublicKeys(environment, { force });
  const ts = now.getTime();
  const matching = items.filter((item) => Array.isArray(item?.usage) && item.usage.includes(usage))
    .filter((item) => new Date(item.validFrom).getTime() <= ts && new Date(item.validTo).getTime() > ts)
    .sort((a, b) => new Date(b.validFrom).getTime() - new Date(a.validFrom).getTime());
  const item = matching[0];
  if (!item?.certificate || !item?.publicKeyId) throw appError('ksef_public_key_not_found', { usage });
  return { ...item, publicKey: certificateDerToPublicKey(item.certificate) };
}
module.exports = { loadPublicKeys, getPublicKey, invalidatePublicKeys };

'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const axios = require('axios');

const MAX_IMAGE_BYTES = Math.max(1_048_576, Number(process.env.IMAGE_PROXY_MAX_BYTES || 12 * 1024 * 1024));
const TIMEOUT_MS = Math.max(1000, Number(process.env.IMAGE_PROXY_TIMEOUT_MS || 10_000));

function normalizeHost(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

function configuredAllowedHosts() {
  const hosts = new Set();
  const sources = [process.env.R2_PUBLIC_URL, process.env.IMAGE_PROXY_ALLOWED_ORIGINS];
  for (const source of sources) {
    if (!source) continue;
    for (const raw of String(source).split(',')) {
      const value = raw.trim();
      if (!value) continue;
      try {
        const parsed = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
        const host = normalizeHost(parsed.hostname);
        if (host) hosts.add(host);
      } catch (_) {
        const host = normalizeHost(value);
        if (host && !host.includes('/')) hosts.add(host);
      }
    }
  }
  return hosts;
}

function ipv4Parts(address) {
  if (net.isIP(address) !== 4) return null;
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function isPrivateIpv4(address) {
  const p = ipv4Parts(address);
  if (!p) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address) {
  if (net.isIP(address) !== 6) return false;
  const value = address.toLowerCase();
  if (value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(value)) return true; // fe80::/10
  if (value.startsWith('ff')) return true; // multicast
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && isPrivateIpv4(mapped[1])) return true;
  return false;
}

function isPrivateAddress(address) {
  return isPrivateIpv4(address) || isPrivateIpv6(address);
}

async function validateResolvedHost(hostname) {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error('image_proxy_dns_empty');
  if (addresses.some((entry) => !entry?.address || isPrivateAddress(entry.address))) {
    throw new Error('image_proxy_private_address');
  }
  return addresses.map((entry) => ({ address: entry.address, family: entry.family }));
}

function pinnedLookup(expectedHost, addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (normalizeHost(hostname) !== expectedHost || !addresses.length) {
      const err = new Error('image_proxy_dns_rebind_blocked');
      err.code = 'image_proxy_dns_rebind_blocked';
      return cb(err);
    }
    if (opts.all) return cb(null, addresses);
    const first = addresses[0];
    return cb(null, first.address, first.family);
  };
}

async function fetchAllowedImage(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch (_) {
    const err = new Error('image_proxy_invalid_url');
    err.code = 'image_proxy_invalid_url';
    throw err;
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    const err = new Error('image_proxy_invalid_url');
    err.code = 'image_proxy_invalid_url';
    throw err;
  }

  const allowedHosts = configuredAllowedHosts();
  const host = normalizeHost(parsed.hostname);
  if (!host || allowedHosts.size === 0 || !allowedHosts.has(host)) {
    const err = new Error('image_proxy_host_forbidden');
    err.code = 'image_proxy_host_forbidden';
    throw err;
  }

  // Resolve once, reject any private answer, then pin the outbound request to
  // that validated resolution. This closes the DNS-rebinding TOCTOU gap where
  // validation sees a public IP but the HTTP client resolves the same hostname
  // again to localhost/private infrastructure a moment later.
  const resolvedAddresses = await validateResolvedHost(host);

  const response = await axios.get(parsed.toString(), {
    responseType: 'arraybuffer',
    timeout: TIMEOUT_MS,
    maxRedirects: 0,
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    headers: { Accept: 'image/*' },
    lookup: pinnedLookup(host, resolvedAddresses),
  });

  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) {
    const err = new Error('image_proxy_not_image');
    err.code = 'image_proxy_not_image';
    throw err;
  }

  const body = Buffer.from(response.data || []);
  if (!body.length || body.length > MAX_IMAGE_BYTES) {
    const err = new Error('image_proxy_size_invalid');
    err.code = 'image_proxy_size_invalid';
    throw err;
  }

  return { body, contentType };
}

module.exports = {
  fetchAllowedImage,
  configuredAllowedHosts,
  isPrivateAddress,
  pinnedLookup,
};

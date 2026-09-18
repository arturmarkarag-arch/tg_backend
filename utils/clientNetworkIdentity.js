'use strict';

const net = require('net');

function normalizeIp(value) {
  let raw = String(value || '').trim();
  if (!raw) return '';

  // Node/Express commonly exposes IPv4 peers as IPv4-mapped IPv6.
  if (raw.startsWith('::ffff:')) {
    const mapped = raw.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return mapped;
  }

  // [IPv6]:port form (rare in forwarded headers, common in low-level peers).
  if (raw.startsWith('[')) {
    const closing = raw.indexOf(']');
    if (closing > 1) {
      const host = raw.slice(1, closing);
      if (net.isIP(host)) return host;
    }
  }

  if (net.isIP(raw)) return raw;

  // IPv4:port form.
  const ipv4Port = raw.match(/^([^:]+):(\d+)$/);
  if (ipv4Port && net.isIP(ipv4Port[1]) === 4) return ipv4Port[1];

  return '';
}

function forwardedChain(req) {
  const raw = String(req?.headers?.['x-forwarded-for'] || '');
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => normalizeIp(part))
    .filter(Boolean);
}

/**
 * Resolve network identity without enabling Express's broad `trust proxy` mode.
 *
 * Production traffic normally arrives Cloudflare -> Render -> Node. For the
 * client-facing bucket we prefer Cloudflare's client address only when a second
 * Cloudflare marker is present, otherwise fall back to the forwarded chain and
 * finally the direct peer. The ingress address is kept separately so the abuse
 * guard can apply a broad anti-spoof / shared-proxy ceiling in addition to the
 * per-client bucket.
 *
 * Proxy headers are not cryptographic credentials. They are useful for traffic
 * shaping, never for authorization. Authorization continues to use signed
 * first-party cookies / service tokens.
 */
function getClientNetworkIdentity(req) {
  const directIp = normalizeIp(
    req?.socket?.remoteAddress
      || req?.connection?.remoteAddress
      || req?.ip,
  );
  const chain = forwardedChain(req);
  const cfConnectingIp = normalizeIp(req?.headers?.['cf-connecting-ip']);
  const hasCloudflareMarker = Boolean(
    req?.headers?.['cf-ray']
      || String(req?.headers?.['cdn-loop'] || '').toLowerCase().includes('cloudflare'),
  );

  const clientIp = (
    (cfConnectingIp && hasCloudflareMarker ? cfConnectingIp : '')
    || chain[0]
    || directIp
    || 'unknown'
  );

  // Right-most XFF is the hop closest to our hosting ingress. It is deliberately
  // separate from clientIp: a caller that tries to rotate/spoof the left side of
  // XFF still shares this wider bucket when the hosting proxy appends its peer.
  const ingressIp = chain[chain.length - 1] || directIp || clientIp;

  return {
    clientIp,
    ingressIp,
    directIp: directIp || '',
    forwardedChain: chain,
    source: cfConnectingIp && hasCloudflareMarker
      ? 'cloudflare'
      : (chain.length ? 'forwarded' : 'direct'),
  };
}

module.exports = {
  normalizeIp,
  forwardedChain,
  getClientNetworkIdentity,
};

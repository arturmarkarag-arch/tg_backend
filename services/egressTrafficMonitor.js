'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const { AsyncLocalStorage } = require('async_hooks');

const INSTALL = Symbol.for('zlotoweczka.egress-monitor.install');
const REQUEST_INSTRUMENTED = Symbol.for('zlotoweczka.egress-monitor.http-request');
const SOCKET_STATE = Symbol.for('zlotoweczka.egress-monitor.socket-state');

const FLUSH_MS = Math.max(60_000, Number(process.env.EGRESS_METRICS_FLUSH_MS) || 300_000);
const SOCKET_SAMPLE_MS = Math.max(2_000, Number(process.env.EGRESS_SOCKET_SAMPLE_MS) || 10_000);
const RETENTION_DAYS = Math.max(7, Number(process.env.EGRESS_METRICS_RETENTION_DAYS) || 35);
const MAX_HTTP_HINTS_PER_SAMPLE = 300;

const requestContext = new AsyncLocalStorage();
let transportStats = new Map();
let httpStats = new Map();
let currentWindowStartedAt = new Date();
let sampleTimer = null;
let flushTimer = null;
let persistenceStarted = false;
let installed = false;
let flushing = null;

const activeSockets = new Set();

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function byteLength(value, encoding) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof value === 'string') return Buffer.byteLength(value, encoding || 'utf8');
  if (typeof Blob !== 'undefined' && value instanceof Blob) return safeNumber(value.size);
  if (value instanceof URLSearchParams) return Buffer.byteLength(value.toString());
  return 0;
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host) {
  const h = normalizeHost(host);
  return !h || h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127(?:\.|$)/.test(h);
}

function normalizePathname(pathname) {
  let path = String(pathname || '/').split('?')[0] || '/';
  try { path = decodeURIComponent(path); } catch (_) { /* preserve raw path */ }
  const parts = path.split('/').map((part) => {
    if (!part) return part;
    if (/^[0-9a-f]{24}$/i.test(part)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) return ':id';
    if (/^\d{7,}$/.test(part)) return ':id';
    if (/^[A-Za-z0-9_-]{40,}$/.test(part)) return ':key';
    return part.length > 96 ? ':segment' : part;
  });
  return parts.join('/') || '/';
}

function normalizeInternalSource(method, path) {
  return `${String(method || 'GET').toUpperCase()} ${normalizePathname(path || '/')}`;
}

function egressRequestContextMiddleware(req, _res, next) {
  return requestContext.run({
    source: normalizeInternalSource(req.method, req.path || req.originalUrl || '/'),
  }, next);
}

function currentSource() {
  return requestContext.getStore()?.source || 'background';
}

function parseConnectTarget(args) {
  let first = args?.[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const host = normalizeHost(first.host || first.hostname || first.servername);
    const port = safeNumber(first.port);
    const path = String(first.path || '');
    if (!host && path) return { skip: true };
    return { host, port };
  }
  if (typeof first === 'number') {
    const maybeHost = typeof args?.[1] === 'string' ? args[1] : 'localhost';
    return { host: normalizeHost(maybeHost), port: safeNumber(first) };
  }
  if (typeof first === 'string') return { skip: true };
  return { host: '', port: 0 };
}

function transportKey(meta) {
  return `${meta.protocol}|${meta.host}|${meta.port || ''}`;
}

function addTransport(meta, bytes, connections = 0) {
  if (!meta?.host || isLoopbackHost(meta.host)) return;
  const delta = Math.max(0, Math.floor(safeNumber(bytes)));
  if (!delta && !connections) return;
  const key = transportKey(meta);
  const row = transportStats.get(key) || {
    key,
    protocol: meta.protocol || 'tcp',
    host: meta.host,
    port: safeNumber(meta.port),
    bytes: 0,
    connections: 0,
    lastSeenAt: null,
  };
  row.bytes += delta;
  row.connections += Math.max(0, Math.floor(safeNumber(connections)));
  row.lastSeenAt = new Date().toISOString();
  transportStats.set(key, row);
}

function sampleSocket(socket) {
  const state = socket?.[SOCKET_STATE];
  if (!state) return;
  const nowBytes = safeNumber(socket.bytesWritten);
  const delta = Math.max(0, nowBytes - safeNumber(state.lastBytes));
  if (delta) addTransport(state, delta, 0);
  state.lastBytes = nowBytes;
}

function registerSocket(socket, target) {
  if (!socket) return;
  const host = normalizeHost(target?.host);
  if (!host || isLoopbackHost(host)) return;
  const existing = socket[SOCKET_STATE];
  if (existing && activeSockets.has(socket)) return;
  const state = existing || {};
  state.host = host;
  state.port = safeNumber(target?.port);
  state.protocol = socket.encrypted ? 'tls' : 'tcp';
  state.lastBytes = safeNumber(socket.bytesWritten);
  socket[SOCKET_STATE] = state;
  activeSockets.add(socket);
  addTransport(state, 0, 1);
  const cleanup = () => {
    sampleSocket(socket);
    activeSockets.delete(socket);
  };
  socket.once('close', cleanup);
}

function installSocketMonitor() {
  if (net.Socket.prototype.connect[INSTALL]) return;
  const originalConnect = net.Socket.prototype.connect;
  function monitoredConnect(...args) {
    const target = parseConnectTarget(args);
    const result = originalConnect.apply(this, args);
    if (!target.skip) registerSocket(this, target);
    return result;
  }
  monitoredConnect[INSTALL] = true;
  monitoredConnect.__egressOriginal = originalConnect;
  net.Socket.prototype.connect = monitoredConnect;

  sampleTimer = setInterval(() => {
    for (const socket of [...activeSockets]) sampleSocket(socket);
  }, SOCKET_SAMPLE_MS);
  sampleTimer.unref?.();
}

function buildHttpTarget(protocol, args) {
  let url = null;
  let options = {};
  const first = args?.[0];
  const second = args?.[1];
  if (first instanceof URL) url = new URL(first.toString());
  else if (typeof first === 'string') {
    try { url = new URL(first); } catch (_) { /* may be options path */ }
  } else if (first && typeof first === 'object') options = { ...first };
  if (second && typeof second === 'object' && !(second instanceof URL)) options = { ...options, ...second };
  if (url) {
    options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname || '/'}${url.search || ''}`,
      ...options,
    };
  }
  const hostHeader = String(options.hostname || options.host || '').replace(/^\[|\]$/g, '');
  const parsedHost = hostHeader.includes(':') && !hostHeader.includes('::')
    ? hostHeader.split(':')[0]
    : hostHeader;
  const resolvedProtocol = String(options.protocol || `${protocol}:`).replace(':', '').toLowerCase();
  const port = safeNumber(options.port) || (resolvedProtocol === 'https' ? 443 : 80);
  return {
    protocol: resolvedProtocol,
    host: normalizeHost(parsedHost),
    port,
    method: String(options.method || 'GET').toUpperCase(),
    path: normalizePathname(options.path || options.pathname || '/'),
  };
}

function httpHintKey(row) {
  return `${row.host}|${row.port}|${row.method}|${row.path}|${row.source}`;
}

function addHttpHint(row) {
  if (!row?.host || isLoopbackHost(row.host)) return;
  const key = httpHintKey(row);
  const current = httpStats.get(key) || {
    key,
    host: row.host,
    port: safeNumber(row.port),
    method: row.method || 'GET',
    path: row.path || '/',
    source: row.source || 'background',
    calls: 0,
    estimatedRequestBytes: 0,
    lastSeenAt: null,
  };
  current.calls += 1;
  current.estimatedRequestBytes += Math.max(0, Math.floor(safeNumber(row.estimatedRequestBytes)));
  current.lastSeenAt = new Date().toISOString();
  httpStats.set(key, current);
  if (httpStats.size > MAX_HTTP_HINTS_PER_SAMPLE * 2) {
    const trimmed = [...httpStats.values()]
      .sort((a, b) => (b.estimatedRequestBytes - a.estimatedRequestBytes) || (b.calls - a.calls))
      .slice(0, MAX_HTTP_HINTS_PER_SAMPLE);
    httpStats = new Map(trimmed.map((entry) => [entry.key, entry]));
  }
}

function installHttpRequestHook(moduleRef, protocol) {
  const original = moduleRef.request;
  if (original?.[INSTALL]) return;
  function monitoredRequest(...args) {
    const target = buildHttpTarget(protocol, args);
    const req = original.apply(this, args);
    if (!req || req[REQUEST_INSTRUMENTED]) return req;
    req[REQUEST_INSTRUMENTED] = true;
    let bodyBytes = 0;
    const originalWrite = req.write;
    const originalEnd = req.end;
    req.write = function monitoredWrite(...writeArgs) {
      bodyBytes += byteLength(writeArgs[0], typeof writeArgs[1] === 'string' ? writeArgs[1] : undefined);
      return originalWrite.apply(this, writeArgs);
    };
    req.end = function monitoredEnd(...endArgs) {
      bodyBytes += byteLength(endArgs[0], typeof endArgs[1] === 'string' ? endArgs[1] : undefined);
      return originalEnd.apply(this, endArgs);
    };
    req.once('finish', () => {
      const headerBytes = typeof req._header === 'string' ? Buffer.byteLength(req._header) : 0;
      addHttpHint({
        ...target,
        source: currentSource(),
        estimatedRequestBytes: headerBytes + bodyBytes,
      });
    });
    return req;
  }
  monitoredRequest[INSTALL] = true;
  monitoredRequest.__egressOriginal = original;
  moduleRef.request = monitoredRequest;
}

function headersEstimate(headers) {
  if (!headers) return 0;
  try {
    if (typeof Headers === 'undefined') return 0;
    const h = new Headers(headers);
    let total = 2;
    h.forEach((value, key) => { total += Buffer.byteLength(`${key}: ${value}\r\n`); });
    return total;
  } catch (_) {
    return 0;
  }
}

function installFetchHook() {
  const original = globalThis.fetch;
  if (typeof original !== 'function' || original[INSTALL]) return;
  async function monitoredFetch(input, init = {}) {
    let url;
    try {
      if (typeof Request !== 'undefined' && input instanceof Request) url = new URL(input.url);
      else url = new URL(String(input));
    } catch (_) {
      return original(input, init);
    }
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const method = String(init?.method || (isRequest ? input.method : 'GET') || 'GET').toUpperCase();
    const body = init?.body;
    let bodyBytes = byteLength(body);
    if (!bodyBytes) {
      try {
        const explicit = typeof Headers !== 'undefined'
          ? new Headers(init?.headers || (isRequest ? input.headers : undefined)).get('content-length')
          : null;
        if (explicit) bodyBytes = safeNumber(explicit);
      } catch (_) { /* ignore */ }
    }
    const requestLineBytes = Buffer.byteLength(`${method} ${normalizePathname(url.pathname)} HTTP/1.1\r\n`);
    addHttpHint({
      host: normalizeHost(url.hostname),
      port: safeNumber(url.port) || (url.protocol === 'https:' ? 443 : 80),
      method,
      path: normalizePathname(url.pathname),
      source: currentSource(),
      estimatedRequestBytes: requestLineBytes + headersEstimate(init?.headers || (isRequest ? input.headers : undefined)) + bodyBytes,
    });
    return original(input, init);
  }
  monitoredFetch[INSTALL] = true;
  monitoredFetch.__egressOriginal = original;
  globalThis.fetch = monitoredFetch;
}

function installEgressTrafficMonitor() {
  if (installed) return;
  installed = true;
  installSocketMonitor();
  installHttpRequestHook(http, 'http');
  installHttpRequestHook(https, 'https');
  installFetchHook();
}

function snapshotCurrent({ reset = false } = {}) {
  for (const socket of [...activeSockets]) sampleSocket(socket);
  const transport = [...transportStats.values()].map((row) => ({ ...row }));
  const httpRows = [...httpStats.values()]
    .sort((a, b) => (b.estimatedRequestBytes - a.estimatedRequestBytes) || (b.calls - a.calls))
    .slice(0, MAX_HTTP_HINTS_PER_SAMPLE)
    .map((row) => ({ ...row }));
  const startedAt = currentWindowStartedAt;
  const endedAt = new Date();
  if (reset) {
    transportStats = new Map();
    httpStats = new Map();
    currentWindowStartedAt = endedAt;
  }
  return { startedAt, endedAt, transport, http: httpRows };
}

function mergeBack(snapshot) {
  for (const row of snapshot.transport || []) addTransport(row, row.bytes, row.connections);
  for (const row of snapshot.http || []) {
    const key = httpHintKey(row);
    const current = httpStats.get(key) || { ...row, calls: 0, estimatedRequestBytes: 0 };
    current.calls += safeNumber(row.calls);
    current.estimatedRequestBytes += safeNumber(row.estimatedRequestBytes);
    current.lastSeenAt = row.lastSeenAt || current.lastSeenAt;
    httpStats.set(key, current);
  }
}

async function flushEgressTraffic() {
  if (flushing) return flushing;
  const snapshot = snapshotCurrent({ reset: true });
  if (!snapshot.transport.length && !snapshot.http.length) return null;
  flushing = (async () => {
    try {
      const EgressTrafficSample = require('../models/EgressTrafficSample');
      const expiresAt = new Date(snapshot.endedAt.getTime() + RETENTION_DAYS * 86400_000);
      await EgressTrafficSample.create({ ...snapshot, expiresAt });
      return true;
    } catch (error) {
      mergeBack(snapshot);
      console.error('[egress-monitor] flush failed:', error?.message || error);
      return false;
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

function startEgressTrafficPersistence() {
  if (persistenceStarted) return;
  persistenceStarted = true;
  try {
    const EgressTrafficSample = require('../models/EgressTrafficSample');
    EgressTrafficSample.createIndexes().catch((error) => console.error('[egress-monitor] index init failed:', error?.message || error));
  } catch (error) {
    console.error('[egress-monitor] model init failed:', error?.message || error);
  }
  flushTimer = setInterval(() => { flushEgressTraffic().catch(() => {}); }, FLUSH_MS);
  flushTimer.unref?.();
}

function stopEgressTrafficTimers() {
  if (sampleTimer) clearInterval(sampleTimer);
  if (flushTimer) clearInterval(flushTimer);
  sampleTimer = null;
  flushTimer = null;
}

function hostPortKey(row) {
  return `${normalizeHost(row?.host)}|${safeNumber(row?.port)}`;
}

function aggregateRows(samples, current) {
  const transport = new Map();
  const hintsByHost = new Map();
  const all = [...samples, current];
  for (const sample of all) {
    for (const row of sample?.transport || []) {
      const key = hostPortKey(row);
      if (!row?.host) continue;
      const agg = transport.get(key) || {
        host: normalizeHost(row.host),
        port: safeNumber(row.port),
        protocol: row.protocol || 'tcp',
        bytes: 0,
        connections: 0,
        lastSeenAt: null,
      };
      agg.bytes += safeNumber(row.bytes);
      agg.connections += safeNumber(row.connections);
      if (!agg.lastSeenAt || String(row.lastSeenAt || '') > agg.lastSeenAt) agg.lastSeenAt = row.lastSeenAt || agg.lastSeenAt;
      transport.set(key, agg);
    }
    for (const hint of sample?.http || []) {
      if (!hint?.host) continue;
      const key = hostPortKey(hint);
      const list = hintsByHost.get(key) || new Map();
      const hintKey = `${hint.method}|${hint.path}|${hint.source}`;
      const agg = list.get(hintKey) || {
        method: hint.method || 'GET',
        path: hint.path || '/',
        source: hint.source || 'background',
        calls: 0,
        estimatedRequestBytes: 0,
      };
      agg.calls += safeNumber(hint.calls);
      agg.estimatedRequestBytes += safeNumber(hint.estimatedRequestBytes);
      list.set(hintKey, agg);
      hintsByHost.set(key, list);
    }
  }

  const rows = [...transport.entries()].map(([key, row]) => {
    const hints = [...(hintsByHost.get(key)?.values() || [])]
      .sort((a, b) => (b.estimatedRequestBytes - a.estimatedRequestBytes) || (b.calls - a.calls));
    const top = hints[0] || null;
    return {
      ...row,
      endpoint: top ? `${top.method} ${top.path}` : `${String(row.protocol || 'tcp').toUpperCase()} ${row.host}:${row.port || ''}`,
      source: top?.source || 'background',
      calls: hints.reduce((sum, hint) => sum + safeNumber(hint.calls), 0),
      estimatedHttpRequestBytes: hints.reduce((sum, hint) => sum + safeNumber(hint.estimatedRequestBytes), 0),
      endpointVariants: hints.length,
    };
  }).sort((a, b) => b.bytes - a.bytes);

  return {
    totalBytes: rows.reduce((sum, row) => sum + safeNumber(row.bytes), 0),
    totalConnections: rows.reduce((sum, row) => sum + safeNumber(row.connections), 0),
    rows,
  };
}

async function getEgressTrafficSummary({ hours = 24 } = {}) {
  const boundedHours = Math.min(24 * 31, Math.max(1, Number(hours) || 24));
  const since = new Date(Date.now() - boundedHours * 3600_000);
  let samples = [];
  try {
    const EgressTrafficSample = require('../models/EgressTrafficSample');
    samples = await EgressTrafficSample.find({ endedAt: { $gte: since } })
      .select('startedAt endedAt transport http')
      .lean();
  } catch (error) {
    console.error('[egress-monitor] read failed:', error?.message || error);
  }
  const current = snapshotCurrent({ reset: false });
  const summary = aggregateRows(samples, current);
  return {
    ...summary,
    hours: boundedHours,
    measuredFrom: samples.length
      ? new Date(Math.min(...samples.map((sample) => new Date(sample.startedAt).getTime()), current.startedAt.getTime())).toISOString()
      : current.startedAt.toISOString(),
    measuredTo: current.endedAt.toISOString(),
    coverage: 'outbound TCP/TLS application bytes; HTTP endpoint metadata where observable',
    note: 'Transport bytes come from Node socket.bytesWritten. TLS/wire/provider overhead may make Render billing slightly higher. Query strings, request bodies and auth headers are never stored.',
  };
}

module.exports = {
  installEgressTrafficMonitor,
  egressRequestContextMiddleware,
  startEgressTrafficPersistence,
  flushEgressTraffic,
  stopEgressTrafficTimers,
  getEgressTrafficSummary,
  _private: {
    normalizePathname,
    parseConnectTarget,
    buildHttpTarget,
    snapshotCurrent,
    aggregateRows,
  },
};

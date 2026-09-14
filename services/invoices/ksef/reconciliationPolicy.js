'use strict';

function normalizedHash(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function sessionStatusCode(status) {
  return Number(status?.status?.code ?? status?.code ?? 0) || 0;
}

function isTerminalSessionStatus(status) {
  return sessionStatusCode(status) >= 200;
}

function selectInvoiceHashMatches(invoices, expectedHash) {
  const expected = normalizedHash(expectedHash);
  if (!expected) return [];
  return (Array.isArray(invoices) ? invoices : []).filter((row) => normalizedHash(row?.invoiceHash) === expected);
}


function buildSessionInvoicesRequest(sessionReferenceNumber, continuationToken = '') {
  const params = new URLSearchParams({ pageSize: '1000' });
  return {
    path: `/sessions/${encodeURIComponent(String(sessionReferenceNumber || ''))}/invoices?${params.toString()}`,
    headers: continuationToken ? { 'x-continuation-token': String(continuationToken) } : {},
  };
}

function retryAfterMs(error, nowMs = Date.now()) {
  const raw = String(error?.args?.retryAfter || '').trim();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1000));
  const date = new Date(raw).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Number(nowMs || Date.now())) : 0;
}

function retryDelayMs(attempt, error, { tickMs = 30_000, maxBackoffMs = 5 * 60_000, nowMs = Date.now() } = {}) {
  const providerDelay = retryAfterMs(error, nowMs);
  if (providerDelay > 0) return Math.min(maxBackoffMs, Math.max(tickMs, providerDelay));
  const exponent = Math.max(0, Math.min(6, Number(attempt || 1) - 1));
  return Math.min(maxBackoffMs, Math.max(tickMs, 5_000 * (2 ** exponent)));
}

module.exports = {
  normalizedHash,
  sessionStatusCode,
  isTerminalSessionStatus,
  selectInvoiceHashMatches,
  buildSessionInvoicesRequest,
  retryAfterMs,
  retryDelayMs,
};

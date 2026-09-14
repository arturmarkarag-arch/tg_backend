'use strict';

const state = {
  blocked: false,
  since: null,
  issues: [],
};

function normalizeIssue(issue = {}) {
  return {
    key: String(issue.key || 'invoice_ksef_unavailable'),
    title: String(issue.title || 'Запис Invoice/KSeF тимчасово заблокований'),
    whatBroke: String(issue.whatBroke || 'Не вдалося підтвердити цілісність Invoice/KSeF даних.'),
    technicalDetails: String(issue.technicalDetails || ''),
    howToFix: Array.isArray(issue.howToFix) ? issue.howToFix.map((step) => String(step)) : [],
    detectedAt: new Date().toISOString(),
  };
}

function blockInvoiceKsefWrites(issue) {
  const normalized = normalizeIssue(issue);
  state.blocked = true;
  state.since ||= normalized.detectedAt;
  const index = state.issues.findIndex((item) => item.key === normalized.key);
  if (index >= 0) state.issues[index] = normalized;
  else state.issues.push(normalized);
}

function areInvoiceKsefWritesBlocked() {
  return state.blocked;
}

function getInvoiceKsefWriteState() {
  return {
    blocked: state.blocked,
    mode: state.blocked ? 'read_only' : 'normal',
    since: state.since,
    issues: state.issues.map((issue) => ({ ...issue })),
  };
}

function getPublicInvoiceKsefWriteState() {
  return {
    blocked: state.blocked,
    mode: state.blocked ? 'read_only' : 'normal',
    since: state.since,
    issues: state.issues.map((issue) => ({
      key: issue.key,
      title: issue.title,
      whatBroke: issue.whatBroke,
      detectedAt: issue.detectedAt,
    })),
  };
}

function invoiceKsefWriteGuard(req, res, next) {
  if (!state.blocked) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  return res.status(503).json({
    error: 'invoice_ksef_read_only',
    message: 'Фактури/KSeF тимчасово працюють лише для перегляду. Інші модулі ERP продовжують працювати.',
    invoiceKsef: ['admin', 'warehouse'].includes(req.telegramUser?.role)
      ? getInvoiceKsefWriteState()
      : getPublicInvoiceKsefWriteState(),
  });
}

module.exports = {
  blockInvoiceKsefWrites,
  areInvoiceKsefWritesBlocked,
  getInvoiceKsefWriteState,
  getPublicInvoiceKsefWriteState,
  invoiceKsefWriteGuard,
};

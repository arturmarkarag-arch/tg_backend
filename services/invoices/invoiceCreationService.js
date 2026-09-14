'use strict';

const { previewInvoiceDraftFromSource, createInvoiceDraft } = require('./invoiceService');
const { normalizeInvoiceDraft, validateFinalizableInvoice } = require('./contract');
const { resolveLegalEntity, legalEntityToInvoiceParty } = require('./legalEntityService');

function addDays(dateOnly, days) {
  if (!dateOnly || !/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) return '';
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Math.max(0, Number(days) || 0));
  return date.toISOString().slice(0, 10);
}

function defaultBankAccount(entity) {
  const explicit = String(entity.paymentDefaults?.bankAccount || '').replace(/\s+/g, '');
  if (explicit) return explicit;
  const accounts = entity.bankAccounts || [];
  const preferred = accounts.find((entry) => entry.isDefault) || accounts[0];
  return String(preferred?.account || '').replace(/\s+/g, '');
}

function applyLegalEntityDefaults(draft, entity) {
  const raw = typeof entity?.toObject === 'function' ? entity.toObject() : entity || {};
  const payment = { ...(draft.payment || {}) };
  if (!payment.method && raw.paymentDefaults?.method) payment.method = raw.paymentDefaults.method;
  if (!payment.bankAccount) payment.bankAccount = defaultBankAccount(raw);
  if (!payment.dueDate && draft.issueDate && Number(raw.paymentDefaults?.dueDays || 0) > 0) {
    payment.dueDate = addDays(draft.issueDate, raw.paymentDefaults.dueDays);
  }

  return normalizeInvoiceDraft({
    ...draft,
    seller: legalEntityToInvoiceParty(raw),
    currency: draft.currency || raw.defaultCurrency || 'PLN',
    payment,
  });
}

async function prepareInvoiceFromSource({ sourceAdapter, sourceProvider, sourceRef = {}, input = {}, legalEntityId = '', context = {} } = {}) {
  const entity = await resolveLegalEntity(legalEntityId, { allowDefault: true, requireActive: true });
  const adapterId = String(sourceAdapter || sourceProvider || '').trim().toLowerCase();
  const draft = await previewInvoiceDraftFromSource(adapterId, { sourceRef, input, context });
  const sourceInput = input?.draft && typeof input.draft === 'object' ? input.draft : input;
  if (!sourceInput?.currency && entity.defaultCurrency) draft.currency = entity.defaultCurrency;
  const prepared = applyLegalEntityDefaults(draft, entity);
  const blockers = validateFinalizableInvoice({ ...prepared, invoiceNumber: prepared.invoiceNumber || '__auto__' })
    .filter((code) => code !== 'invoice_number_required');
  return { draft: prepared, blockers, legalEntity: entity };
}

function sourceIdempotencyKey(draft = {}, legalEntityId = '') {
  if (String(draft?.source?.metadata?.authority || '').trim().toLowerCase() !== 'upstream_order') return '';
  const provider = String(draft?.source?.provider || '').trim().toLowerCase();
  const accountId = String(draft?.source?.metadata?.accountId || '').trim();
  const orderId = String(draft?.source?.entityId || draft?.source?.metadata?.orderId || '').trim();
  const sellerId = String(legalEntityId || draft?.seller?.legalEntityId || '').trim();
  if (!provider || !accountId || !orderId || !sellerId) return '';
  return `invoice-source:${provider}:${accountId}:${orderId}:${sellerId}`.slice(0, 240);
}

async function createInvoiceFromSource({ sourceAdapter, sourceProvider, sourceRef = {}, input = {}, legalEntityId = '', idempotencyKey = '', context = {} } = {}, actor = {}) {
  const prepared = await prepareInvoiceFromSource({ sourceAdapter, sourceProvider, sourceRef, input, legalEntityId, context });
  const effectiveIdempotencyKey = String(idempotencyKey || '').trim() || sourceIdempotencyKey(prepared.draft, String(prepared.legalEntity?._id || legalEntityId || ''));
  const invoice = await createInvoiceDraft(prepared.draft, actor, { idempotencyKey: effectiveIdempotencyKey });
  return { invoice, blockers: prepared.blockers, legalEntity: prepared.legalEntity };
}

module.exports = {
  addDays,
  applyLegalEntityDefaults,
  sourceIdempotencyKey,
  prepareInvoiceFromSource,
  createInvoiceFromSource,
};

'use strict';

const Invoice = require('../../models/Invoice');
const InvoiceSnapshot = require('../../models/InvoiceSnapshot');
const FiscalSubmission = require('../../models/FiscalSubmission');
const { appError } = require('../../utils/errors');
const { normalizeInvoiceDraft, normalizeActor, INVOICE_TYPES, INVOICE_STATUSES } = require('./contract');
const { createInvoiceDraft } = require('./invoiceService');
const { normalizeEnvironment } = require('./ksef/config');

function correctionRef(raw = {}) {
  return raw?.references?.correction && typeof raw.references.correction === 'object'
    ? raw.references.correction
    : null;
}

function validateCorrectionReference(invoice = {}) {
  if (invoice.type !== INVOICE_TYPES.CORRECTION) return [];
  const ref = correctionRef(invoice);
  const blockers = [];
  if (!ref) return ['correction_reference_required'];
  if (!ref.originalInvoiceId) blockers.push('correction_original_invoice_required');
  if (!ref.originalSnapshotId) blockers.push('correction_original_snapshot_required');
  if (!ref.originalInvoiceNumber) blockers.push('correction_original_number_required');
  if (!ref.originalIssueDate) blockers.push('correction_original_issue_date_required');
  if (!ref.originalFiscalReference) blockers.push('correction_original_fiscal_reference_required');
  if (!String(ref.reason || '').trim()) blockers.push('correction_reason_required');
  if (!['1', '2', '3'].includes(String(ref.correctionType || ''))) blockers.push('correction_type_invalid');
  if (String(ref.lineMode || '') !== 'delta') blockers.push('correction_line_mode_invalid');
  return blockers;
}

async function acceptedOriginalSubmission(invoice, environment) {
  const env = normalizeEnvironment(environment);
  const submission = await FiscalSubmission.findOne({
    snapshotId: invoice.finalizedSnapshotId,
    provider: 'ksef',
    environment: env,
    state: 'accepted',
  }).lean();
  if (!submission?.providerData?.ksefNumber) throw appError('invoice_correction_original_ksef_required');
  return submission;
}

async function createCorrectionDraft(originalInvoiceId, input = {}, actor = {}) {
  const environment = normalizeEnvironment(input.environment || 'test');
  const original = await Invoice.findById(originalInvoiceId).lean();
  if (!original) throw appError('invoice_not_found');
  if (original.status !== INVOICE_STATUSES.FINALIZED || !original.finalizedSnapshotId) {
    throw appError('invoice_correction_original_must_be_finalized');
  }
  if (original.type === INVOICE_TYPES.CORRECTION && input.allowCorrectionOfCorrection !== true) {
    throw appError('invoice_correction_chain_requires_explicit_flag');
  }
  const snapshot = await InvoiceSnapshot.findById(original.finalizedSnapshotId).lean();
  if (!snapshot?.payload) throw appError('invoice_correction_original_snapshot_missing');
  const submission = await acceptedOriginalSubmission(original, environment);

  const reason = String(input.reason || '').trim().slice(0, 500);
  if (!reason) throw appError('invoice_correction_reason_required');
  const correctionType = String(input.correctionType || '1').trim();
  if (!['1', '2', '3'].includes(correctionType)) throw appError('invoice_correction_type_invalid');
  if (!Array.isArray(input.items) || input.items.length === 0) throw appError('invoice_correction_items_required');

  const originalPayload = snapshot.payload;
  const draft = normalizeInvoiceDraft({
    type: INVOICE_TYPES.CORRECTION,
    source: {
      provider: 'correction',
      entityType: 'invoice',
      entityId: String(original._id),
      externalNumber: original.invoiceNumber,
      metadata: { originalSource: originalPayload.source || {} },
    },
    seller: originalPayload.seller,
    // Stage 8 common KOR supports financial/item deltas only; party-identity corrections
    // require Podmiot1K/Podmiot2K semantics and stay outside this stage.
    buyer: originalPayload.buyer,
    recipient: originalPayload.recipient,
    issueDate: input.issueDate,
    saleDate: input.saleDate || originalPayload.saleDate,
    currency: originalPayload.currency,
    items: input.items,
    totals: input.totals || {},
    payment: input.payment || originalPayload.payment,
    notes: input.notes || '',
    references: {
      correction: {
        originalInvoiceId: String(original._id),
        originalSnapshotId: String(snapshot._id),
        originalInvoiceNumber: String(originalPayload.invoiceNumber || original.invoiceNumber || ''),
        originalIssueDate: String(originalPayload.issueDate || ''),
        originalFiscalProvider: 'ksef',
        originalFiscalReference: String(submission.providerData.ksefNumber),
        originalEnvironment: environment,
        reason,
        correctionType,
        lineMode: 'delta',
        originalTotals: originalPayload.totals || {},
      },
    },
  });
  const blockers = validateCorrectionReference(draft);
  if (blockers.length) throw appError('invoice_correction_invalid', { blockers });

  const idempotencyKey = String(input.idempotencyKey || '').trim();
  const invoice = await createInvoiceDraft(draft, normalizeActor(actor), {
    idempotencyKey: idempotencyKey ? `correction:${String(original._id)}:${idempotencyKey}`.slice(0, 240) : '',
  });
  return { invoice, originalInvoiceId: String(original._id), environment };
}

module.exports = { correctionRef, validateCorrectionReference, createCorrectionDraft };

'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const Invoice = require('../../models/Invoice');
const InvoiceSnapshot = require('../../models/InvoiceSnapshot');
const { appError } = require('../../utils/errors');
const {
  INVOICE_STATUSES,
  normalizeActor,
  normalizeInvoiceDraft,
  validateFinalizableInvoice,
  buildSnapshotPayload,
} = require('./contract');
const { stableStringify } = require('./stableJson');
const { buildInvoiceDraftFromSource, verifyInvoiceSource } = require('./sourceProviders/registry');
const { resolveLegalEntity } = require('./legalEntityService');
const { allocateInvoiceNumber } = require('./invoiceNumbering');


function isUpstreamOrderSource(invoice = {}) {
  return String(invoice?.source?.metadata?.authority || '').trim().toLowerCase() === 'upstream_order';
}

function mergeUpstreamPayment(current = {}, requested = {}) {
  return {
    ...current,
    dueDate: Object.prototype.hasOwnProperty.call(requested || {}, 'dueDate') ? requested.dueDate : current.dueDate,
    bankAccount: Object.prototype.hasOwnProperty.call(requested || {}, 'bankAccount') ? requested.bankAccount : current.bankAccount,
  };
}

function applyCanonicalDraft(invoice, draft) {
  for (const field of ['coreVersion', 'type', 'invoiceNumber', 'source', 'seller', 'buyer', 'recipient', 'issueDate', 'saleDate', 'currency', 'items', 'totals', 'payment', 'references', 'notes']) {
    invoice[field] = draft[field];
  }
}

async function previewInvoiceDraftFromSource(providerId, request = {}) {
  const raw = await buildInvoiceDraftFromSource(providerId, request);
  return normalizeInvoiceDraft(raw);
}

async function createInvoiceDraft(draftInput = {}, actor = {}, { idempotencyKey = '' } = {}) {
  const draft = normalizeInvoiceDraft(draftInput);
  const normalizedActor = normalizeActor(actor);
  const key = String(idempotencyKey || '').trim().slice(0, 240);

  if (key) {
    const existing = await Invoice.findOne({ idempotencyKey: key });
    if (existing) return existing;
  }

  try {
    return await Invoice.create({
      ...draft,
      status: INVOICE_STATUSES.DRAFT,
      idempotencyKey: key,
      createdBy: normalizedActor,
      updatedBy: normalizedActor,
    });
  } catch (err) {
    if (err?.code === 11000 && key) {
      const existing = await Invoice.findOne({ idempotencyKey: key });
      if (existing) return existing;
    }
    throw err;
  }
}

async function createInvoiceDraftFromSource(providerId, request = {}, actor = {}) {
  const draft = await previewInvoiceDraftFromSource(providerId, request);
  return createInvoiceDraft(draft, actor, { idempotencyKey: request.idempotencyKey });
}

async function updateInvoiceDraft(invoiceId, patch = {}, actor = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw appError('invoice_not_found');
  if (invoice.status !== INVOICE_STATUSES.DRAFT) throw appError('invoice_finalized_immutable');

  const current = invoice.toObject();
  const correctionLocked = current.type === 'correction' && current.references?.correction;
  const upstreamLocked = isUpstreamOrderSource(current);
  const requestedReferences = patch.references ?? current.references;
  const references = correctionLocked
    ? { ...(requestedReferences || {}), correction: current.references.correction }
    : (upstreamLocked ? current.references : requestedReferences);
  const merged = {
    ...current,
    ...patch,
    type: correctionLocked || upstreamLocked ? current.type : (patch.type ?? current.type),
    source: current.source,
    // Seller identity belongs to the LegalEntity snapshot chosen at creation.
    // Provider-authoritative order drafts additionally lock buyer/items/currency
    // so an operator cannot silently replace upstream billing facts.
    seller: current.seller,
    items: upstreamLocked ? current.items : (patch.items ?? current.items),
    buyer: correctionLocked || upstreamLocked ? current.buyer : (patch.buyer ?? current.buyer),
    recipient: correctionLocked || upstreamLocked
      ? current.recipient
      : (Object.prototype.hasOwnProperty.call(patch, 'recipient') ? patch.recipient : current.recipient),
    currency: upstreamLocked ? current.currency : (patch.currency ?? current.currency),
    saleDate: upstreamLocked ? current.saleDate : (patch.saleDate ?? current.saleDate),
    totals: upstreamLocked ? current.totals : (patch.totals ?? current.totals),
    payment: upstreamLocked ? mergeUpstreamPayment(current.payment || {}, patch.payment || {}) : (patch.payment ?? current.payment),
    references,
  };
  const normalized = normalizeInvoiceDraft(merged);
  applyCanonicalDraft(invoice, normalized);
  invoice.updatedBy = normalizeActor(actor);
  await invoice.save();
  return invoice;
}

async function refreshInvoiceDraftFromSource(invoiceId, actor = {}, context = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw appError('invoice_not_found');
  if (invoice.status !== INVOICE_STATUSES.DRAFT) throw appError('invoice_finalized_immutable');

  const current = invoice.toObject();
  if (!isUpstreamOrderSource(current)) throw appError('invoice_source_refresh_not_supported');
  const adapterId = String(current?.source?.metadata?.adapter || '').trim().toLowerCase();
  const accountId = String(current?.source?.metadata?.accountId || '').trim();
  const orderId = String(current?.source?.metadata?.orderId || current?.source?.entityId || '').trim();
  if (!adapterId || !accountId || !orderId) {
    throw appError('invoice_source_contract_invalid', { blockers: ['invoice_source_identity_incomplete'] });
  }

  const upstreamDraft = await previewInvoiceDraftFromSource(adapterId, {
    sourceRef: { accountId, orderId },
    input: {
      type: current.type,
      issueDate: current.issueDate,
      payment: {
        dueDate: current.payment?.dueDate || '',
        bankAccount: current.payment?.bankAccount || '',
      },
        notes: current.notes || '',
        requireInvoiceRequested: current.source?.metadata?.invoiceRequested === true,
        sourceOverrides: context.sourceOverrides || current.source?.metadata?.overrides || {},
      },
    context,
  });

  const normalized = normalizeInvoiceDraft({
    ...upstreamDraft,
    seller: current.seller,
    issueDate: current.issueDate || upstreamDraft.issueDate,
    notes: current.notes || upstreamDraft.notes,
    payment: {
      ...(upstreamDraft.payment || {}),
      dueDate: current.payment?.dueDate || upstreamDraft.payment?.dueDate || '',
      bankAccount: current.payment?.bankAccount || upstreamDraft.payment?.bankAccount || '',
    },
  });
  applyCanonicalDraft(invoice, normalized);
  invoice.updatedBy = normalizeActor(actor);
  await invoice.save();
  return invoice;
}

async function finalizeInvoice(invoiceId, actor = {}) {
  // Exact-read provider-authoritative order sources immediately before the
  // irreversible numbering/snapshot transaction. If upstream business facts
  // changed since draft creation, fail closed instead of finalizing stale data.
  const sourceCheck = await Invoice.findById(invoiceId).lean();
  if (!sourceCheck) throw appError('invoice_not_found');
  if (sourceCheck.status !== INVOICE_STATUSES.FINALIZED && isUpstreamOrderSource(sourceCheck)) {
    await verifyInvoiceSource(sourceCheck);
  }

  const session = await mongoose.connection.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const invoice = await Invoice.findById(invoiceId).session(session);
      if (!invoice) throw appError('invoice_not_found');

      if (invoice.status === INVOICE_STATUSES.FINALIZED && invoice.finalizedSnapshotId) {
        const existingSnapshot = await InvoiceSnapshot.findById(invoice.finalizedSnapshotId).session(session);
        result = { invoice, snapshot: existingSnapshot, alreadyFinalized: true };
        return;
      }

      if (!invoice.seller?.legalEntityId) throw appError('legal_entity_required');
      const legalEntity = await resolveLegalEntity(invoice.seller.legalEntityId, {
        allowDefault: false,
        requireActive: true,
        session,
      });

      if (!invoice.invoiceNumber) {
        const assigned = await allocateInvoiceNumber({
          legalEntity,
          invoiceType: invoice.type,
          issueDate: invoice.issueDate,
          session,
        });
        invoice.invoiceNumber = assigned.invoiceNumber;
      }

      const payload = buildSnapshotPayload(invoice.toObject());
      const blockers = validateFinalizableInvoice(payload);
      if (blockers.length) throw appError('invoice_not_finalizable', { blockers });

      const canonicalJson = stableStringify(payload);
      const sha256 = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
      const finalizedBy = normalizeActor(actor);
      const [snapshot] = await InvoiceSnapshot.create([{
        invoiceId: invoice._id,
        coreVersion: payload.coreVersion,
        invoiceVersion: invoice.__v,
        payload,
        sha256,
        finalizedBy,
      }], { session });

      invoice.status = INVOICE_STATUSES.FINALIZED;
      invoice.finalizedSnapshotId = snapshot._id;
      invoice.finalizedAt = new Date();
      invoice.finalizedBy = finalizedBy;
      invoice.updatedBy = finalizedBy;
      await invoice.save({ session });
      result = { invoice, snapshot, alreadyFinalized: false };
    });
  } finally {
    await session.endSession();
  }
  return result;
}

module.exports = {
  previewInvoiceDraftFromSource,
  createInvoiceDraft,
  createInvoiceDraftFromSource,
  updateInvoiceDraft,
  refreshInvoiceDraftFromSource,
  finalizeInvoice,
};

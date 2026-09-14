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
const { buildInvoiceDraftFromSource } = require('./sourceProviders/registry');
const { resolveLegalEntity } = require('./legalEntityService');
const { allocateInvoiceNumber } = require('./invoiceNumbering');

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
  const requestedReferences = patch.references ?? current.references;
  const references = correctionLocked
    ? { ...(requestedReferences || {}), correction: current.references.correction }
    : requestedReferences;
  const merged = {
    ...current,
    ...patch,
    type: correctionLocked ? current.type : (patch.type ?? current.type),
    source: current.source,
    // Seller identity belongs to the LegalEntity snapshot chosen at creation.
    // A generic draft patch cannot silently swap the issuer. A dedicated future
    // command may rebuild the draft from another LegalEntity before finalization.
    seller: current.seller,
    items: patch.items ?? current.items,
    // Stage 8 common KOR is financial/item-only. Party identity corrections need
    // Podmiot1K/Podmiot2K provider semantics and cannot leak through generic PATCH.
    buyer: correctionLocked ? current.buyer : (patch.buyer ?? current.buyer),
    recipient: correctionLocked
      ? current.recipient
      : (Object.prototype.hasOwnProperty.call(patch, 'recipient') ? patch.recipient : current.recipient),
    totals: patch.totals ?? current.totals,
    payment: patch.payment ?? current.payment,
    references,
  };
  const normalized = normalizeInvoiceDraft(merged);
  applyCanonicalDraft(invoice, normalized);
  invoice.updatedBy = normalizeActor(actor);
  await invoice.save();
  return invoice;
}

async function finalizeInvoice(invoiceId, actor = {}) {
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
  finalizeInvoice,
};

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

function applyCanonicalDraft(invoice, draft) {
  for (const field of ['coreVersion', 'type', 'source', 'seller', 'buyer', 'recipient', 'issueDate', 'saleDate', 'currency', 'items', 'totals', 'payment', 'references', 'notes']) {
    invoice[field] = draft[field];
  }
}

async function previewInvoiceDraftFromSource(providerId, request = {}) {
  const raw = await buildInvoiceDraftFromSource(providerId, request);
  return normalizeInvoiceDraft(raw);
}

async function createInvoiceDraftFromSource(providerId, request = {}, actor = {}) {
  const draft = await previewInvoiceDraftFromSource(providerId, request);
  const normalizedActor = normalizeActor(actor);
  const idempotencyKey = String(request.idempotencyKey || '').trim().slice(0, 240);

  if (idempotencyKey) {
    const existing = await Invoice.findOne({ idempotencyKey });
    if (existing) return existing;
  }

  try {
    return await Invoice.create({
      ...draft,
      status: INVOICE_STATUSES.DRAFT,
      idempotencyKey,
      createdBy: normalizedActor,
      updatedBy: normalizedActor,
    });
  } catch (err) {
    if (err?.code === 11000 && idempotencyKey) {
      const existing = await Invoice.findOne({ idempotencyKey });
      if (existing) return existing;
    }
    throw err;
  }
}

async function updateInvoiceDraft(invoiceId, patch = {}, actor = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) throw appError('invoice_not_found');
  if (invoice.status !== INVOICE_STATUSES.DRAFT) throw appError('invoice_finalized_immutable');

  const current = invoice.toObject();
  const merged = {
    ...current,
    ...patch,
    source: current.source,
    items: patch.items ?? current.items,
    seller: patch.seller ?? current.seller,
    buyer: patch.buyer ?? current.buyer,
    recipient: Object.prototype.hasOwnProperty.call(patch, 'recipient') ? patch.recipient : current.recipient,
    totals: patch.totals ?? current.totals,
    payment: patch.payment ?? current.payment,
    references: patch.references ?? current.references,
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
  createInvoiceDraftFromSource,
  updateInvoiceDraft,
  finalizeInvoice,
};

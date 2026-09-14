'use strict';

const mongoose = require('mongoose');
const BusinessCounterparty = require('../../models/BusinessCounterparty');
const InboundFiscalBusinessLink = require('../../models/InboundFiscalBusinessLink');
const InboundFiscalDocument = require('../../models/InboundFiscalDocument');
const Receipt = require('../../models/Receipt');
const ReceiptItem = require('../../models/ReceiptItem');
const { appError } = require('../../utils/errors');
const {
  normalizeName,
  normalizePartyIdentity,
  scoreCounterpartyCandidate,
  scoreReceiptCandidate,
  extractFa3BusinessFacts,
} = require('./inboundLinkingPolicy');

const MATCHER_VERSION = 1;
function objectId(value, code) {
  const id = String(value || '').trim();
  if (!mongoose.isValidObjectId(id)) throw appError(code);
  return id;
}
function clean(value, max = 1000) { return String(value ?? '').trim().slice(0, max); }
function publicCounterparty(row) { return row?.toObject ? row.toObject() : { ...row }; }
function publicLink(row) { return row?.toObject ? row.toObject() : { ...row }; }

async function listBusinessCounterparties({ role = 'supplier', status = 'active', q = '', limit = 100 } = {}) {
  const filter = {};
  if (role) {
    if (!['supplier', 'customer'].includes(role)) throw appError('business_counterparty_role_invalid');
    filter.roles = role;
  }
  if (status) {
    if (!['active', 'inactive'].includes(status)) throw appError('business_counterparty_status_invalid');
    filter.status = status;
  }
  const query = clean(q, 256);
  if (query) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [{ legalName: { $regex: escaped, $options: 'i' } }, { taxId: { $regex: escaped, $options: 'i' } }];
  }
  return (await BusinessCounterparty.find(filter).sort({ legalName: 1 }).limit(Math.max(1, Math.min(250, Number(limit) || 100))).lean()).map(publicCounterparty);
}

async function createBusinessCounterparty(input = {}) {
  const roles = Array.isArray(input.roles) && input.roles.length ? [...new Set(input.roles.map((x) => clean(x, 32).toLowerCase()))] : ['supplier'];
  if (roles.some((role) => !['supplier', 'customer'].includes(role))) throw appError('business_counterparty_role_invalid');
  const legalName = clean(input.legalName, 512);
  if (!legalName) throw appError('business_counterparty_name_required');
  try {
    return await BusinessCounterparty.create({
      legalName,
      normalizedName: normalizeName(legalName),
      aliases: Array.isArray(input.aliases) ? input.aliases.map((x) => clean(x, 256)).filter(Boolean).slice(0, 50) : [],
      roles,
      countryCode: clean(input.countryCode || 'PL', 8).toUpperCase(),
      taxIdType: clean(input.taxIdType || 'nip', 32).toLowerCase(),
      taxId: clean(input.taxId, 64),
      status: input.status === 'inactive' ? 'inactive' : 'active',
      metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    });
  } catch (error) {
    if (Number(error?.code) === 11000) throw appError('business_counterparty_tax_id_exists');
    throw error;
  }
}

async function updateBusinessCounterparty(id, patch = {}) {
  const row = await BusinessCounterparty.findById(objectId(id, 'business_counterparty_id_invalid'));
  if (!row) throw appError('business_counterparty_not_found');
  if (patch.legalName !== undefined) {
    const name = clean(patch.legalName, 512); if (!name) throw appError('business_counterparty_name_required');
    row.legalName = name; row.normalizedName = normalizeName(name);
  }
  if (patch.aliases !== undefined) row.aliases = Array.isArray(patch.aliases) ? patch.aliases.map((x) => clean(x, 256)).filter(Boolean).slice(0, 50) : [];
  if (patch.roles !== undefined) {
    const roles = Array.isArray(patch.roles) ? [...new Set(patch.roles.map((x) => clean(x, 32).toLowerCase()))] : [];
    if (!roles.length || roles.some((role) => !['supplier', 'customer'].includes(role))) throw appError('business_counterparty_role_invalid');
    row.roles = roles;
  }
  if (patch.countryCode !== undefined) row.countryCode = clean(patch.countryCode, 8).toUpperCase();
  if (patch.taxIdType !== undefined) row.taxIdType = clean(patch.taxIdType, 32).toLowerCase();
  if (patch.taxId !== undefined) row.taxId = clean(patch.taxId, 64);
  if (patch.status !== undefined) {
    if (!['active', 'inactive'].includes(patch.status)) throw appError('business_counterparty_status_invalid');
    row.status = patch.status;
  }
  if (patch.metadata !== undefined) row.metadata = patch.metadata && typeof patch.metadata === 'object' ? patch.metadata : {};
  try { await row.save(); } catch (error) {
    if (Number(error?.code) === 11000) throw appError('business_counterparty_tax_id_exists');
    throw error;
  }
  return row;
}

async function getDocumentWithArtifact(documentId) {
  const id = objectId(documentId, 'ksef_inbound_document_id_invalid');
  const doc = await InboundFiscalDocument.findById(id).select('+artifact.contentBase64');
  if (!doc) throw appError('ksef_inbound_document_not_found');
  return doc;
}

async function upsertSuggestedLink({ documentId, targetType, targetId, score, confidence, evidence }) {
  return InboundFiscalBusinessLink.findOneAndUpdate(
    { documentId, targetType, targetId },
    {
      $set: { score, confidence, evidence, matcherVersion: MATCHER_VERSION, lastEvaluatedAt: new Date() },
      $setOnInsert: { state: 'suggested', origin: 'matcher' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function buildCounterpartyCandidates(document) {
  const seller = document.metadata?.seller || {};
  const identity = normalizePartyIdentity(seller);
  const filter = { status: 'active', roles: 'supplier' };
  if (identity.taxId) filter.taxId = identity.taxId;
  else if (identity.normalizedName) filter.normalizedName = identity.normalizedName;
  else return [];
  const rows = await BusinessCounterparty.find(filter).limit(50).lean();
  const out = [];
  for (const row of rows) {
    const scored = scoreCounterpartyCandidate(seller, row);
    if (scored.score < 40) continue;
    out.push(await upsertSuggestedLink({ documentId: document._id, targetType: 'business_counterparty', targetId: row._id, ...scored }));
  }
  return out;
}

async function buildReceiptCandidates(document, { receiptWindowDays = 14 } = {}) {
  const invoiceDateRaw = document.metadata?.issueDate || document.metadata?.invoicingDate || document.providerStoredAt;
  const invoiceDate = invoiceDateRaw ? new Date(invoiceDateRaw) : null;
  if (!invoiceDate || !Number.isFinite(invoiceDate.getTime())) return [];
  const days = Math.max(1, Math.min(30, Number(receiptWindowDays) || 14));
  const from = new Date(invoiceDate.getTime() - days * 86400000);
  const to = new Date(invoiceDate.getTime() + days * 86400000);
  const receipts = await Receipt.find({ $or: [
    { createdAt: { $gte: from, $lte: to } },
    { startedAt: { $gte: from, $lte: to } },
    { completedAt: { $gte: from, $lte: to } },
  ] }).sort({ createdAt: -1 }).limit(100).lean();
  if (!receipts.length) return [];
  const receiptIds = receipts.map((row) => row._id);
  const items = await ReceiptItem.find({ receiptId: { $in: receiptIds } }).select('receiptId name totalQty status').lean();
  const byReceipt = new Map();
  for (const item of items) {
    const key = String(item.receiptId); const list = byReceipt.get(key) || []; list.push(item); byReceipt.set(key, list);
  }
  let invoiceLines = [];
  if (document.artifact?.contentBase64) {
    try { invoiceLines = extractFa3BusinessFacts(Buffer.from(document.artifact.contentBase64, 'base64').toString('utf8')).lines; } catch (_) { invoiceLines = []; }
  }
  const out = [];
  for (const receipt of receipts) {
    const scored = scoreReceiptCandidate({ invoiceDate, invoiceLines, receipt, receiptItems: byReceipt.get(String(receipt._id)) || [] });
    if (scored.score < 10) continue;
    out.push(await upsertSuggestedLink({ documentId: document._id, targetType: 'receipt', targetId: receipt._id, ...scored }));
  }
  return out;
}

async function refreshInboundBusinessCandidates(documentId, options = {}) {
  const document = await getDocumentWithArtifact(documentId);
  const [counterparties, receipts] = await Promise.all([
    buildCounterpartyCandidates(document), buildReceiptCandidates(document, options),
  ]);
  return { documentId: String(document._id), matcherVersion: MATCHER_VERSION, counterpartyCandidates: counterparties.length, receiptCandidates: receipts.length };
}

async function listInboundBusinessLinks(documentId) {
  const id = objectId(documentId, 'ksef_inbound_document_id_invalid');
  const exists = await InboundFiscalDocument.exists({ _id: id });
  if (!exists) throw appError('ksef_inbound_document_not_found');
  const links = await InboundFiscalBusinessLink.find({ documentId: id }).sort({ state: 1, targetType: 1, score: -1, createdAt: 1 }).lean();
  const cpIds = links.filter((x) => x.targetType === 'business_counterparty').map((x) => x.targetId);
  const receiptIds = links.filter((x) => x.targetType === 'receipt').map((x) => x.targetId);
  const [counterparties, receipts] = await Promise.all([
    cpIds.length ? BusinessCounterparty.find({ _id: { $in: cpIds } }).lean() : [],
    receiptIds.length ? Receipt.find({ _id: { $in: receiptIds } }).lean() : [],
  ]);
  const cpMap = new Map(counterparties.map((x) => [String(x._id), x]));
  const receiptMap = new Map(receipts.map((x) => [String(x._id), x]));
  return links.map((link) => ({ ...publicLink(link), target: link.targetType === 'business_counterparty' ? cpMap.get(String(link.targetId)) || null : receiptMap.get(String(link.targetId)) || null }));
}

async function ensureTargetExists(targetType, targetId) {
  const id = objectId(targetId, 'inbound_business_link_target_id_invalid');
  if (targetType === 'business_counterparty') {
    const row = await BusinessCounterparty.findById(id).lean();
    if (!row) throw appError('business_counterparty_not_found');
    return row;
  }
  if (targetType === 'receipt') {
    const row = await Receipt.findById(id).lean();
    if (!row) throw appError('receipt_not_found');
    return row;
  }
  throw appError('inbound_business_link_target_type_invalid');
}

async function confirmInboundBusinessLink(documentId, { linkId = '', targetType = '', targetId = '', replace = false, reason = '', actor = {} } = {}) {
  const docId = objectId(documentId, 'ksef_inbound_document_id_invalid');
  if (!await InboundFiscalDocument.exists({ _id: docId })) throw appError('ksef_inbound_document_not_found');
  let link = null;
  if (linkId) {
    link = await InboundFiscalBusinessLink.findOne({ _id: objectId(linkId, 'inbound_business_link_id_invalid'), documentId: docId });
    if (!link) throw appError('inbound_business_link_not_found');
    targetType = link.targetType; targetId = String(link.targetId);
  } else {
    await ensureTargetExists(targetType, targetId);
    link = await InboundFiscalBusinessLink.findOne({ documentId: docId, targetType, targetId });
    if (!link) link = new InboundFiscalBusinessLink({ documentId: docId, targetType, targetId, origin: 'manual', confidence: 'manual', score: 0, evidence: [] });
  }
  await ensureTargetExists(targetType, targetId);
  if (targetType === 'business_counterparty') {
    const existing = await InboundFiscalBusinessLink.findOne({ documentId: docId, targetType, state: 'confirmed', _id: { $ne: link._id } });
    if (existing && !replace) throw appError('inbound_business_counterparty_already_confirmed');
    if (existing && replace) {
      existing.state = 'rejected'; existing.decidedAt = new Date(); existing.decidedBy = actor; existing.decisionReason = 'replaced'; await existing.save();
    }
  }
  link.state = 'confirmed'; link.decidedAt = new Date(); link.decidedBy = actor; link.decisionReason = clean(reason, 1000); if (link.origin === 'manual') link.confidence = 'manual';
  try { await link.save(); } catch (error) {
    if (Number(error?.code) === 11000) throw appError('inbound_business_counterparty_already_confirmed');
    throw error;
  }
  return publicLink(link);
}

async function rejectInboundBusinessLink(documentId, linkId, { reason = '', actor = {} } = {}) {
  const docId = objectId(documentId, 'ksef_inbound_document_id_invalid');
  const link = await InboundFiscalBusinessLink.findOne({ _id: objectId(linkId, 'inbound_business_link_id_invalid'), documentId: docId });
  if (!link) throw appError('inbound_business_link_not_found');
  link.state = 'rejected'; link.decidedAt = new Date(); link.decidedBy = actor; link.decisionReason = clean(reason, 1000); await link.save();
  return publicLink(link);
}

module.exports = {
  listBusinessCounterparties, createBusinessCounterparty, updateBusinessCounterparty,
  refreshInboundBusinessCandidates, listInboundBusinessLinks, confirmInboundBusinessLink, rejectInboundBusinessLink,
};

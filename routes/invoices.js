'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const InvoiceSnapshot = require('../models/InvoiceSnapshot');
const {
  createConnection: createKsefConnection, listConnections: listKsefConnections, updateConnection: updateKsefConnection, rotateToken: rotateKsefToken,
} = require('../services/invoices/ksef/connections');
const { checkConnection: checkKsefConnection } = require('../services/invoices/ksef/auth');
const {
  importXadesCredential: importKsefXadesCredential,
  listXadesCredentials: listKsefXadesCredentials,
  updateXadesCredential: updateKsefXadesCredential,
} = require('../services/invoices/ksef/xadesCredentials');
const { checkXadesCredential: checkKsefXadesCredential } = require('../services/invoices/ksef/xadesAuth');
const {
  publicEnrollment: publicKsefCertificateEnrollment,
  getCertificateLimits: getKsefCertificateLimits,
  listCertificateEnrollments: listKsefCertificateEnrollments,
  getCertificateEnrollment: getKsefCertificateEnrollment,
  createCertificateEnrollment: createKsefCertificateEnrollment,
  reconcileCertificateEnrollment: reconcileKsefCertificateEnrollment,
  revokeKsefCertificate,
} = require('../services/invoices/ksef/certificateEnrollments');
const {
  importOfflineCertificate: importKsefOfflineCertificate,
  listOfflineCertificates: listKsefOfflineCertificates,
  updateOfflineCertificate: updateKsefOfflineCertificate,
} = require('../services/invoices/ksef/offlineCertificates');
const {
  validateInvoiceForKsef,
  prepareOffline24Invoice: prepareKsefOffline24Invoice,
  submitInvoiceToKsef,
  getSubmissionStatus: getKsefSubmissionStatus,
  reconcileInvoiceSubmission: reconcileKsefInvoiceSubmission,
  getSubmissionUpo: getKsefSubmissionUpo,
} = require('../services/invoices/ksef/submissions');
const { asyncHandler, appError } = require('../utils/errors');
const { requireTelegramRole } = require('../middleware/telegramAuth');
const { getInvoiceSourceRegistry } = require('../services/invoices/sourceProviders/registry');
const { getFiscalProviderRegistry } = require('../services/invoices/fiscalProviders/registry');
const {
  prepareInvoiceFromSource,
  createInvoiceFromSource,
} = require('../services/invoices/invoiceCreationService');
const { updateInvoiceDraft, finalizeInvoice } = require('../services/invoices/invoiceService');
const {
  createLegalEntity,
  updateLegalEntity,
  listLegalEntities,
  resolveLegalEntity,
} = require('../services/invoices/legalEntityService');

const router = express.Router();
const adminOnly = requireTelegramRole('admin');
router.use(adminOnly);

function actorFromReq(req) {
  const user = req.telegramUser || {};
  return {
    id: String(user.telegramId || ''),
    name: [user.firstName, user.lastName].filter(Boolean).join(' '),
    role: String(user.role || ''),
  };
}

function requireObjectId(value, errorCode) {
  const id = String(value || '').trim();
  if (!mongoose.isValidObjectId(id)) throw appError(errorCode);
  return id;
}

function noStore(res) {
  res.set('Cache-Control', 'no-store');
}

router.get('/meta', asyncHandler(async (_req, res) => {
  noStore(res);
  res.json({
    sourceProviders: getInvoiceSourceRegistry(),
    fiscalProviders: getFiscalProviderRegistry(),
  });
}));

router.get('/legal-entities', asyncHandler(async (req, res) => {
  const items = await listLegalEntities({ includeInactive: String(req.query.includeInactive || '') === 'true' });
  noStore(res);
  res.json({ items });
}));

router.post('/legal-entities', asyncHandler(async (req, res) => {
  const entity = await createLegalEntity(req.body || {});
  noStore(res);
  res.status(201).json(entity);
}));

router.get('/legal-entities/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'legal_entity_id_invalid');
  const entity = await resolveLegalEntity(id, { allowDefault: false, requireActive: false });
  noStore(res);
  res.json(entity);
}));

router.patch('/legal-entities/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'legal_entity_id_invalid');
  const entity = await updateLegalEntity(id, req.body || {});
  noStore(res);
  res.json(entity);
}));


router.get('/ksef/connections', asyncHandler(async (req, res) => {
  const items = await listKsefConnections({ legalEntityId: req.query.legalEntityId || '', includeDisabled: String(req.query.includeDisabled || 'true') !== 'false' });
  noStore(res);
  res.json({ items });
}));

router.post('/ksef/connections', asyncHandler(async (req, res) => {
  const connection = await createKsefConnection(req.body || {});
  noStore(res);
  res.status(201).json(connection);
}));

router.patch('/ksef/connections/:connectionId', asyncHandler(async (req, res) => {
  const connection = await updateKsefConnection(req.params.connectionId, req.body || {});
  noStore(res);
  res.json(connection);
}));

router.post('/ksef/connections/:connectionId/token', asyncHandler(async (req, res) => {
  const connection = await rotateKsefToken(req.params.connectionId, req.body?.token);
  noStore(res);
  res.json(connection);
}));

router.post('/ksef/connections/:connectionId/check', asyncHandler(async (req, res) => {
  const result = await checkKsefConnection(req.params.connectionId);
  noStore(res);
  res.json(result);
}));


router.get('/ksef/xades-credentials', asyncHandler(async (req, res) => {
  const items = await listKsefXadesCredentials({
    environment: req.query.environment || '',
    includeDisabled: String(req.query.includeDisabled || 'true') !== 'false',
  });
  noStore(res);
  res.json({ items });
}));

router.post('/ksef/xades-credentials', asyncHandler(async (req, res) => {
  const credential = await importKsefXadesCredential(req.body || {});
  noStore(res);
  res.status(201).json(credential);
}));

router.patch('/ksef/xades-credentials/:credentialId', asyncHandler(async (req, res) => {
  const credential = await updateKsefXadesCredential(req.params.credentialId, req.body || {});
  noStore(res);
  res.json(credential);
}));

router.post('/ksef/xades-credentials/:credentialId/check', asyncHandler(async (req, res) => {
  const legalEntityId = requireObjectId(req.body?.legalEntityId, 'legal_entity_id_invalid');
  const result = await checkKsefXadesCredential(req.params.credentialId, legalEntityId);
  noStore(res);
  res.json(result);
}));

router.get('/ksef/certificate-limits', asyncHandler(async (req, res) => {
  const legalEntityId = requireObjectId(req.query.legalEntityId, 'legal_entity_id_invalid');
  const limits = await getKsefCertificateLimits({ xadesCredentialId: req.query.xadesCredentialId, legalEntityId });
  noStore(res);
  res.json(limits);
}));

router.get('/ksef/certificate-enrollments', asyncHandler(async (req, res) => {
  const items = await listKsefCertificateEnrollments({
    xadesCredentialId: req.query.xadesCredentialId || '',
    state: req.query.state || '',
  });
  noStore(res);
  res.json({ items });
}));

router.post('/ksef/certificate-enrollments', asyncHandler(async (req, res) => {
  const legalEntityId = requireObjectId(req.body?.legalEntityId, 'legal_entity_id_invalid');
  const enrollment = await createKsefCertificateEnrollment({ ...(req.body || {}), legalEntityId });
  noStore(res);
  res.status(202).json(enrollment);
}));

router.get('/ksef/certificate-enrollments/:enrollmentId', asyncHandler(async (req, res) => {
  const enrollment = await getKsefCertificateEnrollment(req.params.enrollmentId);
  noStore(res);
  res.json(publicKsefCertificateEnrollment(enrollment));
}));

router.post('/ksef/certificate-enrollments/:enrollmentId/reconcile', asyncHandler(async (req, res) => {
  const enrollment = await reconcileKsefCertificateEnrollment(req.params.enrollmentId);
  noStore(res);
  res.json(enrollment);
}));

router.post('/ksef/certificates/:certificateSerialNumber/revoke', asyncHandler(async (req, res) => {
  const legalEntityId = requireObjectId(req.body?.legalEntityId, 'legal_entity_id_invalid');
  const result = await revokeKsefCertificate({
    xadesCredentialId: req.body?.xadesCredentialId,
    legalEntityId,
    certificateSerialNumber: req.params.certificateSerialNumber,
    revocationReason: req.body?.revocationReason,
  });
  noStore(res);
  res.json(result);
}));


router.get('/ksef/offline-certificates', asyncHandler(async (req, res) => {
  const items = await listKsefOfflineCertificates({
    legalEntityId: req.query.legalEntityId || '',
    environment: req.query.environment || '',
    includeDisabled: String(req.query.includeDisabled || 'true') !== 'false',
  });
  noStore(res);
  res.json({ items });
}));

router.post('/ksef/offline-certificates', asyncHandler(async (req, res) => {
  const legalEntityId = requireObjectId(req.body?.legalEntityId, 'legal_entity_id_invalid');
  const certificate = await importKsefOfflineCertificate({ ...(req.body || {}), legalEntityId });
  noStore(res);
  res.status(201).json(certificate);
}));

router.patch('/ksef/offline-certificates/:certificateId', asyncHandler(async (req, res) => {
  const certificate = await updateKsefOfflineCertificate(req.params.certificateId, req.body || {});
  noStore(res);
  res.json(certificate);
}));

router.post('/preview', asyncHandler(async (req, res) => {
  const result = await prepareInvoiceFromSource({
    sourceProvider: req.body?.sourceProvider,
    sourceRef: req.body?.sourceRef || {},
    input: req.body?.input || {},
    legalEntityId: req.body?.legalEntityId || '',
  });
  noStore(res);
  res.json({ draft: result.draft, blockers: result.blockers });
}));

router.post('/', asyncHandler(async (req, res) => {
  const result = await createInvoiceFromSource({
    sourceProvider: req.body?.sourceProvider,
    sourceRef: req.body?.sourceRef || {},
    input: req.body?.input || {},
    legalEntityId: req.body?.legalEntityId || '',
    idempotencyKey: req.body?.idempotencyKey || '',
  }, actorFromReq(req));
  noStore(res);
  res.status(201).json({ invoice: result.invoice, blockers: result.blockers });
}));

router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize) || 25));
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status);
  if (req.query.legalEntityId) filter['seller.legalEntityId'] = String(req.query.legalEntityId);
  if (req.query.sourceProvider) filter['source.provider'] = String(req.query.sourceProvider).toLowerCase();
  const [items, total] = await Promise.all([
    Invoice.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Invoice.countDocuments(filter),
  ]);
  noStore(res);
  res.json({ items, page, pageSize, total });
}));


router.post('/:id/fiscal/ksef/validate', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await validateInvoiceForKsef(id);
  noStore(res);
  res.json(result);
}));


router.post('/:id/fiscal/ksef/offline24/prepare', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await prepareKsefOffline24Invoice(id, { environment: req.body?.environment || 'test' });
  noStore(res);
  res.status(result.alreadyPrepared ? 200 : 201).json(result);
}));

router.post('/:id/fiscal/ksef/submit', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await submitInvoiceToKsef(id, { environment: req.body?.environment || 'test' });
  noStore(res);
  res.status(result.alreadySubmitted ? 200 : 202).json(result);
}));

router.get('/:id/fiscal/ksef/status', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await getKsefSubmissionStatus(id, { environment: req.query.environment || 'test', refresh: String(req.query.refresh || 'true') !== 'false' });
  noStore(res);
  res.json(result);
}));

router.post('/:id/fiscal/ksef/reconcile', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await reconcileKsefInvoiceSubmission(id, { environment: req.body?.environment || 'test' });
  noStore(res);
  res.json(result);
}));

router.get('/:id/fiscal/ksef/upo', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await getKsefSubmissionUpo(id, {
    environment: req.query.environment || 'test',
    refresh: String(req.query.refresh || 'true') !== 'false',
  });
  noStore(res);
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ksef-upo-${id}.xml"`);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-KSeF-UPO-SHA256', result.sha256Hex);
  res.send(result.content);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const invoice = await Invoice.findById(id).lean();
  if (!invoice) throw appError('invoice_not_found');
  const snapshot = invoice.finalizedSnapshotId
    ? await InvoiceSnapshot.findById(invoice.finalizedSnapshotId).lean()
    : null;
  noStore(res);
  res.json({ invoice, snapshot });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const invoice = await updateInvoiceDraft(id, req.body || {}, actorFromReq(req));
  noStore(res);
  res.json(invoice);
}));

router.post('/:id/finalize', asyncHandler(async (req, res) => {
  const id = requireObjectId(req.params.id, 'invoice_id_invalid');
  const result = await finalizeInvoice(id, actorFromReq(req));
  noStore(res);
  res.status(result.alreadyFinalized ? 200 : 201).json(result);
}));

module.exports = router;

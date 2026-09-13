'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const app = read('app.js');
const invoice = read('models/Invoice.js');
const legalEntity = read('models/LegalEntity.js');
const routes = read('routes/invoices.js');
const creation = read('services/invoices/invoiceCreationService.js');
const invoiceService = read('services/invoices/invoiceService.js');
const numbering = read('services/invoices/invoiceNumbering.js');
const warehouse = read('services/invoices/sourceProviders/warehouseOrder.js');
const pricing = read('services/invoices/pricing.js');
const errors = read('utils/errors.js');

check('LegalEntity model exists', exists('models/LegalEntity.js') && legalEntity.includes("mongoose.model('LegalEntity'"));
check('one default LegalEntity is enforced by partial unique index', legalEntity.includes("partialFilterExpression: { isDefault: true }"));
check('Invoice stores issuer LegalEntity snapshot id', invoice.includes('legalEntityId') && invoice.includes("'seller.legalEntityId'"));
check('invoice creation layer applies LegalEntity defaults', creation.includes('applyLegalEntityDefaults') && creation.includes('legalEntityToInvoiceParty'));
check('Warehouse Order requires explicit quantity policy', warehouse.includes('invoice_source_quantity_mode_required') && warehouse.includes('QUANTITY_MODES'));
check('Warehouse Order does not guess net/gross basis', warehouse.includes("input.priceBasis || 'unknown'"));
check('pricing uses decimal-string arithmetic instead of JS float totals', pricing.includes('BigInt') && pricing.includes('roundFractionToMoney'));
check('invoice number is allocated only at finalization', invoiceService.includes('allocateInvoiceNumber') && numbering.includes('Counter.findOneAndUpdate'));
check('finalization resolves active LegalEntity inside transaction', invoiceService.includes('resolveLegalEntity') && invoiceService.includes('withTransaction'));
check('invoice HTTP surface is mounted', app.includes("app.use('/api/invoices', invoicesRouter)"));
check('invoice HTTP surface is admin-only', routes.includes("const adminOnly = requireTelegramRole('admin')") && routes.includes('router.use(adminOnly)'));
check('preview/create/update/finalize routes exist', routes.includes("router.post('/preview'") && routes.includes("router.post('/'") && routes.includes("router.patch('/:id'") && routes.includes("router.post('/:id/finalize'"));
check('LegalEntity errors are explicit', errors.includes('legal_entity_tax_id_invalid') && errors.includes('legal_entity_numbering_invalid'));
check('KSeF remains outside Stage 2 network path', !creation.includes('ksef') && !invoiceService.includes('fiscalProviders/ksef'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice Core Stage 2 static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice Core Stage 2 static contract passed: ${checks.length}/${checks.length}`);

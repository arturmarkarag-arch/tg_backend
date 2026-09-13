'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const invoiceModel = read('models/Invoice.js');
const snapshotModel = read('models/InvoiceSnapshot.js');
const sourceRegistry = read('services/invoices/sourceProviders/registry.js');
const warehouse = read('services/invoices/sourceProviders/warehouseOrder.js');
const fiscalRegistry = read('services/invoices/fiscalProviders/registry.js');
const ksef = read('services/invoices/fiscalProviders/ksef.js');
const service = read('services/invoices/invoiceService.js');

check('canonical Invoice model exists', invoiceModel.includes("mongoose.model('Invoice'"));
check('snapshot is separate from Invoice', snapshotModel.includes("mongoose.model('InvoiceSnapshot'") && invoiceModel.includes('finalizedSnapshotId'));
check('source providers are registry-based', sourceRegistry.includes('getInvoiceSourceAdapter') && sourceRegistry.includes('warehouseOrder'));
check('Warehouse Order does not guess tax basis', warehouse.includes("priceBasis: override.priceBasis || input.priceBasis || 'unknown'"));
check('Warehouse Order requires explicit quantity mode', warehouse.includes("invoice_source_quantity_mode_required"));
check('fiscal providers are separate from source providers', fiscalRegistry.includes('getFiscalProviderAdapter'));
check('KSeF stays behind the fiscal-provider adapter boundary', ksef.includes('createFiscalProviderAdapter') && !service.includes('fiscalProviders/ksef'));
check('finalization hashes canonical snapshot', service.includes("createHash('sha256')") && service.includes('InvoiceSnapshot.create'));
check('finalized invoice is immutable through core update command', service.includes("invoice_finalized_immutable"));
check('Invoice Core never imports KSeF provider', !service.includes('fiscalProviders/ksef'));

const failed = checks.filter((item) => !item.ok);
for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (failed.length) {
  console.error(`Invoice Core Stage 1 static contract failed: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`Invoice Core Stage 1 static contract passed: ${checks.length}/${checks.length}`);

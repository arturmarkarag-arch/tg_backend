'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let pass = 0;
const checks = [];
function check(name, fn) {
  checks.push(name);
  try { if (!fn()) throw new Error('condition=false'); pass += 1; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); }
}

const registry = read('services/invoices/sourceProviders/registry.js');
const contract = read('services/invoices/sourceProviders/orderSourceContract.js');
const base = read('services/invoices/sourceProviders/baseLinkerOrder.js');
const allegro = read('services/invoices/sourceProviders/allegroOrder.js');
const baseOrders = read('services/baseLinkerOrders.js');
const invoiceService = read('services/invoices/invoiceService.js');
const creation = read('services/invoices/invoiceCreationService.js');
const routes = read('routes/invoices.js');

check('invoice source registry includes Allegro and BaseLinker order adapters', () => registry.includes("require('./allegroOrder')") && registry.includes("require('./baseLinkerOrder')"));
check('BaseLinker invoice adapter exact-reads upstream and requests discounts', () => base.includes("usageStage: 'invoice_source_exact'") && base.includes('includeDiscountsData: true'));
check('BaseLinker invoice adapter never reads the local warehouse order index', () => !/BaseLinkerOrderIndex|BaseLinkerPickingState\.find|baseLinkerOrderIndex/i.test(base));
check('BaseLinker exact-order helper can request include_discounts_data', () => baseOrders.includes('include_discounts_data: true'));
check('Allegro invoice adapter exact-reads checkout-form upstream', () => allegro.includes('/order/checkout-forms/${encodeURIComponent(orderId)}') && allegro.includes("stage: 'invoice_source_exact'"));
check('Allegro invoice adapter never reads the local order index', () => !/AllegroOrderIndex|AllegroPickingState\.find|allegroOrderIndex/i.test(allegro));
check('provider contract fails closed on VAT delivery and discount gaps', () => contract.includes('invoice_source_item_${index}_vat_required') && contract.includes('invoice_source_delivery_vat_required') && contract.includes('invoice_source_discounts_not_supported'));
check('provider order snapshot hash excludes transport observedAt', () => contract.includes('delete canonical.observedAt'));
check('provider-authoritative buyer items currency and totals are locked in generic draft PATCH', () => invoiceService.includes('items: upstreamLocked ? current.items') && invoiceService.includes('buyer: correctionLocked || upstreamLocked ? current.buyer') && invoiceService.includes('currency: upstreamLocked ? current.currency') && invoiceService.includes('totals: upstreamLocked ? current.totals'));
check('irreversible finalize exact-verifies source before Mongo transaction', () => invoiceService.includes('await verifyInvoiceSource(sourceCheck)') && invoiceService.indexOf('await verifyInvoiceSource(sourceCheck)') < invoiceService.indexOf('startSession()'));
check('stale provider draft has exact-read refresh service and route', () => invoiceService.includes('async function refreshInvoiceDraftFromSource') && routes.includes("router.post('/:id/source/refresh'"));
check('one business order gets deterministic primary-invoice idempotency identity per seller', () => creation.includes('function sourceIdempotencyKey') && creation.includes('canonicalProvider') && creation.includes('canonicalOrderId') && creation.includes('`invoice-source:${canonicalProvider}:${canonicalOrderId}:${sellerId}`'));
check('provider order identity carries canonical cross-provider identity', () => contract.includes('canonicalProvider') && contract.includes('canonicalOrderId'));
check('BaseLinker Allegro-source orders converge on Allegro canonical identity', () => base.includes("canonicalProvider = sourceType === 'allegro'") && base.includes("canonicalOrderId = canonicalProvider === 'allegro'"));

if (pass !== checks.length) {
  console.error(`Invoice order source provider static contract: FAIL (${pass}/${checks.length})`);
  process.exit(1);
}
console.log(`Invoice order source provider static contract: PASS (${pass}/${checks.length})`);

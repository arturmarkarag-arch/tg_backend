'use strict';

const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
const checks = [];
function check(name, ok) { checks.push({ name, ok: Boolean(ok) }); if (ok) passed += 1; }

const contract = read('services/commerce/providers/contract.js');
const allegro = read('services/commerce/providers/allegro.js');
const baseLinker = read('services/commerce/providers/baseLinker.js');
const automation = read('services/invoices/providerOrderAutomation.js');
const binding = read('services/invoices/providerAccountBinding.js');
const allegroOrders = read('services/allegroOrders.js');
const baseLinkerIndex = read('services/baseLinkerOrderIndex.js');
const invoiceService = read('services/invoices/invoiceService.js');

check('provider contract owns generic invoice.source capability', contract.includes("INVOICE_SOURCE: 'invoice.source'") && contract.includes('invoiceSource'));
check('Allegro adapter declares invoice source mapping', allegro.includes("adapterId: 'allegro_order'") && allegro.includes('invoiceSourceFromOrder'));
check('BaseLinker adapter declares invoice source mapping', baseLinker.includes("adapterId: 'baselinker_order'") && baseLinker.includes('invoiceSourceFromOrder'));
check('automation dispatches via provider adapter, not provider branches', automation.includes('getProviderAdapter(providerId') && !/providerId\s*===\s*['"](?:allegro|baselinker)/.test(automation));
check('automation creates drafts only, never finalizes or submits KSeF', automation.includes('createInvoiceFromSource') && !automation.includes('finalizeInvoice') && !automation.includes('submitInvoiceToKsef'));
check('provider order payload is reused without an extra exact-read', allegroOrders.includes("runProviderOrderInvoiceAutomation('allegro'") && baseLinkerIndex.includes("runProviderOrderInvoiceAutomation('baselinker'"));
check('provider-account seller binding is durable and generic', binding.includes('CommerceProviderAccountBinding') && binding.includes("source: 'auto_single_entity'"));
check('source strictness still lives in invoice source adapters', invoiceService.includes('previewInvoiceDraftFromSource') && automation.includes('requireInvoiceRequested: true'));
check('auto draft idempotency remains Invoice Core responsibility', invoiceService.includes('idempotencyKey') && automation.includes('createInvoiceFromSource'));
check('changed upstream order refreshes the existing draft instead of creating another', automation.includes('refreshInvoiceDraftFromSource') && automation.includes('previous?.invoiceId'));
check('blocked/unbound automation uses retry cooldown instead of hammering every poll', automation.includes('BLOCKED_RETRY_MS') && automation.includes('nextRetryAt'));
check('cross-provider identity converges BaseLinker→Allegro and direct Allegro into one invoice key', read('services/invoices/invoiceCreationService.js').includes('canonicalProvider') && read('services/invoices/sourceProviders/baseLinkerOrder.js').includes("canonicalProvider = sourceType === 'allegro'"));
check('finalized invoice source drift becomes terminal audit state instead of retry loop', automation.includes('finalized_source_changed') && automation.includes('invoice_finalized_source_changed'));
check('automation state upsert tolerates concurrent duplicate-key races', automation.includes('error?.code !== 11000') && automation.includes('{ new: true }'));
check('automation state persists blockers without PII payload', automation.includes('InvoiceSourceAutomationState') && !read('models/InvoiceSourceAutomationState.js').includes('buyer') && !read('models/InvoiceSourceAutomationState.js').includes('address'));

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
if (passed !== checks.length) { console.error(`Invoice order automation: ${passed}/${checks.length} PASS`); process.exit(1); }
console.log(`Invoice order automation: ${passed}/${checks.length} PASS`);

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const checks = [];
function check(name, fn) { try { if (!fn()) throw new Error('condition false'); checks.push([name, true]); } catch (e) { checks.push([name, false, e.message]); } }

check('provider-neutral BusinessCounterparty model exists', () => exists('models/BusinessCounterparty.js'));
check('durable InboundFiscalBusinessLink model exists', () => exists('models/InboundFiscalBusinessLink.js'));
check('counterparty identity has unique tax-id index', () => /unique:\s*true[\s\S]*partialFilterExpression:\s*\{ taxId: \{ \$gt: '' \}/.test(read('models/BusinessCounterparty.js')));
check('link identity is unique per document target', () => /documentId: 1, targetType: 1, targetId: 1 \}, \{ unique: true \}/.test(read('models/InboundFiscalBusinessLink.js')));
check('DB forbids two confirmed counterparties per inbound document', () => /partialFilterExpression:\s*\{ targetType: 'business_counterparty', state: 'confirmed' \}/.test(read('models/InboundFiscalBusinessLink.js')));
check('links preserve suggested confirmed rejected states', () => /\['suggested', 'confirmed', 'rejected'\]/.test(read('models/InboundFiscalBusinessLink.js')));
check('links preserve actor and decision reason audit', () => /decidedBy/.test(read('models/InboundFiscalBusinessLink.js')) && /decisionReason/.test(read('models/InboundFiscalBusinessLink.js')));
check('matching policy is dependency-free/pure', () => !/require\(['"]mongoose['"]\)/.test(read('services/invoices/inboundLinkingPolicy.js')));
check('supplier scoring uses exact tax identity', () => /tax_id_exact/.test(read('services/invoices/inboundLinkingPolicy.js')) && /tax_id_conflict/.test(read('services/invoices/inboundLinkingPolicy.js')));
check('receipt scoring is evidence based, bounded and never called exact', () => /date_proximity/.test(read('services/invoices/inboundLinkingPolicy.js')) && /item_name_overlap/.test(read('services/invoices/inboundLinkingPolicy.js')) && /quantity_close/.test(read('services/invoices/inboundLinkingPolicy.js')) && /score >= 80 \? 'high'/.test(read('services/invoices/inboundLinkingPolicy.js')));
check('FA3 line extraction is bounded for matching only', () => /lines\.length >= 1000/.test(read('services/invoices/inboundLinkingPolicy.js')));
check('refresh creates suggestions, never auto-confirms', () => /\$setOnInsert:\s*\{ state: 'suggested', origin: 'matcher' \}/.test(read('services/invoices/inboundBusinessLinks.js')));
check('manual confirmation requires existing target', () => /ensureTargetExists/.test(read('services/invoices/inboundBusinessLinks.js')));
check('counterparty replacement requires explicit replace', () => /existing && !replace/.test(read('services/invoices/inboundBusinessLinks.js')) && /inbound_business_counterparty_already_confirmed/.test(read('services/invoices/inboundBusinessLinks.js')));
check('receipt linking permits multiple confirmed receipts', () => !/targetType === 'receipt'[\s\S]{0,500}already_confirmed/.test(read('services/invoices/inboundBusinessLinks.js')));
check('business linking service never writes Product or ShopProduct', () => !/models\/(?:Product|ShopProduct)/.test(read('services/invoices/inboundBusinessLinks.js')));
check('business linking service never mutates Receipt', () => !/Receipt\.(?:update|findOneAndUpdate|delete|create)|receipt\.save\(/.test(read('services/invoices/inboundBusinessLinks.js')));
check('candidate refresh may only read ReceiptItem evidence', () => /ReceiptItem\.find/.test(read('services/invoices/inboundBusinessLinks.js')) && !/ReceiptItem\.(?:update|findOneAndUpdate|delete|create)/.test(read('services/invoices/inboundBusinessLinks.js')));
check('business counterparty CRUD is admin-only behind invoice router', () => /router\.use\(adminOnly\)/.test(read('routes/invoices.js')) && /\/business-counterparties/.test(read('routes/invoices.js')));
check('inbound business link refresh/confirm/reject routes exist', () => /business-links\/refresh/.test(read('routes/invoices.js')) && /business-links\/confirm/.test(read('routes/invoices.js')) && /business-links\/:linkId\/reject/.test(read('routes/invoices.js')));
check('route decisions record authenticated actor', () => /actorFromReq\(req\)/.test(read('routes/invoices.js')));
check('critical startup sync includes Stage 7 models', () => /BusinessCounterparty/.test(read('index.js')) && /InboundFiscalBusinessLink/.test(read('index.js')));
check('Stage 7 does not add KSeF provider network calls', () => !/ksefRequest|resolveInboundAccessToken/.test(read('services/invoices/inboundBusinessLinks.js')));
check('Stage 7 does not add frontend coupling', () => !/frontend|socket\.emit/.test(read('services/invoices/inboundBusinessLinks.js')));

for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
const failed = checks.filter((x) => !x[1]);
if (failed.length) process.exit(1);
console.log(`Invoice KSeF Stage 7 static contract passed: ${checks.length}/${checks.length}`);

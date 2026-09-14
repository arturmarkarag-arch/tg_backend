'use strict';
const assert = require('assert');
const {
  normalizePartyIdentity,
  scoreCounterpartyCandidate,
  scoreReceiptCandidate,
  extractFa3BusinessFacts,
} = require('../services/invoices/inboundLinkingPolicy');

const party = normalizePartyIdentity({ name: 'ACME Sp. z o.o.', nip: 'PL 123-456-32-18', countryCode: 'PL' });
assert.equal(party.taxId, '1234563218');
assert.equal(party.taxIdType, 'nip');

const supplier = { legalName: 'ACME Sp. z o.o.', normalizedName: 'ACME SP Z O O', countryCode: 'PL', taxIdType: 'nip', taxId: '1234563218' };
const exact = scoreCounterpartyCandidate({ name: 'ACME Sp. z o.o.', nip: '1234563218', countryCode: 'PL' }, supplier);
assert.equal(exact.score, 100);
assert.equal(exact.confidence, 'exact');
assert(exact.evidence.some((x) => x.code === 'tax_id_exact'));

const conflict = scoreCounterpartyCandidate({ name: 'ACME', nip: '9999999999', countryCode: 'PL' }, supplier);
assert.equal(conflict.score, 0);
assert(conflict.evidence.some((x) => x.code === 'tax_id_conflict'));

const xml = `<?xml version="1.0"?><Faktura><Fa><FaWiersz><P_7>Kubek czerwony 300 ml</P_7><P_8B>10</P_8B></FaWiersz><FaWiersz><P_7>Talerz biały</P_7><P_8B>5.00</P_8B></FaWiersz></Fa></Faktura>`;
const facts = extractFa3BusinessFacts(xml);
assert.deepEqual(facts.lines.map((x) => [x.name, x.quantity]), [['Kubek czerwony 300 ml', 10], ['Talerz biały', 5]]);

const receiptExact = scoreReceiptCandidate({
  invoiceDate: '2026-09-14',
  invoiceLines: facts.lines,
  receipt: { completedAt: '2026-09-14T12:00:00Z' },
  receiptItems: [{ name: 'Kubek czerwony 300 ml', totalQty: 10 }, { name: 'Talerz biały', totalQty: 5 }],
});
assert.equal(receiptExact.score, 95);
assert.equal(receiptExact.confidence, 'high');

const dateOnly = scoreReceiptCandidate({ invoiceDate: '2026-09-14', receipt: { createdAt: '2026-09-15' }, receiptItems: [] });
assert.equal(dateOnly.score, 30);
assert.equal(dateOnly.confidence, 'low');

console.log('Invoice KSeF Stage 7 pure business-linking contract passed');

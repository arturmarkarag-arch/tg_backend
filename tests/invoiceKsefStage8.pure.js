'use strict';
const assert = require('assert');
const { validateFinalizableInvoice, normalizeInvoiceDraft } = require('../services/invoices/contract');
const { generateFa3Xml, providerBlockers } = require('../services/invoices/ksef/fa3');

const correction = {
  coreVersion: 2,
  type: 'correction',
  invoiceNumber: 'KOR/1/2026',
  source: { provider: 'correction', entityType: 'invoice', entityId: 'orig-1', externalNumber: 'FV/1/2026', metadata: {} },
  seller: { legalEntityId: '507f1f77bcf86cd799439011', name: 'Seller Sp. z o.o.', taxId: '1234563218', taxIdType: 'nip', address: { street: 'Test 1', postalCode: '00-001', city: 'Warszawa', countryCode: 'PL' } },
  buyer: { name: 'Buyer Sp. z o.o.', taxId: '5260250274', taxIdType: 'nip', address: { street: 'Test 2', postalCode: '00-002', city: 'Warszawa', countryCode: 'PL' } },
  recipient: null,
  issueDate: '2026-09-14',
  saleDate: '2026-09-13',
  currency: 'PLN',
  items: [{ sourceLineId: '1', productRef: '', name: 'Zwrot towaru', quantity: '-1', unit: 'szt.', unitPrice: '100.00', priceBasis: 'net', vat: { code: '23', rate: '23' }, amounts: { net: '-100.00', vat: '-23.00', gross: '-123.00' }, metadata: {} }],
  totals: { net: '-100.00', vat: '-23.00', gross: '-123.00' },
  payment: { method: 'transfer', dueDate: '', bankAccount: '', paid: false, paidAt: '' },
  references: { correction: {
    originalInvoiceId: '507f191e810c19729de860ea',
    originalSnapshotId: '507f191e810c19729de860eb',
    originalInvoiceNumber: 'FV/1/2026',
    originalIssueDate: '2026-09-01',
    originalFiscalProvider: 'ksef',
    originalFiscalReference: '1234563218-20260901-ABCDEF123456-01',
    originalEnvironment: 'test',
    reason: 'Zwrot towaru', correctionType: '1', lineMode: 'delta',
  } },
  notes: '',
};

const normalizedCorrection = normalizeInvoiceDraft(correction);
assert.equal(normalizedCorrection.items[0].quantity, '-1');
assert.equal(normalizedCorrection.items[0].amounts.net, '-100.00');
assert.throws(
  () => normalizeInvoiceDraft({ ...correction, type: 'invoice', references: {}, items: correction.items }),
  /quantity.*must not be negative|quantity.*must be greater than zero/,
);

assert.deepEqual(validateFinalizableInvoice(correction), []);
assert.deepEqual(providerBlockers(correction), []);
const xml = generateFa3Xml(correction, { generatedAt: '2026-09-14T10:00:00Z' });
assert(xml.includes('<RodzajFaktury>KOR</RodzajFaktury>'));
assert(xml.includes('<PrzyczynaKorekty>Zwrot towaru</PrzyczynaKorekty>'));
assert(xml.includes('<TypKorekty>1</TypKorekty>'));
assert(xml.includes('<DataWystFaKorygowanej>2026-09-01</DataWystFaKorygowanej>'));
assert(xml.includes('<NrFaKorygowanej>FV/1/2026</NrFaKorygowanej>'));
assert(xml.includes('<NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>1234563218-20260901-ABCDEF123456-01</NrKSeFFaKorygowanej>'));
assert(xml.includes('<P_13_1>-100.00</P_13_1><P_14_1>-23.00</P_14_1>'));
assert(xml.includes('<P_15>-123.00</P_15>'));
assert(xml.includes('<P_8B>-1</P_8B>'));

const missing = JSON.parse(JSON.stringify(correction));
delete missing.references.correction.originalFiscalReference;
assert(validateFinalizableInvoice(missing).includes('correction_original_fiscal_reference_required'));
assert(providerBlockers(missing).includes('ksef_correction_original_reference_required'));

console.log('Invoice KSeF Stage 8 pure correction contract passed');

'use strict';

const assert = require('assert');
const { generateFa3Xml } = require('../services/invoices/ksef/fa3');
const { validateFa3Xml } = require('../services/invoices/ksef/xsdValidator');

function correctionSnapshot() {
  return {
    coreVersion: 2,
    type: 'correction',
    invoiceNumber: 'KOR/1/2026',
    source: { provider: 'correction', entityType: 'invoice', entityId: 'orig-1', externalNumber: 'FV/1/2026', metadata: {} },
    seller: {
      legalEntityId: '507f1f77bcf86cd799439011',
      name: 'Seller Sp. z o.o.',
      taxId: '1234563218',
      taxIdType: 'nip',
      address: { street: 'Test 1', postalCode: '00-001', city: 'Warszawa', countryCode: 'PL' },
    },
    buyer: {
      name: 'Buyer Sp. z o.o.',
      taxId: '5260250274',
      taxIdType: 'nip',
      address: { street: 'Test 2', postalCode: '00-002', city: 'Warszawa', countryCode: 'PL' },
    },
    recipient: null,
    issueDate: '2026-09-14',
    saleDate: '2026-09-13',
    currency: 'PLN',
    items: [{
      sourceLineId: '1', productRef: '', name: 'Zwrot towaru', quantity: '-1', unit: 'szt.', unitPrice: '100.00', priceBasis: 'net',
      vat: { code: '23', rate: '23' }, amounts: { net: '-100.00', vat: '-23.00', gross: '-123.00' }, metadata: {},
    }],
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
      reason: 'Zwrot towaru',
      correctionType: '1',
      lineMode: 'delta',
    } },
    notes: 'Stage 8 KOR XSD smoke',
  };
}

async function run() {
  const xml = generateFa3Xml(correctionSnapshot(), { generatedAt: '2026-09-14T10:00:00Z' });
  assert(xml.includes('<RodzajFaktury>KOR</RodzajFaktury>'));
  assert(xml.includes('<NrKSeF>1</NrKSeF>'));
  assert(xml.includes('<NrKSeFFaKorygowanej>1234563218-20260901-ABCDEF123456-01</NrKSeFFaKorygowanej>'));

  const valid = await validateFa3Xml(xml);
  assert.equal(valid.valid, true);

  const invalidXml = xml.replace('<TypKorekty>1</TypKorekty>', '<TypKorekty>99</TypKorekty>');
  await assert.rejects(
    () => validateFa3Xml(invalidXml),
    (error) => error?.code === 'ksef_xsd_validation_failed',
  );

  console.log('Invoice KSeF Stage 8 KOR real XSD smoke passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

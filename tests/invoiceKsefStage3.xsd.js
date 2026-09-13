'use strict';

const assert = require('assert');
const { generateFa3Xml } = require('../services/invoices/ksef/fa3');
const { validateFa3Xml } = require('../services/invoices/ksef/xsdValidator');

function sampleSnapshot() {
  return {
    type: 'invoice',
    invoiceNumber: 'FV/2026/09/000001',
    issueDate: '2026-09-13',
    saleDate: '2026-09-13',
    currency: 'PLN',
    seller: {
      legalEntityId: '66f000000000000000000001',
      name: 'Złotóweczka Test Sp. z o.o.',
      taxIdType: 'nip',
      taxId: '5260250995',
      address: { countryCode: 'PL', street: 'Testowa 1', postalCode: '00-001', city: 'Warszawa' },
    },
    buyer: {
      name: 'Kupujący Test',
      taxIdType: 'nip',
      taxId: '5260250995',
      address: { countryCode: 'PL', street: 'Klienta 2', postalCode: '00-002', city: 'Warszawa' },
    },
    items: [
      {
        name: 'Towar testowy', unit: 'szt.', quantity: '2', unitPrice: '10.00', priceBasis: 'net',
        vat: { code: '23', rate: '23' }, amounts: { net: '20.00', vat: '4.60', gross: '24.60' },
      },
      {
        name: 'Towar 8%', unit: 'szt.', quantity: '1', unitPrice: '10.80', priceBasis: 'gross',
        vat: { code: '8', rate: '8' }, amounts: { net: '10.00', vat: '0.80', gross: '10.80' },
      },
    ],
    totals: { net: '30.00', vat: '5.40', gross: '35.40' },
    payment: { method: 'transfer', dueDate: '2026-09-20', bankAccount: '61109010140000071219812874', paid: false },
    source: { provider: 'warehouse_order', entityType: 'order', entityId: '66f000000000000000000009', externalNumber: '143' },
    notes: 'Stage 3 XSD smoke',
  };
}

async function run() {
  const xml = generateFa3Xml(sampleSnapshot(), { generatedAt: '2026-09-13T20:00:00.000Z' });
  const valid = await validateFa3Xml(xml);
  assert.equal(valid.valid, true);

  const invalidXml = xml.replace('<WariantFormularza>3</WariantFormularza>', '<WariantFormularza>99</WariantFormularza>');
  await assert.rejects(
    () => validateFa3Xml(invalidXml),
    (error) => error?.code === 'ksef_xsd_validation_failed',
  );
  console.log('Invoice KSeF Stage 3 real XSD smoke passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

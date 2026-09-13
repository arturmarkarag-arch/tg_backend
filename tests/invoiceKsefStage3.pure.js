'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { ENVIRONMENTS, KSEF_SCHEMA, PUBLIC_KEY_USAGE, normalizeEnvironment } = require('../services/invoices/ksef/config');
const { encryptSecret, decryptSecret, fingerprint, hint, MASTER_KEY_ENV } = require('../services/invoices/ksef/secretStore');
const { rsaOaepSha256Encrypt, createSessionEncryption, encryptInvoiceXml } = require('../services/invoices/ksef/crypto');
const { generateFa3Xml, providerBlockers, divideDecimal, paymentMethodCode } = require('../services/invoices/ksef/fa3');

function sampleSnapshot(overrides = {}) {
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
        name: 'Towar & test', unit: 'szt.', quantity: '2', unitPrice: '10.00', priceBasis: 'net',
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
    notes: 'Test <FA3>',
    ...overrides,
  };
}

function run() {
  // Official KSeF environments and FA(3) form code contract.
  assert.equal(normalizeEnvironment('TEST'), 'test');
  assert.equal(ENVIRONMENTS.test.apiBaseUrl, 'https://api-test.ksef.mf.gov.pl/v2');
  assert.equal(ENVIRONMENTS.demo.apiBaseUrl, 'https://api-demo.ksef.mf.gov.pl/v2');
  assert.equal(ENVIRONMENTS.prod.apiBaseUrl, 'https://api.ksef.mf.gov.pl/v2');
  assert.deepEqual(KSEF_SCHEMA, { systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' });
  assert.equal(PUBLIC_KEY_USAGE.TOKEN, 'KsefTokenEncryption');
  assert.equal(PUBLIC_KEY_USAGE.SESSION, 'SymmetricKeyEncryption');

  // Secrets must be encrypted at rest and bound to connection + kind by AES-GCM AAD.
  process.env[MASTER_KEY_ENV] = 'stage3-test-only-ksef-master-key-0123456789abcdef';
  const encrypted = encryptSecret('ksef-secret-token', 'conn-1', 'ksef-token');
  assert.notEqual(encrypted.ciphertext, 'ksef-secret-token');
  assert.equal(decryptSecret(encrypted, 'conn-1', 'ksef-token'), 'ksef-secret-token');
  assert.throws(() => decryptSecret(encrypted, 'conn-2', 'ksef-token'), (error) => error?.code === 'ksef_secret_decrypt_failed');
  assert.equal(fingerprint('same'), fingerprint('same'));
  assert.notEqual(fingerprint('same'), fingerprint('different'));
  assert.equal(hint('0123456789'), '••••6789');

  // RSA-OAEP/SHA-256 round-trip — the same primitive used for KSeF token/session-key encryption.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const secret = Buffer.from('token|1789330000000', 'utf8');
  const rsaCiphertext = Buffer.from(rsaOaepSha256Encrypt(secret, publicKey), 'base64');
  const rsaPlaintext = crypto.privateDecrypt({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
  }, rsaCiphertext);
  assert.deepEqual(rsaPlaintext, secret);

  // AES-256-CBC + PKCS#7 round-trip and payload hashes/sizes.
  const session = createSessionEncryption(publicKey);
  assert.equal(session.symmetricKey.length, 32);
  assert.equal(session.initializationVector.length, 16);
  const xmlInput = '<Faktura>żółć &amp; test</Faktura>';
  const invoiceEncryption = encryptInvoiceXml(xmlInput, session.symmetricKey, session.initializationVector);
  const decipher = crypto.createDecipheriv('aes-256-cbc', session.symmetricKey, session.initializationVector);
  const decrypted = Buffer.concat([decipher.update(invoiceEncryption.encrypted), decipher.final()]).toString('utf8');
  assert.equal(decrypted, xmlInput);
  assert.equal(invoiceEncryption.invoiceSize, Buffer.byteLength(xmlInput, 'utf8'));
  assert.equal(invoiceEncryption.invoiceHash, crypto.createHash('sha256').update(Buffer.from(xmlInput)).digest('base64'));
  assert.equal(invoiceEncryption.encryptedInvoiceHash, crypto.createHash('sha256').update(invoiceEncryption.encrypted).digest('base64'));

  // FA(3) generation is deterministic for an immutable snapshot and uses the supported conservative subset.
  const snapshot = sampleSnapshot();
  assert.deepEqual(providerBlockers(snapshot), []);
  const generatedAt = '2026-09-13T20:00:00.000Z';
  const fa3a = generateFa3Xml(snapshot, { generatedAt });
  const fa3b = generateFa3Xml(snapshot, { generatedAt });
  assert.equal(fa3a, fa3b);
  assert.ok(fa3a.includes('xmlns="http://crd.gov.pl/wzor/2025/06/25/13775/"'));
  assert.ok(fa3a.includes('kodSystemowy="FA (3)" wersjaSchemy="1-0E"'));
  assert.ok(fa3a.includes('<WariantFormularza>3</WariantFormularza>'));
  assert.ok(fa3a.includes('<NIP>5260250995</NIP>'));
  assert.ok(fa3a.includes('<P_13_1>20.00</P_13_1><P_14_1>4.60</P_14_1>'));
  assert.ok(fa3a.includes('<P_13_2>10.00</P_13_2><P_14_2>0.80</P_14_2>'));
  assert.ok(fa3a.includes('<P_15>35.40</P_15>'));
  assert.ok(fa3a.includes('<FaWiersz><NrWierszaFa>1</NrWierszaFa>'));
  assert.ok(fa3a.includes('Towar &amp; test'));
  assert.ok(fa3a.includes('<P_9A>10</P_9A>'));
  assert.ok(fa3a.includes('<FormaPlatnosci>6</FormaPlatnosci>'));
  assert.ok(fa3a.includes('<NrZamowienia>143</NrZamowienia>'));
  assert.ok(fa3a.includes('Test &lt;FA3&gt;'));

  // Decimal helper and payment mapping remain deterministic and float-free.
  assert.equal(divideDecimal('10.00', '3', 8), '3.33333333');
  assert.equal(paymentMethodCode('przelew'), '6');
  assert.equal(paymentMethodCode('card'), '2');

  // Stage 3 fails closed instead of guessing unsupported legal/tax scenarios.
  assert.ok(providerBlockers({ ...snapshot, type: 'correction' }).includes('ksef_stage3_correction_not_supported'));
  assert.ok(providerBlockers({ ...snapshot, currency: 'EUR' }).includes('ksef_stage3_currency_not_supported'));
  assert.ok(providerBlockers({ ...snapshot, buyer: { ...snapshot.buyer, taxId: '1234567890' } }).includes('ksef_stage3_buyer_nip_invalid'));
  const unsupportedVat = sampleSnapshot({ items: [{ ...snapshot.items[0], vat: { code: '0', rate: '0' } }] });
  assert.ok(providerBlockers(unsupportedVat).some((item) => item.includes('vat_rate_not_supported')));

  console.log('Invoice KSeF Stage 3 pure contract passed');
}

run();

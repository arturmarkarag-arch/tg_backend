'use strict';

const { buildPdfVisualizationPayload } = require('../services/invoices/ksef/submissions');

const HASH = Buffer.alloc(32, 7).toString('base64');

function invoice() {
  return {
    _id: '66b6e4f0d8f7c2e5b62b1234',
    status: 'finalized',
    issueDate: '2026-09-14',
    seller: { taxId: '8876153218' },
  };
}

describe('KSeF PDF visualization metadata', () => {
  it('builds accepted online metadata from the immutable invoice artifact', () => {
    const result = buildPdfVisualizationPayload({
      invoice: invoice(),
      environment: 'test',
      artifact: { hashBase64: HASH, sha256Hex: 'a'.repeat(64), size: 1234 },
      submission: {
        mode: 'online',
        state: 'accepted',
        acceptedAt: new Date('2026-09-14T10:00:00.000Z'),
        providerData: { ksefNumber: '8876153218-20260914-ABCDEF123456-01' },
        receipt: { receivedAt: new Date('2026-09-14T10:01:00.000Z') },
      },
    });

    expect(result.nrKSeF).toBe('8876153218-20260914-ABCDEF123456-01');
    expect(result.watermark).toBe('');
    expect(result.hasUpo).toBe(true);
    expect(result.qrCode).toContain('https://qr-test.ksef.mf.gov.pl/invoice/8876153218/14-09-2026/');
    expect(result.qr2Code).toBe('');
    expect(result.xmlSha256Hex).toBe('a'.repeat(64));
  });

  it('preserves prepared offline QR I/II URLs', () => {
    const result = buildPdfVisualizationPayload({
      invoice: invoice(),
      environment: 'test',
      artifact: { hashBase64: HASH, sha256Hex: 'b'.repeat(64), size: 1234 },
      submission: {
        mode: 'offline24',
        state: 'prepared',
        providerData: {
          offline: {
            qrI: { url: 'https://qr-test.ksef.mf.gov.pl/invoice/offline-i' },
            qrII: { url: 'https://qr-test.ksef.mf.gov.pl/certificate/offline-ii' },
          },
        },
      },
    });

    expect(result.nrKSeF).toBe('PODGLĄD');
    expect(result.watermark).toBe('PODGLĄD');
    expect(result.qrCode).toBe('https://qr-test.ksef.mf.gov.pl/invoice/offline-i');
    expect(result.qr2Code).toBe('https://qr-test.ksef.mf.gov.pl/certificate/offline-ii');
  });
});

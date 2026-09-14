'use strict';

const mongoose = require('mongoose');
const InboundFiscalDocument = require('../models/InboundFiscalDocument');
const { publicInboundDocument } = require('../services/invoices/ksef/inboundDocuments');

describe('InboundFiscalDocument validation schema', () => {
  it('does not collide with the reserved Mongoose Document.errors property', async () => {
    const document = new InboundFiscalDocument({
      provider: 'ksef',
      legalEntityId: new mongoose.Types.ObjectId(),
      environment: 'test',
      sourceRole: 'buyer',
      sourceSyncId: 'stage10-test-sync',
      providerDocumentId: '5265877635-20250626-010080DD2B5E-26',
      providerArtifactHashBase64: Buffer.alloc(32).toString('base64'),
      metadata: { invoiceNumber: 'TEST/1/2026' },
      artifactState: 'pending_fetch',
      fetch: { state: 'pending', nextAttemptAt: new Date() },
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.validation.issues).toEqual([]);
    expect(document.validation.schemaName).toBe('');

    const publicValue = publicInboundDocument(document);
    expect(publicValue.validation.errors).toEqual([]);
    expect(publicValue.validation.schema).toBe('');
    expect(publicValue.validation.issues).toBeUndefined();
    expect(publicValue.validation.schemaName).toBeUndefined();
  });
});

'use strict';

const crypto = require('crypto');
const { createInvoiceSourceAdapter } = require('./contract');

module.exports = createInvoiceSourceAdapter({
  id: 'manual',
  name: 'Manual invoice',
  entityTypes: ['manual'],
  description: 'Operator/system supplied invoice draft. It still goes through the same Invoice Core normalization and finalization boundary.',
  buildDraft: async ({ sourceRef = {}, input = {} } = {}) => {
    const entityId = String(sourceRef.entityId || sourceRef.id || input.entityId || crypto.randomUUID()).trim();
    return {
      ...(input.draft || input),
      source: {
        ...((input.draft || input).source || {}),
        provider: 'manual',
        entityType: 'manual',
        entityId,
      },
    };
  },
});

'use strict';

const AllegroAccount = require('../models/AllegroAccount');

/**
 * Stage 3 architecture correction.
 *
 * Stage 1/2 temporarily stored baseLinkerAccountId on AllegroAccount. Allegro
 * is now a first-class independent provider, so that field must not survive as
 * misleading durable state. This migration is intentionally narrow and
 * idempotent: it only unsets the obsolete mapping and never touches UUID,
 * Allegro identity, OAuth credentials, enablement or synchronization state.
 *
 * syncIndexes() runs immediately afterwards and removes the obsolete
 * baseLinkerAccountId indexes that existed in the Stage 1/2 schema.
 */
async function migrateAllegroIndependentAccounts() {
  const result = await AllegroAccount.collection.updateMany(
    { baseLinkerAccountId: { $exists: true } },
    { $unset: { baseLinkerAccountId: '' } },
  );
  return { cleanedAccounts: Number(result?.modifiedCount || 0) };
}

module.exports = { migrateAllegroIndependentAccounts };

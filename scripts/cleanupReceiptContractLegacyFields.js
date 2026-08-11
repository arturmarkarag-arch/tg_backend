'use strict';

/**
 * Removes fields that belonged to the retired receipt/warehouse-shift contracts.
 *
 * DRY RUN (default):
 *   node scripts/cleanupReceiptContractLegacyFields.js
 *
 * APPLY:
 *   node scripts/cleanupReceiptContractLegacyFields.js --apply
 *
 * This script deliberately DOES NOT touch:
 *   - ReceiptItem.totalQty
 *   - ReceiptItem.name / ReceiptItem.aiDescription (background AI metadata)
 *   - current picking shift-board data (/api/picking/shift-board)
 */

const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}

const APPLY = process.argv.includes('--apply');

const RECEIPT_FIELDS = [
  'structure',
  'expectedQty',
  'shelfQty',
  'transitQty',
  'barcode',
  'existingProductId',
  'notes',
  'defectPhotoUrls',
  'warehousePending',
];

const USER_SHIFT_FIELDS = [
  'isWarehouseManager',
  'isOnShift',
  'shiftZone',
];

const existsAny = (fields) => ({
  $or: fields.map((field) => ({ [field]: { $exists: true } })),
});

const unsetAll = (fields) => Object.fromEntries(fields.map((field) => [field, '']));

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  const receiptItems = db.collection('receiptitems');
  const users = db.collection('users');

  console.log(`\nReceipt contract cleanup — ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`db=${db.databaseName} host=${mongoose.connection.host}`);

  const [receiptCount, userCount] = await Promise.all([
    receiptItems.countDocuments(existsAny(RECEIPT_FIELDS)),
    users.countDocuments(existsAny(USER_SHIFT_FIELDS)),
  ]);

  console.log(`ReceiptItem rows with legacy fields: ${receiptCount}`);
  console.log(`User rows with legacy shift fields: ${userCount}`);
  console.log(`Receipt fields to unset: ${RECEIPT_FIELDS.join(', ')}`);
  console.log(`User fields to unset: ${USER_SHIFT_FIELDS.join(', ')}`);
  console.log('Protected: ReceiptItem.totalQty, ReceiptItem.name, ReceiptItem.aiDescription');

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply after review.\n');
    return;
  }

  const [receiptResult, userResult] = await Promise.all([
    receiptCount
      ? receiptItems.updateMany(existsAny(RECEIPT_FIELDS), { $unset: unsetAll(RECEIPT_FIELDS) })
      : Promise.resolve({ modifiedCount: 0 }),
    userCount
      ? users.updateMany(existsAny(USER_SHIFT_FIELDS), { $unset: unsetAll(USER_SHIFT_FIELDS) })
      : Promise.resolve({ modifiedCount: 0 }),
  ]);

  console.log(`\nUpdated ReceiptItem rows: ${receiptResult.modifiedCount}`);
  console.log(`Updated User rows: ${userResult.modifiedCount}`);

  const [receiptLeft, userLeft] = await Promise.all([
    receiptItems.countDocuments(existsAny(RECEIPT_FIELDS)),
    users.countDocuments(existsAny(USER_SHIFT_FIELDS)),
  ]);

  if (receiptLeft !== 0 || userLeft !== 0) {
    throw new Error(`VERIFY failed: receipt legacy rows=${receiptLeft}, user legacy rows=${userLeft}`);
  }

  console.log('VERIFY PASS — legacy fields removed.\n');
}

main()
  .catch((err) => {
    console.error('\nERROR:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });

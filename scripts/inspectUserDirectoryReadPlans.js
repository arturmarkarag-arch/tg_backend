'use strict';

// Read-only post-deployment check. It never syncs indexes or writes documents.
const path = require('path');
const { MongoClient } = require('mongoose').mongo;
const { ASSIGNED_SELLER_FIELDS, ADMIN_USER_FIELDS } = require('../services/readModels/userDirectoryReadModel');
const projection = (fields) => Object.fromEntries(fields.split(' ').map((field) => [field, 1]));

async function main() {
  if (process.env.NODE_ENV !== 'production') require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const db = client.db();
    const users = db.collection('users');
    const shops = await db.collection('shops').find({ isActive: true }, { projection: { _id: 1 } }).limit(20).toArray();
    const cases = [
      ['assigned-to-visible-shops', { shopId: { $in: shops.map((shop) => shop._id) }, role: { $in: ['seller', 'admin'] } }, ASSIGNED_SELLER_FIELDS, { _id: 1 }, null],
      ['unassigned-candidates', { shopId: null, role: 'seller', accountState: { $ne: 'removed' } }, ASSIGNED_SELLER_FIELDS, { createdAt: -1, _id: -1 }, 20],
      ['seller-page', { role: 'seller', accountState: { $ne: 'removed' } }, ADMIN_USER_FIELDS, { createdAt: -1, _id: -1 }, 20],
      ['all-user-page', { accountState: { $ne: 'removed' } }, ADMIN_USER_FIELDS, { createdAt: -1, _id: -1 }, 20],
    ];
    console.log(JSON.stringify({ database: db.databaseName, indexes: await users.indexes() }, null, 2));
    for (const [name, filter, fields, sort, limit] of cases) {
      let cursor = users.find(filter, { projection: projection(fields) }).sort(sort);
      if (limit) cursor = cursor.limit(limit);
      const plan = await cursor.explain('executionStats');
      const stats = plan.executionStats || {};
      console.log(JSON.stringify({ name, nReturned: stats.nReturned, keysExamined: stats.totalKeysExamined, docsExamined: stats.totalDocsExamined, executionTimeMillis: stats.executionTimeMillis, winningPlan: plan.queryPlanner?.winningPlan }, null, 2));
    }
  } finally { await client.close(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });

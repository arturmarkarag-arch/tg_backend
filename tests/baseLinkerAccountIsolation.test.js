const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  getBaseLinkerAccountBinding,
  getBaseLinkerAccountScope,
  scopedSettingKey,
} = require('../services/baseLinkerAccount');
const BaseLinkerOrderCache = require('../models/BaseLinkerOrderCache');
const BaseLinkerPickingOrder = require('../models/BaseLinkerPickingOrder');
const BaseLinkerPrintJob = require('../models/BaseLinkerPrintJob');

describe('BaseLinker account identity', () => {
  it('never guesses account identity from token structure', () => {
    const first = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: '123-1-secret-a' });
    const regenerated = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: '123-999-secret-b' });
    const anotherAccount = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: '456-1-secret-a' });

    expect(first.source).toBe('token_fingerprint');
    expect(regenerated.accountScope).not.toBe(first.accountScope);
    expect(anotherAccount.accountScope).not.toBe(first.accountScope);
    expect(first.accountScope).not.toContain('123');
  });

  it('lets an explicit stable account key override token rotation and format', () => {
    const first = getBaseLinkerAccountBinding({
      BASELINKER_ACCOUNT_KEY: 'main-shop',
      BASELINKER_API_TOKEN: 'old-format',
    });
    const rotated = getBaseLinkerAccountBinding({
      BASELINKER_ACCOUNT_KEY: 'main-shop',
      BASELINKER_API_TOKEN: 'completely-new-format',
    });

    expect(first).toEqual(rotated);
    expect(first.source).toBe('configured');
  });

  it('fails closed for unknown token formats', () => {
    const first = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: 'opaque-a' });
    const rotated = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: 'opaque-b' });
    expect(first.source).toBe('token_fingerprint');
    expect(rotated.accountScope).not.toBe(first.accountScope);
  });
});

describe('BaseLinker model tenant boundary', () => {
  let mongod;
  let previousToken;
  let previousKey;

  beforeAll(async () => {
    previousToken = process.env.BASELINKER_API_TOKEN;
    previousKey = process.env.BASELINKER_ACCOUNT_KEY;
    delete process.env.BASELINKER_ACCOUNT_KEY;
    process.env.BASELINKER_API_TOKEN = '100-1-current';
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    await Promise.all([
      BaseLinkerOrderCache.syncIndexes(),
      BaseLinkerPickingOrder.syncIndexes(),
      BaseLinkerPrintJob.syncIndexes(),
    ]);
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongod) await mongod.stop();
    if (previousToken === undefined) delete process.env.BASELINKER_API_TOKEN;
    else process.env.BASELINKER_API_TOKEN = previousToken;
    if (previousKey === undefined) delete process.env.BASELINKER_ACCOUNT_KEY;
    else process.env.BASELINKER_ACCOUNT_KEY = previousKey;
  });

  beforeEach(async () => {
    process.env.BASELINKER_API_TOKEN = '100-1-current';
    const collection = mongoose.connection.db.collection(BaseLinkerOrderCache.collection.name);
    await collection.deleteMany({});
    const currentScope = getBaseLinkerAccountScope();
    const otherScope = getBaseLinkerAccountBinding({ BASELINKER_API_TOKEN: '200-1-other' }).accountScope;
    await collection.insertMany([
      { accountScope: currentScope, orderId: 'same-id', searchText: 'current', order: { order_id: 1 } },
      { accountScope: otherScope, orderId: 'same-id', searchText: 'other', order: { order_id: 1 } },
      { orderId: 'same-id', searchText: 'legacy', order: { order_id: 1 } },
    ]);
  });

  it('reads, aggregates, updates and deletes only inside the current account', async () => {
    expect(await BaseLinkerOrderCache.countDocuments({})).toBe(1);
    expect((await BaseLinkerOrderCache.find({}).lean()).map((row) => row.searchText)).toEqual(['current']);
    expect(await BaseLinkerOrderCache.aggregate([{ $count: 'count' }])).toEqual([{ count: 1 }]);

    await BaseLinkerOrderCache.updateMany({}, { $set: { searchText: 'changed' } });
    const raw = mongoose.connection.db.collection(BaseLinkerOrderCache.collection.name);
    expect(await raw.countDocuments({ searchText: 'changed' })).toBe(1);

    await BaseLinkerOrderCache.deleteMany({});
    expect(await raw.countDocuments({})).toBe(2);
    expect(await raw.countDocuments({ accountScope: { $exists: false } })).toBe(1);
  });

  it('switches settings and records to a different namespace when account changes', async () => {
    const currentScope = getBaseLinkerAccountScope();
    process.env.BASELINKER_API_TOKEN = '200-7-rotated';
    const otherScope = getBaseLinkerAccountScope();

    expect(otherScope).not.toBe(currentScope);
    expect(scopedSettingKey('baselinker.queueSettings.v1', otherScope))
      .not.toBe(scopedSettingKey('baselinker.queueSettings.v1', currentScope));
    expect((await BaseLinkerOrderCache.find({}).lean()).map((row) => row.searchText)).toEqual(['other']);
  });

  it('declares compound account-aware uniqueness for all persisted BaseLinker state', () => {
    const cacheIndexes = BaseLinkerOrderCache.schema.indexes();
    const pickingIndexes = BaseLinkerPickingOrder.schema.indexes();
    const printIndexes = BaseLinkerPrintJob.schema.indexes();
    expect(cacheIndexes).toContainEqual([{ accountScope: 1, orderId: 1 }, expect.objectContaining({ unique: true })]);
    expect(pickingIndexes).toContainEqual([{ accountScope: 1, orderId: 1 }, expect.objectContaining({ unique: true })]);
    expect(pickingIndexes.some(([keys]) => Object.prototype.hasOwnProperty.call(keys, 'claimKey'))).toBe(false);
    expect(printIndexes.some(([keys]) => keys.accountScope === 1 && keys.targetAgentId === 1)).toBe(true);
  });
});

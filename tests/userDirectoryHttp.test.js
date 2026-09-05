'use strict';

// Real Express routes, authentication/role guards, query construction and DTOs.
// The Mongo boundary below is an in-memory fixture (not a Mongo/live test).
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const path = require('path');
process.env.JWT_SECRET = 'isolated-user-directory-test-secret';
const User = require('../models/User');
const Shop = require('../models/Shop');
const City = require('../models/City');
const GroupMember = require('../models/GroupMember');
const Order = require('../models/Order');
const ClearedCart = require('../models/ClearedCart');
const { errorHandler } = require('../utils/errors');
const { signSession } = require('../utils/jwt');
const { telegramAuth } = require('../middleware/telegramAuth');
const calls = [];
let rows;

function stub(rel, exports) {
  const file = require.resolve(path.join(__dirname, '..', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const assign = vi.fn(async ({ telegramId, shopId }) => {
  rows.User.find((user) => user.telegramId === telegramId).shopId = shopId;
  return {};
});
stub('services/shopAssignmentCommand', {
  assignUserToShopCommand: assign,
  unassignUserFromShopCommand: async ({ telegramId }) => assign({ telegramId, shopId: null }),
  buildInitialAssignmentTransition: () => ({}), publishShopAssignmentTransition: async () => {},
});
stub('services/softRemoveUser', { softRemoveUser: vi.fn() });
stub('services/migrateSellerShop', { migrateSellerShop: vi.fn() });
stub('services/unassignSeller', { unassignSellerAndPark: vi.fn() });
stub('services/shopTopologyCommand', { updateShopTopologyCommand: vi.fn() });
stub('socket', { getIO: () => null });
stub('utils/cache', { get: async () => null, set: async () => {}, KEYS: { CITIES: 'cities' } });
stub('utils/modelCache', { invalidateShop: async () => {} });

const app = express();
app.use(express.json());
app.use('/api/users', require('../routes/users'));
app.use('/api/shops', telegramAuth, require('../routes/shops'));
app.use(errorHandler);

const oid = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const cityA = oid(1), cityB = oid(2), shopA = oid(3), shopB = oid(4), groupA = oid(5), groupB = oid(6);
const valueAt = (row, field) => field.split('.').reduce((value, part) => value?.[part], row);
const scalar = (value) => value && typeof value === 'object' && value._bsontype === 'ObjectId' ? String(value) : value;
const equal = (left, right) => right instanceof RegExp ? right.test(left || '') : scalar(left) === scalar(right) || (left == null && right == null);
function matches(row, filter) {
  return Object.entries(filter).every(([field, test]) => {
    if (field === '$and') return test.every((part) => matches(row, part));
    if (field === '$or') return test.some((part) => matches(row, part));
    const value = valueAt(row, field);
    if (test && typeof test === 'object' && !(test instanceof RegExp) && !test._bsontype) {
      return Object.entries(test).every(([op, expected]) => {
        if (op === '$in') return expected.some((entry) => equal(value, entry));
        if (op === '$nin') return !expected.some((entry) => equal(value, entry));
        if (op === '$ne') return !equal(value, expected);
        if (op === '$exists') return (value !== undefined) === expected;
        throw new Error(`Unimplemented fixture operator ${op}`);
      });
    }
    return equal(value, test);
  });
}
function select(row, fields) {
  if (!fields) return { ...row };
  const out = { _id: row._id };
  for (const field of fields.split(/\s+/)) {
    const parts = field.split('.');
    const value = valueAt(row, field);
    if (value === undefined) continue;
    let target = out;
    for (const part of parts.slice(0, -1)) target = target[part] ||= {};
    target[parts.at(-1)] = value;
  }
  return out;
}
function query(model, filter = {}, fields, single = false) {
  const call = { model, filter, projection: fields, sort: null, skip: 0, limit: Infinity, populate: false };
  const run = () => {
    calls.push({ ...call });
    let found = rows[model].filter((row) => matches(row, filter));
    if (call.sort) found.sort((a, b) => {
      for (const [field, direction] of Object.entries(call.sort)) {
        const av = scalar(valueAt(a, field)), bv = scalar(valueAt(b, field));
        if (av > bv) return direction;
        if (av < bv) return -direction;
      }
      return 0;
    });
    found = found.slice(call.skip, call.skip + call.limit).map((row) => select(row, call.projection));
    if (call.populate) found = found.map((row) => ({ ...row, cityId: rows.City.find((city) => equal(city._id, row.cityId)) || null }));
    return single ? found[0] || null : found;
  };
  const chain = {
    select: (fields) => { call.projection = fields; return chain; },
    sort: (sort) => { call.sort = sort; return chain; },
    skip: (skip) => { call.skip = skip; return chain; },
    limit: (limit) => { call.limit = limit; return chain; },
    populate: () => { call.populate = true; return chain; },
    lean: async () => run(),
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  };
  return chain;
}
const auth = (tid = 'admin') => ({ Authorization: `Bearer ${signSession(tid)}` });
const forbidden = ['cartState', 'history', 'googleSub', 'sessionsValidFrom', 'permissions', 'isWarehouseManager', 'isOnline', 'lastActive', 'miniAppState', 'lastOrderAt', 'cartItemCount'];
function expectNarrow(row) { for (const field of forbidden) expect(row).not.toHaveProperty(field); }

beforeEach(() => {
  calls.length = 0;
  assign.mockClear();
  rows = {
    City: [{ _id: cityA, name: 'Жешув' }, { _id: cityB, name: 'Познань' }],
    Shop: [
      { _id: shopA, name: 'Магазин А', cityId: cityA, deliveryGroupId: String(groupA), isActive: true },
      { _id: shopB, name: 'Магазин Б', cityId: cityB, deliveryGroupId: String(groupB), isActive: true },
    ],
    User: Array.from({ length: 600 }, (_, i) => ({
      _id: oid(1000 + i), telegramId: String(800000000 + i), firstName: `Вільний${i}`, lastName: 'Продавець',
      role: 'seller', shopId: null, accountState: i === 0 ? undefined : 'active', createdAt: new Date('2026-01-01'),
      cartState: { orderItems: { secret: 6 } }, history: [{ secret: 'legacy' }], googleSub: 'private', sessionsValidFrom: null,
      permissions: { baseLinkerPicking: true }, isWarehouseManager: true, isOnline: false, lastActive: new Date(),
    })),
    GroupMember: [{ _id: oid(9999), telegramId: 'late', username: 'late_seller', statusCheckedAt: new Date() }],
    Order: [], ClearedCart: [{ _id: oid(9000), ownerTelegramId: 'late', orderItems: { [String(oid(7000))]: 5 }, clearedAt: new Date() }],
  };
  rows.User.push(
    { _id: oid(10), telegramId: 'admin', firstName: 'Admin', role: 'admin', shopId: shopA },
    { _id: oid(11), telegramId: 'late', firstName: 'Пізній', lastName: 'Продавець', role: 'seller', shopId: shopA, createdAt: new Date('2020-01-01') },
    { _id: oid(12), telegramId: 'other', firstName: 'Олена', lastName: 'Іваненко', role: 'seller', shopId: shopB, phoneNumber: '+48123456789' },
    { _id: oid(13), telegramId: 'removed', role: 'seller', shopId: null, accountState: 'removed' },
    { _id: oid(14), telegramId: 'warehouse', role: 'warehouse', shopId: null },
  );
  for (const [name, Model] of Object.entries({ User, Shop, City, GroupMember, Order, ClearedCart })) {
    vi.spyOn(Model, 'find').mockImplementation((filter, fields) => query(name, filter, fields));
    vi.spyOn(Model, 'findOne').mockImplementation((filter, fields) => query(name, filter, fields, true));
    vi.spyOn(Model, 'findById').mockImplementation((id, fields) => query(name, { _id: id }, fields, true));
    vi.spyOn(Model, 'countDocuments').mockImplementation(async (filter) => rows[name].filter((row) => matches(row, filter)).length);
    vi.spyOn(Model, 'distinct').mockImplementation(async (field, filter) => [...new Set(rows[name].filter((row) => matches(row, filter)).map((row) => valueAt(row, field)))]);
  }
  vi.spyOn(User, 'aggregate').mockResolvedValue([]); // historical ex-seller enrichment only
  vi.spyOn(Order, 'aggregate').mockImplementation(() => { throw new Error('Unexpected order statistics read'); });
});
afterEach(() => vi.restoreAllMocks());

describe('user directory HTTP contracts', () => {
  it('returns all assigned identities from the requested shop independently of 600 other sellers', async () => {
    const result = await request(app).get('/api/shops').query({ page: 1, pageSize: 1 }).set(auth()).expect(200);
    const shop = result.body.shops[0];
    expect(shop.sellers.map((seller) => seller.telegramId).sort()).toEqual(['admin', 'late']);
    expect(shop.sellers.find((seller) => seller.telegramId === 'late').telegramUsername).toBe('late_seller');
    shop.sellers.forEach(expectNarrow);
    expect(calls.find((call) => call.model === 'User' && call.filter.shopId)).toMatchObject({ filter: { shopId: { $in: [shopA] } } });
    expect(Order.aggregate).not.toHaveBeenCalled();
  });

  it('paginates unassigned sellers with a stable tie break and includes missing legacy accountState', async () => {
    const fetch = (page) => request(app).get('/api/users/assignment-candidates').query({ shopId: String(shopA), scope: 'unassigned', page, pageSize: 20 }).set(auth()).expect(200);
    const first = (await fetch(1)).body, second = (await fetch(2)).body;
    expect(first.total).toBe(600);
    expect(first.pageCount).toBe(30);
    expect(first.users).toHaveLength(20);
    expect(new Set([...first.users, ...second.users].map((user) => user._id)).size).toBe(40);
    expect(first.users.some((user) => ['admin', 'removed', 'late', 'warehouse'].includes(user.telegramId))).toBe(false);
    first.users.forEach(expectNarrow);
    expect(first.users[0]).not.toHaveProperty('googleEmail');
    expect(calls.filter((call) => call.model === 'User' && call.filter.role === 'seller').every((call) => call.limit === 20 && !call.projection.includes('cartState'))).toBe(true);
    expect(Order.aggregate).not.toHaveBeenCalled();
  });

  it.each(['Олена Іваненко', 'Познань', '+48123456789', 'Магазин Б'])('searches identity and current shop on the server: %s', async (search) => {
    const result = await request(app).get('/api/users/assignment-candidates').query({ shopId: String(shopA), scope: 'all', search }).set(auth()).expect(200);
    expect(result.body.users.map((user) => user.telegramId)).toContain('other');
  });

  it('uses telegramUsername for username search and excludes the current shop from candidates', async () => {
    const query = { shopId: String(shopB), scope: 'all', search: '@late_seller' };
    const response = await request(app).get('/api/users/assignment-candidates').query(query).set(auth()).expect(200);
    expect(response.body.users).toHaveLength(1);
    expect(response.body.users[0].telegramUsername).toBe('late_seller');
    const same = await request(app).get('/api/users/assignment-candidates').query({ ...query, shopId: String(shopA) }).set(auth()).expect(200);
    expect(same.body.users).toHaveLength(0);
  });

  it('intersects city and delivery-group filters and caps the admin page size', async () => {
    const none = await request(app).get('/api/users').query({ cityId: String(cityA), deliveryGroupId: String(groupB) }).set(auth()).expect(200);
    expect(none.body.total).toBe(0);
    const page = await request(app).get('/api/users?pageSize=500').set(auth()).expect(200);
    expect(page.body.users).toHaveLength(100);
    page.body.users.forEach(expectNarrow);
    expect(Order.aggregate).not.toHaveBeenCalled();
  });

  it('reads only reference shops without seller or order joins', async () => {
    const result = await request(app).get('/api/shops/reference?includeInactive=true').set(auth()).expect(200);
    expect(result.body).toHaveLength(2);
    expect(Object.keys(result.body[0]).sort()).toEqual(['_id', 'name', 'address', 'cityId', 'city', 'deliveryGroupId', 'isActive'].sort());
    expect(calls.filter((call) => call.model === 'User').every((call) => call.filter.telegramId === 'admin')).toBe(true);
    expect(User.aggregate).not.toHaveBeenCalled();
    expect(Order.aggregate).not.toHaveBeenCalled();
  });

  it('keeps non-staff shop reads minimal and enforces admin-only candidate access', async () => {
    await request(app).get('/api/users/assignment-candidates').set(auth('warehouse')).expect(403);
    await request(app).get('/api/users/assignment-candidates').set(auth('late')).expect(403);
    await request(app).get('/api/users/assignment-candidates').expect(401);
    const shops = await request(app).get('/api/shops').set(auth('late')).expect(200);
    expect(shops.body[0]).not.toHaveProperty('sellers');
    await request(app).get('/api/shops/reference').set(auth('late')).expect(403);
  });

  it('delegates assignments to the canonical command and returns a narrow user response', async () => {
    const response = await request(app).patch('/api/users/late/shop').send({ shopId: String(shopB) }).set(auth()).expect(200);
    expect(assign).toHaveBeenCalledWith(expect.objectContaining({ telegramId: 'late', shopId: String(shopB) }));
    expect(response.body.shopId).toBe(String(shopB));
    expect(response.body.shopName).toBe('Магазин Б');
    expectNarrow(response.body);
  });

  it('does not claim a legacy cleared-cart snapshot was restored or write to User', async () => {
    const write = vi.spyOn(User, 'updateOne');
    const history = await request(app).get('/api/users/late/cleared-carts').set(auth()).expect(200);
    expect(history.body[0]).toMatchObject({ restorable: false, itemCount: 1 });
    const result = await request(app).post(`/api/users/late/cleared-carts/${oid(9000)}/restore`).set(auth()).send({ mode: 'replace' }).expect(409);
    expect(result.body.error).toBe('cleared_cart_legacy_unrestorable');
    expect(write).not.toHaveBeenCalled();
    expect(rows.ClearedCart[0].restoredAt).toBeUndefined();
  });

  it.each([
    '/api/users?activityFilter=no_cart', '/api/users?cityId=invalid', '/api/users?page=-1',
    '/api/users/assignment-candidates?shopId=invalid',
    `/api/users/assignment-candidates?shopId=${shopA}&scope=all&search=A`,
    `/api/users/assignment-candidates?shopId=${shopA}&scope=unknown`,
  ])('rejects invalid or retired query inputs: %s', async (url) => {
    await request(app).get(url).set(auth()).expect(400);
  });
});

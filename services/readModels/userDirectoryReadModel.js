'use strict';

const mongoose = require('mongoose');
const User = require('../../models/User');
const Shop = require('../../models/Shop');
const City = require('../../models/City');
const GroupMember = require('../../models/GroupMember');
const { getTelegramUsernameMap } = require('../../utils/telegramUsername');
const { appError } = require('../../utils/errors');

// Positive projections AND explicit serializers: lean() can otherwise expose
// retired fields still physically present in Mongo, even outside the schema.
const ASSIGNED_SELLER_FIELDS = '_id telegramId firstName lastName role phoneNumber shopId accountState botBlocked';
const ADMIN_USER_FIELDS = `${ASSIGNED_SELLER_FIELDS} shopNumber googleEmail createdAt updatedAt`;
const REFERENCE_SHOP_FIELDS = '_id name address cityId deliveryGroupId isActive';
const SETTINGS_SHOP_FIELDS = `${REFERENCE_SHOP_FIELDS} lastSeller.telegramId lastSeller.firstName lastSeller.lastName lastSeller.unassignedAt lastSellerChangedAt createdAt updatedAt`;

const id = (value) => value == null ? null : String(value._id || value);

function toAssignedSeller(user, username = '') {
  return {
    _id: id(user._id),
    telegramId: String(user.telegramId || ''),
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    role: user.role,
    phoneNumber: user.phoneNumber || '',
    shopId: id(user.shopId),
    accountState: user.accountState || 'active',
    botBlocked: user.botBlocked === true,
    telegramUsername: username,
  };
}

function toReferenceShop(shop) {
  return {
    _id: id(shop._id),
    name: shop.name || '',
    address: shop.address || '',
    cityId: id(shop.cityId),
    city: shop.cityId?.name || '',
    deliveryGroupId: String(shop.deliveryGroupId || ''),
    isActive: shop.isActive !== false,
  };
}

function toSettingsShop(shop) {
  const last = shop.lastSeller;
  return {
    ...toReferenceShop(shop),
    lastSeller: last ? {
      telegramId: last.telegramId || null,
      firstName: last.firstName || '',
      lastName: last.lastName || '',
      unassignedAt: last.unassignedAt || null,
    } : null,
    lastSellerChangedAt: shop.lastSellerChangedAt || null,
    createdAt: shop.createdAt,
    updatedAt: shop.updatedAt,
  };
}

async function buildUserDirectoryRows(users, { candidates = false } = {}) {
  if (!users.length) return [];
  const tids = users.map((user) => String(user.telegramId || '')).filter(Boolean);
  const shopIds = [...new Set(users.map((user) => id(user.shopId)).filter(Boolean))];
  const unassignedTids = candidates ? users.filter((user) => !user.shopId).map((user) => String(user.telegramId)) : [];
  const [usernames, shops, lastShops] = await Promise.all([
    getTelegramUsernameMap(tids),
    shopIds.length ? Shop.find({ _id: { $in: shopIds } }).select(REFERENCE_SHOP_FIELDS).populate('cityId', 'name').lean() : [],
    unassignedTids.length ? Shop.find({ 'lastSeller.telegramId': { $in: unassignedTids } })
      .select('name lastSeller.telegramId lastSeller.unassignedAt')
      .sort({ 'lastSeller.unassignedAt': -1, _id: 1 }).lean() : [],
  ]);
  const byShop = new Map(shops.map((shop) => [id(shop._id), toReferenceShop(shop)]));
  const lastByTid = new Map();
  for (const shop of lastShops) {
    const tid = String(shop.lastSeller?.telegramId || '');
    if (!lastByTid.has(tid)) lastByTid.set(tid, shop.name || '');
  }
  return users.map((user) => {
    const shop = byShop.get(id(user.shopId));
    const row = {
      ...toAssignedSeller(user, usernames.get(String(user.telegramId)) || ''),
      shopName: shop?.name || '',
      shopCity: shop?.city || '',
      shopDeliveryGroupId: shop?.deliveryGroupId || '',
    };
    return candidates ? { ...row, lastShopName: lastByTid.get(String(user.telegramId)) || '' } : {
      ...row,
      shopCityId: shop?.cityId || null,
      shopNumber: user.shopNumber || '',
      googleEmail: user.googleEmail || '',
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  });
}

async function readAdminUser(telegramId) {
  const user = await User.findOne({ telegramId }).select(ADMIN_USER_FIELDS).lean();
  if (!user) throw appError('user_not_found');
  return (await buildUserDirectoryRows([user]))[0];
}

function parsePage(query, maxPageSize = 100) {
  const positive = (value, fallback, field) => {
    if (value == null) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw appError('validation_failed', { field });
    }
    return Number(value);
  };
  const page = positive(query.page, 1, 'page');
  const pageSize = Math.min(maxPageSize, positive(query.pageSize, 20, 'pageSize'));
  if (!Number.isSafeInteger((page - 1) * pageSize)) throw appError('validation_failed', { field: 'page' });
  return { page, pageSize };
}

function parseSearch(value) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > 128) throw appError('validation_failed', { field: 'search' });
  const search = value.trim();
  if (search.split(/\s+/).length > 8) throw appError('validation_failed', { field: 'search' });
  return search;
}

function optionalObjectId(value, field) {
  if (value == null || value === '' || value === 'all') return null;
  if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw appError('validation_failed', { field });
  return new mongoose.Types.ObjectId(value);
}

// AND across words, OR across identity/contact/current-shop fields. Username
// search uses the same GroupMember source as the returned telegramUsername.
async function buildUserSearchClauses(search) {
  if (!search) return [];
  const tokens = search.split(/\s+/);
  const regexes = tokens.map((token) => new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  const cities = await City.find({ name: { $in: regexes } }).select('_id name').lean();
  const shops = await Shop.find({ $or: [
    { name: { $in: regexes } }, { address: { $in: regexes } },
    { cityId: { $in: cities.map((city) => city._id) } },
  ] }).select('_id name address cityId').lean();
  const usernameMatches = await Promise.all(tokens.map((token) => {
    const raw = token.replace(/^@/, '');
    if (!raw || !/^[A-Za-z0-9_]+$/.test(raw)) return [];
    return GroupMember.distinct('telegramId', { username: new RegExp(raw, 'i') });
  }));
  return regexes.map((re, index) => {
    const cityIds = new Set(cities.filter((city) => re.test(city.name)).map((city) => id(city._id)));
    const shopIds = shops.filter((shop) => re.test(shop.name || '') || re.test(shop.address || '') || cityIds.has(id(shop.cityId)))
      .map((shop) => shop._id);
    return { $or: [
      { firstName: re }, { lastName: re }, { phoneNumber: re }, { telegramId: re }, { shopNumber: re },
      ...(shopIds.length ? [{ shopId: { $in: shopIds } }] : []),
      ...(usernameMatches[index].length ? [{ telegramId: { $in: usernameMatches[index] } }] : []),
    ] };
  });
}

async function readUserPage(filter, { page, pageSize }, { candidates = false } = {}) {
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).select(candidates ? ASSIGNED_SELLER_FIELDS : ADMIN_USER_FIELDS)
      .sort({ createdAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
  ]);
  return {
    users: await buildUserDirectoryRows(users, { candidates }),
    total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

module.exports = {
  ASSIGNED_SELLER_FIELDS, ADMIN_USER_FIELDS, REFERENCE_SHOP_FIELDS, SETTINGS_SHOP_FIELDS,
  toAssignedSeller, toReferenceShop, toSettingsShop, buildUserDirectoryRows,
  readAdminUser, parsePage, parseSearch, optionalObjectId, buildUserSearchClauses, readUserPage,
};

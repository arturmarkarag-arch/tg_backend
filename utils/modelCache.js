'use strict';

/**
 * Hot-lookup cache for Shop and DeliveryGroup.
 *
 * Both are read hundreds of times per minute (migrateSellerShop, buyerSnapshot,
 * handleBotBlocked, registration, picking dashboards) and almost never change.
 * Caching them in Redis with a short TTL and invalidating on PATCH/DELETE cuts
 * dramatic load off MongoDB.
 *
 * - L2 TTL: 5 minutes (Redis). L1 (per-process) inherits from utils/cache.js (60 s).
 * - Stored shape: lean JSON. For Shop we ALSO populate cityId.name so consumers
 *   that need `shop.cityId.name` keep working without an extra Mongo round-trip.
 * - Invalidation: call `invalidateShop(id)` / `invalidateDeliveryGroup(id)` after
 *   any write to that document; the pub/sub channel in utils/cache.js fans out
 *   to all workers.
 */

const cache = require('./cache');
const Shop = require('../models/Shop');
const DeliveryGroup = require('../models/DeliveryGroup');

const SHOP_TTL_SEC  = 5 * 60;
const GROUP_TTL_SEC = 5 * 60;

function shopKey(id)  { return `shop:${String(id)}`; }
function groupKey(id) { return `dg:${String(id)}`; }

async function getShop(id) {
  if (!id) return null;
  const key = shopKey(id);
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const shop = await Shop.findById(id).populate('cityId', 'name').lean();
  if (!shop) return null;

  // Normalise so the cached value is JSON-clean (cityId becomes {_id, name})
  const value = { ...shop };
  if (value._id) value._id = String(value._id);
  if (value.cityId && typeof value.cityId === 'object') {
    value.cityId = {
      _id: value.cityId._id ? String(value.cityId._id) : null,
      name: value.cityId.name || '',
    };
  }
  await cache.set(key, value, SHOP_TTL_SEC);
  return value;
}

async function getDeliveryGroup(id) {
  if (!id) return null;
  const key = groupKey(id);
  const cached = await cache.get(key);
  if (cached !== null) return cached;

  const group = await DeliveryGroup.findById(id).lean();
  if (!group) return null;
  const value = { ...group };
  if (value._id) value._id = String(value._id);
  await cache.set(key, value, GROUP_TTL_SEC);
  return value;
}

async function invalidateShop(id) {
  if (id) await cache.invalidate(shopKey(id));
}

async function invalidateDeliveryGroup(id) {
  if (id) await cache.invalidate(groupKey(id));
}

module.exports = {
  getShop,
  getDeliveryGroup,
  invalidateShop,
  invalidateDeliveryGroup,
};

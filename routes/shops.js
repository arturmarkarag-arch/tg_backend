const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { appError, asyncHandler } = require('../utils/errors');
const Shop = require('../models/Shop');
const City = require('../models/City');
const DeliveryGroup = require('../models/DeliveryGroup');
const User = require('../models/User');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('../middleware/telegramAuth');
const cache = require('../utils/cache');
const { invalidateShop } = require('../utils/modelCache');
const { migrateSellerShop } = require('../services/migrateSellerShop');
const { unassignSellerAndPark } = require('../services/unassignSeller');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');
const { isOrderingOpen } = require('../utils/orderingSchedule');
const { getOrderingSchedule } = require('../utils/getOrderingSchedule');
const { getOrCreateSessionId } = require('../utils/getOrCreateSession');

const router = express.Router();

// Public / non-staff projection of a shop — ONLY the fields registration and a
// shop-picker need. Carries NO seller personal data (name/phone/telegramId/cart/
// history). Used by the public /registry endpoint and the non-staff branch of GET /.
function toMinimalShop(s) {
  return {
    _id: s._id,
    name: s.name,
    address: s.address || '',
    cityId: s.cityId?._id ? String(s.cityId._id) : (s.cityId || null),
    city: s.cityId?.name || '',
    deliveryGroupId: s.deliveryGroupId ? String(s.deliveryGroupId) : '',
    isActive: s.isActive,
  };
}

// ─── GET /api/shops ──────────────────────────────────────────────────────────
// Список магазинів. За замовчуванням тільки активні. Requires auth (mounted
// behind the global telegramAuth gate). Seller PII is returned ONLY to staff
// (admin/warehouse); every other authenticated role gets the minimal projection.
// Public registration uses GET /api/shops/registry instead.
// Query: ?cityId=xxx  ?deliveryGroupId=xxx  ?includeInactive=true
router.get('/', asyncHandler(async (req, res) => {
    const filter = {};

    if (req.query.includeInactive !== 'true') {
      filter.isActive = true;
    }
    if (req.query.cityId) {
      filter.cityId = req.query.cityId;
    }
    if (req.query.deliveryGroupId) {
      filter.deliveryGroupId = req.query.deliveryGroupId;
    }
    // Name search — staff Shops tab only; harmless no-op for legacy callers that
    // never pass it.
    if (req.query.search?.trim()) {
      const re = new RegExp(req.query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.name = re;
    }

    // Pagination is opt-in: only when ?page is present. Legacy callers
    // (reassign modal, transfer-override shop picker, registration) pass no
    // ?page and keep getting the full array — unchanged behaviour.
    const paginate = req.query.page != null;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));

    // Sort: most-recently-changed seller assignment first (missing → last),
    // then alphabetical. Mirrors the previous client-side order.
    const SHOP_SORT = { lastSellerChangedAt: -1, name: 1 };

    let total = null;
    let query = Shop.find(filter).populate('cityId', 'name country').sort(SHOP_SORT);
    if (paginate) {
      total = await Shop.countDocuments(filter);
      query = query.skip((page - 1) * pageSize).limit(pageSize);
    }
    const shops = await query.lean();

    const envelope = (data) => paginate
      ? { shops: data, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
      : data;

    // Seller PII is STAFF-ONLY. Sellers (and any other non-staff authenticated
    // role) get a minimal shop list with no personal data.
    if (!['admin', 'warehouse'].includes(req.telegramUser?.role)) {
      return res.json(envelope(shops.map(toMinimalShop)));
    }

    // Sellers per shop — full data so the Shops tab can render cart/activity
    // status and phone without a separate /users round-trip. NOTE: `history` is
    // deliberately NOT selected here — it can be large and the "previously
    // assigned" feature is computed server-side below (lastExSellers) instead of
    // shipping every seller's full history to the client.
    const shopIds = shops.map((s) => s._id);
    const sellers = await User.find({ role: { $in: ['seller', 'admin'] }, shopId: { $in: shopIds } })
      .select('shopId firstName lastName telegramId role phoneNumber cartState miniAppState')
      .lean();

    // Compute cartItemCount + lastOrderAt the same way GET /users does, so the
    // client treats both responses identically.
    const getCartCount = (u) => {
      const items = u.cartState?.orderItems;
      if (!items) return 0;
      const obj = items instanceof Map ? Object.fromEntries(items) : items;
      return Object.values(obj).reduce((s, q) => s + (Number(q) || 0), 0);
    };
    const sellerTids = sellers.map((s) => s.telegramId).filter(Boolean);
    const lastOrders = sellerTids.length
      ? await Order.aggregate([
        { $match: { buyerTelegramId: { $in: sellerTids } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$buyerTelegramId', lastOrderAt: { $first: '$createdAt' } } },
      ])
      : [];
    const lastOrderMap = new Map(lastOrders.map((o) => [o._id, o.lastOrderAt]));

    const sellersByShop = {};   // shopId → full seller objects (UI cards)
    const sellerNamesByShop = {}; // shopId → display-name strings (legacy)
    for (const s of sellers) {
      const sid = String(s.shopId);
      if (!sellersByShop[sid]) sellersByShop[sid] = [];
      if (!sellerNamesByShop[sid]) sellerNamesByShop[sid] = [];
      sellersByShop[sid].push({
        ...s,
        cartItemCount: getCartCount(s),
        lastOrderAt: lastOrderMap.get(s.telegramId) || null,
      });
      const label = [s.firstName, s.lastName].filter(Boolean).join(' ') || String(s.telegramId);
      sellerNamesByShop[sid].push(s.role === 'admin' ? `${label} (адмін)` : label);
    }

    // "Previously assigned" (last 2 ex-sellers) per shop — computed server-side
    // for just the shops in this response so we never ship full history arrays.
    const lastExByShopName = await computeLastExSellersByShopName(shops);

    // Active order flags — only when filtered by deliveryGroupId (for reassign modal)
    const activeOrderShopIds = new Set();
    if (req.query.deliveryGroupId) {
      const activeOrders = await Order.find({
        status: { $in: ['new', 'in_progress'] },
        'buyerSnapshot.deliveryGroupId': req.query.deliveryGroupId,
      }).select('shopId').lean();
      for (const o of activeOrders) {
        if (o.shopId) activeOrderShopIds.add(String(o.shopId));
      }
    }

    const result = shops.map((s) => {
      const sid = String(s._id);
      const shopSellers = sellersByShop[sid] || [];
      const shopSellerNames = sellerNamesByShop[sid] || [];
      return {
        ...s,
        cityId: s.cityId?._id ? String(s.cityId._id) : (s.cityId || null),
        city: s.cityId?.name || '',
        sellerCount: shopSellers.length,
        sellerNames: shopSellerNames,
        sellers: shopSellers,
        lastExSellers: lastExByShopName[s.name] || [],
        hasActiveOrder: activeOrderShopIds.has(sid),
      };
    });

    res.json(envelope(result));
}));

// Build a { shopName → [{ telegramId, firstName, lastName }] (top 2) } map of the
// most-recent ex-sellers for the given shops. Mirrors the old client-side logic
// (ShopsTab.lastExSellersByShopName): sources are sellers' `history` entries that
// point away from the shop (action 'shop_changed', meta.fromShop === name) plus
// the shop's own `lastSeller` snapshot. Only loads sellers whose history touches
// one of these shops, so it scales with the page, not the whole user table.
async function computeLastExSellersByShopName(shops) {
  const shopNames = shops.map((s) => s.name).filter(Boolean);
  const map = {}; // shopName → { telegramId → { seller, at } }
  if (shopNames.length) {
    const exSellers = await User.find({
      role: { $in: ['seller', 'admin'] },
      history: { $elemMatch: { action: 'shop_changed', 'meta.fromShop': { $in: shopNames } } },
    }).select('firstName lastName telegramId history').lean();

    for (const s of exSellers) {
      if (!Array.isArray(s.history)) continue;
      for (const h of s.history) {
        if (h.action !== 'shop_changed' || !h.meta?.fromShop) continue;
        const key = h.meta.fromShop;
        if (!shopNames.includes(key)) continue;
        const at = h.at ? new Date(h.at) : null;
        const tid = s.telegramId;
        if (!map[key]) map[key] = {};
        const existing = map[key][tid];
        if (!existing || (at && at > existing.at)) {
          map[key][tid] = {
            seller: { telegramId: s.telegramId, firstName: s.firstName || '', lastName: s.lastName || '' },
            at,
          };
        }
      }
    }
  }

  // Fold in each shop's own lastSeller snapshot.
  for (const shop of shops) {
    const ls = shop.lastSeller;
    if (!ls?.telegramId) continue;
    if (!map[shop.name]) map[shop.name] = {};
    if (!map[shop.name][ls.telegramId]) {
      map[shop.name][ls.telegramId] = {
        seller: { telegramId: ls.telegramId, firstName: ls.firstName || '', lastName: ls.lastName || '' },
        at: ls.unassignedAt ? new Date(ls.unassignedAt) : null,
      };
    }
  }

  const out = {};
  for (const [name, byTid] of Object.entries(map)) {
    out[name] = Object.values(byTid)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, 2)
      .map((e) => e.seller);
  }
  return out;
}

// ─── GET /api/shops/cities ────────────────────────────────────────────────────
// Публічний список міст (для реєстрації та seller)
router.get('/cities', asyncHandler(async (req, res) => {
  let cities = await cache.get(cache.KEYS.CITIES);
  if (!cities) {
    cities = await City.find().sort({ name: 1 }).lean();
    await cache.set(cache.KEYS.CITIES, cities);
  }
  res.json(cities);
}));

// ─── GET /api/shops/registry ──────────────────────────────────────────────────
// PUBLIC minimal shop list for the registration screen. A not-yet-registered
// Telegram user cannot pass telegramAuth (no User record), so registration must
// stay public — but it gets NO seller data, only id/name/address/city/group.
// Active shops only, optionally filtered by ?cityId=.
router.get('/registry', asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.query.cityId) filter.cityId = req.query.cityId;
  const shops = await Shop.find(filter).populate('cityId', 'name').sort({ name: 1 }).lean();
  res.json(shops.map(toMinimalShop));
}));

// ─── GET /api/shops/without-seller ────────────────────────────────────────────
// STAFF-ONLY. Active shops that currently have NO seller/admin assigned — the
// "Без продавця" warning block on the Shops tab. Global (not page-scoped), so
// the block stays accurate regardless of which page of the paginated list the
// admin is viewing. Carries minimal data + lastExSellers (who left last).
router.get('/without-seller', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const assignedShopIds = await User.distinct('shopId', {
    role: { $in: ['seller', 'admin'] },
    shopId: { $ne: null },
  });
  const shops = await Shop.find({ isActive: true, _id: { $nin: assignedShopIds } })
    .populate('cityId', 'name')
    .sort({ name: 1 })
    .lean();
  const lastExByShopName = await computeLastExSellersByShopName(shops);
  // Return full shop docs (the list is small — only unassigned shops) so the
  // warning block can expand a row straight into the edit form (ShopRow/ShopForm
  // need deliveryGroupId/isActive/etc.). sellers is [] by definition here.
  const result = shops.map((s) => ({
    ...s,
    cityId: s.cityId?._id ? String(s.cityId._id) : (s.cityId || null),
    city: s.cityId?.name || '',
    sellers: [],
    sellerCount: 0,
    lastExSellers: lastExByShopName[s.name] || [],
  }));
  res.json({ shops: result, count: result.length });
}));

// ─── GET /api/shops/:id ───────────────────────────────────────────────────────
router.get('/:id', asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id).populate('cityId', 'name country').lean();
  if (!shop) throw appError('shop_not_found');

  const cityId = shop.cityId?._id ? String(shop.cityId._id) : (shop.cityId || null);
  const base = { ...shop, cityId, city: shop.cityId?.name || '' }; // city computed from populate, not stored field

  // The seller list (names + telegramIds) is STAFF-ONLY — a seller must not be
  // able to enumerate other sellers via shop ids.
  if (!['admin', 'warehouse'].includes(req.telegramUser?.role)) {
    return res.json(base);
  }

  const sellers = await User.find({ shopId: shop._id, role: { $in: ['seller', 'admin'] } })
    .select('telegramId firstName lastName role')
    .lean();
  res.json({ ...base, sellers });
}));

// ─── POST /api/shops ──────────────────────────────────────────────────────────
router.post('/', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const { name, cityId, deliveryGroupId, address } = req.body;

  if (!name || !String(name).trim()) throw appError('shop_name_required');
  if (!cityId) throw appError('shop_city_required');
  if (!deliveryGroupId) throw appError('shop_delivery_group_required');

  const cityDoc = await City.findById(cityId).lean();
  if (!cityDoc) throw appError('shop_city_not_found');
  const group = await DeliveryGroup.findById(deliveryGroupId).lean();
  if (!group) throw appError('shop_delivery_group_not_found');

  const shop = await Shop.create({
    name: String(name).trim(),
    cityId: cityDoc._id,
    deliveryGroupId: deliveryGroupId ? String(deliveryGroupId) : '',
    address: address ? String(address).trim() : '',
  });

  res.status(201).json(shop);
}));

// ─── PATCH /api/shops/:id ─────────────────────────────────────────────────────
router.patch('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id);
  if (!shop) throw appError('shop_not_found');

  const { name, cityId, deliveryGroupId, address, isActive } = req.body;

  // Snapshot the delivery group BEFORE mutation so we can detect a real change
  // and cascade it to the shop's sellers (their deliveryGroupId/warehouseZone are
  // denormalized copies — see users.js sanitizeUserPayload).
  const prevDeliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';

  // Match POST: name and cityId must never become empty on an existing shop.
  // An empty name cascades into buyerSnapshot.shopName='' on every active order
  // and from there into PickingTask.items.shopName, which then either renders
  // blank in the picking UI or, on a fresh build, gets stamped with the
  // "невідомий магазин" fallback in taskBuilder.
  if (name !== undefined && !String(name).trim()) throw appError('shop_name_required');
  if (cityId !== undefined && !cityId) throw appError('shop_city_required');

  if (name !== undefined) shop.name = String(name).trim();
  if (address !== undefined) shop.address = String(address).trim();
  if (isActive !== undefined) shop.isActive = Boolean(isActive);

  if (cityId !== undefined) {
    const cityDoc = await City.findById(cityId).lean();
    if (!cityDoc) throw appError('shop_city_not_found');
    shop.cityId = cityDoc._id;
  }

  if (deliveryGroupId !== undefined) {
    if (deliveryGroupId) {
      const group = await DeliveryGroup.findById(deliveryGroupId).lean();
      if (!group) throw appError('shop_delivery_group_not_found');
    }

    // Guard (mirrors the deliveryGroups day-change guard): moving the shop to a
    // different group mid-cycle would strand its active orders — they keep the OLD
    // group's orderingSessionId, fall out of both groups' current sessions, and the
    // seller's next upsert-item opens a PARALLEL order in the new group. Refuse the
    // move while the OLD group's window is open, the shop has active orders in the
    // old current session, or those orders are already in picking. Allowed freely
    // once the cycle is over (no active orders) → applies to the next session.
    const newGroupIdRaw = deliveryGroupId ? String(deliveryGroupId) : '';
    if (newGroupIdRaw !== prevDeliveryGroupId && prevDeliveryGroupId) {
      const prevGroup = await DeliveryGroup.findById(prevDeliveryGroupId).lean();
      if (prevGroup) {
        const schedule = await getOrderingSchedule();
        const { isOpen } = isOrderingOpen(prevGroup.dayOfWeek, schedule);
        const prevSessionId = await getOrCreateSessionId(prevDeliveryGroupId, prevGroup.dayOfWeek, schedule);
        const shopActiveOrderIds = (await Order.find(
          { ...activeOrderShopFilter(shop._id), orderingSessionId: prevSessionId },
          '_id',
        ).lean()).map((o) => o._id);
        const inPicking = shopActiveOrderIds.length > 0 && !!(await PickingTask.exists({
          deliveryGroupId: prevDeliveryGroupId,
          status: { $in: ['pending', 'locked'] },
          'items.orderId': { $in: shopActiveOrderIds },
        }));
        if (isOpen || shopActiveOrderIds.length > 0) {
          const reason = isOpen ? 'вікно замовлень відкрите'
            : inPicking ? 'триває збирання'
            : 'є активні замовлення в поточній сесії';
          throw appError('shop_group_change_session_active', { reason });
        }
      }
    }

    shop.deliveryGroupId = deliveryGroupId ? String(deliveryGroupId) : '';
  }

  await shop.save();
  await invalidateShop(shop._id);

  // Propagate identity changes onto already-placed ACTIVE orders and their
  // pending/locked picking tasks. buyerSnapshot is a point-in-time copy taken
  // at order time; without this the warehouse would pick/label and deliver to
  // the OLD shop name/address for every order placed before this edit.
  const nameChanged = name !== undefined;
  const addressChanged = address !== undefined;
  const cityChanged = cityId !== undefined;
  if (nameChanged || addressChanged || cityChanged) {
    const cityDoc2 = await City.findById(shop.cityId).lean();
    const snap = {
      'buyerSnapshot.shopName': shop.name,
      'buyerSnapshot.shopCity': cityDoc2?.name || '',
      'buyerSnapshot.shopAddress': shop.address || '',
    };
    const activeOrders = await Order.find(
      activeOrderShopFilter(shop._id),
      '_id',
    ).lean();
    if (activeOrders.length) {
      const ids = activeOrders.map((o) => o._id);
      await Order.updateMany({ _id: { $in: ids } }, { $set: snap });
      if (nameChanged) {
        await PickingTask.updateMany(
          { status: { $in: ['pending', 'locked'] }, 'items.orderId': { $in: ids } },
          { $set: { 'items.$[elem].shopName': shop.name } },
          { arrayFilters: [{ 'elem.orderId': { $in: ids } }] },
        );
      }
    }
  }

  // Cascade a delivery-group change onto the shop's sellers. deliveryGroupId and
  // warehouseZone are denormalized onto each seller's User doc; without this they
  // keep computing their ordering window / picking group from the OLD group until
  // someone re-saves each user individually.
  //
  // NOTE: already-placed ACTIVE orders are intentionally NOT moved to the new
  // group — an order belongs to the ordering session / picking run it was placed
  // in (its orderingSessionId is tied to the old group). Only the sellers move, so
  // their NEXT order lands in the new group. The current run finishes where it was.
  const newDeliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';
  if (deliveryGroupId !== undefined && newDeliveryGroupId !== prevDeliveryGroupId) {
    let warehouseZone = '';
    if (newDeliveryGroupId) {
      const grp = await DeliveryGroup.findById(newDeliveryGroupId).lean();
      warehouseZone = grp?.name || '';
    }
    // Cascade to sellers AND admins bound to this shop — an admin with a shopId
    // also derives their ordering window / picking group from these denormalized
    // fields, so leaving them stale would route the admin's next order to the OLD
    // group. (warehouse users carry no shop, so they're untouched.)
    await User.updateMany(
      { shopId: shop._id, role: { $in: ['seller', 'admin'] } },
      { $set: { deliveryGroupId: newDeliveryGroupId, warehouseZone } },
    );
  }

  res.json(shop);
}));

// ─── DELETE /api/shops/:id ────────────────────────────────────────────────────
// Видаляємо тільки якщо 0 продавців прив'язано
router.delete('/:id', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  // Wrap check + delete in a transaction so a seller or active order created
  // between the count and the delete cannot leave us with orphan references.
  const session = await mongoose.connection.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const shop = await Shop.findById(req.params.id).session(session);
      if (!shop) throw appError('shop_not_found');

      const sellerCount = await User.countDocuments({
        shopId: String(shop._id),
        role: 'seller',
      }).session(session);
      if (sellerCount > 0) throw appError('shop_has_sellers', { sellerCount });

      const activeOrders = await Order.countDocuments(
        activeOrderShopFilter(shop._id),
      ).session(session);
      if (activeOrders > 0) throw appError('shop_has_active_orders', { activeOrders });

      await Shop.deleteOne({ _id: shop._id }, { session });
      result = { message: 'Магазин видалено', _shopId: String(shop._id) };
    });
    if (result?._shopId) {
      await invalidateShop(result._shopId);
      delete result._shopId;
    }
    return res.json(result);
  } finally {
    session.endSession();
  }
}));

// ─── PATCH /api/shops/:id/sellers ─────────────────────────────────────────────
// Масове оновлення продавців магазину (знімаємо/додаємо через список telegramId)
// Body: { sellers: ['111', '222'] } — повний новий список продавців магазину
router.patch('/:id/sellers', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id).lean();
  if (!shop) throw appError('shop_not_found');

  const newSellers = Array.isArray(req.body.sellers)
    ? req.body.sellers.map((id) => String(id).trim()).filter(Boolean)
    : [];

  const shopIdStr = String(shop._id);

  // Поточні продавці цього магазину
  const currentSellers = await User.find({ shopId: shopIdStr, role: 'seller' })
    .select('telegramId')
    .lean();
  const currentIds = currentSellers.map((u) => u.telegramId);

  // Валідуємо нових продавців
  if (newSellers.length > 0) {
    const validUsers = await User.find({
      telegramId: { $in: newSellers },
      role: 'seller',
    }).distinct('telegramId');
    const invalid = newSellers.filter((id) => !validUsers.includes(id));
    if (invalid.length > 0) throw appError('shop_sellers_invalid', { ids: invalid });
  }

  // Знімаємо/призначаємо в одній транзакції — інакше при збої між
  // двома updateMany частина продавців може опинитися «у підвішеному стані»
  // (вже знятий зі старого, ще не призначений у новий).
  const toRemove = currentIds.filter((id) => !newSellers.includes(id));
  const toAdd = newSellers.filter((id) => !currentIds.includes(id));

  if (toRemove.length > 0 || toAdd.length > 0) {
    const actor = req.telegramUser;
    const invalidateFns = [];
    const session = await mongoose.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Removals: unassign + park not-yet-picked orders so they follow the seller.
        for (const tgId of toRemove) {
          const seller = await User.findOne({ telegramId: tgId }).session(session);
          if (!seller) continue;
          await unassignSellerAndPark({
            session,
            seller,
            fromShopId: shopIdStr,
            actor,
            reason: 'bulk_sellers_update',
          });
        }

        // Additions: full migration so the seller's active/parked order, cart
        // reservation and history are handled atomically (not a raw shopId set).
        if (toAdd.length > 0) {
          const shopFull = await Shop.findById(req.params.id)
            .populate('cityId', 'name').session(session);
          for (const tgId of toAdd) {
            const seller = await User.findOne({ telegramId: tgId, role: 'seller' }).session(session);
            if (!seller) continue;
            const result = await migrateSellerShop({
              session,
              existingUser: seller,
              newShopFull: shopFull,
              actor,
              reason: 'bulk_sellers_update',
              resetCartNavigation: false,
              pushHistory: true,
              updateLastSeller: true,
            });
            if (result.invalidate) invalidateFns.push(result.invalidate);
          }
        }

        await Shop.findByIdAndUpdate(
          req.params.id,
          { $set: { lastSellerChangedAt: new Date() } },
          { session }
        );
      });
    } finally {
      session.endSession();
    }
    for (const fn of invalidateFns) {
      try { await fn(); } catch (e) { console.warn('[shops sellers] invalidate failed:', e?.message); }
    }
    await invalidateShop(req.params.id);
  }

  // Повертаємо оновлений список
  const updatedSellers = await User.find({ shopId: shopIdStr, role: 'seller' })
    .select('telegramId firstName lastName')
    .lean();

  res.json({ sellers: updatedSellers });
}));

// ─── POST /api/shops/:id/transfer-hash ────────────────────────────────────────
// Generate (or regenerate) a one-time seller-transfer hash for this shop.
// The admin hands the returned code to a seller, who pastes it into the bot and
// is moved to THIS shop with no further confirmation. Single-use semantics:
//   • Generating a new code OVERWRITES any previous one (old value invalidated).
//   • The bot CLEARS the field the moment it is consumed (see telegramBot.js).
// We retry on the rare unique-index collision so a code is always distinct.
router.post('/:id/transfer-hash', telegramAuth, requireTelegramRole('admin'), asyncHandler(async (req, res) => {
  const shop = await Shop.findById(req.params.id);
  if (!shop) throw appError('shop_not_found');

  // Format: ZP-XXXXXXXXXXXX (upper hex). Prefix makes it self-evidently a
  // transfer code in chat and lets the bot match it without false positives.
  const makeHash = () => `ZP-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

  let saved = null;
  for (let attempt = 0; attempt < 5 && !saved; attempt += 1) {
    const candidate = makeHash();
    try {
      shop.transferHash = candidate;
      shop.transferHashCreatedAt = new Date();
      await shop.save();
      saved = candidate;
    } catch (err) {
      // 11000 → another shop already holds this (extremely unlikely) code; retry.
      if (err?.code === 11000) continue;
      throw err;
    }
  }
  if (!saved) throw appError('shop_transfer_hash_failed');

  await invalidateShop(shop._id);

  // Deep link the admin can forward directly: the seller taps it, hits one
  // "Start" button, and is moved with no further steps. The ZP-<hex> format is
  // already Telegram start-param safe ([A-Za-z0-9_-], ≤64 chars) — no encoding.
  const botUsername = (process.env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, '').trim();
  const deepLink = botUsername ? `https://t.me/${botUsername}?start=${saved}` : null;

  res.json({ transferHash: saved, transferHashCreatedAt: shop.transferHashCreatedAt, deepLink });
}));

module.exports = router;

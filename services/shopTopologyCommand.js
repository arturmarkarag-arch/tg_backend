'use strict';

const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const City = require('../models/City');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const SupplementWave = require('../models/SupplementWave');
const { appError } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');
const { isOrderingOpen, getOpenDateWarsaw } = require('../utils/orderingSchedule');
const { invalidateShop } = require('../utils/modelCache');
const { getIO } = require('../socket');

function str(value) {
  return value == null ? '' : String(value);
}

/**
 * Canonical CURRENT Shop topology/configuration command.
 *
 * Owns the relation and identity fields that other operational state depends on:
 *   Shop.deliveryGroupId, Shop.isActive, Shop.name/address/cityId.
 *
 * The Express route is transport only. Guards + snapshot propagation are kept in
 * one transaction so we cannot commit a new Shop identity while leaving active
 * Orders/PickingTasks on the previous delivery identity after a partial failure.
 */
async function updateShopTopologyCommand({ shopId, patch = {}, actor = null }) {
  const id = str(shopId).trim();
  if (!id) throw appError('shop_not_found');

  const allowed = ['name', 'cityId', 'deliveryGroupId', 'address', 'isActive'];
  const input = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, key)) input[key] = patch[key];
  }

  return withLock(`shop:${id}:topology`, async () => {
    const session = await mongoose.connection.startSession();
    let outcome = null;
    try {
      await session.withTransaction(async () => {
      const shop = await Shop.findById(id).session(session);
      if (!shop) throw appError('shop_not_found');

      const prevDeliveryGroupId = shop.deliveryGroupId ? String(shop.deliveryGroupId) : '';
      const prevIsActive = shop.isActive !== false;

      if (input.name !== undefined && !String(input.name).trim()) {
        throw appError('shop_name_required');
      }
      if (input.cityId !== undefined && !input.cityId) {
        throw appError('shop_city_required');
      }

      let nextCity = null;
      if (input.cityId !== undefined) {
        nextCity = await City.findById(input.cityId).session(session).lean();
        if (!nextCity) throw appError('shop_city_not_found');
      }

      let nextGroupId = prevDeliveryGroupId;
      if (input.deliveryGroupId !== undefined) {
        nextGroupId = input.deliveryGroupId ? String(input.deliveryGroupId) : '';
        if (nextGroupId) {
          const group = await DeliveryGroup.findById(nextGroupId).session(session).lean();
          if (!group) throw appError('shop_delivery_group_not_found');
        }
      }

      // Group assignment is CURRENT topology, but current-cycle Order ownership is
      // SESSION state. Never let a topology edit strand current session work.
      if (nextGroupId !== prevDeliveryGroupId && prevDeliveryGroupId) {
        const prevGroup = await DeliveryGroup.findById(prevDeliveryGroupId).session(session).lean();
        if (prevGroup) {
          const { isOpen } = isOrderingOpen(prevGroup.orderingSchedule);
          const openDate = getOpenDateWarsaw(prevGroup.orderingSchedule);
          const currentSession = await OrderingSession.findOne(
            { groupId: prevDeliveryGroupId, openDate },
            '_id',
          ).session(session).lean();

          let shopActiveOrderIds = [];
          let inPicking = false;
          let activeSupplementWave = false;
          if (currentSession?._id) {
            shopActiveOrderIds = (await Order.find(
              { ...activeOrderShopFilter(shop._id), orderingSessionId: String(currentSession._id) },
              '_id',
            ).session(session).lean()).map((row) => row._id);

            inPicking = shopActiveOrderIds.length > 0 && Boolean(await PickingTask.exists({
              deliveryGroupId: prevDeliveryGroupId,
              status: { $in: ['pending', 'locked'] },
              'items.orderId': { $in: shopActiveOrderIds },
            }).session(session));

            // SupplementWave is frozen SESSION ownership. Moving a Shop to another
            // CURRENT group while the Wave is open/frozen would make seller access
            // follow the new topology while warehouse work remains in the old
            // delivery cycle. Block the topology change instead of migrating history.
            activeSupplementWave = Boolean(await SupplementWave.exists({
              deliveryGroupId: prevDeliveryGroupId,
              orderingSessionId: String(currentSession._id),
              status: { $in: ['open', 'frozen'] },
            }).session(session));
          }

          if (isOpen || shopActiveOrderIds.length > 0 || activeSupplementWave) {
            const reason = activeSupplementWave ? 'є активне дозамовлення в поточній доставці'
              : isOpen ? 'вікно замовлень відкрите'
                : inPicking ? 'триває збирання'
                : 'є активні замовлення в поточній сесії';
            throw appError('shop_group_change_session_active', { reason });
          }
        }
      }

      const nameChanged = input.name !== undefined && String(input.name).trim() !== String(shop.name || '');
      const addressChanged = input.address !== undefined && String(input.address).trim() !== String(shop.address || '');
      const cityChanged = input.cityId !== undefined && String(input.cityId) !== String(shop.cityId || '');
      const groupChanged = nextGroupId !== prevDeliveryGroupId;
      const activeChanged = input.isActive !== undefined && Boolean(input.isActive) !== prevIsActive;

      if (input.name !== undefined) shop.name = String(input.name).trim();
      if (input.address !== undefined) shop.address = String(input.address).trim();
      if (input.isActive !== undefined) shop.isActive = Boolean(input.isActive);
      if (nextCity) shop.cityId = nextCity._id;
      if (input.deliveryGroupId !== undefined) shop.deliveryGroupId = nextGroupId;

      await shop.save({ session });

      // Delivery identity is live-until-terminal by existing project policy.
      // Keep active Order/PickingTask presentation aligned atomically with Shop.
      if (nameChanged || addressChanged || cityChanged) {
        const cityName = nextCity?.name
          || (await City.findById(shop.cityId, 'name').session(session).lean())?.name
          || '';
        const snap = {
          'buyerSnapshot.shopName': shop.name,
          'buyerSnapshot.shopCity': cityName,
          'buyerSnapshot.shopAddress': shop.address || '',
        };
        const activeOrders = await Order.find(activeOrderShopFilter(shop._id), '_id')
          .session(session)
          .lean();
        if (activeOrders.length) {
          const ids = activeOrders.map((row) => row._id);
          await Order.updateMany({ _id: { $in: ids } }, { $set: snap }, { session });
          if (nameChanged) {
            await PickingTask.updateMany(
              { status: { $in: ['pending', 'locked'] }, 'items.orderId': { $in: ids } },
              { $set: { 'items.$[elem].shopName': shop.name } },
              { arrayFilters: [{ 'elem.orderId': { $in: ids } }], session },
            );
          }
        }
      }

      outcome = {
        shopId: String(shop._id),
        previousDeliveryGroupId: prevDeliveryGroupId || null,
        deliveryGroupId: nextGroupId || null,
        groupChanged,
        activeChanged,
        identityChanged: nameChanged || addressChanged || cityChanged,
        actorTelegramId: str(actor?.telegramId),
      };
      });
    } finally {
      await session.endSession();
    }

    // Publish only after Mongo commit. Cache/socket failures never mutate truth.
    try { await invalidateShop(id); } catch (_) {}

    try {
      const io = getIO();
      if (io && outcome) {
        const groups = [...new Set([
          outcome.previousDeliveryGroupId,
          outcome.deliveryGroupId,
        ].filter(Boolean))];
        if (outcome.groupChanged || outcome.activeChanged || outcome.identityChanged) {
          for (const groupId of groups) {
            io.to(`picking_group_${groupId}`).emit('shop_status_changed', { groupId });
          }
        }
        if (outcome.groupChanged || outcome.activeChanged) {
          io.emit('delivery_groups_updated');
        }
      }
    } catch (_) { /* best-effort */ }

    const updated = await Shop.findById(id).lean();
    return { shop: updated, ...outcome };
  });
}

module.exports = { updateShopTopologyCommand };

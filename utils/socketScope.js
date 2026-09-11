'use strict';

function roomUser(telegramId) {
  const id = String(telegramId || '').trim();
  return id ? `user_${id}` : '';
}

function roomSellerGroup(deliveryGroupId) {
  const id = String(deliveryGroupId || '').trim();
  return id ? `seller_group_${id}` : '';
}

function roomSellerShop(shopId) {
  const id = String(shopId || '').trim();
  return id ? `seller_shop_${id}` : '';
}

function emitStaff(io, event, payload) {
  if (!io || !event) return;
  io.to('staff').emit(event, payload);
}

function emitUserAndStaff(io, telegramId, event, payload) {
  if (!io || !event) return;
  emitStaff(io, event, payload);
  const room = roomUser(telegramId);
  if (room) io.to(room).emit(event, payload);
}

/**
 * Rebuilds seller shop/group room membership from CURRENT database authority.
 * This matters after a live shop reassignment: a long-lived socket must not keep
 * receiving events for the shop/group it used to belong to.
 */
async function syncSellerSocketScope(io, telegramId) {
  if (!io) return { shopId: '', deliveryGroupId: '' };
  const userRoom = roomUser(telegramId);
  if (!userRoom) return { shopId: '', deliveryGroupId: '' };

  try {
    // Revoke old scopes FIRST. Authorization refresh must fail closed: if the
    // following DB read/join fails, the socket may temporarily lose realtime but
    // it must never keep the previous shop/group subscription.
    const sockets = await io.in(userRoom).fetchSockets();
    const staleRooms = new Set();
    for (const socket of sockets) {
      for (const room of socket.rooms || []) {
        if (String(room).startsWith('seller_shop_') || String(room).startsWith('seller_group_')) {
          staleRooms.add(String(room));
        }
      }
    }
    for (const room of staleRooms) io.in(userRoom).socketsLeave(room);

    const User = require('../models/User');
    const Shop = require('../models/Shop');
    const user = await User.findOne({ telegramId: String(telegramId) }, 'role shopId accountState botBlocked').lean();

    let shopId = '';
    let deliveryGroupId = '';
    if (user?.role === 'seller' && user?.accountState !== 'removed' && !user?.botBlocked && user?.shopId) {
      const shop = await Shop.findById(user.shopId, 'deliveryGroupId isActive').lean();
      if (shop && shop.isActive !== false) {
        shopId = String(shop._id);
        deliveryGroupId = String(shop.deliveryGroupId || '').trim();
      }
    }

    if (shopId) io.in(userRoom).socketsJoin(roomSellerShop(shopId));
    if (deliveryGroupId) io.in(userRoom).socketsJoin(roomSellerGroup(deliveryGroupId));
    return { shopId, deliveryGroupId };
  } catch (error) {
    // If we cannot prove/update current authorization, kill these connections.
    // Reconnect re-runs socket auth from current Mongo truth and cannot preserve
    // a stale room membership from the previous assignment.
    try { io.in(userRoom).disconnectSockets(true); } catch (_) {}
    throw error;
  }
}

/**
 * Supplement realtime is seller-sensitive. Staff always receives the event for
 * operational cache reconciliation, while sellers receive it only for their
 * own shop (when shopId is present) or, for group-wide wave events, their own
 * delivery group. If neither authoritative scope is present, fail closed to
 * staff-only instead of broadcasting metadata to every seller.
 */
function emitSupplementScoped(io, event, payload = {}) {
  if (!io || !event) return;
  emitStaff(io, event, payload);

  const shopRoom = roomSellerShop(payload?.shopId);
  if (shopRoom) {
    io.to(shopRoom).emit(event, payload);
    return;
  }

  const groupRoom = roomSellerGroup(payload?.deliveryGroupId);
  if (groupRoom) io.to(groupRoom).emit(event, payload);
}

module.exports = {
  roomUser,
  roomSellerGroup,
  roomSellerShop,
  emitStaff,
  emitUserAndStaff,
  emitSupplementScoped,
  syncSellerSocketScope,
};

const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Block = require('./models/Block');
const User = require('./models/User');
const { validateTelegramInitData } = require('./utils/validateTelegramInitData');
const { verifySession } = require('./utils/jwt');
const { pubClient, subClient, isEnabled: redisEnabled } = require('./utils/redis');
const { createAdapter } = require('@socket.io/redis-adapter');

let io = null;

// Tracks which items are currently locked by a user
// Map<productId, { userId, userName, timestamp, socketId, timer }>
const lockedItems = new Map();

// Remove a lock and clear its auto-unlock timer so timers don't pile up under
// heavy drag-and-drop (each lock_item schedules a setTimeout).
function releaseLock(productId) {
  const lock = lockedItems.get(productId);
  if (lock?.timer) clearTimeout(lock.timer);
  lockedItems.delete(productId);
}

// Tracks which sellers are currently viewing a given shop room
// Map<shopId, Map<telegramId, { telegramId, name }>>
// Presence is derived live from actual room membership rather than a parallel
// Map — that way a socket that left the room (explicit leave_shop or disconnect)
// can never linger as a phantom seller, and multiple tabs of one user collapse
// to a single entry (deduped by telegramId).
function broadcastShopSellers(shopId) {
  if (!io) return;
  const room = `shop_${shopId}`;
  const socketIds = io.sockets.adapter.rooms.get(room);
  const byTelegramId = new Map();
  if (socketIds) {
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      byTelegramId.set(s.telegramId, { telegramId: s.telegramId, name: s.userName || s.telegramId });
    }
  }
  const list = Array.from(byTelegramId.values());
  io.to(room).emit('shop_sellers_updated', { shopId, sellers: list, count: list.length });
}

// Receipt viewers are derived live from room membership (same rationale as
// broadcastShopSellers): a socket that left the room or disconnected can never
// linger as a phantom viewer, and multiple tabs collapse to one entry.
function broadcastReceiptParticipants(receiptId) {
  if (!io) return;
  const room = `receipt_${receiptId}`;
  const socketIds = io.sockets.adapter.rooms.get(room);
  const byTelegramId = new Map();
  if (socketIds) {
    for (const sid of socketIds) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      byTelegramId.set(s.telegramId, { telegramId: s.telegramId, name: s.userName || s.telegramId });
    }
  }
  io.to(room).emit('receipt_users_updated', Array.from(byTelegramId.values()));
}

/**
 * Returns a lightweight block payload for socket broadcasts.
 * Sends only IDs instead of full populated product objects,
 * reducing per-event payload from ~15 KB to ~700 bytes.
 */
function slimBlock(block) {
  return {
    blockId: block.blockId,
    version: block.version,
    productIds: (block.productIds || []).map((id) => String(id._id || id)),
  };
}

// Auto-unlock after 60 seconds
const LOCK_TIMEOUT_MS = 60_000;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: require('./utils/corsOptions').corsOrigin,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Cross-worker Socket.IO via Redis pub/sub. Without this, an emit on worker A
  // never reaches a client connected to worker B.
  if (redisEnabled() && pubClient && subClient) {
    try {
      io.adapter(createAdapter(pubClient, subClient));
      console.log('[Socket] Redis adapter active — events broadcast across all workers');
    } catch (err) {
      console.warn('[Socket] Redis adapter init failed, falling back to single-process:', err.message);
    }
  } else {
    console.warn('[Socket] Running without Redis adapter — single-process only');
  }

  // Auth middleware — verify initData (mini-app) OR session JWT (browser).
  io.use(async (socket, next) => {
    const initData = socket.handshake.auth?.initData;
    const token = socket.handshake.auth?.token;
    let telegramId = '';

    if (initData) {
      const { valid, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
      if (!valid) {
        return next(new Error(`Unauthorized: ${error || 'Invalid initData'}`));
      }
      try {
        const params = new URLSearchParams(initData);
        const user = JSON.parse(params.get('user') || '{}');
        telegramId = String(user.id || '');
        socket.userName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || telegramId;
      } catch {
        return next(new Error('Unauthorized: Could not parse user from initData'));
      }
    } else if (token) {
      const session = verifySession(token);
      if (!session) {
        return next(new Error('Unauthorized: Invalid session token'));
      }
      telegramId = session.telegramId;
    } else {
      return next(new Error('Unauthorized: initData or token is required'));
    }

    if (!telegramId) {
      return next(new Error('Unauthorized: Missing telegramId'));
    }
    const dbUser = await User.findOne({ telegramId }).lean();
    if (!dbUser) {
      return next(new Error('Unauthorized: User not registered'));
    }
    if (dbUser.botBlocked) {
      return next(new Error('Forbidden: Account blocked'));
    }
    if (!['admin', 'warehouse', 'seller'].includes(dbUser.role)) {
      return next(new Error('Forbidden: Insufficient role'));
    }
    if (!socket.userName) {
      socket.userName = [dbUser.firstName, dbUser.lastName].filter(Boolean).join(' ').trim() || telegramId;
    }
    socket.telegramId = telegramId;
    socket.userRole = dbUser.role;
    socket.shopId = dbUser.shopId ? String(dbUser.shopId) : '';
    next();
  });

  io.on('connection', (socket) => {
    socket.receiptIds = new Set();
    console.log(`[Socket] Client connected: ${socket.id} (telegramId=${socket.telegramId})`);

    const isWarehouseStaff = () => ['admin', 'warehouse'].includes(socket.userRole);

    // Join a block room to receive updates for that block.
    // Block/picking/receipt rooms are warehouse-domain — sellers have no
    // business there, so deny the join (prevents presence/info exposure).
    socket.on('join_block', (blockNumber) => {
      if (!isWarehouseStaff()) return;
      socket.join(`block_${blockNumber}`);
    });

    socket.on('leave_block', (blockNumber) => {
      socket.leave(`block_${blockNumber}`);
    });

    // Join a picking-group room to receive real-time shop status updates
    socket.on('join_picking_group', (groupId) => {
      if (!isWarehouseStaff()) return;
      if (groupId) socket.join(`picking_group_${groupId}`);
    });

    socket.on('leave_picking_group', (groupId) => {
      if (groupId) socket.leave(`picking_group_${groupId}`);
    });

    // Join a shop room for co-seller presence awareness.
    // A seller may only ever observe presence in their OWN shop; admins and
    // warehouse staff may observe any shop.
    socket.on('join_shop', (shopId) => {
      if (!shopId) return;
      if (socket.userRole === 'seller' && String(shopId) !== socket.shopId) return;
      const room = `shop_${shopId}`;
      socket.join(room);
      socket.shopIds = socket.shopIds || new Set();
      socket.shopIds.add(String(shopId));
      broadcastShopSellers(String(shopId));
    });

    socket.on('leave_shop', (shopId) => {
      if (!shopId) return;
      socket.leave(`shop_${shopId}`);
      socket.shopIds?.delete(String(shopId));
      broadcastShopSellers(String(shopId));
    });

    socket.on('join_receipt', (receiptId) => {
      if (!isWarehouseStaff()) return;
      const room = `receipt_${receiptId}`;
      socket.join(room);
      socket.receiptIds.add(receiptId);
      broadcastReceiptParticipants(receiptId);
    });

    socket.on('leave_receipt', (receiptId) => {
      const room = `receipt_${receiptId}`;
      socket.leave(room);
      socket.receiptIds.delete(receiptId);
      broadcastReceiptParticipants(receiptId);
    });

    // Lock an item — prevents others from selecting it
    // userId is taken from authenticated socket.telegramId, not from client payload
    socket.on('lock_item', ({ productId, userName }) => {
      if (!['admin', 'warehouse'].includes(socket.userRole)) {
        socket.emit('lock_denied', { productId, lockedBy: 'Forbidden' });
        return;
      }
      const userId = socket.telegramId;
      if (lockedItems.has(productId)) {
        const existing = lockedItems.get(productId);
        if (existing.userId !== userId) {
          socket.emit('lock_denied', { productId, lockedBy: existing.userName });
          return;
        }
      }

      // Clear any prior auto-unlock timer (re-lock by the same user) so it
      // can't fire later and drop the refreshed lock.
      const prior = lockedItems.get(productId);
      if (prior?.timer) clearTimeout(prior.timer);

      const lockData = { userId, userName, timestamp: Date.now(), socketId: socket.id };
      lockData.timer = setTimeout(() => {
        const current = lockedItems.get(productId);
        if (current && current.socketId === socket.id) {
          lockedItems.delete(productId);
          io.emit('item_unlocked', { productId });
        }
      }, LOCK_TIMEOUT_MS);
      lockedItems.set(productId, lockData);

      // Broadcast lock to everyone except sender
      socket.broadcast.emit('item_locked', { productId, userId, userName });
    });

    // Unlock an item
    // userId is taken from authenticated socket.telegramId, not from client payload
    socket.on('unlock_item', ({ productId }) => {
      if (!['admin', 'warehouse'].includes(socket.userRole)) {
        return;
      }
      const userId = socket.telegramId;
      const existing = lockedItems.get(productId);
      if (existing && existing.userId === userId) {
        releaseLock(productId);
        io.emit('item_unlocked', { productId });
      }
    });

    // Move item between blocks
    // Auth is via socket.telegramId only — never trust a userId from the payload.
    socket.on('move_item', async ({ productId, fromBlock, toBlock, toIndex }) => {
      if (!['admin', 'warehouse'].includes(socket.userRole)) {
        socket.emit('move_error', { error: 'Forbidden: insufficient role' });
        return;
      }
      try {
        console.log(`[Socket] move_item: product=${productId} from=${fromBlock} to=${toBlock} idx=${toIndex}`);

        const session = await mongoose.connection.startSession();
        try {
          await session.withTransaction(async () => {
            const source = await Block.findOne({ blockId: fromBlock }).session(session);
            const target = fromBlock === toBlock
              ? source
              : await Block.findOne({ blockId: toBlock }).session(session);

            if (!source || !target) {
              throw Object.assign(new Error('Block not found'), { code: 'BLOCK_NOT_FOUND' });
            }

            const idx = source.productIds.findIndex((id) => id.toString() === productId);
            if (idx === -1) {
              throw Object.assign(new Error('Product not in source block'), { code: 'PRODUCT_NOT_FOUND_IN_SOURCE' });
            }

            source.productIds.splice(idx, 1);
            const safeIndex = Math.min(Math.max(0, toIndex), target.productIds.length);
            target.productIds.splice(safeIndex, 0, productId);

            if (fromBlock === toBlock) {
              source.version += 1;
              await source.save({ session });
            } else {
              source.version += 1;
              target.version += 1;
              await source.save({ session });
              await target.save({ session });
            }
          });
        } finally {
          await session.endSession();
        }

        // Broadcast slim block updates to all clients
        const updatedSource = await Block.findOne({ blockId: fromBlock }).lean();
        const updatedTarget = fromBlock === toBlock
          ? updatedSource
          : await Block.findOne({ blockId: toBlock }).lean();

        io.emit('block_updated', slimBlock(updatedSource));
        if (fromBlock !== toBlock) {
          io.emit('block_updated', slimBlock(updatedTarget));
        }

        // Unlock the moved item
        releaseLock(productId);
        io.emit('item_unlocked', { productId });

        // Notify the mover — only blockIds needed, data arrives via block_updated
        socket.emit('move_success', { source: { blockId: fromBlock }, target: { blockId: toBlock } });
      } catch (err) {
        console.error('[Socket] move_item error:', err);
        socket.emit('move_error', { error: err.message || 'Move failed' });
      }
    });

    // Request current locks
    socket.on('get_locks', () => {
      const locks = {};
      for (const [productId, data] of lockedItems) {
        locks[productId] = { userId: data.userId, userName: data.userName };
      }
      socket.emit('current_locks', locks);
    });

    // Cleanup on disconnect
    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} (telegramId=${socket.telegramId}) reason=${reason}`);
      for (const [productId, data] of lockedItems) {
        if (data.socketId === socket.id) {
          releaseLock(productId);
          io.emit('item_unlocked', { productId });
        }
      }

      // This socket has already left its rooms by the time 'disconnect' fires,
      // so re-broadcasting derives the correct remaining presence.
      for (const shopId of socket.shopIds || []) {
        broadcastShopSellers(shopId);
      }

      for (const receiptId of socket.receiptIds || []) {
        broadcastReceiptParticipants(receiptId);
      }
    });
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { initSocket, getIO };

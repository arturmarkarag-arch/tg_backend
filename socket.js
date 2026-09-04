const { Server } = require('socket.io');
const Block = require('./models/Block');
const { moveProductBetweenBlocks } = require('./services/blockMoveCommand');
const User = require('./models/User');
const { isRemovedUser } = require('./utils/userAccountState');
const { validateTelegramInitData } = require('./utils/validateTelegramInitData');
const { verifySession } = require('./utils/jwt');
const { pubClient, subClient, isEnabled: redisEnabled } = require('./utils/redis');
const { hasBaseLinkerPickingAccess } = require('./utils/baseLinkerAccess');
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

// Receipt viewers are derived live from room membership: a socket that left
// the room or disconnected can never
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
    } catch (err) {
    }
  } else {
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
    if (!dbUser || isRemovedUser(dbUser)) {
      return next(new Error('Unauthorized: User not registered'));
    }
    if (dbUser.botBlocked) {
      return next(new Error('Forbidden: Account blocked'));
    }
    if (!['admin', 'warehouse', 'seller', 'baselinker'].includes(dbUser.role)) {
      return next(new Error('Forbidden: Insufficient role'));
    }
    if (!socket.userName) {
      socket.userName = [dbUser.firstName, dbUser.lastName].filter(Boolean).join(' ').trim() || telegramId;
    }
    socket.telegramId = telegramId;
    socket.userRole = dbUser.role;
    socket.shopId = dbUser.shopId ? String(dbUser.shopId) : '';
    socket.baseLinkerPickingAccess = hasBaseLinkerPickingAccess(dbUser);
    next();
  });

  io.on('connection', (socket) => {
    socket.receiptIds = new Set();
    // Private per-user room for targeted seller/browser events. The room name is
    // derived only from the authenticated socket identity — never from client
    // payload — so another user cannot subscribe to someone else's notifications.
    socket.join(`user_${socket.telegramId}`);
    // Staff-only room for rich cache reconciliation payloads. Seller sockets
    // still receive the minimal public catalogue_updated signal, but never the
    // product field patch used by admin TanStack caches.
    if (['admin', 'warehouse'].includes(socket.userRole)) socket.join('staff');
    if (socket.baseLinkerPickingAccess) socket.join('baselinker_staff');

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
    socket.on('move_item', async ({ productId, fromBlock, toBlock, toIndex, expectedFromVersion, expectedToVersion }) => {
      if (!['admin', 'warehouse'].includes(socket.userRole)) {
        socket.emit('move_error', { error: 'forbidden', message: 'Недостатньо прав для цієї дії' });
        return;
      }
      try {
        const result = await moveProductBetweenBlocks({
          productId,
          fromBlock,
          toBlock,
          toIndex,
          expectedFromVersion,
          expectedToVersion,
        });

        // Broadcast final physical truth after the canonical command committed.
        const updatedSource = await Block.findById(result.sourceId).lean();
        const updatedTarget = result.sameBlock
          ? updatedSource
          : await Block.findById(result.targetId).lean();

        io.emit('block_updated', slimBlock(updatedSource));
        if (!result.sameBlock) io.emit('block_updated', slimBlock(updatedTarget));
        if (result.positionChanges.length) {
          io.emit('picking_tasks_positions_updated', result.positionChanges);
        }

        releaseLock(productId);
        io.emit('item_unlocked', { productId });
        socket.emit('move_success', {
          source: { blockId: result.fromBlockId },
          target: { blockId: result.toBlockId },
        });
      } catch (err) {
        socket.emit('move_error', {
          error: err?.code || 'move_failed',
          message: err?.message || 'Move failed',
          ...(err?.args || {}),
        });
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
    socket.on('disconnect', () => {
      for (const [productId, data] of lockedItems) {
        if (data.socketId === socket.id) {
          releaseLock(productId);
          io.emit('item_unlocked', { productId });
        }
      }

      // This socket has already left its rooms by the time 'disconnect' fires,
      // so re-broadcasting derives the correct remaining presence.
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

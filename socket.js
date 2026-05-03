const { Server } = require('socket.io');
const mongoose = require('mongoose');
const Block = require('./models/Block');
const User = require('./models/User');
const { validateTelegramInitData } = require('./utils/validateTelegramInitData');

let io = null;

// Tracks which items are currently locked by a user
// Map<productId, { userId, userName, timestamp }>
const lockedItems = new Map();

// Tracks users in receipt rooms: Map<receiptId, Map<telegramId, { telegramId, name }>>
const receiptParticipants = new Map();

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
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware — verify initData on every socket connection
  io.use(async (socket, next) => {
    const initData = socket.handshake.auth?.initData;
    if (!initData) {
      return next(new Error('Unauthorized: initData is required'));
    }
    const { valid, error } = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!valid) {
      return next(new Error(`Unauthorized: ${error || 'Invalid initData'}`));
    }
    const params = new URLSearchParams(initData);
    let telegramId = '';
    try {
      const user = JSON.parse(params.get('user') || '{}');
      telegramId = String(user.id || '');
      socket.userName = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || telegramId;
    } catch {
      return next(new Error('Unauthorized: Could not parse user from initData'));
    }
    if (!telegramId) {
      return next(new Error('Unauthorized: Missing telegramId'));
    }
    const dbUser = await User.findOne({ telegramId }).lean();
    if (!dbUser) {
      return next(new Error('Unauthorized: User not registered'));
    }
    if (!['admin', 'warehouse'].includes(dbUser.role)) {
      return next(new Error('Forbidden: Insufficient role'));
    }
    socket.telegramId = telegramId;
    socket.userRole = dbUser.role;
    next();
  });

  io.on('connection', (socket) => {
    socket.receiptIds = new Set();
    console.log(`[Socket] Client connected: ${socket.id} (telegramId=${socket.telegramId})`);

    // Join a block room to receive updates for that block
    socket.on('join_block', (blockNumber) => {
      socket.join(`block_${blockNumber}`);
    });

    socket.on('leave_block', (blockNumber) => {
      socket.leave(`block_${blockNumber}`);
    });

    socket.on('join_receipt', (receiptId) => {
      const room = `receipt_${receiptId}`;
      socket.join(room);
      socket.receiptIds.add(receiptId);

      const participants = receiptParticipants.get(receiptId) || new Map();
      participants.set(socket.telegramId, {
        telegramId: socket.telegramId,
        name: socket.userName || socket.telegramId,
      });
      receiptParticipants.set(receiptId, participants);
      io.to(room).emit('receipt_users_updated', Array.from(participants.values()));
    });

    socket.on('leave_receipt', (receiptId) => {
      const room = `receipt_${receiptId}`;
      socket.leave(room);
      socket.receiptIds.delete(receiptId);

      const participants = receiptParticipants.get(receiptId);
      if (participants) {
        participants.delete(socket.telegramId);
        if (participants.size === 0) {
          receiptParticipants.delete(receiptId);
        } else {
          receiptParticipants.set(receiptId, participants);
        }
        io.to(room).emit('receipt_users_updated', Array.from(participants.values()));
      }
    });

    // Lock an item — prevents others from selecting it
    // userId is taken from authenticated socket.telegramId, not from client payload
    socket.on('lock_item', ({ productId, userName }) => {
      const userId = socket.telegramId;
      if (lockedItems.has(productId)) {
        const existing = lockedItems.get(productId);
        if (existing.userId !== userId) {
          socket.emit('lock_denied', { productId, lockedBy: existing.userName });
          return;
        }
      }

      const lockData = { userId, userName, timestamp: Date.now(), socketId: socket.id };
      lockedItems.set(productId, lockData);

      // Broadcast lock to everyone except sender
      socket.broadcast.emit('item_locked', { productId, userId, userName });

      // Auto-unlock after timeout
      setTimeout(() => {
        const current = lockedItems.get(productId);
        if (current && current.socketId === socket.id) {
          lockedItems.delete(productId);
          io.emit('item_unlocked', { productId });
        }
      }, LOCK_TIMEOUT_MS);
    });

    // Unlock an item
    // userId is taken from authenticated socket.telegramId, not from client payload
    socket.on('unlock_item', ({ productId }) => {
      const userId = socket.telegramId;
      const existing = lockedItems.get(productId);
      if (existing && existing.userId === userId) {
        lockedItems.delete(productId);
        io.emit('item_unlocked', { productId });
      }
    });

    // Move item between blocks
    socket.on('move_item', async ({ productId, fromBlock, toBlock, toIndex, userId }) => {
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
        lockedItems.delete(productId);
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
    socket.on('disconnect', () => {
      console.log(`[Socket] Client disconnected: ${socket.id}`);
      for (const [productId, data] of lockedItems) {
        if (data.socketId === socket.id) {
          lockedItems.delete(productId);
          io.emit('item_unlocked', { productId });
        }
      }

      for (const receiptId of socket.receiptIds || []) {
        const room = `receipt_${receiptId}`;
        const participants = receiptParticipants.get(receiptId);
        if (participants) {
          participants.delete(socket.telegramId);
          if (participants.size === 0) {
            receiptParticipants.delete(receiptId);
          } else {
            receiptParticipants.set(receiptId, participants);
          }
          io.to(room).emit('receipt_users_updated', Array.from(participants.values()));
        }
      }
    });
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { initSocket, getIO };

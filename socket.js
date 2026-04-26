const { Server } = require('socket.io');
const Block = require('./models/Block');

let io = null;

// Tracks which items are currently locked by a user
// Map<productId, { userId, userName, timestamp }>
const lockedItems = new Map();

// Auto-unlock after 60 seconds
const LOCK_TIMEOUT_MS = 60_000;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Join a block room to receive updates for that block
    socket.on('join_block', (blockNumber) => {
      socket.join(`block_${blockNumber}`);
    });

    socket.on('leave_block', (blockNumber) => {
      socket.leave(`block_${blockNumber}`);
    });

    // Lock an item — prevents others from selecting it
    socket.on('lock_item', ({ productId, userId, userName }) => {
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
    socket.on('unlock_item', ({ productId, userId }) => {
      const existing = lockedItems.get(productId);
      if (existing && existing.userId === userId) {
        lockedItems.delete(productId);
        io.emit('item_unlocked', { productId });
      }
    });

    // Move item between blocks
    socket.on('move_item', async ({ productId, fromBlock, toBlock, toIndex, userId }) => {
      try {
        console.log(`[Socket] move_item: product=${productId} from=${fromBlock} to=${toBlock} idx=${toIndex}`);

        const source = await Block.findOne({ blockId: fromBlock });
        const target = fromBlock === toBlock ? source : await Block.findOne({ blockId: toBlock });

        if (!source || !target) {
          console.log('[Socket] move_item: Block not found', { fromBlock, toBlock });
          socket.emit('move_error', { error: 'Block not found' });
          return;
        }

        const idx = source.productIds.findIndex((id) => id.toString() === productId);
        if (idx === -1) {
          console.log('[Socket] move_item: Product not in source block');
          socket.emit('move_error', { error: 'Product not in source block' });
          return;
        }

        source.productIds.splice(idx, 1);
        const safeIndex = Math.min(Math.max(0, toIndex), target.productIds.length);
        target.productIds.splice(safeIndex, 0, productId);

        if (fromBlock === toBlock) {
          source.version += 1;
          await source.save();
        } else {
          source.version += 1;
          target.version += 1;
          await source.save();
          await target.save();
        }

        // Populate and broadcast updated blocks
        const updatedSource = await Block.findOne({ blockId: fromBlock }).populate('productIds').lean();
        const updatedTarget = fromBlock === toBlock
          ? updatedSource
          : await Block.findOne({ blockId: toBlock }).populate('productIds').lean();

        // Broadcast to ALL clients so every board updates in real time
        io.emit('block_updated', updatedSource);
        if (fromBlock !== toBlock) {
          io.emit('block_updated', updatedTarget);
        }

        // Unlock the moved item
        lockedItems.delete(productId);
        io.emit('item_unlocked', { productId });

        // Notify the mover specifically
        socket.emit('move_success', { source: updatedSource, target: updatedTarget });
      } catch (err) {
        console.error('[Socket] move_item error:', err);
        socket.emit('move_error', { error: err.message });
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
      // Release all locks held by this socket
      for (const [productId, data] of lockedItems) {
        if (data.socketId === socket.id) {
          lockedItems.delete(productId);
          io.emit('item_unlocked', { productId });
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

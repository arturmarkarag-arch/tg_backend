const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Block = require('../models/Block');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const BotSession = require('../models/BotSession');
const { archiveProduct, getProductTitle } = require('../services/archiveProduct');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { sendMessageWithRetry } = require('../telegramBot');

const router = express.Router();

function normalizeWorkerId(id) {
  if (!id) return null;
  return String(id).trim();
}

router.get('/workers', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const workers = await User.find({ role: 'warehouse' }).sort({ firstName: 1, lastName: 1 }).lean();
  res.json(workers.map((worker) => ({
    telegramId: worker.telegramId,
    _id: worker._id,
    firstName: worker.firstName,
    lastName: worker.lastName,
    shopName: worker.shopName,
    isWarehouseManager: worker.isWarehouseManager || false,
    isOnShift: worker.isOnShift || false,
    shiftZone: worker.shiftZone || { startBlock: null, endBlock: null },
  })));
});

router.get('/shift-status', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const activeWorkers = await User.find({ role: 'warehouse', isOnShift: true }).lean();
  const activeWorkerIds = activeWorkers.map((worker) => String(worker.telegramId));
  const lockedTasks = await PickingTask.find({ status: 'locked', lockedBy: { $in: activeWorkerIds } })
    .select('lockedBy blockId positionIndex lockedAt')
    .lean();

  const tasksByWorker = new Map();
  for (const task of lockedTasks) {
    const workerTasks = tasksByWorker.get(task.lockedBy) || [];
    workerTasks.push({
      taskId: String(task._id),
      blockId: task.blockId,
      positionIndex: task.positionIndex,
      lockedAt: task.lockedAt,
    });
    tasksByWorker.set(task.lockedBy, workerTasks);
  }

  const response = activeWorkers.map((worker) => ({
    telegramId: worker.telegramId,
    firstName: worker.firstName,
    lastName: worker.lastName,
    shiftZone: worker.shiftZone || { startBlock: null, endBlock: null },
    lockedTasks: tasksByWorker.get(String(worker.telegramId)) || [],
  }));

  res.json(response);
});

router.post('/remove-from-shift', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const { workerId } = req.body;
  if (!workerId) {
    return res.status(400).json({ error: 'workerId is required' });
  }

  const normalizedWorkerId = String(workerId).trim();
  let worker;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      worker = await User.findOne({
        role: 'warehouse',
        telegramId: normalizedWorkerId,
      }).session(session);

      if (!worker) {
        throw Object.assign(new Error('Warehouse worker not found'), { status: 404 });
      }

      worker.isOnShift = false;
      worker.shiftZone = { startBlock: null, endBlock: null };
      await worker.save({ session });

      await PickingTask.updateMany(
        { lockedBy: worker.telegramId, status: 'locked' },
        { $set: { status: 'pending', lockedBy: null, lockedAt: null, skippedBy: [] } },
        { session }
      );

      // Drop active pick/ship sessions so old inline buttons stop working for this worker.
      await BotSession.deleteMany(
        {
          chatId: worker.telegramId,
          type: { $in: ['pick', 'ship'] },
        },
        { session }
      );
    });
  } catch (err) {
    await session.endSession();
    return res.status(err.status || 500).json({ error: err.message || 'Failed to remove worker from shift' });
  }
  await session.endSession();

  try {
    await sendMessageWithRetry(worker.telegramId, 'Менеджер завершив вашу зміну. Поточні завдання скасовано.');
  } catch (err) {
    console.warn(`Failed to notify worker ${worker.telegramId}:`, err?.message || err);
  }

  res.json({ message: 'Worker removed from shift and locked tasks released' });
});

router.post('/confirm-shift', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only warehouse managers or admins can confirm shift assignments' });
  }

  const { workerIds } = req.body;
  if (!Array.isArray(workerIds) || workerIds.length === 0) {
    return res.status(400).json({ error: 'workerIds must be a non-empty array' });
  }

  const normalizedIds = workerIds.map(normalizeWorkerId).filter(Boolean);
  if (normalizedIds.length === 0) {
    return res.status(400).json({ error: 'Invalid workerIds provided' });
  }

  const warehouseWorkers = await User.find({ role: 'warehouse' }).lean();
  const matchedWorkers = warehouseWorkers.filter((worker) =>
    normalizedIds.includes(worker.telegramId) || normalizedIds.includes(String(worker._id))
  );

  if (matchedWorkers.length === 0) {
    return res.status(404).json({ error: 'No matching warehouse workers found' });
  }

  const totalWorkers = matchedWorkers.length;
  const lastBlock = await Block.findOne().sort({ blockId: -1 }).lean();
  const maxBlockNumber = lastBlock ? lastBlock.blockId : 0;

  if (maxBlockNumber === 0) {
    return res.status(400).json({ error: 'No warehouse blocks defined' });
  }

  const blocksPerPerson = Math.floor(maxBlockNumber / totalWorkers);
  if (blocksPerPerson < 1) {
    return res.status(400).json({ error: 'Insufficient blocks to assign to selected workers' });
  }

  const assignments = matchedWorkers.map((worker, index) => {
    const startBlock = index * blocksPerPerson + 1;
    const endBlock = index === totalWorkers - 1 ? maxBlockNumber : (startBlock + blocksPerPerson - 1);
    return {
      telegramId: worker.telegramId,
      shiftZone: { startBlock, endBlock },
    };
  });

  const unresolvedSkippedCount = await PickingTask.countDocuments({
    status: 'pending',
    'skippedBy.0': { $exists: true },
  });

  if (unresolvedSkippedCount > 0) {
    return res.status(409).json({
      error: 'shift_change_blocked_unresolved_skipped_tasks',
      message: `Неможливо почати нову зміну: є ${unresolvedSkippedCount} відкладених позицій, які потрібно завершити в поточній зміні (знайти товар або позначити "Закінчився").`,
      unresolvedSkippedCount,
    });
  }

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await User.updateMany(
        { role: 'warehouse' },
        { $set: { isOnShift: false, shiftZone: { startBlock: null, endBlock: null } } },
        { session }
      );

      await BotSession.deleteMany(
        { type: { $in: ['pick', 'ship'] } },
        { session }
      );

      // Release all currently locked tasks so they can be reassigned in the new shift.
      await PickingTask.updateMany(
        { status: 'locked' },
        { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
        { session }
      );

      for (const assignment of assignments) {
        await User.updateOne(
          { telegramId: assignment.telegramId },
          {
            $set: {
              isOnShift: true,
              shiftZone: assignment.shiftZone,
            },
          },
          { session }
        );
      }
    });
  } finally {
    await session.endSession();
  }

  const notifyPromises = assignments.map(async (assignment) => {
    const worker = matchedWorkers.find((w) => w.telegramId === assignment.telegramId);
    if (!worker) return;
    const message = `✅ Ви призначені на зміну складу.` +
      `\nЗона: ${assignment.shiftZone.startBlock}–${assignment.shiftZone.endBlock}` +
      `\nЯкщо ви не можете вийти на зміну, повідомте адміністратора.`;
    try {
      await sendMessageWithRetry(assignment.telegramId, message);
    } catch (err) {
      console.warn(`Failed to notify warehouse worker ${assignment.telegramId}:`, err.message || err);
    }
  });

  await Promise.all(notifyPromises);

  res.json({
    message: 'Shift confirmed for warehouse workers',
    assigned: assignments,
    requestedBy: requestingUser.telegramId,
  });
});

router.post('/close-shift', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only warehouse managers or admins can close shift' });
  }

  const unresolvedTasksCount = await PickingTask.countDocuments({
    status: { $in: ['pending', 'locked'] },
  });

  if (unresolvedTasksCount > 0) {
    return res.status(409).json({
      error: 'shift_close_blocked_unresolved_tasks',
      message: `Неможливо завершити зміну: залишилось ${unresolvedTasksCount} невирішених позицій (pending/locked).`,
      unresolvedTasksCount,
    });
  }

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await User.updateMany(
        { role: 'warehouse' },
        { $set: { isOnShift: false, shiftZone: { startBlock: null, endBlock: null } } },
        { session }
      );

      await BotSession.deleteMany(
        { type: { $in: ['pick', 'ship'] } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }

  res.json({
    message: 'Shift closed successfully',
    closedBy: requestingUser.telegramId,
  });
});

router.get('/unresolved-skipped', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only warehouse managers or admins can view unresolved skipped tasks' });
  }

  const tasks = await PickingTask.find({
    status: { $in: ['pending', 'locked'] },
    'skippedBy.0': { $exists: true },
  })
    .populate('productId')
    .sort({ blockId: 1, positionIndex: 1 })
    .lean();

  const items = tasks
    .map((task) => {
      const product = task.productId;
      if (!product || product.status === 'archived') return null;
      const pendingQty = (task.items || [])
        .filter((item) => !item.packed)
        .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

      const imageUrl =
        (Array.isArray(product.imageUrls) && product.imageUrls[0]) ||
        product.localImageUrl ||
        null;

      return {
        taskId: String(task._id),
        productId: String(product._id),
        productTitle: getProductTitle(product),
        productStatus: product.status,
        imageUrl,
        blockId: task.blockId,
        positionIndex: task.positionIndex,
        taskStatus: task.status,
        lockedBy: task.lockedBy || null,
        lockedAt: task.lockedAt || null,
        skippedBy: Array.isArray(task.skippedBy) ? task.skippedBy : [],
        skippedCount: Array.isArray(task.skippedBy) ? task.skippedBy.length : 0,
        pendingShopsCount: (task.items || []).filter((item) => !item.packed).length,
        pendingQty,
      };
    })
    .filter(Boolean);

  res.json(items);
});

router.post('/unresolved-skipped/:taskId/archive', requireTelegramRoles(['admin', 'warehouse']), async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    return res.status(403).json({ error: 'Only warehouse managers or admins can archive unresolved skipped tasks' });
  }

  const task = await PickingTask.findById(req.params.taskId).lean();
  if (!task) {
    return res.status(404).json({ error: 'Picking task not found' });
  }

  if (!Array.isArray(task.skippedBy) || task.skippedBy.length === 0) {
    return res.status(400).json({ error: 'This task is not marked as skipped' });
  }

  const product = await Product.findById(task.productId);
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }

  if (product.status === 'archived') {
    return res.status(400).json({ error: 'Product is already archived' });
  }

  const { cancelledCount } = await archiveProduct(product, { notifyBuyers: true });

  res.json({
    message: 'Product archived from unresolved skipped task',
    productId: String(product._id),
    productTitle: getProductTitle(product),
    cancelledOrdersCount: cancelledCount,
    archivedBy: requestingUser.telegramId,
  });
});

module.exports = router;

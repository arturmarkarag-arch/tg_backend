const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Block = require('../models/Block');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const { archiveProduct, getProductTitle } = require('../services/archiveProduct');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');

const router = express.Router();

function normalizeWorkerId(id) {
  if (!id) return null;
  return String(id).trim();
}

router.get('/workers', requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const workers = await User.find({ role: 'warehouse' }).sort({ firstName: 1, lastName: 1 }).lean();
  res.json(workers.map((worker) => ({
    telegramId: worker.telegramId,
    _id: worker._id,
    firstName: worker.firstName,
    lastName: worker.lastName,
    isWarehouseManager: worker.isWarehouseManager || false,
    isOnShift: worker.isOnShift || false,
    shiftZone: worker.shiftZone || { startBlock: null, endBlock: null },
  })));
}));

router.get('/shift-status', requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
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
}));

router.post('/remove-from-shift', requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const { workerId } = req.body;
  if (!workerId) throw appError('warehouse_worker_id_required');

  const normalizedWorkerId = String(workerId).trim();
  let worker;
  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      worker = await User.findOne({
        role: 'warehouse',
        telegramId: normalizedWorkerId,
      }).session(session);

      if (!worker) throw appError('warehouse_worker_not_found');

      worker.isOnShift = false;
      worker.shiftZone = { startBlock: null, endBlock: null };
      await worker.save({ session });

      // Release any tasks locked by this worker so other workers can pick them up.
      await PickingTask.updateMany(
        { lockedBy: worker.telegramId, status: 'locked' },
        { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
        { session }
      );

    });
  } finally {
    await session.endSession();
  }

  res.json({ message: 'Worker removed from shift and locked tasks released' });
}));

router.post('/confirm-shift', requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    throw appError('warehouse_only_manager_confirm');
  }

  const { workerIds } = req.body;
  if (!Array.isArray(workerIds) || workerIds.length === 0) throw appError('warehouse_workerids_required');

  const normalizedIds = workerIds.map(normalizeWorkerId).filter(Boolean);
  if (normalizedIds.length === 0) throw appError('warehouse_workerids_invalid');

  const warehouseWorkers = await User.find({ role: 'warehouse' }).lean();
  const matchedWorkers = warehouseWorkers.filter((worker) =>
    normalizedIds.includes(worker.telegramId) || normalizedIds.includes(String(worker._id))
  );

  if (matchedWorkers.length === 0) throw appError('warehouse_no_matching_workers');

  const totalWorkers = matchedWorkers.length;
  const lastBlock = await Block.findOne().sort({ blockId: -1 }).lean();
  const maxBlockNumber = lastBlock ? lastBlock.blockId : 0;

  if (maxBlockNumber === 0) throw appError('warehouse_no_blocks');

  const blocksPerPerson = Math.floor(maxBlockNumber / totalWorkers);
  if (blocksPerPerson < 1) throw appError('warehouse_insufficient_blocks');

  const assignments = matchedWorkers.map((worker, index) => {
    const startBlock = index * blocksPerPerson + 1;
    const endBlock = index === totalWorkers - 1 ? maxBlockNumber : (startBlock + blocksPerPerson - 1);
    return {
      telegramId: worker.telegramId,
      shiftZone: { startBlock, endBlock },
    };
  });

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await User.updateMany(
        { role: 'warehouse' },
        { $set: { isOnShift: false, shiftZone: { startBlock: null, endBlock: null } } },
        { session }
      );

      // Release all locked/pending tasks for a clean shift.
      await PickingTask.updateMany(
        { status: { $in: ['locked', 'pending'] } },
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

  // Bot-specific (H-7): notifications via bot no longer sent
  // const notifyPromises = assignments.map(async (assignment) => { ... });
  // await Promise.all(notifyPromises);

  res.json({
    message: 'Shift confirmed for warehouse workers',
    assigned: assignments,
    requestedBy: requestingUser.telegramId,
  });
}));

router.post('/close-shift', requireTelegramRoles(['admin', 'warehouse']), asyncHandler(async (req, res) => {
  const requestingUser = req.telegramUser;
  if (!requestingUser.isWarehouseManager && requestingUser.role !== 'admin') {
    throw appError('warehouse_only_manager_close');
  }

  // Bot-specific (H-6): PickingTask guard relied on bot /pick locking — no longer relevant
  // const unresolvedTasksCount = await PickingTask.countDocuments({
  //   status: { $in: ['pending', 'locked'] },
  // });
  // if (unresolvedTasksCount > 0) {
  //   return res.status(409).json({
  //     error: 'shift_close_blocked_unresolved_tasks',
  //     message: `Неможливо завершити зміну: залишилось ${unresolvedTasksCount} невирішених позицій (pending/locked).`,
  //     unresolvedTasksCount,
  //   });
  // }

  const session = await mongoose.connection.startSession();
  try {
    await session.withTransaction(async () => {
      await User.updateMany(
        { role: 'warehouse' },
        { $set: { isOnShift: false, shiftZone: { startBlock: null, endBlock: null } } },
        { session }
      );

      // Release all locked tasks so they are available when the next session starts.
      await PickingTask.updateMany(
        { status: 'locked' },
        { $set: { status: 'pending', lockedBy: null, lockedAt: null } },
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
}));

module.exports = router;

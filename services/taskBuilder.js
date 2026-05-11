'use strict';

const Block = require('../models/Block');
const PickingTask = require('../models/PickingTask');
const Order = require('../models/Order');
const User = require('../models/User');

/**
 * Returns a Map of productId → { blockId, index } for each productId
 * that is physically present in a shipping block (active/pending status).
 */
async function getShippingBlockPositions(productIds) {
  if (!Array.isArray(productIds) || !productIds.length) return new Map();

  const blocks = await Block.find(
    { productIds: { $in: productIds } },
    'blockId productIds'
  )
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .sort({ blockId: 1 })
    .lean();

  const positions = new Map();
  for (const block of blocks) {
    const visibleProducts = (block.productIds || []).filter(Boolean);
    for (let index = 0; index < visibleProducts.length; index += 1) {
      const pid = String(visibleProducts[index]._id);
      if (!positions.has(pid)) {
        positions.set(pid, { blockId: block.blockId, index });
      }
    }
  }

  return positions;
}

/**
 * Creates / appends PickingTask records from all current open orders.
 * Pass targetDeliveryGroupId to scope to one delivery group only.
 *
 * Guard: re-entrant calls are silently dropped (only one run at a time).
 */
async function buildPickingTasksFromOrders(targetDeliveryGroupId = null) {
  if (buildPickingTasksFromOrders._running) return;
  buildPickingTasksFromOrders._running = true;
  try {
    // 1. Find already assigned order/product pairs so we don't create duplicates.
    const activeTaskFilter = { status: { $in: ['pending', 'locked'] } };
    if (targetDeliveryGroupId !== null) activeTaskFilter.deliveryGroupId = String(targetDeliveryGroupId);

    const activeTasks = await PickingTask.find(
      activeTaskFilter,
      'productId items.orderId blockId positionIndex deliveryGroupId'
    ).lean();

    const assignedOrderProducts = new Set();
    for (const task of activeTasks) {
      const pid = String(task.productId);
      for (const item of task.items) {
        assignedOrderProducts.add(`${item.orderId}_${pid}`);
      }
    }

    // 2. Take all active orders and build missing picking tasks.
    const orders = await Order.find({ status: { $in: ['new', 'in_progress'] } })
      .populate('items.productId')
      .sort({ createdAt: 1 })
      .lean();

    const buyerIds = orders.length ? [...new Set(orders.map((order) => order.buyerTelegramId))] : [];
    const buyers = buyerIds.length ? await User.find({ telegramId: { $in: buyerIds } }).lean() : [];
    const buyerMap = new Map(buyers.map((buyer) => [buyer.telegramId, buyer]));

    const productGroups = new Map(); // key: `${productId}::${deliveryGroupId}`
    for (const order of orders) {
      const buyer = buyerMap.get(order.buyerTelegramId);
      const dGroupId = order.buyerSnapshot?.deliveryGroupId || '';

      if (targetDeliveryGroupId !== null && dGroupId !== String(targetDeliveryGroupId)) continue;

      for (const item of order.items) {
        if (item.packed || item.cancelled || !item.productId) continue;
        if (item.productId.status === 'archived') continue;
        const productId = String(item.productId._id);
        if (assignedOrderProducts.has(`${order._id}_${productId}`)) continue;

        const key = `${productId}::${dGroupId}`;
        const group = productGroups.get(key) || {
          productId: item.productId._id,
          deliveryGroupId: dGroupId,
          items: [],
        };
        group.items.push({
          orderId: order._id,
          shopName: order.buyerSnapshot?.shopName || buyer?.shopName || 'невідомий магазин',
          quantity: item.quantity || 0,
          packed: false,
        });
        productGroups.set(key, group);
      }
    }

    // Refresh location of existing pending/locked tasks in case products were moved between blocks.
    if (activeTasks.length) {
      const existingPositions = await getShippingBlockPositions(
        activeTasks.map((t) => String(t.productId))
      );
      await Promise.all(
        activeTasks.map(async (t) => {
          const pos = existingPositions.get(String(t.productId));
          if (!pos) return;
          const newBlockId = pos.blockId;
          const newPosIdx = pos.index + 1;
          if (t.blockId === newBlockId && t.positionIndex === newPosIdx) return;
          await PickingTask.updateOne(
            { _id: t._id },
            { $set: { blockId: newBlockId, positionIndex: newPosIdx } }
          );
        })
      );
    }

    if (!productGroups.size) return;

    const activeTaskByProduct = new Map(
      activeTasks.map((t) => [`${String(t.productId)}::${t.deliveryGroupId || ''}`, t])
    );
    const toAppend = new Map();
    const toInsert = new Map();

    for (const [key, group] of productGroups.entries()) {
      const existing = activeTaskByProduct.get(key);
      if (existing) {
        toAppend.set(key, { taskId: existing._id, newItems: group.items });
      } else {
        toInsert.set(key, group);
      }
    }

    if (toAppend.size) {
      await Promise.all(
        Array.from(toAppend.values()).map(({ taskId, newItems }) =>
          PickingTask.updateOne(
            { _id: taskId },
            { $push: { items: { $each: newItems } } }
          )
        )
      );
    }

    if (!toInsert.size) return;

    const uniqueProductIds = [
      ...new Set(Array.from(toInsert.values()).map((g) => String(g.productId))),
    ];
    const positions = await getShippingBlockPositions(uniqueProductIds);
    const tasks = [];
    for (const [, group] of toInsert.entries()) {
      const position = positions.get(String(group.productId));
      if (!position) continue; // product not placed in any block — skip until warehouse assigns it
      tasks.push({
        productId: group.productId,
        deliveryGroupId: group.deliveryGroupId,
        blockId: position.blockId,
        positionIndex: position.index + 1,
        items: group.items,
      });
    }

    tasks.sort((a, b) => a.blockId - b.blockId || a.positionIndex - b.positionIndex);
    if (!tasks.length) return;

    try {
      await PickingTask.insertMany(tasks, { ordered: false });
    } catch (err) {
      if (err?.code !== 11000 && err?.name !== 'BulkWriteError') {
        console.error('[taskBuilder] PickingTask insert error:', err);
      }
    }
  } finally {
    buildPickingTasksFromOrders._running = false;
  }
}

module.exports = { getShippingBlockPositions, buildPickingTasksFromOrders };

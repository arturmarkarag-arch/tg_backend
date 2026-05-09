require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Order = require('../models/Order');
  const PickingTask = require('../models/PickingTask');
  const DeliveryGroup = require('../models/DeliveryGroup');
  const User = require('../models/User');

  // All active orders
  const orders = await Order.find(
    { status: { $in: ['new', 'in_progress'] } },
    'buyerTelegramId buyerSnapshot status createdAt'
  ).lean();
  console.log('\n=== Active orders:', orders.length, '===');
  const byGroup = {};
  for (const o of orders) {
    const g = o.buyerSnapshot?.deliveryGroupId || '(empty)';
    byGroup[g] = (byGroup[g] || 0) + 1;
  }
  console.log('By deliveryGroupId:', JSON.stringify(byGroup, null, 2));

  // Last 5 orders
  const recent = await Order.find(
    { status: { $in: ['new', 'in_progress'] } },
    'buyerTelegramId buyerSnapshot status createdAt'
  ).sort({ createdAt: -1 }).limit(5).lean();
  console.log('\nMost recent active orders:');
  for (const o of recent) {
    const snap = o.buyerSnapshot || {};
    console.log(`  buyer=${o.buyerTelegramId} | shop="${snap.shopName}" | city="${snap.shopCity}" | dgId="${snap.deliveryGroupId}" | status=${o.status} | created=${o.createdAt}`);
  }

  // Delivery groups
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek').lean();
  console.log('\n=== Delivery groups ===');
  for (const g of groups) {
    console.log(`  ${g._id}  ${g.name}  day=${g.dayOfWeek}`);
  }

  // Picking tasks
  const tasks = await PickingTask.countDocuments({ status: { $in: ['pending', 'locked'] } });
  const tasksByGroup = await PickingTask.aggregate([
    { $match: { status: { $in: ['pending', 'locked'] } } },
    { $group: { _id: '$deliveryGroupId', count: { $sum: 1 } } },
  ]);
  console.log('\n=== Picking tasks (pending+locked):', tasks, '===');
  console.log(JSON.stringify(tasksByGroup, null, 2));

  // Check sellers missing deliveryGroupId
  const sellersNoGroup = await User.countDocuments({ role: 'seller', deliveryGroupId: { $in: ['', null] } });
  const sellersTotal = await User.countDocuments({ role: 'seller' });
  console.log(`\n=== Sellers: ${sellersTotal} total, ${sellersNoGroup} without deliveryGroupId ===`);

  await mongoose.disconnect();
  console.log('\nDone.');
});

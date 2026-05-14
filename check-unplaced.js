'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Product = require('./models/Product');
const Block = require('./models/Block');
const Order = require('./models/Order');
const PickingTask = require('./models/PickingTask');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const placed = new Set(
    (await Block.find({}, 'productIds').lean()).flatMap(b => b.productIds.map(String))
  );

  const active = await Product.find({ status: 'active' }, '_id name orderNumber brand model category quantity createdAt').lean();
  const unplaced = active.filter(p => !placed.has(String(p._id)));

  console.log('\n=== Активні продукти без блоку ===');
  for (const p of unplaced) {
    console.log(`  id=${p._id}  #${p.orderNumber}  "${p.name || p.brand || p.model}"  qty=${p.quantity}  created=${p.createdAt?.toISOString().slice(0,10)}`);
  }

  console.log('\n=== Загальна статистика ===');
  const [total, act, arch, pend] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ status: 'active' }),
    Product.countDocuments({ status: 'archived' }),
    Product.countDocuments({ status: 'pending' }),
  ]);
  console.log(`  Products: total=${total} active=${act} archived=${arch} pending=${pend}`);
  console.log(`  Blocks: ${await Block.countDocuments()}, productIds placed: ${placed.size}`);

  const [orders, activeOrders, pickingPending, pickingLocked] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ status: { $in: ['new', 'in_progress'] } }),
    PickingTask.countDocuments({ status: 'pending' }),
    PickingTask.countDocuments({ status: 'locked' }),
  ]);
  console.log(`  Orders: total=${orders} active=${activeOrders}`);
  console.log(`  PickingTasks: pending=${pickingPending} locked=${pickingLocked}`);

  await mongoose.disconnect();
}
main().catch(console.error);

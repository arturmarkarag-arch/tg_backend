'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const PickingTask = require('./models/PickingTask');
const Product = require('./models/Product');
const Order = require('./models/Order');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  const pendingProductIds = (await Product.find({ status: 'pending' }, '_id').lean()).map(p => p._id);
  const tasks = await PickingTask.find(
    { status: { $in: ['pending', 'locked'] }, productId: { $in: pendingProductIds } }
  ).lean();

  console.log(`\nЗадачі для продуктів зі статусом "pending" (${tasks.length}):\n`);

  for (const t of tasks) {
    const p = await Product.findById(t.productId).lean();
    const title = p?.name || p?.brand || p?.model || `#${p?.orderNumber}` || '?';
    console.log(`Task ${t._id}`);
    console.log(`  Продукт: "${title}"  orderNumber=${p?.orderNumber}  status=${p?.status}  qty=${p?.quantity}`);
    console.log(`  Створено: ${p?.createdAt?.toISOString().slice(0,10)}`);
    console.log(`  blockId=${t.blockId}  positionIndex=${t.positionIndex}  deliveryGroup=${t.deliveryGroupId}`);
    console.log(`  Items (${t.items?.length || 0}):`);
    for (const item of (t.items || [])) {
      const o = await Order.findById(item.orderId, 'status orderingSessionId buyerSnapshot').lean();
      console.log(`    orderId=${item.orderId}  qty=${item.quantity}  packed=${item.packed}`);
      console.log(`      orderStatus=${o?.status || 'NOT FOUND'}  shop=${o?.buyerSnapshot?.shopName || '?'}`);
    }
    console.log();
  }

  await mongoose.disconnect();
}
main().catch(console.error);

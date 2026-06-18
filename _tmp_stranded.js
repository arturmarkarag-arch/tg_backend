require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Order = require('./models/Order');
  const OrderingSession = require('./models/OrderingSession');
  const DeliveryGroup = require('./models/DeliveryGroup');
  const { getOrderingSchedule } = require('./utils/getOrderingSchedule');
  const { getOpenDateWarsaw } = require('./utils/orderingSchedule');

  const schedule = await getOrderingSchedule();
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek').lean();

  for (const g of groups) {
    const openDate = getOpenDateWarsaw(g.dayOfWeek, schedule);
    const cur = await OrderingSession.findOne({ groupId: String(g._id), openDate }, '_id pickingStatus').lean();
    const curId = cur ? String(cur._id) : null;

    const active = await Order.find(
      { 'buyerSnapshot.deliveryGroupId': String(g._id), status: { $in: ['new', 'in_progress'] } },
      'orderNumber status orderingSessionId items.packed items.skipped items.cancelled buyerSnapshot.shopName',
    ).lean();

    const stranded = active.filter((o) => String(o.orderingSessionId || '') !== String(curId || ''));
    if (stranded.length === 0) continue;

    console.log(`\n=== ${g.name} (dow=${g.dayOfWeek}) curSession=${curId} status=${cur?.pickingStatus}`);
    for (const o of stranded) {
      const items = o.items || [];
      const packed = items.filter((i) => i.packed).length;
      const skipped = items.filter((i) => i.skipped).length;
      const cancelled = items.filter((i) => i.cancelled).length;
      const open = items.filter((i) => !i.packed && !i.skipped && !i.cancelled).length;
      console.log(`  #${o.orderNumber} ${o.status} sess=${o.orderingSessionId} ${o.buyerSnapshot?.shopName} | total=${items.length} packed=${packed} open=${open} skip=${skipped} canc=${cancelled}`);
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('THROW:', e.message); process.exit(1); });

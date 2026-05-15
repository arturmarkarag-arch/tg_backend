const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { asyncHandler } = require('../utils/errors');
const DeliveryGroup = require('../models/DeliveryGroup');
const Shop = require('../models/Shop');
const User = require('../models/User');
const Product = require('../models/Product');
const Block = require('../models/Block');
const Order = require('../models/Order');
const PickingTask = require('../models/PickingTask');
const AppSetting = require('../models/AppSetting');
const { buildPickingTasksFromOrders } = require('../services/taskBuilder');
const { findAndLockNext, releaseWorkerAndStaleLocks, completePickingTask } = require('../services/pickingService');
const { getCurrentOrderingSessionId, getWarsawNow, isOrderingOpen, getOrderingWindowOpenAt } = require('../utils/orderingSchedule');
const { getOrderingSchedule, invalidateOrderingScheduleCache, ORDERING_SCHEDULE_KEY } = require('../utils/getOrderingSchedule');
const ShopTransferRequest = require('../models/ShopTransferRequest');
const cache = require('../utils/cache');
const { getIO } = require('../socket');

// Picks a dayOfWeek such that the test group's ordering window is CURRENTLY
// OPEN — sellers can submit orders in the real flow, and the dashboard shows
// "session active". After demo orders are placed, "Відкрити сесію збирання"
// builds picking tasks. This matches the natural app flow.
async function pickActiveOrderingDayOfWeek() {
  const schedule = await getOrderingSchedule();
  for (let day = 0; day < 7; day += 1) {
    if (isOrderingOpen(day, schedule).isOpen) return day;
  }
  return null;
}

// Alternative: pick a day where we're past the closing time but still in the
// "current session" window (picking phase). Used when caller explicitly wants
// orders that immediately enter the picking phase.
async function pickPickingPhaseDayOfWeek() {
  const schedule = await getOrderingSchedule();
  const now = Date.now();
  for (let day = 0; day < 7; day += 1) {
    if (isOrderingOpen(day, schedule).isOpen) continue;
    const openAt = getOrderingWindowOpenAt(day, schedule);
    if (openAt.getTime() < now) return day;
  }
  return null;
}

const router = express.Router();
const jobs = new Map();

// Marker used in every test entity name/id so cleanup-sweep can find leftovers.
// Short suffix so it doesn't overflow UI columns: "Marymont_test", "Марта_test".
const TEST_MARKER = '_test';
const TEST_BLOCK_BASE = 900000; // test blocks start above this id

// A unique 4-hex run token (8 chars) distinguishes concurrent test runs while
// keeping displayed names short. Used in telegramIds and group names only.
function makeRunToken() { return crypto.randomBytes(4).toString('hex'); }
function makeJobId() { return crypto.randomBytes(8).toString('hex'); }
function appendLog(job, message) { job.logs.push(`${new Date().toISOString()} ${message}`); }
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function dbReady() {
  return mongoose.connection?.readyState === 1;
}

// ─── GET /api/warehouse-test/health ─────────────────────────────────────────
// Preflight check: DB connection state, basic counts. Called by the HTML page
// on load so the operator sees whether everything is wired up before running.
router.get('/health', asyncHandler(async (req, res) => {
  const ready = dbReady();
  if (!ready) {
    return res.json({
      dbConnected: false,
      readyState: mongoose.connection?.readyState ?? null,
    });
  }
  const [blockDocs, sellerCount, warehouseCount, leftoverShops, leftoverUsers, leftoverGroups] = await Promise.all([
    Block.find({ blockId: { $lt: TEST_BLOCK_BASE } }, 'blockId productIds').lean(),
    User.countDocuments({ role: 'seller' }),
    User.countDocuments({ role: 'warehouse' }),
    Shop.countDocuments({ name: { $regex: TEST_MARKER } }),
    User.countDocuments({ telegramId: { $regex: TEST_MARKER } }),
    DeliveryGroup.countDocuments({ name: { $regex: TEST_MARKER } }),
  ]);

  // Real delivery groups that have members — these are the source for cloning.
  const realGroups = await DeliveryGroup.find(
    { name: { $not: new RegExp(TEST_MARKER) }, members: { $exists: true, $not: { $size: 0 } } },
    'name dayOfWeek members',
  ).lean();

  const totalProductsInBlocks = blockDocs.reduce((s, b) => s + (b.productIds?.length || 0), 0);

  res.json({
    dbConnected: true,
    productCount: totalProductsInBlocks,
    activeProductCount: totalProductsInBlocks,
    blockCount: blockDocs.length,
    sellerCount,
    warehouseCount,
    realGroups: realGroups.map((g) => ({
      id: String(g._id),
      name: g.name,
      dayOfWeek: g.dayOfWeek,
      memberCount: g.members?.length || 0,
    })),
    leftovers: {
      shops: leftoverShops,
      users: leftoverUsers,
      deliveryGroups: leftoverGroups,
      total: leftoverShops + leftoverUsers + leftoverGroups,
    },
    activeJobs: [...jobs.values()].filter((j) => j.status === 'running').length,
  });
}));

// ─── POST /api/warehouse-test/cleanup ───────────────────────────────────────
// Sweep cleanup: removes EVERY test entity by TEST_MARKER substring. Safe to
// run any time — production data does not contain the marker. Useful when a
// previous run crashed before its `finally` could fire.
router.post('/cleanup', asyncHandler(async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'db_not_connected' });

  // Find test delivery groups first — used to scope PickingTask cleanup
  const testGroups = await DeliveryGroup.find({ name: { $regex: TEST_MARKER } }, '_id').lean();
  const testGroupIds = testGroups.map((g) => String(g._id));
  const testShops = await Shop.find({ name: { $regex: TEST_MARKER } }, '_id').lean();
  const testShopIds = testShops.map((s) => String(s._id));

  const [users, shops, groups, tasks, orders, blocks, transfers] = await Promise.all([
    User.deleteMany({ telegramId: { $regex: TEST_MARKER } }),
    Shop.deleteMany({ _id: { $in: testShopIds } }),
    DeliveryGroup.deleteMany({ _id: { $in: testGroupIds } }),
    testGroupIds.length ? PickingTask.deleteMany({ deliveryGroupId: { $in: testGroupIds } }) : Promise.resolve({ deletedCount: 0 }),
    testShopIds.length ? Order.deleteMany({ shopId: { $in: testShopIds } }) : Promise.resolve({ deletedCount: 0 }),
    Block.deleteMany({ blockId: { $gte: TEST_BLOCK_BASE } }),
    ShopTransferRequest.deleteMany({ sellerTelegramId: { $regex: TEST_MARKER } }),
  ]);

  try {
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    getIO()?.emit?.('delivery_groups_updated');
  } catch { /* non-critical */ }

  res.json({
    deletedUsers: users.deletedCount || 0,
    deletedShops: shops.deletedCount || 0,
    deletedDeliveryGroups: groups.deletedCount || 0,
    deletedPickingTasks: tasks.deletedCount || 0,
    deletedOrders: orders.deletedCount || 0,
    deletedBlocks: blocks.deletedCount || 0,
    deletedTransferRequests: transfers.deletedCount || 0,
  });
}));

// ─── POST /api/warehouse-test/run ───────────────────────────────────────────
// Creates an isolated test scenario using REAL existing products (sampled
// randomly from active inventory), simulates warehouse picking with N active
// workers, then sweeps every created entity in `finally`.
router.post('/run', asyncHandler(async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'db_not_connected' });

  // sourceGroupId: ID of a real delivery group whose sellers/shops we clone.
  // If omitted, falls back to the group with the most members.
  const sourceGroupId = req.body.sourceGroupId || null;
  const activeWorkersCount = Math.max(1, Math.min(50, Number(req.body.activeWorkersCount) || 3));
  const deliveryDay = Number(req.body.deliveryDay);
  // productCount still controls how many product IDs go into the test block
  // (i.e. how many distinct SKUs workers will pick). 0 = use all from real blocks.
  const productCount = Math.max(0, Math.min(500, Number(req.body.productCount) || 0));
  // deliveryDay = -1 → auto-pick day with currently ACTIVE ordering session
  // deliveryDay = -2 → auto-pick day in picking phase (window already closed)
  const rawAutoMinutes = Math.max(0, Math.min(60, Number(req.body.autoScheduleMinutes) || 0));
  let dayOfWeek;
  if (deliveryDay === -1) {
    if (rawAutoMinutes > 0) {
      // autoSchedule will open its own window — no need to find an already-open one.
      dayOfWeek = getWarsawNow().dayOfWeek;
    } else {
      dayOfWeek = await pickActiveOrderingDayOfWeek();
      if (dayOfWeek === null) {
        return res.status(400).json({ error: 'no_active_day_available', message: 'Зараз жодна група не має активного вікна замовлень — оберіть день вручну або змініть розклад.' });
      }
    }
  } else if (deliveryDay === -2) {
    dayOfWeek = await pickPickingPhaseDayOfWeek();
    if (dayOfWeek === null) {
      return res.status(400).json({ error: 'no_picking_phase_day_available', message: 'Жодна група зараз не в picking-фазі.' });
    }
  } else {
    dayOfWeek = Number.isInteger(deliveryDay) && deliveryDay >= 0 && deliveryDay <= 6
      ? deliveryDay
      : getWarsawNow().dayOfWeek;
  }
  // When true, fixtures stay in DB after the run so the operator can inspect
  // the group on the picking page. Cleanup is then triggered manually.
  const keepData = req.body.keepData === true;
  // How long (seconds) to spread order creation over. Each seller places one
  // order; we sleep between them so the operator can watch them appear on the
  // dashboard in real time. 0 = instant.
  const staggerSeconds = Math.max(0, Math.min(180, Number(req.body.staggerSeconds) || 30));
  // Range of items per order. Each seller picks a random count in [min, max].
  const itemsPerOrderMin = Math.max(1, Number(req.body.itemsPerOrderMin) || 5);
  const itemsPerOrderMax = Math.max(itemsPerOrderMin, Number(req.body.itemsPerOrderMax) || 20);
  // autoScheduleMinutes > 0: temporarily override ordering schedule so the
  // window opens RIGHT NOW and closes in N minutes. Restored in finally.
  // 0 = no override (default — use current schedule as-is).
  // Minimum safe value = ceil(staggerSeconds / 60) + 1, otherwise the window
  // may close before all orders are placed and they land in the wrong session.
  const minSafeMinutes = rawAutoMinutes > 0 ? Math.ceil(staggerSeconds / 60) + 1 : 0;
  const autoScheduleMinutes = rawAutoMinutes > 0 ? Math.max(rawAutoMinutes, minSafeMinutes) : 0;

  const jobId = makeJobId();
  const job = {
    id: jobId,
    status: 'pending',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    params: { sourceGroupId, activeWorkersCount, dayOfWeek, productCount, keepData, staggerSeconds, itemsPerOrderMin, itemsPerOrderMax, autoScheduleMinutes },
    progress: { step: 0, total: 6, label: 'Очікування' },
    logs: [],
    result: null,
    error: null,
    cleanup: null,
  };
  jobs.set(jobId, job);

  (async () => {
    let originalSchedule = null;
    let autoCloseHour = null;
    let autoCloseMinute = null;
    try {
      job.status = 'running';
      appendLog(job, '=== START warehouse flow test ===');

      // Always load the real schedule upfront so sessionId computation uses
      // the production openHour, not the modified test schedule or hardcoded defaults.
      originalSchedule = (await AppSetting.findOne({ key: ORDERING_SCHEDULE_KEY }).lean())?.value || null;
      if (!originalSchedule) appendLog(job, 'УВАГА: налаштування розкладу відсутні в БД — sessionId буде з дефолтами (16:00)');

      if (autoScheduleMinutes > 0) {
        const now = getWarsawNow();
        const closeMinuteTotal = now.minute + autoScheduleMinutes + 1;
        autoCloseHour = (now.hour + Math.floor(closeMinuteTotal / 60)) % 24;
        autoCloseMinute = closeMinuteTotal % 60;
        const openMinuteTotal = now.minute > 0 ? now.minute - 1 : 59;
        const openHour = now.minute > 0 ? now.hour : (now.hour - 1 + 24) % 24;
        const testSchedule = { openHour, openMinute: openMinuteTotal, closeHour: autoCloseHour, closeMinute: autoCloseMinute };
        await AppSetting.updateOne(
          { key: ORDERING_SCHEDULE_KEY },
          { $set: { value: testSchedule } },
          { upsert: true },
        );
        await invalidateOrderingScheduleCache();
        appendLog(job, `Розклад: відкрито ${openHour}:${String(openMinuteTotal).padStart(2,'0')} → закрито ${autoCloseHour}:${String(autoCloseMinute).padStart(2,'0')} Warsaw`);
        dayOfWeek = getWarsawNow().dayOfWeek;
        appendLog(job, `dayOfWeek = сьогодні (${dayOfWeek}) — кнопка "Розпочати збирання" з'явиться о ${autoCloseHour}:${String(autoCloseMinute).padStart(2,'0')}`);
      }

      // Step 1: collect product IDs from real blocks (blockId < TEST_BLOCK_BASE).
      // "Active" products in this system are those that live in a real block —
      // pending = incoming/receiving flow, not available for ordering.
      job.progress = { step: 1, total: 6, label: 'Збір товарів з реальних блоків' };
      const realBlocks = await Block.find({ blockId: { $lt: TEST_BLOCK_BASE } }, 'blockId productIds').lean();
      if (realBlocks.length === 0) throw new Error('Немає реальних блоків у БД — спочатку створіть блоки в адмін-панелі');
      const allRealProductIds = realBlocks.flatMap((b) => b.productIds || []);
      const totalActive = allRealProductIds.length;
      if (totalActive === 0) throw new Error('Блоки існують але порожні — додайте товари в блоки');
      appendLog(job, `Знайдено ${realBlocks.length} блоків, ${totalActive} позицій товарів`);

      // Step 2: fixtures — clone sellers+shops from a real delivery group.
      job.progress = { step: 2, total: 6, label: 'Створення фікстур' };
      const runToken = makeRunToken();
      const idSuffix = `_test_${runToken}`; // unique per run, goes in telegramId/groupName

      // Resolve source group: use the explicitly passed ID, or fall back to the
      // group with the most members.
      let sourceGroup = null;
      if (sourceGroupId) {
        sourceGroup = await DeliveryGroup.findById(sourceGroupId).lean();
      }
      if (!sourceGroup) {
        sourceGroup = await DeliveryGroup.find(
          { name: { $not: new RegExp(TEST_MARKER) } },
          'name dayOfWeek members',
        ).lean().then((gs) => gs.sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0))[0] || null);
      }
      if (!sourceGroup) throw new Error('Не знайдено реальних груп доставки — створіть хоча б одну групу');
      appendLog(job, `Джерело: "${sourceGroup.name}" (${sourceGroup.members?.length || 0} продавців)`);

      // Use source group's dayOfWeek unless overridden by deliveryDay param.
      // If deliveryDay was already resolved above (auto-pick), keep it.
      // If deliveryDay = 0–6 explicit, use it. Otherwise fall back to source group.
      const effectiveDayOfWeek = (deliveryDay >= 0 && deliveryDay <= 6) ? deliveryDay
        : (dayOfWeek !== undefined && dayOfWeek !== null) ? dayOfWeek
        : sourceGroup.dayOfWeek;

      const deliveryGroup = await DeliveryGroup.create({
        name: `WT${idSuffix}`,
        dayOfWeek: effectiveDayOfWeek,
        members: [],
      });
      appendLog(job, `DeliveryGroup: ${deliveryGroup._id} (day ${effectiveDayOfWeek})`);

      // Test block: populate with a subset (or all) of real block product IDs.
      const blockProductIds = productCount > 0
        ? shuffle(allRealProductIds).slice(0, productCount)
        : allRealProductIds.slice();
      const maxTestBlock = (await Block.findOne(
        { blockId: { $gte: TEST_BLOCK_BASE } },
        'blockId',
      ).sort({ blockId: -1 }).lean())?.blockId || (TEST_BLOCK_BASE - 1);
      const blockId = maxTestBlock + 1;
      await Block.create({ blockId, productIds: blockProductIds });
      appendLog(job, `Тестовий Block ${blockId}: ${blockProductIds.length} позицій з ${allRealProductIds.length} доступних`);

      // Load sellers from the source group.
      const sourceMemberIds = sourceGroup.members || [];
      const existingSellers = sourceMemberIds.length
        ? await User.find({ telegramId: { $in: sourceMemberIds }, role: 'seller', shopId: { $ne: null } }).lean()
        : [];
      if (existingSellers.length === 0) throw new Error(`Група "${sourceGroup.name}" не має продавців з магазинами`);

      const uniqueShopIds = [...new Set(existingSellers.map((s) => String(s.shopId)).filter(Boolean))];
      const existingShops = await Shop.find({ _id: { $in: uniqueShopIds } }).lean();
      const shopByOrigId = new Map(existingShops.map((s) => [String(s._id), s]));

      // Clone shops — short unique suffix to avoid name clashes between runs.
      const shopNameSuffix = `${TEST_MARKER}_${runToken}`;
      const testShops = await Shop.insertMany(existingShops.map((s) => ({
        name: `${s.name}${shopNameSuffix}`,
        cityId: s.cityId || null,
        deliveryGroupId: String(deliveryGroup._id),
        address: s.address || '',
        isActive: true,
      })));
      const testShopByOrigId = new Map(existingShops.map((orig, i) => [String(orig._id), testShops[i]]));
      appendLog(job, `Створено ${testShops.length} тестових магазинів`);

      // Clone sellers — real names + "_test", unique telegramId.
      const sellerDocs = existingSellers.map((s) => ({
        telegramId: `${s.telegramId}${idSuffix}`,
        role: 'seller',
        firstName: `${s.firstName || 'Seller'}${TEST_MARKER}`,
        lastName: `${s.lastName || ''}${TEST_MARKER}`,
        phoneNumber: s.phoneNumber || '',
        shopId: (testShopByOrigId.get(String(s.shopId)) || testShops[0])._id,
        deliveryGroupId: String(deliveryGroup._id),
      }));
      const sellers = await User.insertMany(sellerDocs);
      appendLog(job, `Створено ${sellers.length} тестових продавців (з "${sourceGroup.name}")`);

      // Populate DeliveryGroup.members with seller telegramIds so the group
      // shows up correctly in admin/picking dashboards (the broadcast feature
      // also reads this list).
      await DeliveryGroup.updateOne(
        { _id: deliveryGroup._id },
        { $set: { members: sellers.map((s) => s.telegramId) } },
      );

      // Invalidate the cached delivery-groups list and notify connected
      // clients so the picking dashboard re-fetches and renders our new group.
      try {
        await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
        const io = getIO();
        io?.emit?.('delivery_groups_updated');
      } catch (e) {
        appendLog(job, `cache/socket notify failed: ${e.message || e}`);
      }
      appendLog(job, 'Інвалідовано кеш delivery groups + socket emit — група має зʼявитись на дашборді');

      // Warehouse workers: clone existing if any, else synthesize.
      const existingWorkers = await User.find({ role: 'warehouse' }).limit(activeWorkersCount).lean();
      const workers = existingWorkers.length
        ? await User.insertMany(existingWorkers.map((w) => ({
          telegramId: `${w.telegramId}${idSuffix}`,
          role: 'warehouse',
          firstName: `${w.firstName || 'Worker'}${TEST_MARKER}`,
          lastName: `${w.lastName || 'Warehouse'}${TEST_MARKER}`,
          deliveryGroupId: String(deliveryGroup._id),
          warehouseZone: w.warehouseZone || '',
          isWarehouseManager: w.isWarehouseManager || false,
        })))
        : await User.insertMany(Array.from({ length: activeWorkersCount }, (_, i) => ({
          telegramId: `wt_worker_${i + 1}${idSuffix}`,
          role: 'warehouse',
          firstName: `Worker${i + 1}${TEST_MARKER}`,
          lastName: `Warehouse${TEST_MARKER}`,
          deliveryGroupId: String(deliveryGroup._id),
        })));
      appendLog(job, `Створено ${workers.length} warehouse-працівників`);

      job.cleanup = {
        deliveryGroupId: String(deliveryGroup._id),
        shopIds: testShops.map((s) => String(s._id)),
        blockId,
        sessionId: null,
        sellerTelegramIds: sellers.map((s) => s.telegramId),
        workerTelegramIds: workers.map((w) => w.telegramId),
      };

      // Step 3: orders — one per seller, staggered over `staggerSeconds` so
      // the operator can demo orders flowing in. Each order picks a small
      // random subset of the sampled products. Socket events fire per-order
      // so connected dashboards update live.
      job.progress = { step: 3, total: 6, label: `Створення замовлень (${staggerSeconds}s)` };
      // When autoScheduleMinutes > 0 the test schedule is already in DB, so we
      // use it for orders — this makes the shop-status table show counts live.
      // After the window closes we migrate orders to the original-schedule sessionId
      // so the picking page works correctly after restoration.
      // When autoScheduleMinutes = 0 we use the original schedule directly (no migration needed).
      const activeScheduleForSession = autoScheduleMinutes > 0
        ? ((await AppSetting.findOne({ key: ORDERING_SCHEDULE_KEY }).lean())?.value || originalSchedule || {})
        : (originalSchedule || {});
      let sessionId = getCurrentOrderingSessionId(String(deliveryGroup._id), effectiveDayOfWeek, activeScheduleForSession);
      appendLog(job, `sessionId: ${sessionId}`);
      job.cleanup.sessionId = sessionId;

      const maxOrderNumber = (await Order.findOne().sort({ orderNumber: -1 }).lean())?.orderNumber || 0;
      let nextOrderNumber = maxOrderNumber + 100000 + 1;

      const intervalMs = staggerSeconds > 0 && sellers.length > 1
        ? Math.floor((staggerSeconds * 1000) / sellers.length)
        : 0;
      const orders = [];
      const groupIdStr = String(deliveryGroup._id);

      for (let i = 0; i < sellers.length; i += 1) {
        const seller = sellers[i];
        const shop = testShops.find((s) => String(s._id) === String(seller.shopId)) || testShops[0];
        // Per-order sample directly from DB — avoids being capped by the
        // initial pool size and gives each order its own random count and mix.
        const orderItemCount = randomInt(itemsPerOrderMin, itemsPerOrderMax);
        // Sample product IDs from the real blocks, then load their documents.
        const sampledIds = shuffle(allRealProductIds).slice(0, Math.min(orderItemCount, allRealProductIds.length));
        const productsInOrder = await Product.find({ _id: { $in: sampledIds } }).lean();
        const items = productsInOrder.map((p) => ({
          productId: p._id,
          name: p.name,
          price: p.price || 0,
          quantity: randomInt(1, 5),
        }));
        const order = await Order.create({
          buyerTelegramId: seller.telegramId,
          shopId: shop._id,
          status: 'new',
          orderNumber: nextOrderNumber,
          orderingSessionId: sessionId,
          buyerSnapshot: {
            shopId: shop._id,
            shopName: shop.name,
            shopCity: 'TestCity',
            deliveryGroupId: groupIdStr,
          },
          items,
          totalPrice: items.reduce((sum, it) => sum + it.price * it.quantity, 0),
        });
        nextOrderNumber += 1;
        orders.push(order);
        appendLog(job, `Order ${i + 1}/${sellers.length} від ${seller.firstName} (${items.length} позицій)`);

        // Push live updates so picking/admin dashboards refresh.
        try {
          const io = getIO();
          io?.emit?.('user_order_updated', { buyerTelegramId: seller.telegramId });
          io?.to?.(`picking_group_${groupIdStr}`).emit('shop_status_changed', { groupId: groupIdStr });
        } catch { /* non-critical */ }

        job.progress = { step: 3, total: 6, label: 'Створення замовлень', completed: i + 1, totalTasks: sellers.length };

        if (intervalMs > 0 && i < sellers.length - 1) {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }
      appendLog(job, `Створено ${orders.length} замовлень за ${staggerSeconds}s`);

      // Step 3b: "дозамовлення" — for ~40% of sellers we add 1–3 extra items
      // to their existing order (same orderingSessionId, same session). This
      // exercises the "add to existing order during open session" flow.
      const refillTargets = shuffle(orders).slice(0, Math.ceil(orders.length * 0.4));
      let refilledCount = 0;
      for (const existing of refillTargets) {
        const extraIds = shuffle(allRealProductIds).slice(0, randomInt(1, 3));
        const extraProds = await Product.find({ _id: { $in: extraIds } }).lean();
        const extraItems = extraProds.map((p) => ({
          productId: p._id,
          name: p.name,
          price: p.price || 0,
          quantity: randomInt(1, 3),
        }));
        const extraTotal = extraItems.reduce((s, it) => s + it.price * it.quantity, 0);
        await Order.updateOne(
          { _id: existing._id, status: { $in: ['new', 'in_progress'] } },
          { $push: { items: { $each: extraItems } }, $inc: { totalPrice: extraTotal } },
        );
        refilledCount += 1;
        try {
          getIO()?.emit?.('user_order_updated', { buyerTelegramId: existing.buyerTelegramId });
        } catch { /* non-critical */ }
        if (intervalMs > 0) await new Promise((r) => setTimeout(r, Math.min(intervalMs, 400)));
      }
      appendLog(job, `Додано додаткові позиції до ${refilledCount} замовлень (дозамовлення)`);

      // Step 4: wait for the ordering window to close, then build picking tasks.
      // When autoScheduleMinutes > 0 we know exactly when the window closes and
      // can sleep until that moment — fully automated, no manual button needed.
      // When keepData=true without autoSchedule the operator uses the real app
      // picking page to start manually (legacy path kept for flexibility).
      if (autoScheduleMinutes > 0) {
        // Calculate ms until autoCloseHour:autoCloseMinute in Warsaw time.
        const nowForWait = getWarsawNow();
        const closeTotalMinutes = autoCloseHour * 60 + autoCloseMinute;
        const nowTotalMinutes = nowForWait.hour * 60 + nowForWait.minute;
        let waitMs = (closeTotalMinutes - nowTotalMinutes) * 60 * 1000;
        if (waitMs < 0) waitMs = 0; // already past close time
        if (waitMs > 0) {
          const waitSec = Math.ceil(waitMs / 1000);
          job.progress = { step: 4, total: 6, label: `Очікування закриття вікна (${waitSec}s)` };
          appendLog(job, `Чекаємо закриття вікна замовлень: ~${waitSec}s до ${autoCloseHour}:${String(autoCloseMinute).padStart(2,'0')} Warsaw...`);
          await new Promise((r) => setTimeout(r, waitMs + 5000)); // +5s grace
          appendLog(job, 'Вікно замовлень закрито. Мігруємо sessionId...');
          // Migrate orders from test-schedule sessionId → original-schedule sessionId
          // so the picking page (which uses the restored schedule) finds them correctly.
          if (originalSchedule) {
            const originalSessionId = getCurrentOrderingSessionId(String(deliveryGroup._id), effectiveDayOfWeek, originalSchedule);
            if (originalSessionId !== sessionId) {
              const migrated = await Order.updateMany(
                { orderingSessionId: sessionId, 'buyerSnapshot.deliveryGroupId': String(deliveryGroup._id) },
                { $set: { orderingSessionId: originalSessionId } },
              );
              sessionId = originalSessionId;
              job.cleanup.sessionId = originalSessionId;
              appendLog(job, `sessionId мігровано → ${originalSessionId} (${migrated.modifiedCount} замовлень)`);
            }
          }
        }
      } else if (keepData) {
        job.progress = { step: 4, total: 6, label: 'Замовлення створено — очікуємо закриття вікна в додатку' };
        appendLog(job, '⏸ keepData=true — дані залишено. Коли вікно замовлень закриється, кнопка "Розпочати збирання" стане активною в додатку (picking page).');
        job.result = {
          deliveryGroupId: String(deliveryGroup._id),
          deliveryGroupName: deliveryGroup.name,
          blockId,
          blockProductCount: blockProductIds.length,
          createdShops: testShops.length,
          createdSellers: sellers.length,
          createdOrders: orders.length,
          sessionId,
        };
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        return;
      }

      job.progress = { step: 4, total: 6, label: 'Генерація picking tasks' };
      await buildPickingTasksFromOrders(String(deliveryGroup._id), { orderingSessionId: sessionId });
      const taskCount = await PickingTask.countDocuments({ deliveryGroupId: String(deliveryGroup._id) });
      appendLog(job, `Побудовано ${taskCount} picking tasks`);

      // When autoSchedule: data stays in DB — warehouse clicks "Розпочати збирання"
      // in the real app to start picking. The test job is done; cleanup is manual.
      if (autoScheduleMinutes > 0) {
        try {
          await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
          const io = getIO();
          io?.emit?.('delivery_groups_updated');
          io?.to?.(`picking_group_${groupIdStr}`).emit('shop_status_changed', { groupId: groupIdStr });
        } catch { /* non-critical */ }
        job.progress = { step: 4, total: 6, label: 'Готово — очікує на склад' };
        appendLog(job, `✅ ${taskCount} picking tasks готові. Натисніть "Розпочати збирання" у picking page додатку.`);
        appendLog(job, `Група: ${deliveryGroup.name} (day=${effectiveDayOfWeek})`);
        job.result = {
          deliveryGroupId: String(deliveryGroup._id),
          deliveryGroupName: deliveryGroup.name,
          blockId,
          blockProductCount: blockProductIds.length,
          createdShops: testShops.length,
          createdSellers: sellers.length,
          createdOrders: orders.length,
          pickingTaskCount: taskCount,
          sessionId,
          awaitingWarehouseStart: true,
        };
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        return;
      }

      if (taskCount === 0) {
        appendLog(job, 'УВАГА: tasks=0. Перевірте чи test block містить товари з реальних блоків.');
      }

      // Step 5: simulate workers picking concurrently.
      job.progress = { step: 5, total: 6, label: 'Імітація роботи складу' };
      const activeWorkers = workers.slice(0, activeWorkersCount);
      let completedTasks = 0;
      let errors = 0;
      const processingTimeoutMs = 35_000;
      const processingDeadline = Date.now() + processingTimeoutMs;
      appendLog(job, `Запуск роботи складу з таймаутом ${processingTimeoutMs / 1000}s`);

      await Promise.all(activeWorkers.map(async (worker) => {
        await releaseWorkerAndStaleLocks(worker.telegramId, String(deliveryGroup._id));
        while (true) {
          if (Date.now() > processingDeadline) {
            appendLog(job, `Worker ${worker.telegramId} припинив роботу через перевищення таймауту`);
            break;
          }
          const { task } = await findAndLockNext(worker.telegramId, blockId, String(deliveryGroup._id));
          if (!task) break;
          try {
            await completePickingTask({
              taskId: String(task._id),
              userTelegramId: worker.telegramId,
              userFirstName: worker.firstName,
              userLastName: worker.lastName,
              userRole: 'warehouse',
              items: [],
            });
            completedTasks += 1;
          } catch (err) {
            errors += 1;
            appendLog(job, `Worker ${worker.telegramId} error: ${err.message || err}`);
          }
          job.progress = { step: 5, total: 6, label: 'Обробка завдань', completed: completedTasks, totalTasks: taskCount };
        }
      }));

      const timedOut = Date.now() > processingDeadline;
      if (timedOut) {
        appendLog(job, `УВАГА: обробка не встигла за ${processingTimeoutMs / 1000}s і була зупинена.`);
      }

      // Step 6: summary.
      job.progress = { step: 6, total: 6, label: 'Підсумок' };
      const fulfilledOrders = await Order.countDocuments({ status: 'fulfilled', orderingSessionId: sessionId });
      const remainingOrders = await Order.countDocuments({ status: { $in: ['new', 'in_progress'] }, orderingSessionId: sessionId });
      appendLog(job, `Tasks done: ${completedTasks}/${taskCount}, errors: ${errors}`);
      appendLog(job, `Orders fulfilled: ${fulfilledOrders}, pending: ${remainingOrders}`);

      job.result = {
        deliveryGroupId: String(deliveryGroup._id),
        blockId,
        blockProductCount: blockProductIds.length,
        createdShops: testShops.length,
        createdSellers: sellers.length,
        createdWorkers: workers.length,
        activeWorkers: activeWorkers.length,
        createdOrders: orders.length,
        taskCount,
        completedTasks,
        errors,
        fulfilledOrders,
        remainingOrders,
        timedOut: timedOut || false,
        sessionId,
      };
      if (timedOut) {
        job.status = 'failed';
        job.error = `processing_timeout_${processingTimeoutMs}`;
      } else {
        job.status = 'completed';
      }
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'failed';
      job.error = err?.message || String(err);
      appendLog(job, `FATAL: ${job.error}`);
    } finally {
      // Restore ordering schedule if we overrode it.
      if (originalSchedule) {
        try {
          await AppSetting.updateOne(
            { key: ORDERING_SCHEDULE_KEY },
            { $set: { value: originalSchedule } },
            { upsert: true },
          );
          await invalidateOrderingScheduleCache();
          appendLog(job, 'Розклад замовлень відновлено до оригінального значення.');
        } catch (e) {
          appendLog(job, `Не вдалось відновити розклад: ${e.message || e}`);
        }
      }
      if (keepData) {
        appendLog(job, '⏸ keepData=true — тестові дані ЗАЛИШЕНО в БД. Очистіть вручну кнопкою "Очистити тестові дані".');
      } else {
        appendLog(job, 'Очищення тимчасових даних...');
        try {
          const summary = await cleanUpJobData(job);
          appendLog(job, `Очищено: ${JSON.stringify(summary)}`);
        } catch (e) {
          appendLog(job, `Cleanup failed: ${e.message || e}`);
        }
      }
      job.finishedAt = job.finishedAt || new Date().toISOString();
    }
  })();

  res.json({ jobId });
}));

// Per-job cleanup. Uses entity IDs captured in `job.cleanup` to remove only
// what this run created — never touches anything else.
async function cleanUpJobData(job) {
  if (!job?.cleanup) return { skipped: true };
  const { deliveryGroupId, shopIds, blockId, sessionId, sellerTelegramIds, workerTelegramIds } = job.cleanup;

  const telegramIds = [...(sellerTelegramIds || []), ...(workerTelegramIds || [])];

  const [users, shops, group, tasks, orders, block] = await Promise.all([
    telegramIds.length ? User.deleteMany({ telegramId: { $in: telegramIds } }) : Promise.resolve({ deletedCount: 0 }),
    shopIds?.length ? Shop.deleteMany({ _id: { $in: shopIds } }) : Promise.resolve({ deletedCount: 0 }),
    deliveryGroupId ? DeliveryGroup.deleteOne({ _id: deliveryGroupId }) : Promise.resolve({ deletedCount: 0 }),
    deliveryGroupId ? PickingTask.deleteMany({ deliveryGroupId }) : Promise.resolve({ deletedCount: 0 }),
    sessionId ? Order.deleteMany({ orderingSessionId: sessionId }) : Promise.resolve({ deletedCount: 0 }),
    blockId ? Block.deleteOne({ blockId }) : Promise.resolve({ deletedCount: 0 }),
  ]);

  try {
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    getIO()?.emit?.('delivery_groups_updated');
  } catch { /* non-critical */ }

  return {
    users: users.deletedCount || 0,
    shops: shops.deletedCount || 0,
    deliveryGroups: group.deletedCount || 0,
    pickingTasks: tasks.deletedCount || 0,
    orders: orders.deletedCount || 0,
    blocks: block.deletedCount || 0,
  };
}

// ─── POST /api/warehouse-test/seed-conflicts ───────────────────────────────
// Creates all 4 shop-transfer conflict scenarios for trainee practice:
//   A. target shop has seller, no orders
//   B. target shop has seller WITH active order (cart-decision required)
//   C. one party has order, other doesn't (variant of B but reversed)
//   D. order migrated from another delivery group (cross-group transfer)
//
// Each scenario creates an actual pending `ShopTransferRequest` with full
// `conflictSnapshot`, so the admin UI renders the conflict resolution flow.
// Everything is tagged with TEST_MARKER and removed by the standard cleanup.
router.post('/seed-conflicts', asyncHandler(async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'db_not_connected' });

  // Reuse the most recent MAIN test run group (skip CFaux auxiliary groups).
  const explicitGroupId = req.body?.groupId;
  let group1;
  if (explicitGroupId) {
    group1 = await DeliveryGroup.findById(explicitGroupId).lean();
  } else {
    group1 = await DeliveryGroup.findOne({
      name: { $regex: TEST_MARKER },
      $nor: [{ name: /CFaux/ }],
    }).sort({ createdAt: -1 }).lean();
  }
  if (!group1) {
    return res.status(404).json({
      error: 'no_test_group',
      message: 'Спершу натисніть "Запустити тест" щоб створити тестову групу — конфлікти додаються до неї.',
    });
  }
  const dayOfWeek = group1.dayOfWeek;

  const cfToken = crypto.randomBytes(3).toString('hex'); // short 6-char token
  const suffix = `_cf${cfToken}${TEST_MARKER}`; // e.g. _cfab1234_test
  const scenarios = [];

  const cfUsableStatuses = ['active', 'pending'];
  const totalActive = await Product.countDocuments({ status: { $in: cfUsableStatuses } });
  if (totalActive === 0) return res.status(400).json({ error: 'no_active_products' });
  const sampled = await Product.aggregate([
    { $match: { status: { $in: cfUsableStatuses } } },
    { $sample: { size: Math.min(20, totalActive) } },
  ]);

  // group2 is auxiliary — only used as the SOURCE side of scenario D.
  const group2 = await DeliveryGroup.create({ name: `WT-CFaux${suffix}`, dayOfWeek, members: [] });
  const sessionId1 = getCurrentOrderingSessionId(String(group1._id), dayOfWeek);
  const sessionId2 = getCurrentOrderingSessionId(String(group2._id), dayOfWeek);

  // Each scenario gets its OWN shops so they don't share sellers/conflicts.
  // CF shops do NOT get the main group's deliveryGroupId — they are "incoming
  // shops" from other regions and should NOT appear on the main picking board.
  const shopDocs = [
    { label: 'A-target',  grpId: '' },        // target has no group yet (new assignment)
    { label: 'B-from',    grpId: '' },
    { label: 'B-target',  grpId: String(group1._id) }, // B-target IS in main group (occupant is there)
    { label: 'C-from',    grpId: '' },
    { label: 'C-target',  grpId: String(group1._id) }, // C-target IS in main group
    { label: 'D-source',  grpId: String(group2._id) }, // cross-group source
  ].map(({ label, grpId }) => ({
    name: `CF-${label}${TEST_MARKER}`,
    deliveryGroupId: grpId || undefined,
    address: 'TestCity',
    isActive: true,
  }));
  const shops = await Shop.insertMany(shopDocs);
  const [shopA, shopBfrom, shopBtgt, shopCfrom, shopCtgt, shopD] = shops;

  // Create source seller for D in group2 (has an order in group2).
  const sellerD = await User.create({
    telegramId: `wt_D${cfToken}${TEST_MARKER}`,
    role: 'seller',
    firstName: `D-src${TEST_MARKER}`,
    lastName: `Seller${TEST_MARKER}`,
    shopId: shopD._id,
    deliveryGroupId: String(group2._id),
  });

  // For each scenario, create the "requesting seller" and any "target occupant".
  const mkSeller = async (label, shop, group) => User.create({
    telegramId: `wt_${label}${cfToken}${TEST_MARKER}`,
    role: 'seller',
    firstName: `${label}${TEST_MARKER}`,
    lastName: `Seller${TEST_MARKER}`,
    shopId: shop?._id || null,
    deliveryGroupId: group ? String(group._id) : '',
  });
  const mkOrder = async (seller, shop, group, sessionId, label) => {
    const itemsCount = randomInt(2, 4);
    const items = shuffle(sampled).slice(0, itemsCount).map((p) => ({
      productId: p._id, name: p.name, price: p.price || 0, quantity: randomInt(1, 3),
    }));
    return Order.create({
      buyerTelegramId: seller.telegramId,
      shopId: shop._id,
      status: 'new',
      orderNumber: Date.now() + Math.floor(Math.random() * 1000),
      orderingSessionId: sessionId,
      buyerSnapshot: {
        shopId: shop._id, shopName: shop.name, shopCity: 'TestCity',
        deliveryGroupId: String(group._id),
      },
      items,
      totalPrice: items.reduce((s, it) => s + it.price * it.quantity, 0),
    });
  };

  // ── A: target shop has occupant, no orders on either side ───────────────
  {
    const requester = await mkSeller('A-req', null, group1);
    const occupant = await mkSeller('A-occ', shopA, group1);
    const req = await ShopTransferRequest.create({
      sellerTelegramId: requester.telegramId,
      sellerName: `${requester.firstName} ${requester.lastName}`,
      isAssignment: true,
      fromShopId: null, fromShopName: '', fromDeliveryGroupId: '',
      toShopId: shopA._id, toShopName: shopA.name, toDeliveryGroupId: String(group1._id),
      conflictSnapshot: {
        targetShopHasSeller: true,
        targetShopSellerName: `${occupant.firstName} ${occupant.lastName}`,
        targetShopSellerTelegramId: occupant.telegramId,
        targetSellerCartHasItems: false, targetSellerCartItemCount: 0,
        targetSellerHasActiveOrder: false, sourceShopHasActiveOrder: false,
        cartHasItems: false, cartItemCount: 0,
      },
    });
    scenarios.push({ id: 'A', label: 'Target has seller, no orders', requestId: String(req._id), shop: shopA.name });
  }

  // ── B: both have orders, target occupant has cart ───────────────────────
  {
    const requester = await mkSeller('B-req', shopBfrom, group1);
    const occupant = await mkSeller('B-occ', shopBtgt, group1);
    const reqOrder = await mkOrder(requester, shopBfrom, group1, sessionId1, 'B-req');
    const occOrder = await mkOrder(occupant, shopBtgt, group1, sessionId1, 'B-occ');
    const req = await ShopTransferRequest.create({
      sellerTelegramId: requester.telegramId,
      sellerName: `${requester.firstName} ${requester.lastName}`,
      isAssignment: false,
      fromShopId: shopBfrom._id, fromShopName: shopBfrom.name, fromDeliveryGroupId: String(group1._id),
      toShopId: shopBtgt._id, toShopName: shopBtgt.name, toDeliveryGroupId: String(group1._id),
      conflictSnapshot: {
        targetShopHasSeller: true,
        targetShopSellerName: `${occupant.firstName} ${occupant.lastName}`,
        targetShopSellerTelegramId: occupant.telegramId,
        targetSellerCartHasItems: true, targetSellerCartItemCount: occOrder.items.length,
        targetSellerHasActiveOrder: true, targetSellerActiveOrderId: occOrder._id,
        sourceShopHasActiveOrder: true, sourceShopActiveOrderId: reqOrder._id,
        cartHasItems: true, cartItemCount: reqOrder.items.length,
      },
    });
    scenarios.push({ id: 'B', label: 'Both sellers have active orders', requestId: String(req._id), shop: shopBtgt.name });
  }

  // ── C: requester HAS order, target shop is EMPTY ────────────────────────
  {
    const requester = await mkSeller('C-req', shopCfrom, group1);
    const reqOrder = await mkOrder(requester, shopCfrom, group1, sessionId1, 'C-req');
    const req = await ShopTransferRequest.create({
      sellerTelegramId: requester.telegramId,
      sellerName: `${requester.firstName} ${requester.lastName}`,
      isAssignment: false,
      fromShopId: shopCfrom._id, fromShopName: shopCfrom.name, fromDeliveryGroupId: String(group1._id),
      toShopId: shopCtgt._id, toShopName: shopCtgt.name, toDeliveryGroupId: String(group1._id),
      conflictSnapshot: {
        targetShopHasSeller: false,
        sourceShopHasActiveOrder: true, sourceShopActiveOrderId: reqOrder._id,
        cartHasItems: true, cartItemCount: reqOrder.items.length,
      },
    });
    scenarios.push({ id: 'C', label: 'Requester has order, target empty', requestId: String(req._id), shop: shopCtgt.name });
  }

  // ── D: cross-group transfer, order from another group migrates ──────────
  {
    const orderD = await mkOrder(sellerD, shopD, group2, sessionId2, 'D');
    const req = await ShopTransferRequest.create({
      sellerTelegramId: sellerD.telegramId,
      sellerName: `${sellerD.firstName} ${sellerD.lastName}`,
      isAssignment: false,
      fromShopId: shopD._id, fromShopName: shopD.name, fromDeliveryGroupId: String(group2._id),
      toShopId: shopA._id, toShopName: shopA.name, toDeliveryGroupId: String(group1._id),
      conflictSnapshot: {
        targetShopHasSeller: false,
        sourceShopHasActiveOrder: true, sourceShopActiveOrderId: orderD._id,
        cartHasItems: true, cartItemCount: orderD.items.length,
        crossGroup: true,
      },
    });
    scenarios.push({ id: 'D', label: 'Order migrates from another group', requestId: String(req._id), fromShop: shopD.name, toShop: shopA.name });
  }

  // Invalidate delivery-groups cache + notify dashboards.
  try {
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    getIO()?.emit?.('delivery_groups_updated');
  } catch { /* non-critical */ }

  res.json({
    groups: [{ id: String(group1._id), name: group1.name }, { id: String(group2._id), name: group2.name }],
    scenarios,
  });
}));

// ─── POST /api/warehouse-test/start-picking ────────────────────────────────
// Builds PickingTasks from the orders placed during a staggered run.
//
// Important: we DO NOT shift the group's dayOfWeek. The orders' stored
// `orderingSessionId` is derived from `getCurrentOrderingSessionId(groupId,
// dayOfWeek)`; shifting dayOfWeek would change what the app considers the
// "current session" and the orders would appear as stale.
//
// Whether picking is actually allowed on the dashboard depends on the app's
// own session logic: if the group's ordering window is currently CLOSED, the
// warehouse can pick. Choose a dayOfWeek for the test that lines up with the
// current Warsaw time (default in UI = today).
router.post('/start-picking', asyncHandler(async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'db_not_connected' });

  let groupId = req.body?.groupId;
  if (!groupId) {
    // Skip auxiliary CFaux groups (created for conflict scenario D) — find the
    // latest MAIN test run group (name starts with "WT_test_").
    const latest = await DeliveryGroup.findOne({
      name: { $regex: TEST_MARKER },
      $nor: [{ name: /CFaux/ }],
    }).sort({ createdAt: -1 }).lean();
    if (!latest) return res.status(404).json({ error: 'no_test_group' });
    groupId = String(latest._id);
  }

  const group = await DeliveryGroup.findById(groupId).lean();
  if (!group) return res.status(404).json({ error: 'group_not_found' });

  // Use the sessionId stored on the orders themselves so picking tasks are
  // built for exactly the same session as the orders we just placed.
  const latestOrder = await Order.findOne({ 'buyerSnapshot.deliveryGroupId': String(group._id) })
    .sort({ createdAt: -1 })
    .select('orderingSessionId')
    .lean();
  const sessionId = latestOrder?.orderingSessionId;
  if (sessionId) {
    await buildPickingTasksFromOrders(String(group._id), { orderingSessionId: sessionId });
  }
  const taskCount = await PickingTask.countDocuments({ deliveryGroupId: String(group._id) });

  try {
    await cache.invalidate(cache.KEYS.DELIVERY_GROUPS);
    const io = getIO();
    io?.emit?.('delivery_groups_updated');
    io?.to?.(`picking_group_${String(group._id)}`).emit('shop_status_changed', { groupId: String(group._id) });
  } catch { /* non-critical */ }

  res.json({
    groupId: String(group._id),
    groupName: group.name,
    dayOfWeek: group.dayOfWeek,
    sessionId: sessionId || null,
    pickingTaskCount: taskCount,
    hint: 'Якщо вікно замовлень для цієї групи зараз ВІДКРИТЕ, picking може бути заблокований логікою сесій. Оберіть dayOfWeek = сьогодні Warsaw.',
  });
}));

router.get('/status/:jobId', asyncHandler(async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json(job);
}));

// Lightweight list of recent jobs for the UI.
router.get('/jobs', asyncHandler(async (req, res) => {
  const list = [...jobs.values()]
    .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''))
    .slice(0, 20)
    .map((j) => ({
      id: j.id,
      status: j.status,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      params: j.params,
      error: j.error,
    }));
  res.json(list);
}));

module.exports = router;

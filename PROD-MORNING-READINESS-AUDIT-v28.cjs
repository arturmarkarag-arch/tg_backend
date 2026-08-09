'use strict';

/**
 * V28 PROD MORNING READINESS AUDIT — READ-ONLY DATABASE AUDIT
 *
 * What this script is for:
 *   Before replacing the old production server/client with V28, prove that the
 *   already prepared/current warehouse session will still be the SAME session
 *   under the V28 per-DeliveryGroup schedule logic, and detect data that would
 *   block "Розпочати" or prevent clean session completion.
 *
 * IMPORTANT ENV LAYOUT (this script is built for it):
 *
 *   project/
 *     .env          <-- SOURCE OF TRUTH, loaded explicitly with override:true
 *     server/
 *       package.json
 *       node_modules/
 *       models/
 *       utils/
 *       ...
 *
 * Run from the V28 server folder:
 *   node PROD-MORNING-READINESS-AUDIT-v28.cjs
 *
 * You can also place the script in server/scripts/; it auto-detects server root.
 *
 * DB SAFETY:
 *   - no create/update/delete/save/insert/bulkWrite operations are called;
 *   - mongoose autoIndex/autoCreate are disabled;
 *   - Redis check, if REDIS_URL exists, uses PING only;
 *   - a JSON report is written only to the LOCAL filesystem.
 */

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------------
// Locate V28 server root and load ../.env FIRST.
// -----------------------------------------------------------------------------

function isServerRoot(dir) {
  return Boolean(
    dir
    && fs.existsSync(path.join(dir, 'package.json'))
    && fs.existsSync(path.join(dir, 'models', 'DeliveryGroup.js'))
    && fs.existsSync(path.join(dir, 'models', 'OrderingSession.js'))
    && fs.existsSync(path.join(dir, 'utils', 'orderingSchedule.js'))
  );
}

function walkUpForServer(startDir) {
  let current = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    if (isServerRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const SERVER_ROOT =
  walkUpForServer(process.cwd())
  || walkUpForServer(__dirname)
  || walkUpForServer(path.dirname(__dirname));

if (!SERVER_ROOT) {
  console.error('❌ Не знайдено V28 server root (package.json + models + utils).');
  console.error('   Запусти скрипт із папки V28/server або поклади його в V28/server/scripts/.');
  process.exit(2);
}

const ENV_PATH = path.resolve(SERVER_ROOT, '..', '.env');
if (!fs.existsSync(ENV_PATH)) {
  console.error(`❌ Не знайдено головний .env на рівень вище server:\n   ${ENV_PATH}`);
  process.exit(2);
}

let dotenv;
try {
  dotenv = require(require.resolve('dotenv', { paths: [SERVER_ROOT] }));
} catch (err) {
  console.error('❌ Не знайдено dotenv у server/node_modules. Спочатку виконай npm ci/npm install у server.');
  process.exit(2);
}

const envResult = dotenv.config({ path: ENV_PATH, override: true });
if (envResult.error) {
  console.error(`❌ Не вдалося прочитати ${ENV_PATH}: ${envResult.error.message}`);
  process.exit(2);
}

// -----------------------------------------------------------------------------
// Load project runtime AFTER the parent .env is in process.env.
// -----------------------------------------------------------------------------

const mongoose = require(require.resolve('mongoose', { paths: [SERVER_ROOT] }));
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const DeliveryGroup = require(path.join(SERVER_ROOT, 'models', 'DeliveryGroup'));
const OrderingSession = require(path.join(SERVER_ROOT, 'models', 'OrderingSession'));
const Order = require(path.join(SERVER_ROOT, 'models', 'Order'));
const PickingTask = require(path.join(SERVER_ROOT, 'models', 'PickingTask'));
const Product = require(path.join(SERVER_ROOT, 'models', 'Product'));
const Block = require(path.join(SERVER_ROOT, 'models', 'Block'));
const AppSetting = require(path.join(SERVER_ROOT, 'models', 'AppSetting'));

const {
  isOrderingOpen,
  getOpenDateWarsaw,
  getOrderingWindowBoundsForOpenDate,
  getSessionDeliveryDate,
  normalizeOrderingSchedule,
  validateOrderingScheduleDeliveryDay,
  getWarsawNow,
} = require(path.join(SERVER_ROOT, 'utils', 'orderingSchedule'));

const {
  buildLegacyCompatibleGroupSchedule,
} = require(path.join(SERVER_ROOT, 'utils', 'legacyOrderingScheduleMigration'));

const MONGODB_URI = String(process.env.MONGODB_URI || '').trim();
if (!MONGODB_URI) {
  console.error(`❌ MONGODB_URI відсутній у ${ENV_PATH}`);
  process.exit(2);
}

const NOW = new Date();
const ACTIVE_ORDER_STATUSES = ['new', 'in_progress'];
const TERMINAL_ORDER_STATUSES = ['fulfilled', 'confirmed', 'cancelled'];
const ACTIVE_TASK_STATUSES = ['pending', 'locked'];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const str = (v) => (v == null ? '' : String(v));
const terminalItem = (item) => Boolean(item?.packed || item?.cancelled || item?.skipped);

function uriMeta(uri) {
  try {
    const parsed = new URL(uri);
    return {
      host: parsed.hostname || '(unknown)',
      db: parsed.pathname.replace(/^\//, '') || '(default)',
    };
  } catch {
    return { host: '(unparsed)', db: '(unparsed)' };
  }
}

function redisMeta(uri) {
  if (!uri) return { configured: false, host: '(not configured)' };
  try {
    const parsed = new URL(uri);
    return { configured: true, host: parsed.hostname || '(unknown)' };
  } catch {
    return { configured: true, host: '(configured/unparsed)' };
  }
}

function schedulePlain(schedule) {
  if (!schedule) return null;
  return {
    startDay: Number(schedule.startDay),
    startHour: Number(schedule.startHour),
    startMinute: Number(schedule.startMinute),
    endDay: Number(schedule.endDay),
    endHour: Number(schedule.endHour),
    endMinute: Number(schedule.endMinute),
  };
}

function scheduleKey(schedule) {
  return JSON.stringify(schedulePlain(schedule));
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function localStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function pushIssue(bucket, severity, code, message, details = {}) {
  bucket.push({ severity, code, message, ...details });
}

function countSeverity(issues, severity) {
  return issues.filter((x) => x.severity === severity).length;
}

function formatIssue(issue, indent = '   ') {
  const marker = issue.severity === 'critical' ? '❌' : issue.severity === 'warning' ? '⚠️' : 'ℹ️';
  return `${indent}${marker} [${issue.code}] ${issue.message}`;
}

function parkedOrder(order) {
  return (
    !str(order.shopId)
    && !str(order.buyerSnapshot?.shopId)
    && !str(order.buyerSnapshot?.deliveryGroupId)
  );
}

async function pingRedisReadOnly() {
  const url = String(process.env.REDIS_URL || '').trim();
  if (!url) return { configured: false, ok: null, message: 'REDIS_URL не заданий' };

  let Redis;
  try {
    Redis = require(require.resolve('ioredis', { paths: [SERVER_ROOT] }));
  } catch (err) {
    return { configured: true, ok: false, message: `ioredis не знайдено: ${err.message}` };
  }

  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const pong = await client.ping();
    return { configured: true, ok: pong === 'PONG', message: `PING=${pong}` };
  } catch (err) {
    return { configured: true, ok: false, message: err.message };
  } finally {
    try { client.disconnect(); } catch {}
  }
}

function hasNamedUniqueIndex(indexes, name) {
  return indexes.some((idx) => idx.name === name && idx.unique === true);
}

function hasSessionUniqueIndex(indexes) {
  return indexes.some((idx) => {
    const key = idx.key || {};
    return idx.unique === true
      && Number(key.groupId) === 1
      && Number(key.openDate) === 1
      && Object.keys(key).length === 2;
  });
}

// -----------------------------------------------------------------------------
// Global DB integrity/index audit.
// -----------------------------------------------------------------------------

async function auditGlobalIntegrity() {
  const issues = [];

  const [orderIndexes, taskIndexes, blockIndexes, sessionIndexes] = await Promise.all([
    Order.collection.indexes(),
    PickingTask.collection.indexes(),
    Block.collection.indexes(),
    OrderingSession.collection.indexes(),
  ]);

  const indexChecks = {
    orderUnique: hasNamedUniqueIndex(orderIndexes, 'one_active_order_per_buyer_shop_session'),
    taskUnique: hasNamedUniqueIndex(taskIndexes, 'one_active_task_per_product_group_session'),
    blockUnique: hasNamedUniqueIndex(blockIndexes, 'one_product_per_nonempty_block'),
    sessionUnique: hasSessionUniqueIndex(sessionIndexes),
  };

  if (!indexChecks.orderUnique) pushIssue(issues, 'critical', 'index_order_unique_missing', 'Відсутній unique index active Order per seller+shop+session.');
  if (!indexChecks.taskUnique) pushIssue(issues, 'critical', 'index_task_unique_missing', 'Відсутній session-scoped unique index PickingTask.');
  if (!indexChecks.blockUnique) pushIssue(issues, 'critical', 'index_block_unique_missing', 'Відсутній partial unique index товару між непорожніми блоками.');
  if (!indexChecks.sessionUnique) pushIssue(issues, 'critical', 'index_session_unique_missing', 'Відсутній unique index OrderingSession(groupId, openDate).');

  const [
    groups,
    sessions,
    activeOrders,
    activeTasks,
    duplicateOrders,
    duplicateTasks,
    duplicateBlockProducts,
    terminalOrders,
  ] = await Promise.all([
    DeliveryGroup.find({}, '_id name').lean(),
    OrderingSession.find({}, '_id groupId openDate pickingStatus').lean(),
    Order.find(
      { status: { $in: ACTIVE_ORDER_STATUSES } },
      '_id buyerTelegramId shopId orderingSessionId buyerSnapshot status items orderNumber',
    ).lean(),
    PickingTask.find(
      { status: { $in: ACTIVE_TASK_STATUSES } },
      '_id productId deliveryGroupId orderingSessionId status lockedBy lockedAt blockId positionIndex',
    ).lean(),
    Order.aggregate([
      {
        $match: {
          status: { $in: ACTIVE_ORDER_STATUSES },
          shopId: { $type: 'objectId' },
          orderingSessionId: { $gt: '' },
        },
      },
      {
        $group: {
          _id: {
            buyerTelegramId: '$buyerTelegramId',
            shopId: '$shopId',
            orderingSessionId: '$orderingSessionId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]),
    PickingTask.aggregate([
      { $match: { status: { $in: ACTIVE_TASK_STATUSES } } },
      {
        $group: {
          _id: {
            productId: '$productId',
            deliveryGroupId: '$deliveryGroupId',
            orderingSessionId: '$orderingSessionId',
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]),
    Block.aggregate([
      { $unwind: '$productIds' },
      {
        $group: {
          _id: '$productIds',
          count: { $sum: 1 },
          blocks: { $addToSet: '$blockId' },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]),
    Order.find(
      { status: { $in: TERMINAL_ORDER_STATUSES } },
      '_id orderNumber status orderingSessionId buyerSnapshot items',
    ).lean(),
  ]);

  const groupIds = new Set(groups.map((g) => str(g._id)));
  const sessionById = new Map(sessions.map((s) => [str(s._id), s]));

  const orphanSessions = sessions.filter((s) => !groupIds.has(str(s.groupId)));
  const activeOrdersMissingSessionId = activeOrders.filter((o) => !str(o.orderingSessionId));
  const activeTasksMissingSessionId = activeTasks.filter((t) => !str(t.orderingSessionId));
  const activeOrdersMissingSession = activeOrders.filter((o) => str(o.orderingSessionId) && !sessionById.has(str(o.orderingSessionId)));
  const activeTasksMissingSession = activeTasks.filter((t) => str(t.orderingSessionId) && !sessionById.has(str(t.orderingSessionId)));

  const activeOrderGroupMismatch = activeOrders.filter((o) => {
    const s = sessionById.get(str(o.orderingSessionId));
    if (!s || parkedOrder(o)) return false;
    return str(o.buyerSnapshot?.deliveryGroupId) !== str(s.groupId);
  });

  const activeTaskGroupMismatch = activeTasks.filter((t) => {
    const s = sessionById.get(str(t.orderingSessionId));
    if (!s) return false;
    return str(t.deliveryGroupId) !== str(s.groupId);
  });

  const terminalOrdersWithNonterminalItems = terminalOrders.filter((o) =>
    !parkedOrder(o) && (o.items || []).some((item) => !terminalItem(item))
  );

  if (duplicateOrders.length) pushIssue(issues, 'critical', 'duplicate_active_orders', `Є дублікати active Order keys: ${duplicateOrders.length}.`);
  if (duplicateTasks.length) pushIssue(issues, 'critical', 'duplicate_active_tasks', `Є дублікати active PickingTask keys: ${duplicateTasks.length}.`);
  if (duplicateBlockProducts.length) pushIssue(issues, 'critical', 'duplicate_block_products', `Один і той самий товар фізично присутній у кількох блоках: ${duplicateBlockProducts.length}.`);
  if (activeOrdersMissingSessionId.length) pushIssue(issues, 'warning', 'active_orders_without_session_id', `Active Orders без orderingSessionId: ${activeOrdersMissingSessionId.length}. Це legacy/stale дані; V28 current-session picking їх не використовує, тому самі по собі вони не блокують нову зміну.`);
  if (activeTasksMissingSessionId.length) pushIssue(issues, 'warning', 'active_tasks_without_session_id', `Active PickingTasks без orderingSessionId: ${activeTasksMissingSessionId.length}. Це legacy/orphan repair data, не current-session blocker.`);
  if (activeOrdersMissingSession.length) pushIssue(issues, 'warning', 'active_orders_missing_session', `Active Orders посилаються на неіснуючу OrderingSession: ${activeOrdersMissingSession.length}. Це stale/orphan warning; current-session checks нижче окремо ловлять реальні blockers.`);
  if (activeTasksMissingSession.length) pushIssue(issues, 'warning', 'active_tasks_missing_session', `Active PickingTasks посилаються на неіснуючу OrderingSession: ${activeTasksMissingSession.length}. Це orphan repair warning, не blocker нової session.`);
  if (activeOrderGroupMismatch.length) pushIssue(issues, 'warning', 'active_order_group_mismatch', `Active Order/session group mismatch поза контекстом current group audit: ${activeOrderGroupMismatch.length}. Current-session mismatch нижче є CRITICAL; historical/stale mismatch не блокує нову зміну.`);
  if (activeTaskGroupMismatch.length) pushIssue(issues, 'warning', 'active_task_group_mismatch', `Active PickingTask/session group mismatch поза current group audit: ${activeTaskGroupMismatch.length}. Current-session mismatch нижче є CRITICAL; old debris не блокує нову зміну.`);
  if (terminalOrdersWithNonterminalItems.length) {
    pushIssue(
      issues,
      'warning',
      'terminal_orders_with_nonterminal_items',
      `Історично в БД є terminal Orders з нетермінальними позиціями: ${terminalOrdersWithNonterminalItems.length}. Старі сесії не повинні блокувати current session; current-session broken lines нижче перевіряються окремо як CRITICAL.`,
    );
  }
  if (orphanSessions.length) {
    pushIssue(issues, 'warning', 'orphan_historical_sessions', `OrderingSession без існуючої DeliveryGroup: ${orphanSessions.length}. Самі по собі старі orphan sessions НЕ повинні блокувати нову зміну.`);
  }

  return {
    issues,
    indexChecks,
    counts: {
      groups: groups.length,
      sessions: sessions.length,
      activeOrders: activeOrders.length,
      activeTasks: activeTasks.length,
      orphanSessions: orphanSessions.length,
      duplicateOrders: duplicateOrders.length,
      duplicateTasks: duplicateTasks.length,
      duplicateBlockProducts: duplicateBlockProducts.length,
      activeOrdersMissingSessionId: activeOrdersMissingSessionId.length,
      activeTasksMissingSessionId: activeTasksMissingSessionId.length,
      activeOrdersMissingSession: activeOrdersMissingSession.length,
      activeTasksMissingSession: activeTasksMissingSession.length,
      activeOrderGroupMismatch: activeOrderGroupMismatch.length,
      activeTaskGroupMismatch: activeTaskGroupMismatch.length,
      terminalOrdersWithNonterminalItems: terminalOrdersWithNonterminalItems.length,
    },
  };
}

// -----------------------------------------------------------------------------
// Per-group old-runtime -> V28 continuity + "press Start" readiness.
// -----------------------------------------------------------------------------

async function auditGroup(group, legacyValue) {
  const issues = [];
  const groupId = str(group._id);
  const groupName = group.name || groupId;

  let v28Schedule;
  try {
    v28Schedule = normalizeOrderingSchedule(group.orderingSchedule);
    validateOrderingScheduleDeliveryDay(v28Schedule, group.dayOfWeek);
  } catch (err) {
    pushIssue(issues, 'critical', 'invalid_v28_schedule', `V28 orderingSchedule невалідний: ${err.message}`);
    return { groupId, groupName, dayOfWeek: group.dayOfWeek, issues, state: 'BLOCKED' };
  }

  const v28OpenDate = getOpenDateWarsaw(v28Schedule, NOW);
  const v28Window = isOrderingOpen(v28Schedule, NOW);
  const bounds = getOrderingWindowBoundsForOpenDate(v28OpenDate, v28Schedule);
  const deliveryDate = getSessionDeliveryDate(v28OpenDate, group.dayOfWeek, v28Schedule);

  let legacySchedule = null;
  let legacyOpenDate = null;
  let legacyWindowOpen = null;
  if (legacyValue) {
    try {
      legacySchedule = buildLegacyCompatibleGroupSchedule(group.dayOfWeek, legacyValue);
      legacyOpenDate = getOpenDateWarsaw(legacySchedule, NOW);
      legacyWindowOpen = isOrderingOpen(legacySchedule, NOW).isOpen;
    } catch (err) {
      pushIssue(issues, 'critical', 'legacy_schedule_unreadable', `Не можу відтворити старий global schedule: ${err.message}`);
    }
  } else {
    pushIssue(issues, 'critical', 'legacy_schedule_missing', "Немає AppSetting('ordering.schedule'): неможливо довести old→V28 continuity готової ранкової сесії.");
  }

  const [v28Session, legacySession] = await Promise.all([
    OrderingSession.findOne(
      { groupId, openDate: v28OpenDate },
      '_id groupId seq openDate openAt closeAt scheduleSnapshot openNotifiedAt pickingStatus pickingConfirmedAt pickingStartedAt pickingCompletedAt events shopNumbers',
    ).lean(),
    legacyOpenDate
      ? OrderingSession.findOne(
        { groupId, openDate: legacyOpenDate },
        '_id groupId seq openDate pickingStatus',
      ).lean()
      : null,
  ]);

  const v28SessionId = v28Session ? str(v28Session._id) : '';
  const legacySessionId = legacySession ? str(legacySession._id) : '';

  const [v28Orders, legacyOrders, currentTasks, staleOrders, staleTasks] = await Promise.all([
    v28SessionId
      ? Order.find(
        { orderingSessionId: v28SessionId, status: { $ne: 'expired' } },
        '_id orderNumber status buyerTelegramId shopId buyerSnapshot items createdAt updatedAt',
      ).lean()
      : [],
    legacySessionId
      ? Order.find(
        { orderingSessionId: legacySessionId, status: { $ne: 'expired' } },
        '_id status',
      ).lean()
      : [],
    v28SessionId
      ? PickingTask.find(
        { orderingSessionId: v28SessionId },
        '_id productId deliveryGroupId orderingSessionId status blockId positionIndex lockedBy lockedAt items.orderId',
      ).lean()
      : [],
    v28SessionId
      ? Order.find(
        {
          'buyerSnapshot.deliveryGroupId': groupId,
          status: { $in: ACTIVE_ORDER_STATUSES },
          orderingSessionId: { $ne: v28SessionId },
        },
        '_id orderNumber orderingSessionId buyerTelegramId buyerSnapshot createdAt',
      ).lean()
      : Order.find(
        {
          'buyerSnapshot.deliveryGroupId': groupId,
          status: { $in: ACTIVE_ORDER_STATUSES },
        },
        '_id orderNumber orderingSessionId buyerTelegramId buyerSnapshot createdAt',
      ).lean(),
    v28SessionId
      ? PickingTask.find(
        {
          deliveryGroupId: groupId,
          status: { $in: ACTIVE_TASK_STATUSES },
          orderingSessionId: { $ne: v28SessionId },
        },
        '_id productId orderingSessionId status blockId positionIndex lockedBy lockedAt',
      ).lean()
      : PickingTask.find(
        { deliveryGroupId: groupId, status: { $in: ACTIVE_TASK_STATUSES } },
        '_id productId orderingSessionId status blockId positionIndex lockedBy lockedAt',
      ).lean(),
  ]);

  // Exact old -> V28 handover checks.
  if (legacySchedule) {
    if (legacyOpenDate !== v28OpenDate) {
      pushIssue(
        issues,
        'critical',
        'open_date_changes',
        `V28 обирає інший current openDate: old=${legacyOpenDate}, V28=${v28OpenDate}.`,
      );
    }
    if (legacyWindowOpen !== v28Window.isOpen) {
      pushIssue(
        issues,
        'critical',
        'window_state_changes',
        `Стан ordering window змінюється після деплою: old=${legacyWindowOpen}, V28=${v28Window.isOpen}.`,
      );
    }
    if (legacySessionId && legacySessionId !== v28SessionId) {
      pushIssue(
        issues,
        'critical',
        'session_identity_changes',
        `Готова стара session змінюється: old=${legacySessionId}, V28=${v28SessionId || '(none)'}.`,
      );
    }
    if (legacyOrders.length > 0 && v28Orders.length === 0) {
      pushIssue(
        issues,
        'critical',
        'orders_not_visible_in_v28_session',
        `У старій current session є ${legacyOrders.length} Order, але V28 current session їх не бачить.`,
      );
    }
    if (scheduleKey(legacySchedule) !== scheduleKey(v28Schedule) && legacyOpenDate === v28OpenDate) {
      pushIssue(
        issues,
        'warning',
        'schedule_changed_but_session_preserved',
        'Per-group schedule відрізняється від старого global mapping, але current openDate/session identity зберігаються.',
      );
    }
  }

  const activeOrdersAll = v28Orders.filter((o) => ACTIVE_ORDER_STATUSES.includes(o.status));
  const operationalOrders = v28Orders.filter((o) => !parkedOrder(o));
  const parkedOrders = v28Orders.filter(parkedOrder);
  // Exact set used by start-session/taskBuilder for THIS delivery group. Parked
  // or wrong-group historical provenance must not become a false morning blocker.
  const activeOrders = activeOrdersAll.filter((o) => (
    !parkedOrder(o) && str(o.buyerSnapshot?.deliveryGroupId) === groupId
  ));

  // Current-session ownership must be exact. A mismatch is a hard closure blocker.
  const orderGroupMismatches = operationalOrders.filter((o) => str(o.buyerSnapshot?.deliveryGroupId) !== groupId);
  const taskGroupMismatches = currentTasks.filter((t) => str(t.deliveryGroupId) !== groupId);
  if (orderGroupMismatches.length) {
    pushIssue(issues, 'critical', 'current_order_group_mismatch', `Current session має Order/group mismatch: ${orderGroupMismatches.length}.`);
  }
  if (taskGroupMismatches.length) {
    pushIssue(issues, 'critical', 'current_task_group_mismatch', `Current session має PickingTask/group mismatch: ${taskGroupMismatches.length}.`);
  }

  // Exact pre-start seller/shop conflict gate used by POST /api/picking/start-session.
  const ordersByShop = new Map();
  for (const order of activeOrders) {
    const shopId = str(order.shopId || order.buyerSnapshot?.shopId);
    if (!shopId) continue;
    if (!ordersByShop.has(shopId)) ordersByShop.set(shopId, []);
    ordersByShop.get(shopId).push(order);
  }

  const conflicts = [];
  for (const [shopId, rows] of ordersByShop.entries()) {
    const buyers = [...new Set(rows.map((o) => str(o.buyerTelegramId)).filter(Boolean))];
    if (buyers.length <= 1) continue;
    conflicts.push({
      shopId,
      shopName: rows[0]?.buyerSnapshot?.shopName || '',
      buyers,
      orderIds: rows.map((o) => str(o._id)),
      orderNumbers: rows.map((o) => o.orderNumber ?? null),
    });
  }
  if (conflicts.length) {
    pushIssue(issues, 'critical', 'shop_conflicts_block_start', `Є ${conflicts.length} магазин(и/ів) з Orders від 2+ продавців у current session — кнопка «Розпочати» буде заблокована до вирішення конфлікту.`, { conflicts });
  }

  // Detect duplicate product rows in one active Order. MASS acceptance guarantees
  // none; old production debris should be surfaced before the shift.
  let duplicateProductRows = 0;
  let activeOrdersWithNoLiveItems = 0;
  const liveLines = [];

  for (const order of activeOrders) {
    const seen = new Set();
    const duplicates = new Set();
    let liveCount = 0;
    for (const item of order.items || []) {
      const pid = str(item.productId);
      if (pid) {
        if (seen.has(pid)) duplicates.add(pid);
        seen.add(pid);
      }
      if (terminalItem(item)) continue;
      liveCount += 1;
      liveLines.push({
        orderId: str(order._id),
        orderNumber: order.orderNumber ?? null,
        shopName: order.buyerSnapshot?.shopName || '',
        itemId: str(item._id),
        productId: pid || null,
        name: item.name || '',
        quantity: Number(item.quantity) || 0,
      });
    }
    duplicateProductRows += duplicates.size;
    if (liveCount === 0) activeOrdersWithNoLiveItems += 1;
  }

  if (duplicateProductRows) {
    pushIssue(issues, 'critical', 'duplicate_product_rows_in_order', `Active Orders містять duplicate product rows: ${duplicateProductRows}.`);
  }
  if (activeOrdersWithNoLiveItems) {
    pushIssue(issues, 'critical', 'active_order_without_live_items', `Є active Order зі status new/in_progress, але всі його позиції вже terminal: ${activeOrdersWithNoLiveItems}. Це inconsistent business status.`);
  }

  // Predict task-builder coverage WITHOUT creating PickingTasks.
  const liveProductIds = [...new Set(liveLines.map((x) => x.productId).filter(Boolean))];
  const [products, blocks] = await Promise.all([
    liveProductIds.length
      ? Product.find({ _id: { $in: liveProductIds } }, '_id status name brand model category orderNumber').lean()
      : [],
    liveProductIds.length
      ? Block.find({ productIds: { $in: liveProductIds } }, 'blockId productIds').sort({ blockId: 1 }).lean()
      : [],
  ]);

  const productById = new Map(products.map((p) => [str(p._id), p]));
  const blocksByProduct = new Map();
  for (const block of blocks) {
    for (const pidValue of block.productIds || []) {
      const pid = str(pidValue);
      if (!blocksByProduct.has(pid)) blocksByProduct.set(pid, []);
      blocksByProduct.get(pid).push(block.blockId);
    }
  }

  const predictedCoverageGaps = [];
  for (const line of liveLines) {
    const product = line.productId ? productById.get(line.productId) : null;
    let reason = null;
    if (!line.productId || !product) reason = 'product_deleted';
    else if (product.status === 'archived') reason = 'product_archived';
    else if (!blocksByProduct.has(line.productId)) reason = 'no_block';
    else if ((blocksByProduct.get(line.productId) || []).length > 1) reason = 'multiple_blocks';

    if (reason) {
      predictedCoverageGaps.push({
        ...line,
        reason,
        productStatus: product?.status || null,
        blocks: line.productId ? (blocksByProduct.get(line.productId) || []) : [],
      });
    }
  }

  if (predictedCoverageGaps.length) {
    const reasonCounts = predictedCoverageGaps.reduce((acc, row) => {
      acc[row.reason] = (acc[row.reason] || 0) + 1;
      return acc;
    }, {});
    pushIssue(
      issues,
      'critical',
      'predicted_coverage_gap',
      `Після натискання «Розпочати» taskBuilder не зможе фізично покрити ${predictedCoverageGaps.length} позиці(ю/ї). Причини: ${JSON.stringify(reasonCounts)}.`,
      { gaps: predictedCoverageGaps.slice(0, 50) },
    );
  }

  const terminalOrdersWithBrokenLines = operationalOrders.filter((o) =>
    TERMINAL_ORDER_STATUSES.includes(o.status)
    && (o.items || []).some((item) => !terminalItem(item))
  );
  if (terminalOrdersWithBrokenLines.length) {
    pushIssue(
      issues,
      'critical',
      'current_terminal_order_broken_lines',
      `У current session є terminal Orders з nonterminal items: ${terminalOrdersWithBrokenLines.length}. Closure їх правильно заблокує до repair.`,
    );
  }

  const pendingTasks = currentTasks.filter((t) => t.status === 'pending');
  const lockedTasks = currentTasks.filter((t) => t.status === 'locked');
  const completedTasks = currentTasks.filter((t) => t.status === 'completed');

  if (v28Session?.pickingStatus === 'pending' && lockedTasks.length) {
    pushIssue(issues, 'critical', 'locked_tasks_before_start', `Session ще pending, але вже є locked PickingTask: ${lockedTasks.length}. Перед ранковим стартом це треба розібрати.`);
  }
  if (v28Session?.pickingStatus === 'pending' && completedTasks.length) {
    pushIssue(issues, 'critical', 'completed_tasks_in_pending_session', `Session pending, але вже має completed PickingTask: ${completedTasks.length}. Lifecycle inconsistent.`);
  }
  if (v28Session?.pickingStatus === 'pending' && pendingTasks.length) {
    pushIssue(issues, 'warning', 'prebuilt_pending_tasks', `Session ще pending, але вже має ${pendingTasks.length} pending tasks (можливо попередня невдала/перервана спроба start). Повторний start-session є idempotent, але це варто знати.`);
  }

  if (staleOrders.length) {
    pushIssue(issues, 'warning', 'stale_orders_nonblocking', `Старі active Orders поза current session: ${staleOrders.length}. За V28 це WARNING, вони НЕ повинні блокувати ранкову сесію.`);
  }
  if (staleTasks.length) {
    pushIssue(issues, 'warning', 'stale_tasks_nonblocking', `Старі pending/locked PickingTasks поза current session: ${staleTasks.length}. За V28 це історичний/repair warning, не blocker current session.`);
  }
  if (parkedOrders.length) {
    pushIssue(issues, 'warning', 'parked_orders_nonblocking', `Parked Orders у provenance цієї session: ${parkedOrders.length}. Closure трактує їх як non-blocking warning.`);
  }

  // Materialized session metadata is informative. Old sessions may legitimately
  // miss V28 snapshot fields; that does not break identity.
  if (v28Session && !v28Session.scheduleSnapshot) {
    pushIssue(issues, 'warning', 'session_without_schedule_snapshot', 'Current session не має scheduleSnapshot (типово для старої materialized session). V28 identity працює по groupId+openDate; це не blocker.');
  }

  const criticalCount = countSeverity(issues, 'critical');

  let state;
  if (criticalCount > 0) {
    state = 'BLOCKED';
  } else if (v28Window.isOpen) {
    state = 'WAIT_ORDERING_CLOSE';
  } else if (!v28Session) {
    state = activeOrders.length ? 'BLOCKED' : 'EMPTY_NOT_MATERIALIZED';
  } else if (v28Session.pickingStatus === 'pending') {
    state = activeOrders.length ? 'READY_TO_PRESS_START' : 'READY_EMPTY_SESSION';
  } else if (['confirmed', 'in_progress'].includes(v28Session.pickingStatus)) {
    state = 'READY_TO_RESUME_PICKING';
  } else if (v28Session.pickingStatus === 'completed') {
    state = 'ALREADY_COMPLETED';
  } else {
    state = 'UNKNOWN';
  }

  return {
    groupId,
    groupName,
    dayOfWeek: group.dayOfWeek,
    state,
    issues,
    schedule: {
      legacy: schedulePlain(legacySchedule),
      v28: schedulePlain(v28Schedule),
      same: legacySchedule ? scheduleKey(legacySchedule) === scheduleKey(v28Schedule) : null,
      legacyWindowOpen,
      v28WindowOpen: v28Window.isOpen,
      openDateLegacy: legacyOpenDate,
      openDateV28: v28OpenDate,
      sessionOpenAt: iso(bounds.openAt),
      sessionCloseAt: iso(bounds.closeAt),
      deliveryDate,
    },
    session: {
      legacySessionId: legacySessionId || null,
      v28SessionId: v28SessionId || null,
      sameSession: legacySessionId ? legacySessionId === v28SessionId : null,
      seq: v28Session?.seq ?? null,
      pickingStatus: v28Session?.pickingStatus || null,
      pickingConfirmedAt: iso(v28Session?.pickingConfirmedAt),
      pickingStartedAt: iso(v28Session?.pickingStartedAt),
      pickingCompletedAt: iso(v28Session?.pickingCompletedAt),
      openNotifiedAt: iso(v28Session?.openNotifiedAt),
    },
    counts: {
      legacySessionOrders: legacyOrders.length,
      v28SessionOrders: v28Orders.length,
      activeOrders: activeOrders.length,
      activeOrdersAllInSession: activeOrdersAll.length,
      liveOrderItems: liveLines.length,
      predictedDistinctTasks: new Set(liveLines.map((x) => x.productId).filter((pid) => pid && !predictedCoverageGaps.some((g) => g.productId === pid))).size,
      currentTasks: currentTasks.length,
      pendingTasks: pendingTasks.length,
      lockedTasks: lockedTasks.length,
      completedTasks: completedTasks.length,
      conflicts: conflicts.length,
      predictedCoverageGaps: predictedCoverageGaps.length,
      staleOrders: staleOrders.length,
      staleTasks: staleTasks.length,
      parkedOrders: parkedOrders.length,
      terminalOrdersWithBrokenLines: terminalOrdersWithBrokenLines.length,
    },
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  const mongo = uriMeta(MONGODB_URI);
  const rmeta = redisMeta(process.env.REDIS_URL || '');
  const warsaw = getWarsawNow(NOW);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('V28 PROD MORNING READINESS AUDIT — READ ONLY');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Server root: ${SERVER_ROOT}`);
  console.log(`ENV source:  ${ENV_PATH}`);
  console.log(`Mongo host:  ${mongo.host}`);
  console.log(`Mongo DB:    ${mongo.db}`);
  console.log(`Redis:       ${rmeta.configured ? `configured (${rmeta.host})` : 'NOT configured'}`);
  console.log(`Now UTC:     ${NOW.toISOString()}`);
  console.log(`Warsaw now:  ${warsaw.year}-${String(warsaw.month).padStart(2, '0')}-${String(warsaw.day).padStart(2, '0')} ${String(warsaw.hour).padStart(2, '0')}:${String(warsaw.minute).padStart(2, '0')} (weekday=${warsaw.dayOfWeek})`);
  console.log('DB writes:   NONE');
  console.log('');

  const startedAt = Date.now();
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    autoIndex: false,
    autoCreate: false,
    readPreference: 'primaryPreferred',
  });
  await mongoose.connection.db.command({ ping: 1 });
  console.log('✅ MongoDB connection + PING OK');

  const redis = await pingRedisReadOnly();
  if (!redis.configured) console.log('⚠️ Redis: REDIS_URL не заданий (для single-process допустимо; для multi-worker distributed locks/Socket adapter відсутні).');
  else if (redis.ok) console.log(`✅ Redis read-only PING OK (${redis.message})`);
  else console.log(`❌ Redis configured but PING failed: ${redis.message}`);

  const legacySetting = await AppSetting.findOne({ key: 'ordering.schedule' }).lean();
  const legacyValue = legacySetting?.value || null;
  if (legacyValue) console.log(`✅ Legacy AppSetting('ordering.schedule') знайдено: ${JSON.stringify(legacyValue)}`);
  else console.log("❌ Legacy AppSetting('ordering.schedule') НЕ знайдено — old→V28 handover не можна математично зіставити.");
  console.log('');

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log('GLOBAL DB / INDEX INTEGRITY');
  console.log('──────────────────────────────────────────────────────────────────────');
  const globalAudit = await auditGlobalIntegrity();
  console.log(`Indexes: Order=${globalAudit.indexChecks.orderUnique ? 'OK' : 'FAIL'} | PickingTask=${globalAudit.indexChecks.taskUnique ? 'OK' : 'FAIL'} | Block=${globalAudit.indexChecks.blockUnique ? 'OK' : 'FAIL'} | OrderingSession=${globalAudit.indexChecks.sessionUnique ? 'OK' : 'FAIL'}`);
  console.log(`Counts: groups=${globalAudit.counts.groups}, sessions=${globalAudit.counts.sessions}, activeOrders=${globalAudit.counts.activeOrders}, activeTasks=${globalAudit.counts.activeTasks}`);
  console.log(`Duplicates: orders=${globalAudit.counts.duplicateOrders}, tasks=${globalAudit.counts.duplicateTasks}, blockProducts=${globalAudit.counts.duplicateBlockProducts}`);
  console.log(`Integrity: orphanActiveOrders=${globalAudit.counts.activeOrdersMissingSession}, orphanActiveTasks=${globalAudit.counts.activeTasksMissingSession}, orderGroupMismatch=${globalAudit.counts.activeOrderGroupMismatch}, taskGroupMismatch=${globalAudit.counts.activeTaskGroupMismatch}`);
  console.log(`Terminal Orders with nonterminal items=${globalAudit.counts.terminalOrdersWithNonterminalItems}`);
  if (!globalAudit.issues.length) console.log('✅ Global integrity blockers не знайдено.');
  for (const issue of globalAudit.issues) console.log(formatIssue(issue));
  console.log('');

  const groups = await DeliveryGroup.find({}, '_id name dayOfWeek orderingSchedule').sort({ name: 1 }).lean();
  const groupReports = [];

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`DELIVERY GROUPS (${groups.length}) — OLD → V28 + MORNING START READINESS`);
  console.log('──────────────────────────────────────────────────────────────────────');

  for (const group of groups) {
    const report = await auditGroup(group, legacyValue);
    groupReports.push(report);

    const criticals = countSeverity(report.issues || [], 'critical');
    const warnings = countSeverity(report.issues || [], 'warning');
    const marker = criticals ? '❌' : report.state === 'READY_TO_PRESS_START' ? '✅' : '🟡';

    console.log(`${marker} [${report.groupName}] state=${report.state} critical=${criticals} warnings=${warnings}`);
    if (report.schedule) {
      console.log(`   deliveryDay=${report.dayOfWeek} deliveryDate=${report.schedule.deliveryDate}`);
      console.log(`   old openDate=${report.schedule.openDateLegacy || '(unknown)'} | V28 openDate=${report.schedule.openDateV28}`);
      console.log(`   ordering window: old=${report.schedule.legacyWindowOpen} | V28=${report.schedule.v28WindowOpen}`);
      console.log(`   V28 bounds: ${report.schedule.sessionOpenAt} → ${report.schedule.sessionCloseAt}`);
    }
    if (report.session) {
      console.log(`   session old=${report.session.legacySessionId || '(none)'} | V28=${report.session.v28SessionId || '(none)'} | same=${report.session.sameSession}`);
      console.log(`   pickingStatus=${report.session.pickingStatus || '(none)'} seq=${report.session.seq ?? '(none)'}`);
    }
    if (report.counts) {
      console.log(`   Orders: active=${report.counts.activeOrders}, liveItems=${report.counts.liveOrderItems}, predictedTasks=${report.counts.predictedDistinctTasks}`);
      console.log(`   Tasks: current=${report.counts.currentTasks}, pending=${report.counts.pendingTasks}, locked=${report.counts.lockedTasks}, completed=${report.counts.completedTasks}`);
      console.log(`   hard-data checks: conflicts=${report.counts.conflicts}, predictedCoverageGaps=${report.counts.predictedCoverageGaps}, brokenTerminalOrders=${report.counts.terminalOrdersWithBrokenLines}`);
      console.log(`   historical warnings: staleOrders=${report.counts.staleOrders}, staleTasks=${report.counts.staleTasks}, parkedOrders=${report.counts.parkedOrders}`);
    }
    for (const issue of report.issues || []) console.log(formatIssue(issue));
    console.log('');
  }

  const allIssues = [
    ...globalAudit.issues.map((x) => ({ scope: 'global', ...x })),
    ...groupReports.flatMap((r) => (r.issues || []).map((x) => ({ scope: r.groupName, ...x }))),
  ];
  if (!legacyValue) {
    allIssues.push({ scope: 'global', severity: 'critical', code: 'legacy_schedule_missing', message: 'Old→V28 continuity proof unavailable.' });
  }
  if (redis.configured && redis.ok === false) {
    allIssues.push({ scope: 'global', severity: 'critical', code: 'redis_unreachable', message: `REDIS_URL configured, але PING failed: ${redis.message}` });
  }
  if (!redis.configured) {
    allIssues.push({ scope: 'global', severity: 'warning', code: 'redis_not_configured', message: 'REDIS_URL missing; multi-worker distributed locks/socket adapter unavailable.' });
  }

  // Deduplicate exact issue code+scope because legacy missing is both per-group and global.
  const dedupedIssues = [];
  const issueKeys = new Set();
  for (const issue of allIssues) {
    const key = `${issue.scope}|${issue.severity}|${issue.code}`;
    if (issueKeys.has(key)) continue;
    issueKeys.add(key);
    dedupedIssues.push(issue);
  }

  const criticals = countSeverity(dedupedIssues, 'critical');
  const warnings = countSeverity(dedupedIssues, 'warning');
  const readyNow = groupReports.filter((r) => r.state === 'READY_TO_PRESS_START').length;
  const waitClose = groupReports.filter((r) => r.state === 'WAIT_ORDERING_CLOSE').length;
  const resume = groupReports.filter((r) => r.state === 'READY_TO_RESUME_PICKING').length;
  const completed = groupReports.filter((r) => r.state === 'ALREADY_COMPLETED').length;
  const blocked = groupReports.filter((r) => r.state === 'BLOCKED').length;

  const verdict = criticals === 0 ? 'GO' : 'NO_GO';
  const reportObject = {
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    readOnly: true,
    serverRoot: SERVER_ROOT,
    envPath: ENV_PATH,
    mongo,
    redis: { ...redis, host: rmeta.host },
    legacyScheduleFound: Boolean(legacyValue),
    legacySchedule: legacyValue || null,
    verdict,
    summary: {
      criticals,
      warnings,
      groups: groups.length,
      readyToPressStartNow: readyNow,
      waitOrderingClose: waitClose,
      readyToResumePicking: resume,
      alreadyCompleted: completed,
      blocked,
    },
    global: globalAudit,
    groups: groupReports,
    issues: dedupedIssues,
  };

  const reportDir = path.join(SERVER_ROOT, 'predeploy-reports');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `prod-morning-readiness-${localStamp()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reportObject, null, 2), 'utf8');

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('FINAL VERDICT');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Groups: ready-now=${readyNow}, wait-close=${waitClose}, resume=${resume}, completed=${completed}, blocked=${blocked}`);
  console.log(`Findings: CRITICAL=${criticals}, WARNING=${warnings}`);
  console.log(`Local JSON report: ${reportPath}`);
  console.log('');

  if (criticals === 0) {
    console.log('✅ GO: old→V28 current-session identity/data handover не має критичних розбіжностей.');
    if (readyNow > 0) console.log(`✅ ${readyNow} group(s) прямо зараз у стані READY_TO_PRESS_START: window closed, pending session, no conflicts, predicted task coverage OK.`);
    if (waitClose > 0) console.log(`🟡 ${waitClose} group(s) ще мають відкрите ordering window — «Розпочати» зараз має бути заблоковано штатно до closeAt.`);
    if (resume > 0) console.log(`🟡 ${resume} group(s) уже confirmed/in_progress — їх треба продовжувати, а не починати заново.`);
    console.log('✅ По поточному DB state не знайдено blocker-а, який мав би не дати штатно дійти до terminal items/orders після обробки всіх tasks.');
    console.log('⚠️ Це не може гарантувати 100% від зовнішніх відмов Mongo/Redis/network/host, але перевіряє саме data/session/schedule/picking invariants перед деплоєм.');
  } else {
    console.log('❌ NO-GO: є критичні знахідки. НЕ деплой V28 перед ранковою зміною, поки вони не розібрані.');
    for (const issue of dedupedIssues.filter((x) => x.severity === 'critical')) {
      console.log(`   ❌ [${issue.scope}] [${issue.code}] ${issue.message}`);
    }
    process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    console.error('');
    console.error('❌ AUDIT FAILED:', err?.stack || err);
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch {}
  });

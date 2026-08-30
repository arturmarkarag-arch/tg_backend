'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const checks = [];
function check(name, ok, detail = '') {
  const pass = Boolean(ok);
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function appError(code, meta = {}) {
  const err = new Error(code);
  err.code = code;
  err.meta = meta;
  return err;
}

function makeThenableQuery(value) {
  let current = value;
  const query = {
    sort() { return query; },
    session() { return query; },
    select() { return query; },
    populate() { return query; },
    lean() { return Promise.resolve(current); },
    then(resolve, reject) { return Promise.resolve(current).then(resolve, reject); },
    catch(reject) { return Promise.resolve(current).catch(reject); },
  };
  return query;
}

async function withLoadStubs(stubs, fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return await fn();
  } finally {
    Module._load = originalLoad;
  }
}

function loadFresh(rel, stubs) {
  const absolute = path.join(ROOT, rel);
  delete require.cache[require.resolve(absolute)];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(absolute);
  } finally {
    Module._load = originalLoad;
  }
}

const ORDER_STATUS = Object.freeze({
  NEW: 'new',
  NEW_UNASSIGN: 'new_unassign',
  IN_PROGRESS: 'in_progress',
  CONFIRMED: 'confirmed',
  FULFILLED: 'fulfilled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});
const ACTIVE_ORDER_STATUSES = Object.freeze(['new', 'in_progress']);
const PARKED_ORDER_STATUSES = Object.freeze(['new_unassign']);

function makeOrder(id, {
  status = 'new',
  shopId = 'shop-A',
  snapshotShopId = shopId,
  orderingSessionId = 'session-any',
  ownership = { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
} = {}) {
  return {
    _id: id,
    status,
    shopId,
    buyerSnapshot: snapshotShopId == null ? null : { shopId: snapshotShopId },
    orderingSessionId,
    __ownership: ownership,
  };
}

async function expectCode(fn, code, kind = null) {
  try {
    await fn();
    return false;
  } catch (err) {
    if (err?.code !== code) return false;
    return kind == null || err?.meta?.kind === kind;
  }
}

async function runSellerResolverBehavior() {
  let orders = [];
  let shops = new Map();
  const Order = {
    find() { return makeThenableQuery(orders); },
  };
  const Shop = {
    findById(id) { return makeThenableQuery(shops.get(String(id)) || null); },
  };
  const ownershipApi = {
    getOrderOwnershipState: async (order) => order.__ownership,
  };
  const statusApi = { ORDER_STATUS, ACTIVE_ORDER_STATUSES, PARKED_ORDER_STATUSES };

  const mod = loadFresh('services/sellerOrderAssignment.js', {
    '../models/Order': Order,
    '../models/Shop': Shop,
    '../utils/errors': { appError },
    '../utils/orderOwnership': ownershipApi,
    '../utils/orderStatus': statusApi,
  });

  // 1) The source session is deliberately arbitrary: mutable NEXT/recovery/etc.
  // is selected by ownership, while an older frozen row remains visibility-only.
  orders = [
    makeOrder('old-frozen', {
      shopId: 'shop-A', orderingSessionId: 'session-old',
      ownership: { frozen: true, reason: 'ordering_closed', session: { groupId: 'group-A' } },
    }),
    makeOrder('live-next', {
      shopId: 'shop-A', orderingSessionId: 'session-NEXT-with-arbitrary-id',
      ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
    }),
  ];
  let resolution = await mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: 'shop-A' } });
  check('source resolver selects mutable Order regardless of CURRENT/NEXT bucket', String(resolution.transferOrder?._id) === 'live-next');
  check('frozen historical Order is visible but does not block transferable Order', resolution.frozenOrders.length === 1 && String(resolution.frozenOrders[0]._id) === 'old-frozen');

  // 2) Frozen-only history is a legal state after seller movement.
  orders = [makeOrder('frozen-only', {
    shopId: 'shop-A', orderingSessionId: 'session-old',
    ownership: { frozen: true, reason: 'picking_started', session: { groupId: 'group-A' } },
  })];
  resolution = await mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: 'shop-A' } });
  check('frozen-only history produces no transferable Order', !resolution.transferOrder);
  check('frozen Shop-owned history is retained for audit/visibility', String(resolution.stayedOrder?._id) === 'frozen-only');

  // 3) Two mutable rows must never be guessed between.
  orders = [makeOrder('m1'), makeOrder('m2')];
  check('two mutable Orders fail closed instead of arbitrary findOne()', await expectCode(
    () => mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: 'shop-A' } }),
    'seller_order_assignment_invariant',
    'multiple_transferable_orders',
  ));

  // 4) Current assignment mismatch is not repaired by guessing.
  orders = [makeOrder('wrong-shop', {
    shopId: 'shop-B', snapshotShopId: 'shop-B',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-B' } },
  })];
  check('mutable Order on another CURRENT Shop fails closed', await expectCode(
    () => mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: 'shop-A' } }),
    'seller_order_assignment_invariant',
    'transferable_order_shop_mismatch',
  ));

  // 5) Top-level/snapshot disagreement is corruption, not fallback authority.
  orders = [makeOrder('split-shop', { shopId: 'shop-A', snapshotShopId: 'shop-B' })];
  check('shopId vs buyerSnapshot.shopId disagreement fails closed', await expectCode(
    () => mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: 'shop-A' } }),
    'seller_order_assignment_invariant',
    'order_shop_snapshot_mismatch',
  ));

  // 6) Canonical parked row follows an unassigned seller while still mutable.
  orders = [makeOrder('parked', {
    status: 'new_unassign', shopId: 'shop-A', orderingSessionId: 'session-open',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
  })];
  resolution = await mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: null } });
  check('mutable new_unassign is the canonical recoverable Order for unassigned seller', String(resolution.transferOrder?._id) === 'parked');

  // 7) Old compatibility shape with null ownership can be recovered once.
  orders = [makeOrder('legacy-null', {
    status: 'new', shopId: null, snapshotShopId: null, orderingSessionId: 'session-open',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
  })];
  resolution = await mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: null } });
  check('legacy null-owned mutable row remains one-shot recoverable', String(resolution.transferOrder?._id) === 'legacy-null');

  // 8) An unassigned seller must not silently steal a still Shop-owned active row.
  orders = [makeOrder('owned-live', {
    status: 'new', shopId: 'shop-A', snapshotShopId: 'shop-A',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
  })];
  check('unassigned seller cannot guess a Shop-owned active Order as its cart', await expectCode(
    () => mod.resolveSellerAssignmentOrder({ seller: { telegramId: '100', shopId: null } }),
    'seller_order_assignment_invariant',
    'unassigned_seller_live_order_mismatch',
  ));

  // 9) Explicit repair pins one exact session and requires explicit frozen override.
  orders = [makeOrder('repair-frozen', {
    shopId: 'shop-A', orderingSessionId: 'session-selected',
    ownership: { frozen: true, reason: 'ordering_closed', session: { groupId: 'group-A' } },
  })];
  resolution = await mod.resolveSellerAssignmentOrder({
    seller: { telegramId: '100', shopId: 'shop-A' },
    expectedOrderingSessionId: 'session-selected',
    allowFrozenOverride: false,
  });
  check('explicit exact-session repair does not move frozen Order without opt-in', !resolution.transferOrder && String(resolution.stayedOrder?._id) === 'repair-frozen');
  resolution = await mod.resolveSellerAssignmentOrder({
    seller: { telegramId: '100', shopId: 'shop-A' },
    expectedOrderingSessionId: 'session-selected',
    allowFrozenOverride: true,
  });
  check('explicit exact-session repair may select frozen Order only with opt-in', String(resolution.transferOrder?._id) === 'repair-frozen');

  // 10) Post-write invariant validates both CURRENT Shop and target group identity.
  shops = new Map([['shop-B', { _id: 'shop-B', deliveryGroupId: 'group-B' }]]);
  orders = [makeOrder('post-ok', {
    shopId: 'shop-B', snapshotShopId: 'shop-B', orderingSessionId: 'session-B',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-B' } },
  })];
  let post = await mod.assertSellerAssignmentOrderInvariant({ sellerTelegramId: '100', currentShopId: 'shop-B' });
  check('post-write invariant accepts exactly one mutable Order on assigned Shop/group', post.ok === true && post.transferableCount === 1);

  orders = [makeOrder('post-bad-group', {
    shopId: 'shop-B', snapshotShopId: 'shop-B', orderingSessionId: 'session-A',
    ownership: { frozen: false, reason: 'ordering_open', session: { groupId: 'group-A' } },
  })];
  check('post-write invariant rejects cross-group mutable Order even when shopId matches', await expectCode(
    () => mod.assertSellerAssignmentOrderInvariant({ sellerTelegramId: '100', currentShopId: 'shop-B' }),
    'seller_order_assignment_invariant',
    'transferable_order_session_group_mismatch',
  ));
}

async function runOwnershipBehavior() {
  let pipelineExists = false;
  let sessionDoc = null;

  const PickingTask = {
    exists() { return makeThenableQuery(pipelineExists ? { _id: 'task-1' } : null); },
  };
  const OrderingSession = {
    findById() { return makeThenableQuery(sessionDoc); },
  };

  const mod = loadFresh('utils/orderOwnership.js', {
    '../models/PickingTask': PickingTask,
    '../models/OrderingSession': OrderingSession,
  });

  const now = new Date('2026-08-30T16:00:00.000Z');
  const dynamicStubs = { '../models/PickingTask': PickingTask, '../models/OrderingSession': OrderingSession };
  pipelineExists = true;
  let state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o1', orderingSessionId: 's1' }, { now }));
  check('PickingTask presence freezes ownership independently of session projection', state.frozen && state.reason === 'picking_pipeline');

  pipelineExists = false;
  state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o2', orderingSessionId: '' }, { now }));
  check('Order without session id remains mutable legacy/current compatibility state', !state.frozen && state.reason === 'no_ordering_session');

  sessionDoc = null;
  state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o3', orderingSessionId: 'missing' }, { now }));
  check('missing referenced OrderingSession fails closed', state.frozen && state.reason === 'session_not_found');

  sessionDoc = { groupId: 'g', pickingStatus: 'pending', closeAt: new Date('2026-08-30T17:00:00.000Z') };
  state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o4', orderingSessionId: 's4' }, { now }));
  check('pending session with future closeAt is mutable', !state.frozen && state.reason === 'ordering_open');

  sessionDoc = { groupId: 'g', pickingStatus: 'pending', closeAt: new Date('2026-08-30T15:00:00.000Z') };
  state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o5', orderingSessionId: 's5' }, { now }));
  check('closed ordering window freezes existing source ownership', state.frozen && state.reason === 'ordering_closed');

  sessionDoc = { groupId: 'g', pickingStatus: 'in_progress', closeAt: new Date('2026-08-30T17:00:00.000Z') };
  state = await withLoadStubs(dynamicStubs, () => mod.getOrderOwnershipState({ _id: 'o6', orderingSessionId: 's6' }, { now }));
  check('non-pending picking status freezes existing source ownership', state.frozen && state.reason === 'picking_started');
}

async function runDestinationBehavior() {
  let group = { _id: 'group-B', orderingSchedule: { startDay: 1 } };
  let currentSession = { _id: 'current-B', pickingStatus: 'pending', openDate: '2026-08-31' };
  let currentId = 'current-B';
  let nextId = 'next-B';
  const helperCalls = [];

  const DeliveryGroup = {
    findById() { return makeThenableQuery(group); },
  };
  const OrderingSession = {
    findById() { return makeThenableQuery(currentSession); },
  };
  const sessionApi = {
    async getOrCreateSessionId(groupId, schedule, opts) {
      helperCalls.push(['current', String(groupId), opts?.session || null]);
      return currentId;
    },
    async getOrCreateNextSessionId(groupId, schedule, opts) {
      helperCalls.push(['next', String(groupId), opts?.session || null]);
      return nextId;
    },
  };

  const mod = loadFresh('services/orderAssignmentRouting.js', {
    '../models/DeliveryGroup': DeliveryGroup,
    '../models/OrderingSession': OrderingSession,
    '../utils/errors': { appError },
    '../utils/getOrCreateSession': sessionApi,
  });

  const mongoSession = { id: 'tx' };
  let target = await mod.resolveAssignmentDestination({ shop: { deliveryGroupId: 'group-B' }, session: mongoSession });
  check('destination router keeps CURRENT when pickingStatus is pending', target.targetSessionId === 'current-B' && !target.routedToNextSession);
  check('destination CURRENT materialization receives caller Mongo session', helperCalls.some((c) => c[0] === 'current' && c[2] === mongoSession));

  currentSession = { _id: 'current-B', pickingStatus: 'in_progress', openDate: '2026-08-31' };
  target = await mod.resolveAssignmentDestination({ shop: { deliveryGroupId: 'group-B' }, session: mongoSession });
  check('destination router sends incoming mutable Order to NEXT after picking starts', target.targetSessionId === 'next-B' && target.routedToNextSession);
  check('destination NEXT materialization receives caller Mongo session', helperCalls.some((c) => c[0] === 'next' && c[2] === mongoSession));

  target = await mod.resolveAssignmentDestination({ shop: { deliveryGroupId: null }, session: mongoSession });
  check('shop without delivery group has explicit no-target result', target.targetSessionId === null && target.routeReason === 'no_delivery_group');

  group = null;
  check('missing destination DeliveryGroup fails closed', await expectCode(
    () => mod.resolveAssignmentDestination({ shop: { deliveryGroupId: 'missing-group' }, session: mongoSession }),
    'group_not_found',
  ));
}

function runSourceContracts() {
  const migration = read('services/migrateSellerShop.js');
  const unassign = read('services/unassignSeller.js');
  const routing = read('services/orderAssignmentRouting.js');
  const ownership = read('services/sellerOrderAssignment.js');
  const orderRoutes = read('routes/orders.js');
  const shops = read('routes/shops.js');
  const sessions = read('utils/getOrCreateSession.js');
  const clientApi = fs.readFileSync(path.join(ROOT, '..', 'client', 'src', 'api.js'), 'utf8');
  const sellerModal = fs.readFileSync(path.join(ROOT, '..', 'client', 'src', 'components', 'picking', 'SellerReassignModal.jsx'), 'utf8');

  check('migrate source uses canonical session-agnostic seller ownership resolver', migration.includes('resolveSellerAssignmentOrder({'));
  check('migrate source no longer uses activeOrderShopFilter as source discovery', !migration.includes("require('../utils/orderShopFilter')") && !migration.includes('activeOrderShopFilter('));
  check('CURRENT/NEXT destination routing is a separate service', migration.includes('resolveAssignmentDestination({') && routing.includes('destination-routing decision only'));
  check('unassign uses same canonical ownership resolver', unassign.includes('resolveSellerAssignmentOrder({'));
  check('assignment and unassignment both run post-write invariant', migration.includes('assertSellerAssignmentOrderInvariant({') && unassign.includes('assertSellerAssignmentOrderInvariant({'));
  check('destination decision is pickingStatus-based and does not use closeAt', routing.includes("currentSession.pickingStatus === 'pending'") && !/currentSession\.closeAt|\{[^}]*closeAt[^}]*\}\s*=\s*currentSession/.test(routing));

  check('manual Order snapshot repair uses shared destination router', orderRoutes.includes("router.patch('/:id/snapshot'") && orderRoutes.includes('resolveAssignmentDestination({'));
  check('manual snapshot conflict is scoped to exact destination session', /activeOrderShopFilter\(targetShop\._id,[\s\S]{0,500}orderingSessionId:\s*newSessionId/.test(orderRoutes));
  check('stale restore treats old snapshot as history and routes from current User assignment', orderRoutes.includes("A stale Order's snapshot is HISTORY") && orderRoutes.includes('const buyerShop = await Shop.findById(buyer.shopId)'));
  check('seller order writers fence their expected CURRENT assignment', (orderRoutes.match(/updateSellerStateForExpectedAssignment\(\{/g) || []).length >= 6);
  check('bulk seller removal rechecks exact current Shop inside transaction', shops.includes("role: 'seller',\n            shopId: shopIdStr"));

  check('session identity helpers accept caller transaction session', sessions.includes('async function getOrCreateSessionId(groupId, schedule, { session = null } = {})') && sessions.includes('async function getOrCreateNextSessionId(groupId, schedule, { session = null } = {})'));
  check('source ownership resolver never names CURRENT/NEXT as lookup buckets', !/findCurrentSessionId|getOrCreateNextSessionId|getOrCreateSessionId/.test(ownership));

  // Client remains transport/UI: no seller-move destination computation is duplicated there.
  check('client seller assignment delegates to backend command endpoints', clientApi.includes("request(`/users/${telegramId}/shop`") && sellerModal.includes('assignUserToShop('));
  check('client has no routedToNext seller migration business state', !clientApi.includes('routedToNextSession') && !sellerModal.includes('routedToNextSession'));
}

(async () => {
  console.log('SELLER ASSIGNMENT ARCHITECTURE 2026-08-30');
  console.log('-----------------------------------------');
  try {
    await runSellerResolverBehavior();
    await runOwnershipBehavior();
    await runDestinationBehavior();
    runSourceContracts();
  } catch (err) {
    console.error('UNCAUGHT:', err?.stack || err);
    process.exit(1);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\nSELLER ASSIGNMENT ARCHITECTURE: ${checks.length - failed.length}/${checks.length} PASS`);
  if (failed.length) process.exit(1);
})();

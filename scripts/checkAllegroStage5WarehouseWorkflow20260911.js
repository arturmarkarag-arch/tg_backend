'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const picking = read('services/allegroPicking.js');
const orders = read('services/allegroOrders.js');
const routes = read('routes/allegro.js');
const model = read('models/AllegroPickingOrder.js');
const shared = read('domain/warehousePickingState.js');
const blState = read('domain/baseLinkerPickingState.js');
const blPicking = read('services/baseLinkerPicking.js');
const socket = read('socket.js');
const startup = read('index.js');
let pass = 0;
function check(name, fn) { fn(); pass += 1; console.log(`PASS ${name}`); }

check('BaseLinker and Allegro share the same warehouse state machine', () => {
  assert(blState.includes("require('./warehousePickingState')"));
  assert(shared.includes("READY_WITH_ISSUE: 'ready_to_pack_with_issue'"));
  assert(picking.includes("require('../domain/warehousePickingState')"));
});

check('Allegro picking is isolated by account UUID plus order id', () => {
  assert(model.includes("index({ allegroAccountId: 1, orderId: 1 }, { unique: true })"));
  assert(model.includes('ownerTelegramId'));
  assert(model.includes('revision'));
  assert(startup.includes("require('./models/AllegroPickingOrder').syncIndexes()"));
});

check('warehouse workers can use operational Allegro routes while diagnostics stay admin-only', () => {
  assert(routes.includes("router.get('/orders', requireMarketplaceWarehouseAccess"));
  assert(routes.includes("router.get('/picking/my-active', requireMarketplaceWarehouseAccess"));
  assert(routes.includes("router.get('/api-usage', requireTelegramRole('admin')"));
  assert(routes.includes("router.post('/sync', requireTelegramRole('admin')"));
});

check('claim verifies the exact current Allegro checkout form before materializing picking state', () => {
  const claim = picking.slice(picking.indexOf('async function claimPickingOrder'), picking.indexOf('async function heartbeatPickingOrder'));
  assert(claim.includes('fetchExactOrder(aid, oid)'));
  assert(claim.includes('assertActionable(order)'));
  assert(claim.includes('synchronizeItems(doc, buildSourceItems(order), actor)'));
});

check('upstream changes are persisted before review-required claim/send exits', () => {
  const claim = picking.slice(picking.indexOf('async function claimPickingOrder'), picking.indexOf('async function heartbeatPickingOrder'));
  const sent = picking.slice(picking.indexOf('async function markPickingOrderSent'), picking.indexOf('async function acknowledgeUpstreamReview'));
  for (const block of [claim, sent]) {
    assert(block.includes('itemSync.changed || upstreamChanged'));
    assert(block.includes('await savePickingDoc(doc)'));
    assert(block.indexOf('await savePickingDoc(doc)') < block.indexOf("throw appError('allegro_upstream_review_required'"));
  }
});

check('sending is fail-closed and updates Allegro only after local readiness checks', () => {
  const sent = picking.slice(picking.indexOf('async function markPickingOrderSent'), picking.indexOf('async function acknowledgeUpstreamReview'));
  assert(sent.includes('fetchExactOrder(aid, oid)'));
  assert(sent.includes('packingReadiness(doc.items)'));
  assert(sent.includes("throw appError('allegro_picking_items_unhandled'"));
  assert(sent.includes("throw appError('allegro_picking_has_unresolved_issues'"));
  assert(sent.includes("path: `/order/checkout-forms/${encodeURIComponent(oid)}/fulfillment`"));
  assert(sent.includes("body: { status: 'SENT' }"));
  assert(sent.includes("retryPolicy: 'idempotent'"));
});

check('orders:write capability is required before warehouse send', () => {
  const sent = picking.slice(picking.indexOf('async function markPickingOrderSent'), picking.indexOf('async function acknowledgeUpstreamReview'));
  assert(sent.includes('capabilityMatrix(account?.scopes)'));
  assert(sent.includes('scopeState.capabilities.ordersWrite !== true'));
  assert(sent.includes('ALLEGRO_SCOPE.ORDERS_WRITE'));
});

check('local shelves remain Mongo-only; critical upstream reads live only in command paths', () => {
  const page = orders.slice(orders.indexOf('async function getAllegroOrderPage'), orders.indexOf('async function getLocalAllegroOrder'));
  assert(page.includes('AllegroOrderIndex'));
  assert(page.includes('getPickingStates'));
  assert(!page.includes('allegroRequest('));
});

check('one worker cannot actively pick BaseLinker and Allegro simultaneously', () => {
  assert(picking.includes('`marketplace-worker:${actor.by}`'));
  assert(picking.includes('BaseLinkerPickingOrder.findOne'));
  assert(blPicking.includes('`marketplace-worker:${actor.by}`'));
  assert(blPicking.includes('AllegroPickingOrder.findOne'));
});

check('realtime warehouse updates use the shared marketplace staff room', () => {
  assert(socket.includes("socket.join('marketplace_staff')"));
  assert(picking.includes("to('marketplace_staff').emit('allegro_picking_updated'"));
  assert(picking.includes("to('marketplace_staff').emit('allegro_orders_changed'"));
});

check('shipment work stays outside picking state and is implemented by the dedicated Allegro adapter', () => {
  assert(!picking.includes('/shipment-management/'));
  const shipment = read('services/allegroShipments.js');
  assert(shipment.includes('/shipment-management/delivery-proposals/'));
  assert(shipment.includes('/shipment-management/shipments/create-commands'));
  assert(shipment.includes('/shipment-management/label'));
});

console.log(`\nAllegro Stage 5 backend warehouse workflow: ${pass}/${pass} PASS`);

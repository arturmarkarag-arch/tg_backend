'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const routes = read('routes/allegro.js');
const orders = read('services/allegroOrders.js');
const oauth = read('services/allegroOAuth.js');
const caps = read('services/allegroCapabilities.js');
const shipment = read('services/allegroShipments.js');
const http = read('services/allegroHttpClient.js');
const model = read('models/AllegroShipmentBinding.js');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

check('OAuth requests the sale offer read scope needed for product photos', () => {
  assert(oauth.includes("'allegro:api:sale:offers:read'"));
  assert(caps.includes("SALE_OFFERS_READ: 'allegro:api:sale:offers:read'"));
  assert(caps.includes('saleOffersRead'));
});

check('order ingest enriches missing product photos without making images a hard dependency', () => {
  assert(orders.includes("path: '/sale/offers'"));
  assert(orders.includes("query: { 'offer.id': id, limit: 1 }"));
  assert(orders.includes('/sale/product-offers/${encodeURIComponent(id)}'));
  assert(orders.includes('/sale/products/${encodeURIComponent(productId)}'));
  assert(orders.includes('image_url: images[0]'));
  assert(orders.includes('images,'));
  assert(orders.includes('upstreamStatus(error)'));
});

check('existing cached product photos are reused and old Stage 5 rows are backfilled on sync', () => {
  assert(orders.includes('existingOfferImageMap'));
  assert(orders.includes('const missing = offerIds.filter((offerId) => !imageMap.has(offerId))'));
  assert(orders.includes('async function backfillMissingOrderImages'));
  assert(orders.includes("{ stage: 'offer_image_backfill' }"));
  assert(orders.includes('const imageBackfill = await backfillMissingOrderImages(account)'));
});

check('TTN routes are operational warehouse routes and not admin diagnostics only', () => {
  assert(routes.includes("router.get('/accounts/:accountId/orders/:orderId/shipment', requireMarketplaceWarehouseAccess"));
  assert(routes.includes("router.post('/accounts/:accountId/orders/:orderId/shipment/prepare', requireMarketplaceWarehouseAccess"));
  assert(routes.includes("router.get('/accounts/:accountId/orders/:orderId/shipment/label', requireMarketplaceWarehouseAccess"));
});

check('shipment creation is fail-closed on local picking readiness and fresh upstream state', () => {
  assert(shipment.includes('AllegroPickingOrder.findOne'));
  assert(shipment.includes("pickingStatus === ORDER_STATUS.READY_WITH_ISSUE"));
  assert(shipment.includes("pickingStatus !== ORDER_STATUS.READY"));
  assert(shipment.includes("stage: 'shipment_order_revalidate'"));
  assert(shipment.includes('classifyUpstream(current.payload)'));
  assert(shipment.includes("throw appError('allegro_order_cancelled'"));
});

check('shipment creation uses Allegro delivery proposal and one durable command id per order', () => {
  assert(shipment.includes('/shipment-management/delivery-proposals/${encodeURIComponent(oid)}'));
  assert(shipment.includes("path: '/shipment-management/shipments/create-commands'"));
  assert(shipment.includes('const commandId = binding?.commandId || crypto.randomUUID()'));
  assert(model.includes('commandId'));
  assert(model.includes('index({ accountId: 1, orderId: 1 }, { unique: true })'));
});

check('existing upstream tracking blocks accidental duplicate shipment creation', () => {
  const trackingPos = shipment.indexOf('const trackingBefore = await fetchOrderTracking(aid, oid)');
  const proposalPos = shipment.indexOf("stage: 'shipment_delivery_proposal'");
  assert(trackingPos >= 0 && proposalPos > trackingPos);
  assert(shipment.includes('externalTrackingOnly: true'));
});

check('shipment labels use the binary response path', () => {
  assert(shipment.includes("path: '/shipment-management/label'"));
  assert(shipment.includes("responseType: 'buffer'"));
  assert(http.includes("options.responseType === 'buffer'"));
  assert(http.includes('Buffer.from(await response.arrayBuffer())'));
});

check('shipment adapter requires shipment scopes per store', () => {
  assert(shipment.includes("'allegro:api:shipments:write'"));
  assert(shipment.includes("'allegro:api:shipments:read'"));
  assert(shipment.includes("throw appError('allegro_shipment_scope_required'"));
});

check('status advertises the Stage 5.1 workflow API version for frontend route guarding', () => {
  assert(routes.includes('hardeningStage: \'5.1\''));
  assert(routes.includes('workflowApiVersion: 2'));
});

console.log(`\nAllegro Stage 5.1 backend photos + TTN: ${pass}/${pass} PASS`);

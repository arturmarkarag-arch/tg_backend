'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

const route = read('routes/deliveryGroups.js');
const facade = read('services/readModels/deliveryGroupShopStatusReadModel.js');
const readiness = read('services/readModels/currentShopTopologyReadModel.js');
const current = read('services/readModels/currentSessionShopStatusReadModel.js');
const orderingStatus = read('services/readModels/sellerOrderingStatusReadModel.js');
const shopProducts = read('services/readModels/currentSessionShopProductsReadModel.js');
const groupCatalog = read('services/readModels/deliveryGroupCatalogReadModel.js');
const sessionSummary = read('services/readModels/deliveryGroupSessionSummaryReadModel.js');

const readModels = {
  'currentShopTopologyReadModel.js': readiness,
  'currentSessionShopStatusReadModel.js': current,
  'deliveryGroupShopStatusReadModel.js': facade,
  'sellerOrderingStatusReadModel.js': orderingStatus,
  'currentSessionShopProductsReadModel.js': shopProducts,
  'deliveryGroupCatalogReadModel.js': groupCatalog,
  'deliveryGroupSessionSummaryReadModel.js': sessionSummary,
};
const forbiddenWrite = /\.(?:findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|create|save)\s*\(|startSession\(|withTransaction\(|getOrCreateSessionId\(/;

console.log('V48.21 OPERATIONAL READ MODELS — SERVER');
console.log('---------------------------------------');

check('deliveryGroups route delegates seller ordering-status read',
  route.includes('buildSellerOrderingStatusReadModel(req.telegramUser)'));
check('deliveryGroups route delegates readiness/current shop-status read',
  route.includes('buildDeliveryGroupShopStatusReadModel({'));
check('deliveryGroups route delegates lazy current-session product disclosure',
  route.includes('buildCurrentSessionShopProductsReadModel({'));
check('deliveryGroups route delegates group catalogue and summary reads',
  route.includes('buildDeliveryGroupSummaryReadModel()') && route.includes('buildDeliveryGroupListReadModel()'));
check('deliveryGroups route delegates session summary read',
  route.includes('buildDeliveryGroupSessionSummariesReadModel()'));
check('deliveryGroups controller is substantially reduced from pre-V48.21 aggregate size',
  route.split(/\r?\n/).length < 700);

for (const [name, source] of Object.entries(readModels)) {
  check(`${name} contains no domain-write/session-materialisation primitive`, !forbiddenWrite.test(source));
}

check('readiness module has no Order/session/history model dependency',
  !readiness.includes('models/Order')
  && !readiness.includes('models/OrderingSession')
  && !readiness.includes('models/PickingTask')
  && !readiness.includes('models/CatalogReview'));
check('readiness still derives CURRENT assignment through canonical projection',
  readiness.includes('buildReadinessShopProjection') && readiness.includes('ASSIGNED_SHOP_ROLES'));
check('shop-status facade uses explicit current/readiness vocabulary',
  facade.includes("CURRENT: 'current'") && facade.includes("READINESS: 'readiness'"));
check('readiness response explicitly has no current session identity', facade.includes('currentSessionId: null'));
check('current-session read model keeps assigned users separate from session participants',
  current.includes('assignedUsers: currentAssignedUsers') && current.includes('sessionParticipants,'));
check('CatalogReview is read only when a current session exists',
  current.includes('const reviewMarks = currentSessionId ? await CatalogReview.find('));
check('snapshot-only and top-level Order shop identity use one resolver',
  current.includes("return String(order?.shopId || order?.buyerSnapshot?.shopId || '')")
  && (current.match(/resolveOrderShopId\(order\)/g) || []).length >= 2);
check('seller ordering-status uses read-only session lookup',
  orderingStatus.includes('findCurrentSessionId(String(group._id), group.orderingSchedule)'));
check('delivery-group selector phase remains owned by sessionPresentation',
  groupCatalog.includes('getCurrentGroupPresentation(group, { now })')
  && !groupCatalog.includes('deriveSessionPhase('));
check('ordered-products disclosure reuses liveItem from current-session projection',
  shopProducts.includes("require('./currentSessionShopStatusReadModel')")
  && shopProducts.includes('if (!liveItem(item)) continue'));
check('admin session summaries use existing session identity only',
  sessionSummary.includes('findCurrentSessionId(') && !sessionSummary.includes('getOrCreateSessionId('));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.21 OPERATIONAL READ MODELS: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

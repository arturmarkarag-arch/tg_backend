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

function runtimeJsFiles() {
  const out = [];
  const walk = (p) => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
    }
  };
  for (const rel of ['routes', 'services', 'utils']) walk(path.join(ROOT, rel));
  out.push(path.join(ROOT, 'socket.js'), path.join(ROOT, 'telegramBot.js'));
  return out;
}
const rel = (file) => path.relative(ROOT, file).replace(/\\/g, '/');

const users = read('routes/users.js');
const orders = read('routes/orders.js');
const telegram = read('routes/v1/telegram.js');
const assignment = read('services/shopAssignmentCommand.js');
const migration = read('services/migrateSellerShop.js');
const unassign = read('services/unassignSeller.js');
const transfer = read('routes/shopTransfer.js');
const shops = read('routes/shops.js');
const invite = read('services/redeemShopInvite.js');
const softRemove = read('services/softRemoveUser.js');
const registration = read('services/createUserFromRequest.js');
const bot = read('telegramBot.js');
const topology = read('services/shopTopologyCommand.js');
const blocks = read('routes/blocks.js');
const blockCommand = read('services/blockMoveCommand.js');
const blockPrimitives = read('services/blockMembershipPrimitives.js');
const products = read('routes/products.js');
const archive = read('services/archiveProduct.js');
const archivePrimitives = read('services/archiveProductPrimitives.js');
const scrub = read('utils/scrubBlocks.js');
const warehouseTest = read('routes/warehouseTest.js');

console.log('V48.20 MUTATION AUTHORITY — SERVER');
console.log('----------------------------------');

check('ordinary admin User->Shop changes use application commands',
  users.includes('assignUserToShopCommand({') && users.includes('unassignUserFromShopCommand({')
  && !users.includes('migrateSellerShop({') && !users.includes('unassignSellerAndPark({'));
check('seller self-service assignment uses the same application command', telegram.includes('assignUserToShopCommand({'));
check('conflict repair uses application commands with explicit frozen-order opt-ins',
  orders.includes('assignUserToShopCommand({') && orders.includes('unassignUserFromShopCommand({')
  && orders.includes('allowFrozenOrderTransfer: true') && orders.includes('allowFrozenOrderPark: true')
  && !orders.includes('migrateSellerShop({') && !orders.includes('unassignSellerAndPark({'));
check('assignment application command owns lock + transaction + low-level primitives',
  assignment.includes('withLock(`user:${tid}:shop`') && assignment.includes('session.withTransaction(async () =>')
  && assignment.includes('migrateSellerShop({') && assignment.includes('unassignSellerAndPark({'));
check('assignment publisher is topology-driven rather than movedOrder-driven',
  assignment.includes('if (!result.assignmentChanged && !result.orderChanged) return result')
  && assignment.includes("emit('shop_status_changed', { groupId })")
  && assignment.includes("io.emit('delivery_groups_updated')"));
check('migration/unassignment expose transition metadata even without an Order move',
  migration.includes('assignmentChanged: oldShopId !== newShopId')
  && migration.includes('prevGroupId = oldShopFull?.deliveryGroupId')
  && unassign.includes('assignmentChanged: Boolean(shopIdStr)') && unassign.includes('prevGroupId'));
check('shop transfer publishes canonical transition after its wider transaction',
  transfer.includes('migrateSellerShop({') && transfer.includes('publishShopAssignmentTransition(migrationResult)'));
check('bulk shop seller edit keeps retry-safe transition metadata and publishes every committed transition',
  shops.includes('assignmentTransitions.push') && shops.includes('assignmentTransitions.length = 0')
  && shops.includes('publishShopAssignmentTransition(transition)'));
check('shop invite and soft removal share post-commit assignment publication',
  invite.includes('publishShopAssignmentTransition({') && softRemove.includes('publishShopAssignmentTransition(assignmentTransition)'));
check('registration returns transition metadata and HTTP/Bot callers publish it post-commit',
  registration.includes('return { user, assignmentTransition }')
  && registration.includes('return { user: existing, assignmentTransition }')
  && telegram.includes('publishShopAssignmentTransition(assignmentTransition)')
  && bot.includes('publishShopAssignmentTransition(resolution.assignmentTransition)'));
check('initial admin-created assigned User publishes canonical CURRENT transition',
  assignment.includes('function buildInitialAssignmentTransition')
  && users.includes('buildInitialAssignmentTransition({ user, shop: targetShop })'));

check('Shop PATCH delegates to canonical topology command', shops.includes('updateShopTopologyCommand({'));
check('Shop topology command owns distributed lock + one transaction',
  topology.includes('withLock(`shop:${id}:topology`') && topology.includes('session.withTransaction(async () =>'));
check('Shop topology guard is read-only and does not materialize OrderingSession',
  topology.includes('OrderingSession.findOne(') && topology.includes('getOpenDateWarsaw')
  && !topology.includes('getOrCreateSessionId'));
check('Shop identity/order/task propagation is inside the topology transaction',
  topology.includes('await shop.save({ session })') && topology.includes('Order.updateMany')
  && topology.includes('PickingTask.updateMany'));
check('Shop topology publication runs only after the transaction block',
  topology.indexOf('await session.endSession()') < topology.indexOf('await invalidateShop(id)'));

const blockPatterns = [
  /\b(?:block|source|target|freshBlock|current)\.productIds\s*\.\s*(?:push|splice)\s*\(/,
  /\$pull\s*:\s*\{\s*productIds/,
  /\$push\s*:\s*\{\s*productIds/,
  /\$set\s*:\s*\{\s*productIds/,
  /\.productIds\s*=\s*filteredIds/,
];
const blockAllowed = new Set(['services/blockMoveCommand.js', 'services/blockMembershipPrimitives.js']);
const blockOffenders = runtimeJsFiles().filter((file) => {
  const relative = rel(file);
  if (blockAllowed.has(relative)) return false;
  const src = fs.readFileSync(file, 'utf8');
  return blockPatterns.some((pattern) => pattern.test(src));
}).map(rel);
check('all runtime Block.productIds writes are confined to membership command/primitives', blockOffenders.length === 0);
check('HTTP block transport delegates move/place/remove/repair',
  blocks.includes('moveProductBetweenBlocks') && blocks.includes('placeProductInBlock')
  && blocks.includes('removeProductFromBlock') && blocks.includes('repairBlockMissingProducts')
  && !blocks.includes('refreshPickingTaskPositions'));
check('canonical block membership command owns derived PickingTask position repair',
  blockCommand.includes('refreshPickingTaskPositions()'));
check('transaction-aware block primitives exist for wider aggregate workflows',
  blockPrimitives.includes('detachProductFromAllBlocks')
  && blockPrimitives.includes('appendProductsToBlockDocument')
  && blockPrimitives.includes('pruneInvalidBlockProductIds'));
check('block-photo, archive, maintenance and admin test workflows use membership primitives',
  products.includes('appendProductsToBlockDocument({')
  && archivePrimitives.includes('detachProductFromAllBlocks({')
  && scrub.includes('pruneInvalidBlockProductIds({')
  && warehouseTest.includes('appendProductsToBlockDocument({'));
check('archive and scrub reconcile derived picking positions after physical removal',
  archive.includes('positionChanges = await refreshPickingTaskPositions()')
  && scrub.includes('await refreshPickingTaskPositions()'));

const topologyOffenders = runtimeJsFiles().filter((file) => {
  const relative = rel(file);
  if (relative === 'services/shopTopologyCommand.js') return false;
  const src = fs.readFileSync(file, 'utf8');
  return /\bshop\.deliveryGroupId\s*=(?!=)/.test(src) || /\bshop\.isActive\s*=(?!=)/.test(src);
}).map(rel);
check('direct Shop.deliveryGroupId/isActive assignment is confined to topology command', topologyOffenders.length === 0);

check('supplement topology authority uses exact-session item state; Shop deactivation additionally fences exact current request revision',
  topology.includes('SupplementOffer.find')
  && topology.includes('orderingSessionId: String(currentSession._id)')
  && topology.includes('status: { $in: ACTIVE_ITEM_STATUSES }')
  && topology.includes('itemStatus: ITEM_RELATION_STATUS.ACTIVE')
  && topology.includes('SupplementRequest.exists')
  && topology.includes('revision: revisionOf(offer)')
  && topology.includes('shopId: shop._id')
  && topology.includes("throw appError('shop_deactivate_session_active'"));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.20 MUTATION AUTHORITY: ${checks.length - failed.length}/${checks.length} PASS`);
if (blockOffenders.length) console.log(`Block writer offenders: ${blockOffenders.join(', ')}`);
if (topologyOffenders.length) console.log(`Shop topology offenders: ${topologyOffenders.join(', ')}`);
if (failed.length) process.exit(1);

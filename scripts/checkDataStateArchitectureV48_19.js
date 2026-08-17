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

const state = read('utils/shopOperationalState.js');
const projection = read('services/shopStatusProjection.js');
const groups = read('routes/deliveryGroups.js');
const shopStatusFacade = read('services/readModels/deliveryGroupShopStatusReadModel.js');
const readinessShopStatus = read('services/readModels/currentShopTopologyReadModel.js');
const currentShopStatus = read('services/readModels/currentSessionShopStatusReadModel.js');
const shops = read('routes/shops.js');
const users = read('routes/users.js');
const transfer = read('routes/shopTransfer.js');
const migration = read('services/migrateSellerShop.js');
const assignmentCommand = read('services/shopAssignmentCommand.js');
const orders = read('routes/orders.js');
const supplement = read('routes/supplement.js');
const blockCommand = read('services/blockMoveCommand.js');
const blocks = read('routes/blocks.js');
const socket = read('socket.js');

console.log('V48.19 DATA/STATE ARCHITECTURE — SERVER');
console.log('---------------------------------------');

check('CURRENT shop-assignment semantics live in one policy module',
  state.includes("ASSIGNED_SHOP_ROLES = Object.freeze(['seller', 'admin'])")
  && state.includes('buildCurrentAssignment'));
check('assigned and operational assignment are distinct facts',
  state.includes('assignedCount') && state.includes('operationalCount')
  && state.includes('hasAssigned') && state.includes('hasOperationalUser'));
check('read-model layer explicitly separates currentAssignment from sessionParticipants',
  projection.includes('currentAssignment') && projection.includes('sessionParticipants')
  && projection.includes('Business decisions MUST use'));
check('readiness and current session use the shared shop-status projection builders',
  groups.includes('buildDeliveryGroupShopStatusReadModel({')
  && shopStatusFacade.includes("require('./currentShopTopologyReadModel')")
  && shopStatusFacade.includes("require('./currentSessionShopStatusReadModel')")
  && readinessShopStatus.includes('buildReadinessShopProjection')
  && currentShopStatus.includes('buildCurrentSessionShopProjection'));
check('Settings /shops exposes the same currentAssignment contract',
  shops.includes('buildCurrentAssignment(shopSellers, { shop: s })') && shops.includes('currentAssignment,'));
check('POST /users is create-only for an existing telegram identity',
  users.includes("if (existing) throw appError('user_telegram_id_taken'") && users.includes('User.create(payload)'));
check('generic user patch refuses raw shop transition and uses application commands',
  users.includes('canonical_assignment_required')
  && users.includes('assignUserToShopCommand({')
  && users.includes('unassignUserFromShopCommand({')
  && !users.includes('migrateSellerShop({')
  && !users.includes('unassignSellerAndPark({')
  && assignmentCommand.includes('migrateSellerShop({')
  && assignmentCommand.includes('unassignSellerAndPark({'));

check('shop-transfer approval uses the canonical migration for initial and later assignment',
  transfer.includes('One assignment command for BOTH initial placement and later transfers')
  && transfer.includes('migrationResult = await migrateSellerShop({'));
check('soft-removed re-registration validates the intended role, not stale removed-account role',
  read('services/createUserFromRequest.js').includes('existingUser: { ...existing.toObject(), role }'));
check('canonical assignment command enforces role and re-reads target shop in-session',
  migration.includes('assertAssignableShopRole(existingUser?.role, appError)')
  && migration.includes('const freshTargetShop = await Shop.findById(requestedShopId)')
  && migration.includes('assertOperationalShop(freshTargetShop, appError)'));
check('inactive shops are blocked at normal ordering writes', orders.includes("throw appError('shop_inactive')"));
check('inactive shops are blocked at supplement writes', supplement.includes("throw appError('shop_inactive')"));
check('inactive shops cannot create catalog-reviewed session events',
  groups.includes("if (shop.isActive === false) throw appError('shop_inactive')"));
check('HTTP block move delegates to one canonical command',
  blocks.includes("require('../services/blockMoveCommand')") && blocks.includes('await moveProductBetweenBlocks({'));
check('Socket block move delegates to the same canonical command',
  socket.includes("require('./services/blockMoveCommand')") && socket.includes('await moveProductBetweenBlocks({'));
check('canonical block command owns PickingTask position reconciliation',
  blockCommand.includes('const positionChanges = await refreshPickingTaskPositions()'));
check('canonical block command owns optimistic source/target version checks',
  blockCommand.includes('expectedFromVersion') && blockCommand.includes('expectedToVersion')
  && blockCommand.includes("throw appError('block_stale'"));
check('Socket transport no longer owns its own Mongo block transaction',
  !socket.includes("const mongoose = require('mongoose')") && !socket.includes('mongoose.connection.startSession'));
check('stable shop_inactive error exists in API vocabulary', read('utils/errors.js').includes('shop_inactive'));

const failed = checks.filter((row) => !row.ok);
console.log(`\nV48.19 DATA/STATE SERVER: ${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

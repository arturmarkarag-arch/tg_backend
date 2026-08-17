'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

describe('V48.19 Data/State architecture contract', () => {
  it('shop status has an explicit CURRENT vs SESSION/HISTORY read-model boundary', () => {
    const route = read('routes/deliveryGroups.js');
    const facade = read('services/readModels/deliveryGroupShopStatusReadModel.js');
    const projection = read('services/shopStatusProjection.js');
    expect(route).toContain("require('../services/readModels/deliveryGroupShopStatusReadModel')");
    expect(route).toContain('buildDeliveryGroupShopStatusReadModel({');
    expect(facade).toContain("require('./currentShopTopologyReadModel')");
    expect(facade).toContain("require('./currentSessionShopStatusReadModel')");
    expect(projection).toContain('currentAssignment');
    expect(projection).toContain('sessionParticipants');
    expect(projection).toContain('Business decisions MUST use');
  });

  it('settings and picking expose the same CURRENT assignment contract', () => {
    const shops = read('routes/shops.js');
    const readiness = read('services/readModels/currentShopTopologyReadModel.js');
    const current = read('services/readModels/currentSessionShopStatusReadModel.js');
    expect(shops).toContain('currentAssignment');
    expect(shops).toContain('buildCurrentAssignment(shopSellers, { shop: s })');
    expect(readiness).toContain('buildReadinessShopProjection');
    expect(current).toContain('buildCurrentSessionShopProjection');
  });

  it('existing users cannot be updated through POST /users', () => {
    const users = read('routes/users.js');
    const createRoute = sliceBetweenOrThrow(users, "router.post('/',", "router.patch('/:telegramId/shop'", { label: 'POST /users' });
    expect(createRoute).toContain('if (existing) throw appError(\'user_telegram_id_taken\'');
    expect(createRoute).toContain('User.create(payload)');
    expect(createRoute).not.toContain('findByIdAndUpdate');
    expect(createRoute).not.toContain('findOneAndUpdate');
  });

  it('all ordinary existing-user shop changes use the application assignment command', () => {
    const users = read('routes/users.js');
    const command = read('services/shopAssignmentCommand.js');
    expect(users).toContain("require('../services/shopAssignmentCommand')");
    expect(users).toContain('assignUserToShopCommand({');
    expect(users).toContain('unassignUserFromShopCommand({');
    expect(users).toContain('canonical_assignment_required');
    expect(users).not.toContain('migrateSellerShop({');
    expect(users).not.toContain('unassignSellerAndPark({');
    expect(command).toContain('migrateSellerShop({');
    expect(command).toContain('unassignSellerAndPark({');

    const transfer = read('routes/shopTransfer.js');
    const approval = sliceBetweenOrThrow(transfer, "router.post('/:id/approve'", "router.post('/:id/reject'", { label: 'shop transfer approve' });
    expect(approval).toContain('migrateSellerShop({');
    expect(approval).toContain('publishShopAssignmentTransition(migrationResult)');
    expect(approval).not.toMatch(/User\.(?:updateOne|findOneAndUpdate)\([^\n]*shopId/);
  });

  it('soft-removed re-registration validates the intended new role at the canonical assignment boundary', () => {
    const registration = read('services/createUserFromRequest.js');
    expect(registration).toContain('existingUser: { ...existing.toObject(), role }');
  });

  it('canonical assignment command rechecks role and target shop inside the transaction session', () => {
    const migration = read('services/migrateSellerShop.js');
    expect(migration).toContain('assertAssignableShopRole(existingUser?.role, appError)');
    expect(migration).toContain('const freshTargetShop = await Shop.findById(requestedShopId)');
    expect(migration).toContain('.session(session)');
    expect(migration).toContain('assertOperationalShop(freshTargetShop, appError)');
  });

  it('inactive shops cannot accept new ordering, supplement, assignment or catalogue-reviewed writes', () => {
    expect(read('routes/orders.js')).toContain("throw appError('shop_inactive')");
    expect(read('routes/supplement.js')).toContain("throw appError('shop_inactive')");
    expect(read('routes/deliveryGroups.js')).toContain("throw appError('shop_inactive')");
    expect(read('services/migrateSellerShop.js')).toContain('assertOperationalShop(freshTargetShop, appError)');
  });

  it('HTTP and Socket block moves call one canonical command', () => {
    const http = read('routes/blocks.js');
    const socket = read('socket.js');
    const command = read('services/blockMoveCommand.js');
    expect(http).toContain("require('../services/blockMoveCommand')");
    expect(http).toContain('await moveProductBetweenBlocks({');
    expect(socket).toContain("require('./services/blockMoveCommand')");
    expect(socket).toContain('await moveProductBetweenBlocks({');
    expect(command).toContain('refreshPickingTaskPositions()');
    expect(command).toContain('expectedFromVersion');
    expect(command).toContain('expectedToVersion');
  });
});

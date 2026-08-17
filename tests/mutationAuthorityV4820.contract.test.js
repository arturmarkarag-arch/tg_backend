'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function runtimeJsFiles() {
  const roots = ['routes', 'services', 'utils'];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  for (const rel of roots) walk(path.join(ROOT, rel));
  out.push(path.join(ROOT, 'socket.js'), path.join(ROOT, 'telegramBot.js'));
  return out;
}

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }

describe('V48.20 Mutation Authority contract', () => {
  it('ordinary User -> Shop mutations go through one application command', () => {
    const users = read('routes/users.js');
    const telegram = read('routes/v1/telegram.js');
    const orders = read('routes/orders.js');
    const command = read('services/shopAssignmentCommand.js');

    expect(users).toContain('assignUserToShopCommand({');
    expect(users).toContain('unassignUserFromShopCommand({');
    expect(telegram).toContain('assignUserToShopCommand({');
    expect(orders).toContain('assignUserToShopCommand({');
    expect(orders).toContain('unassignUserFromShopCommand({');
    expect(users).not.toContain('migrateSellerShop({');
    expect(users).not.toContain('unassignSellerAndPark({');
    expect(orders).not.toContain('migrateSellerShop({');
    expect(orders).not.toContain('unassignSellerAndPark({');

    expect(command).toContain('withLock(`user:${tid}:shop`');
    expect(command).toContain('session.withTransaction(async () =>');
    expect(command).toContain('migrateSellerShop({');
    expect(command).toContain('unassignSellerAndPark({');
  });

  it('assignment publication is driven by topology transition, not whether an Order moved', () => {
    const command = read('services/shopAssignmentCommand.js');
    const migration = read('services/migrateSellerShop.js');
    const unassign = read('services/unassignSeller.js');

    expect(command).toContain('if (!result.assignmentChanged) return result');
    expect(command).toContain("emit('shop_status_changed', { groupId })");
    expect(command).toContain("io.emit('delivery_groups_updated')");
    expect(command).toContain('result.orderChanged && result.sellerTelegramId');
    expect(migration).toContain('assignmentChanged: oldShopId !== newShopId');
    expect(migration).toContain('prevGroupId = oldShopFull?.deliveryGroupId');
    expect(unassign).toContain('assignmentChanged: Boolean(shopIdStr)');
    expect(unassign).toContain('prevGroupId');
  });

  it('wider assignment workflows use the low-level primitive only inside their transaction and share post-commit publication', () => {
    const transfer = read('routes/shopTransfer.js');
    const shops = read('routes/shops.js');
    const invite = read('services/redeemShopInvite.js');
    const remove = read('services/softRemoveUser.js');
    const registration = read('services/createUserFromRequest.js');
    const telegram = read('routes/v1/telegram.js');
    const bot = read('telegramBot.js');

    expect(transfer).toContain('migrateSellerShop({');
    expect(transfer).toContain('publishShopAssignmentTransition(migrationResult)');
    expect(shops).toContain('assignmentTransitions.push');
    expect(shops).toContain('assignmentTransitions.length = 0');
    expect(shops).toContain('publishShopAssignmentTransition(transition)');
    expect(invite).toContain('migrateSellerShop({');
    expect(invite).toContain('publishShopAssignmentTransition({');
    expect(remove).toContain('unassignSellerAndPark({');
    expect(remove).toContain('publishShopAssignmentTransition(assignmentTransition)');

    // Registration must keep token/request + account creation atomic, but returns
    // transition metadata so the caller publishes only AFTER its transaction.
    expect(registration).toContain('return { user: existing, assignmentTransition }');
    expect(registration).toContain('return { user, assignmentTransition }');
    expect(telegram).toContain('publishShopAssignmentTransition(assignmentTransition)');
    expect(bot).toContain('publishShopAssignmentTransition(resolution.assignmentTransition)');
  });

  it('initial account creation with a shop publishes the same CURRENT transition contract', () => {
    const users = read('routes/users.js');
    const command = read('services/shopAssignmentCommand.js');
    const createRoute = sliceBetweenOrThrow(users, "router.post('/',", "router.patch('/:telegramId/shop'", { label: 'POST /users' });
    expect(command).toContain('function buildInitialAssignmentTransition');
    expect(createRoute).toContain('buildInitialAssignmentTransition({ user, shop: targetShop })');
    expect(createRoute).toContain('publishShopAssignmentTransition(');
  });

  it('Shop topology mutation has one transactional command and never materializes a session just to validate an edit', () => {
    const shops = read('routes/shops.js');
    const command = read('services/shopTopologyCommand.js');
    const patchRoute = sliceBetweenOrThrow(shops, "router.patch('/:id'", "router.delete('/:id'", { label: 'PATCH /shops/:id' });

    expect(patchRoute).toContain('updateShopTopologyCommand({');
    expect(patchRoute).not.toContain('shop.deliveryGroupId =');
    expect(patchRoute).not.toContain('Order.updateMany');
    expect(patchRoute).not.toContain('PickingTask.updateMany');
    expect(command).toContain('withLock(`shop:${id}:topology`');
    expect(command).toContain('session.withTransaction(async () =>');
    expect(command).toContain('OrderingSession.findOne(');
    expect(command).toContain('getOpenDateWarsaw');
    expect(command).not.toContain('getOrCreateSessionId');
    expect(command).toContain("io.emit('delivery_groups_updated')");
  });

  it('Product -> Block membership writes live only in canonical membership modules', () => {
    const offenders = [];
    const mutationPatterns = [
      /\b(?:block|source|target|freshBlock|current)\.productIds\s*\.\s*(?:push|splice)\s*\(/,
      /\$pull\s*:\s*\{\s*productIds/,
      /\$push\s*:\s*\{\s*productIds/,
      /\$set\s*:\s*\{\s*productIds/,
      /\.productIds\s*=\s*filteredIds/,
    ];
    const allowed = new Set([
      'services/blockMoveCommand.js',
      'services/blockMembershipPrimitives.js',
    ]);

    for (const file of runtimeJsFiles()) {
      const relative = rel(file);
      const src = fs.readFileSync(file, 'utf8');
      if (!allowed.has(relative) && mutationPatterns.some((pattern) => pattern.test(src))) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('HTTP block routes are transport-only for move/place/remove/repair', () => {
    const blocks = read('routes/blocks.js');
    expect(blocks).toContain('repairBlockMissingProducts');
    expect(blocks).toContain('moveProductBetweenBlocks');
    expect(blocks).toContain('removeProductFromBlock');
    expect(blocks).toContain('placeProductInBlock');
    expect(blocks).not.toMatch(/\$pull\s*:\s*\{\s*productIds/);
    expect(blocks).not.toMatch(/\$push\s*:\s*\{\s*productIds/);
    expect(blocks).not.toContain('refreshPickingTaskPositions');
  });

  it('wider Product/Block workflows use transaction-aware membership primitives instead of writing arrays themselves', () => {
    const upload = read('routes/products.js');
    const archivePrimitives = read('services/archiveProductPrimitives.js');
    const scrub = read('utils/scrubBlocks.js');
    const warehouseTest = read('routes/warehouseTest.js');
    const primitives = read('services/blockMembershipPrimitives.js');

    expect(upload).toContain('appendProductsToBlockDocument({');
    expect(archivePrimitives).toContain('detachProductFromAllBlocks({');
    expect(scrub).toContain('pruneInvalidBlockProductIds({');
    expect(warehouseTest).toContain('appendProductsToBlockDocument({');
    expect(warehouseTest).toContain('pruneInvalidBlockProductIds({');
    expect(primitives).toContain('async function detachProductFromAllBlocks');
    expect(primitives).toContain('async function appendProductsToBlockDocument');
    expect(primitives).toContain('async function pruneInvalidBlockProductIds');
  });

  it('every physical removal path reconciles derived PickingTask positions after truth changes', () => {
    const command = read('services/blockMoveCommand.js');
    const archive = read('services/archiveProduct.js');
    const scrub = read('utils/scrubBlocks.js');
    expect(command).toContain('refreshPickingTaskPositions()');
    expect(archive).toContain('positionChanges = await refreshPickingTaskPositions()');
    expect(archive).toContain("emit('picking_tasks_positions_updated', positionChanges)");
    expect(scrub).toContain('await refreshPickingTaskPositions()');
  });

  it('direct CURRENT shop topology field writes are confined to the topology command', () => {
    const offenders = [];
    for (const file of runtimeJsFiles()) {
      const relative = rel(file);
      const src = fs.readFileSync(file, 'utf8');
      if (relative !== 'services/shopTopologyCommand.js'
          && (/\bshop\.deliveryGroupId\s*=(?!=)/.test(src) || /\bshop\.isActive\s*=(?!=)/.test(src))) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('supplement topology guard belongs to Wave/session ownership, never child request rows', () => {
    const command = read('services/shopTopologyCommand.js');
    // V48.S2 resolved the former F-09 policy. CURRENT Shop topology is blocked by
    // non-terminal work owned by the exact OrderingSession aggregate. Child item
    // / request rows are not allowed to become topology authority.
    expect(command).toContain('SupplementWave');
    expect(command).toContain('orderingSessionId');
    expect(command).not.toContain('SupplementOffer');
    expect(command).not.toContain('SupplementRequest');
  });
});

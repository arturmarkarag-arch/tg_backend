const express = require('express');
const User = require('../models/User');
const Shop = require('../models/Shop');
const { telegramAuth, requireTelegramRole } = require('../middleware/telegramAuth');
const ClearedCart = require('../models/ClearedCart');
const {
  assignUserToShopCommand,
  unassignUserFromShopCommand,
  buildInitialAssignmentTransition,
  publishShopAssignmentTransition,
} = require('../services/shopAssignmentCommand');
const { appError, asyncHandler } = require('../utils/errors');
const { getIO } = require('../socket');
const { softRemoveUser } = require('../services/softRemoveUser');
const {
  readAdminUser, parsePage, parseSearch, optionalObjectId, buildUserSearchClauses, readUserPage,
} = require('../services/readModels/userDirectoryReadModel');
const { isAssignedShopRole, assertOperationalShop } = require('../utils/shopOperationalState');

const router = express.Router();
router.use(telegramAuth);
router.use(requireTelegramRole('admin'));

async function sendAdminUser(res, telegramId, status = 200) {
  const dto = await readAdminUser(telegramId);
  try { getIO()?.to('staff').emit('user_directory_changed', {}); } catch (_) { /* best effort */ }
  return res.status(status).json(dto);
}

async function sanitizeUserPayload(payload, existing = null) {
  const role = payload.role ?? existing?.role ?? 'seller';
  const data = { role };

  // Only write fields that were explicitly provided — undefined means "not in payload, leave as-is"
  if (payload.firstName  !== undefined) data.firstName  = payload.firstName;
  if (payload.lastName   !== undefined) data.lastName   = payload.lastName;
  if (payload.phoneNumber !== undefined) data.phoneNumber = payload.phoneNumber;
  // Google sign-in is OAuth-PROVEN (googleSub), never admin-typed. A typed email
  // linked nothing (login keys on sub, not email) and was misleading, so the
  // manual googleEmail field is gone. The admin can only UNLINK — which clears
  // BOTH sub and email. Linking is done by the user in the mini-app
  // (Профіль → «Привʼязати Google»).
  if (payload.unlinkGoogle === true || payload.unlinkGoogle === 'true') {
    data.googleSub = '';
    data.googleEmail = '';
  }
  if (payload.botBlocked !== undefined && payload.botBlocked !== null) {
    data.botBlocked = Boolean(payload.botBlocked === 'false' ? false : payload.botBlocked);
  }
  // Seller-specific fields. Група доставки НЕ пишеться в User — вона живе на
  // магазині (Shop.deliveryGroupId), тож призначення магазину саме по собі й
  // визначає групу.
  if (isAssignedShopRole(role)) {
    if (payload.shopId !== undefined) data.shopId = payload.shopId || null;
    if (payload.shopNumber !== undefined) data.shopNumber = payload.shopNumber;
  } else {
    data.shopId = null;
    data.shopNumber = '';
  }

  return data;
}

router.get('/', asyncHandler(async (req, res) => {
  const pagination = parsePage(req.query);
  const filter = { accountState: { $ne: 'removed' } };
  const role = req.query.role;
  if (role && role !== 'all') {
    if (!['seller', 'admin', 'warehouse', 'baselinker'].includes(role)) throw appError('validation_failed', { field: 'role' });
    filter.role = role;
  }
  // Retired filters used unscoped legacy cart/timestamp state. Never silently
  // return a misleading "no order" list for an old caller.
  if (req.query.activityFilter) throw appError('user_activity_filter_retired');
  const groupId = optionalObjectId(req.query.deliveryGroupId, 'deliveryGroupId');
  const cityId = optionalObjectId(req.query.cityId, 'cityId');
  if (groupId || cityId) {
    const scope = {};
    if (groupId) scope.deliveryGroupId = String(groupId);
    if (cityId) scope.cityId = cityId;
    const shops = await Shop.find(scope).select('_id').lean();
    filter.shopId = { $in: shops.map((shop) => shop._id) };
  }
  const clauses = await buildUserSearchClauses(parseSearch(req.query.search));
  if (clauses.length) filter.$and = clauses;
  res.json(await readUserPage(filter, pagination));
}));

// Declared BEFORE /:telegramId. Assignment search is admin-only via router.use.
// Assigned people are returned by /shops; this endpoint is only for candidates.
router.get('/assignment-candidates', asyncHandler(async (req, res) => {
  const pagination = parsePage(req.query, 50);
  const shopId = optionalObjectId(req.query.shopId, 'shopId');
  if (!shopId) throw appError('validation_failed', { field: 'shopId' });
  const scope = req.query.scope || 'unassigned';
  if (!['unassigned', 'all'].includes(scope)) throw appError('validation_failed', { field: 'scope' });
  const search = parseSearch(req.query.search);
  if (scope === 'all' && search.length < 2) throw appError('validation_failed', { field: 'search' });
  const shop = await Shop.findById(shopId).select('_id').lean();
  if (!shop) throw appError('shop_not_found');
  const filter = {
    role: 'seller',
    accountState: { $ne: 'removed' },
    shopId: scope === 'unassigned' ? null : { $ne: shopId },
  };
  const clauses = await buildUserSearchClauses(search);
  if (clauses.length) filter.$and = clauses;
  res.json(await readUserPage(filter, pagination, { candidates: true }));
}));

router.get('/:telegramId', asyncHandler(async (req, res) => {
  res.json(await readAdminUser(req.params.telegramId));
}));

const { cartItemsToObject } = require('../services/clearedCart');

// ─── GET /api/users/:telegramId/cleared-carts ───────────────────────────────
// Historical legacy snapshots, shown as read-only records in Order history.
router.get('/:telegramId/cleared-carts', asyncHandler(async (req, res) => {
  const carts = await ClearedCart.find({ ownerTelegramId: req.params.telegramId })
    .select('_id clearedAt clearedByName reason shopName orderItems restoredAt restoredByName')
    .sort({ clearedAt: -1, _id: -1 })
    .lean();
  res.json(carts.map((c) => {
    const items = cartItemsToObject(c.orderItems);
    return {
      _id: c._id,
      clearedAt: c.clearedAt,
      clearedByName: c.clearedByName,
      reason: c.reason,
      shopName: c.shopName,
      itemCount: Object.values(items).filter((quantity) => Number(quantity) > 0).length,
      restoredAt: c.restoredAt || null,
      restoredByName: c.restoredByName || '',
      restorable: false,
      restoreUnavailableReason: 'Знімок старого кошика не містить сесії замовлення. Автоматичне відновлення недоступне.',
    };
  }));
}));

// Historical ClearedCart snapshots have no orderingSessionId, canonical Order
// identity or frozen ownership. Writing them into User.cartState never restored
// an Order. Preserve the audit records and reject cached clients explicitly.
// Actual stale Orders retain the canonical /orders/:id/stale/restore-to-cart flow.
router.post('/:telegramId/cleared-carts/:cartId/restore', asyncHandler(async (req, res) => {
  const cartId = optionalObjectId(req.params.cartId, 'cartId');
  const snapshot = await ClearedCart.findOne({ _id: cartId, ownerTelegramId: req.params.telegramId }).select('_id').lean();
  if (!snapshot) throw appError('cleared_cart_not_found');
  throw appError('cleared_cart_legacy_unrestorable');
}));

router.post('/', asyncHandler(async (req, res) => {
  const telegramId = req.body.telegramId;
  if (!telegramId) throw appError('auth_telegram_id_missing');

  // CREATE means create. Updating an existing identity through POST used to be a
  // second mutation path that could raw-write shopId and bypass migrateSellerShop.
  // Existing users must go through PATCH, where assignment/unassignment has one
  // canonical transactional workflow.
  const existing = await User.findOne({ telegramId }).select('_id').lean();
  if (existing) throw appError('user_telegram_id_taken', { telegramId });

  const payload = await sanitizeUserPayload(req.body, null);
  payload.telegramId = telegramId;
  let targetShop = null;
  if (payload.shopId) {
    targetShop = await Shop.findById(payload.shopId).lean();
    assertOperationalShop(targetShop, appError);
  }
  try {
    const user = await User.create(payload);
    if (targetShop) {
      await publishShopAssignmentTransition(buildInitialAssignmentTransition({ user, shop: targetShop }));
    }
    return sendAdminUser(res, user.telegramId, 201);
  } catch (err) {
    // Race: another request created the same telegramId between findOne and create.
    if (err && err.code === 11000) {
      throw appError('user_telegram_id_taken', { telegramId });
    }
    throw err;
  }
}));

// Lightweight endpoint — one external assignment command for full consistency.
router.patch('/:telegramId/shop', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId }).select('role').lean();
  if (!existing) throw appError('user_not_found');
  if (!isAssignedShopRole(existing.role)) {
    throw appError('validation_failed', { field: 'role' });
  }

  const actor = req.telegramUser || { telegramId: 'admin', firstName: 'Admin', lastName: '', role: 'admin' };
  const { shopId } = req.body;

  const result = shopId
    ? await assignUserToShopCommand({
        telegramId: req.params.telegramId,
        shopId,
        actor,
        reason: 'admin_shop_assignment',
      })
    : await unassignUserFromShopCommand({
        telegramId: req.params.telegramId,
        actor,
        reason: 'admin_unassign_shop',
        updateLastSeller: true,
      });

  return sendAdminUser(res, req.params.telegramId);
}));

router.patch('/:telegramId', asyncHandler(async (req, res) => {
  const existing = await User.findOne({ telegramId: req.params.telegramId }).select('role shopId');
  if (!existing) throw appError('user_not_found');

  const payload = await sanitizeUserPayload(req.body, existing);

  // Existing-user assignment is an application command, not a raw User update.
  const oldShopId = existing.shopId ? String(existing.shopId) : null;
  const newShopId = payload.shopId ? String(payload.shopId) : null;
  const shopChanging = payload.shopId !== undefined && newShopId !== oldShopId && newShopId;

  if (shopChanging && isAssignedShopRole(payload.role ?? existing.role)) {
    const actor = req.telegramUser || { telegramId: 'admin', firstName: 'Admin', lastName: '', role: 'admin' };
    const nonShopPayload = { ...payload };
    delete nonShopPayload.shopId;

    const result = await assignUserToShopCommand({
      telegramId: req.params.telegramId,
      shopId: newShopId,
      actor,
      reason: 'admin_general_patch',
      userPatch: nonShopPayload,
    });
    return sendAdminUser(res, req.params.telegramId);
  }

  // Unassign through the same application command. Non-shop profile/role
  // edits are committed in the same transaction as the relation transition.
  const shopClearing = payload.shopId !== undefined && !newShopId && oldShopId
    && isAssignedShopRole(existing.role);
  if (shopClearing) {
    const actor = req.telegramUser || { telegramId: 'admin', firstName: 'Admin', lastName: '', role: 'admin' };
    const nonShopPayload = { ...payload };
    delete nonShopPayload.shopId;

    const result = await unassignUserFromShopCommand({
      telegramId: req.params.telegramId,
      actor,
      reason: 'admin_general_patch_unassign',
      userPatch: nonShopPayload,
      updateLastSeller: true,
    });
    return sendAdminUser(res, req.params.telegramId);
  }

  // Defensive invariant: no shopId transition is allowed to fall through to a
  // generic raw update. Every assignment/unassignment must pass the canonical
  // transactional migration path above.
  const rawShopLeak = payload.shopId !== undefined
    && (payload.shopId ? String(payload.shopId) : null) !== oldShopId;
  if (rawShopLeak) {
    throw appError('validation_failed', { field: 'shopId', details: 'canonical_assignment_required' });
  }

  const user = await User.findOneAndUpdate(
    { telegramId: req.params.telegramId },
    payload,
    { new: true, runValidators: true }
  );
  return sendAdminUser(res, req.params.telegramId);
}));

router.delete('/:telegramId', asyncHandler(async (req, res) => {
  const telegramId = String(req.params.telegramId || '').trim();
  const existing = await User.findOne({ telegramId }).select('_id').lean();
  if (!existing) throw appError('user_not_found');

  const result = await softRemoveUser({
    telegramId,
    actor: req.telegramUser,
  });

  try {
    const io = getIO();
    io?.to('staff').emit('user_directory_changed', {});
    io?.to(`user_${telegramId}`).emit('account_removed', { telegramId });
    io?.in(`user_${telegramId}`).disconnectSockets(true);
  } catch (_) { /* best-effort */ }

  res.json({
    message: 'Доступ користувача закрито. Дані збережено; повторна реєстрація дозволена.',
    ...result,
    removed: true,
    canRegisterAgain: true,
  });
}));

module.exports = router;

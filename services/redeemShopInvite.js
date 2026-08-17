// Redeem a shop invite for someone who ALREADY has an account → move them onto
// the invite's shop.
//
// There is exactly one link per shop (see services/registrationToken.js
// `issueShopInvite`). The bot decides what it means by looking at the redeemer:
//   • no account yet → registration with the shop pre-fixed (routes/v1/telegram.js);
//   • registered     → this file: a straight transfer, no admin confirmation.
//
// Single-use is enforced atomically by consuming the token inside the same
// transaction as the migration — and as the LAST step of it, after every
// refusal path has been ruled out (see the note in the transaction body). If two
// messages race, only the first flips `usedAt`; the second gets `code_consumed`.
//
// Returns one of:
//   { ok: true,  shop, movedOrder, prevGroupId, newGroupId }
//   { ok: false, reason: 'not_found' | 'not_seller' | 'same_shop' | 'code_consumed' | 'shop_inactive' }

const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const User = require('../models/User');
const { withLock } = require('../utils/lock');
const { publishShopAssignmentTransition } = require('./shopAssignmentCommand');
const { migrateSellerShop } = require('./migrateSellerShop');
const {
  peekShopInvite,
  consumeRegistrationToken,
  normalizeShopCode,
} = require('./registrationToken');

/**
 * @param {Object}  params
 * @param {string}  params.code              The shop code (raw; normalized here).
 * @param {string}  params.sellerTelegramId  Telegram id of whoever redeemed it.
 */
async function redeemShopInvite({ code, sellerTelegramId }) {
  const token = normalizeShopCode(code);
  const tgId = String(sellerTelegramId);

  // Fast reject outside the tx (and it scopes the lock). The authoritative
  // consume happens inside.
  const invite = await peekShopInvite(token);
  if (!invite) return { ok: false, reason: 'not_found' };

  const shopPreview = await Shop.findById(invite.shopId).lean();
  if (!shopPreview) return { ok: false, reason: 'not_found' };
  if (!shopPreview.isActive) return { ok: false, reason: 'shop_inactive' };

  // Only sellers may be moved. Admin/warehouse accounts are refused so a leaked
  // link can't silently re-home a staff account.
  const seller = await User.findOne({ telegramId: tgId, role: 'seller', accountState: { $ne: 'removed' } }).lean();
  if (!seller) return { ok: false, reason: 'not_seller' };

  if (String(seller.shopId || '') === String(shopPreview._id)) {
    return { ok: false, reason: 'same_shop' };
  }

  // Lock on the seller (matches the admin reassignment path) so a queued admin
  // edit and a code redeem can't both migrate the same seller on stale state.
  const result = await withLock(`user:${tgId}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out = null;
      await session.withTransaction(async () => {
        // ORDER MATTERS. Every refusal below exits with a plain `return`, and a
        // `return` inside withTransaction COMMITS — it does not abort. So the
        // token must be the LAST thing touched: consuming first burnt the link on
        // "shop_inactive"/"not_seller"/"same_shop", leaving the person with the
        // bot saying "магазин неактивний" over an already-dead code.
        // (A THROW still aborts, so migrateSellerShop failing rolls the consume
        //  back — that is why the consume stays inside the transaction.)
        const shopFull = await Shop.findById(invite.shopId)
          .populate('cityId', 'name')
          .session(session)
          .lean();
        if (!shopFull || !shopFull.isActive) { out = { ok: false, reason: 'shop_inactive' }; return; }

        // Re-read the seller inside the tx/lock so we migrate from fresh state.
        const freshSeller = await User.findOne({ telegramId: tgId, role: 'seller', accountState: { $ne: 'removed' } }).session(session).lean();
        if (!freshSeller) { out = { ok: false, reason: 'not_seller' }; return; }
        if (String(freshSeller.shopId || '') === String(shopFull._id)) {
          out = { ok: false, reason: 'same_shop' }; return;
        }

        // Everything checks out → CONSUME atomically: flips usedAt only if still
        // unused. A concurrent redeem loses this guard (WriteConflict → retry →
        // sees usedAt) and gets `code_consumed`.
        const consumed = await consumeRegistrationToken(token, tgId, session);
        if (!consumed) { out = { ok: false, reason: 'code_consumed' }; return; }

        const migrated = await migrateSellerShop({
          session,
          existingUser: freshSeller,
          newShopFull: shopFull,
          actor: {
            telegramId: tgId,
            firstName: freshSeller.firstName || '',
            lastName: freshSeller.lastName || '',
            role: 'seller',
          },
          reason: 'shop_invite_redeem',
        });

        out = {
          ok: true,
          shop: shopFull,
          fromShopId: freshSeller.shopId ? String(freshSeller.shopId) : null,
          movedOrder: migrated.movedOrder,
          prevGroupId: migrated.prevGroupId,
          newGroupId: migrated.newGroupId,
          _invalidate: migrated.invalidate,
        };
      });
      return out;
    } finally {
      session.endSession();
    }
  });

  // CURRENT assignment publication is shared with admin/self-service paths.
  // This intentionally runs even when no active Order moved.
  if (result?.ok) {
    await publishShopAssignmentTransition({
      ...result,
      invalidate: result._invalidate,
      sellerTelegramId: tgId,
      assignmentChanged: true,
      toShopId: String(result.shop?._id || ''),
    });
    delete result._invalidate;
  }

  return result;
}

module.exports = { redeemShopInvite };

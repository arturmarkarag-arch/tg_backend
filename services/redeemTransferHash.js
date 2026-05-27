// Redeem a one-time shop-transfer hash on behalf of a seller.
//
// Flow (admin → seller → bot):
//   1. Admin generates a hash for a shop (POST /api/shops/:id/transfer-hash).
//   2. Admin sends the code to a seller.
//   3. Seller pastes it into the bot. The bot calls this with the seller's
//      telegramId — NO admin confirmation. We move the seller to the shop the
//      hash belongs to and clear the hash so it can never be reused.
//
// Single-use is enforced atomically: the hash is consumed via a conditional
// update inside the transaction. If two messages race, only the first matches
// the still-present hash; the second sees it gone and gets `hash_consumed`.
//
// Returns one of:
//   { ok: true,  shop, movedOrder, prevGroupId, newGroupId }
//   { ok: false, reason: 'not_found' | 'not_seller' | 'same_shop' | 'hash_consumed' | 'shop_inactive' }

const mongoose = require('mongoose');
const Shop = require('../models/Shop');
const User = require('../models/User');
const { withLock } = require('../utils/lock');
const { invalidateShop } = require('../utils/modelCache');
const { migrateSellerShop } = require('./migrateSellerShop');

// Server-side mirror of the bot's matcher — the canonical shape of a code.
const TRANSFER_HASH_RE = /^ZP-[0-9A-F]{12}$/;

function normalizeHash(raw) {
  return String(raw || '').trim().toUpperCase();
}

function looksLikeTransferHash(raw) {
  return TRANSFER_HASH_RE.test(normalizeHash(raw));
}

/**
 * @param {Object}  params
 * @param {string}  params.hash              The pasted code (raw; normalized here).
 * @param {string}  params.sellerTelegramId  Telegram id of whoever pasted it.
 */
async function redeemTransferHash({ hash, sellerTelegramId }) {
  const transferHash = normalizeHash(hash);
  if (!TRANSFER_HASH_RE.test(transferHash)) return { ok: false, reason: 'not_found' };

  const tgId = String(sellerTelegramId);

  // Find the shop holding this hash up-front (outside the tx, for a fast reject
  // and to scope the lock). The authoritative consume happens inside the tx.
  const shopPreview = await Shop.findOne({ transferHash }).lean();
  if (!shopPreview) return { ok: false, reason: 'not_found' };
  if (!shopPreview.isActive) return { ok: false, reason: 'shop_inactive' };

  // Only registered sellers may redeem. Admin/warehouse/strangers are refused so
  // a leaked code can't silently re-home a non-seller account.
  const seller = await User.findOne({ telegramId: tgId, role: 'seller' }).lean();
  if (!seller) return { ok: false, reason: 'not_seller' };

  if (String(seller.shopId || '') === String(shopPreview._id)) {
    return { ok: false, reason: 'same_shop' };
  }

  // Lock on the seller (matches the admin reassignment path) so a queued admin
  // edit and a hash redeem can't both migrate the same seller on stale state.
  const result = await withLock(`user:${tgId}:shop`, async () => {
    const session = await mongoose.connection.startSession();
    try {
      let out = null;
      await session.withTransaction(async () => {
        // CONSUME the hash atomically: clear it only if still equal to what we
        // matched. A concurrent redeem / regenerate will fail this guard.
        const consumed = await Shop.findOneAndUpdate(
          { _id: shopPreview._id, transferHash },
          { $set: { transferHash: null, transferHashCreatedAt: null } },
          { new: false, session },
        ).populate('cityId', 'name');
        if (!consumed) { out = { ok: false, reason: 'hash_consumed' }; return; }

        // Re-read the seller inside the tx/lock so we migrate from fresh state.
        const freshSeller = await User.findOne({ telegramId: tgId, role: 'seller' }).session(session).lean();
        if (!freshSeller) { out = { ok: false, reason: 'not_seller' }; return; }
        if (String(freshSeller.shopId || '') === String(consumed._id)) {
          out = { ok: false, reason: 'same_shop' }; return;
        }

        const migrated = await migrateSellerShop({
          session,
          existingUser: freshSeller,
          newShopFull: consumed,
          actor: {
            telegramId: tgId,
            firstName: freshSeller.firstName || '',
            lastName: freshSeller.lastName || '',
            role: 'seller',
          },
          reason: 'transfer_hash_redeem',
        });

        out = {
          ok: true,
          shop: consumed,
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

  // Cache invalidation MUST happen AFTER the transaction commits — see the note
  // in migrateSellerShop about the stale-read window.
  if (result?.ok) {
    if (result._invalidate) {
      try { await result._invalidate(); } catch (e) { console.warn('[redeemTransferHash] invalidate failed:', e?.message); }
    }
    try { await invalidateShop(result.shop._id); } catch (_) {}
    if (result.fromShopId) { try { await invalidateShop(result.fromShopId); } catch (_) {} }
    delete result._invalidate;
  }

  return result;
}

module.exports = { redeemTransferHash, looksLikeTransferHash, TRANSFER_HASH_RE };

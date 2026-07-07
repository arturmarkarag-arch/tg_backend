const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const PickingTask = require('../models/PickingTask');
const { getIO } = require('../socket');
const { telegramAuth, requireTelegramRoles } = require('../middleware/telegramAuth');
const { appError, asyncHandler } = require('../utils/errors');

const router = express.Router();

router.use(telegramAuth);
router.use(requireTelegramRoles(['admin', 'warehouse']));

/**
 * GET /api/archive?page=1&pageSize=10
 * Returns archived products grouped by archivedAt date (day),
 * sorted newest-day-first, within each day newest-first.
 * Only includes products archived within the last 30 days.
 */
router.get('/', asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const total = await Product.countDocuments({ status: 'archived', archivedAt: { $gte: cutoff } });

  const products = await Product.find({ status: 'archived', archivedAt: { $gte: cutoff } })
    .sort({ archivedAt: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);

  // Group by calendar day (UTC date string)
  const grouped = [];
  const dayMap = new Map();
  for (const p of products) {
    const day = p.archivedAt
      ? p.archivedAt.toISOString().slice(0, 10)
      : 'невідомо';
    if (!dayMap.has(day)) {
      dayMap.set(day, []);
      grouped.push({ day, items: dayMap.get(day) });
    }
    dayMap.get(day).push(p);
  }

  res.json({
    total,
    page,
    pageSize,
    pageCount: Math.ceil(total / pageSize),
    groups: grouped,
  });
}));

/**
 * POST /api/archive/:id/restore
 *
 * HARD INVARIANT — restore lands the product in "Надходження" (incoming queue
 * на ReceivePage / IncomingProductsPage), NEVER on a shelf (= никогда в Block).
 *
 * Shelf placement in this codebase = Block.productIds membership. orderNumber
 * is the GLOBAL catalog sort sequence, NOT a shelf slot. The user's complaint
 * "не йде на полицю в номер відразу" targets two things:
 *   1. Inserting the product into an existing Block (a real shelf). FORBIDDEN.
 *   2. Restoring the OLD orderNumber via shiftUp (cascading every active item
 *      up by one to make room). FORBIDDEN — it's a silent catalog mutation.
 *
 * What restore DOES do (the minimum to make the item appear in Надходження):
 *   • status='pending' (NOT 'active'), source='receive'. The active⟺in-a-Block
 *     invariant means a restored item — which lands in Надходження, not on a shelf —
 *     must stay 'pending' until the worker places it into a block; block-add
 *     (routes/blocks.js) is what flips it to 'active' AND creates its ShopProduct
 *     mirror. IncomingProductsPage lists pending receive items (qty filter relaxed
 *     for restoredFromArchive). So restore deliberately does NOT touch the mirror.
 *   • orderNumber = max + 1 (append to the catalog tail). No shiftUp, no use
 *     of originalOrderNumber. The worker decides shelving in Надходження.
 *   • restoredFromArchive=true so the "З архіву" badge surfaces in the UI.
 *
 * Do NOT "improve" this by re-shelving in one step (don't push into a Block),
 * and do NOT restore the original orderNumber via shiftUp. The user has
 * explained this rule 5+ times. See [[product-restore-from-archive]].
 */
router.post('/:id/restore', asyncHandler(async (req, res) => {
  const session = await mongoose.startSession();
  let product;
  try {
    await session.withTransaction(async () => {
      product = await Product.findById(req.params.id).session(session);
      if (!product) throw appError('product_not_found');
      if (product.status !== 'archived') throw appError('product_not_archived');
      // Once a stale-archived product has been handed over to the shop catalogue
      // (retention.convertStaleArchivedToShop), it is a shop-OWNED product, not a
      // warehouse one. Restoring it would spawn a duplicate (a fresh mirror alongside
      // the detached shop-owned doc), so the handover is one-way.
      if (product.shopConvertedAt) throw appError('product_converted_to_shop');

      // Append-to-tail orderNumber so it doesn't collide with any active doc.
      // No shiftUp anywhere — that was the "fucked-up numbers logic" the user
      // banned. The worker assigns a real shelf position later via Block.
      const tail = await Product.findOne({ status: { $ne: 'archived' } })
        .sort({ orderNumber: -1 })
        .select('orderNumber')
        .session(session)
        .lean();
      const newOrderNumber = (tail?.orderNumber || 0) + 1;

      // Restore lands the product in Надходження (NOT in a block), so per the
      // active⟺in-block invariant it must be 'pending' until the worker places it
      // into a block (block-add flips it to 'active').
      product.status = 'pending';
      product.source = 'receive';
      product.archivedAt = null;
      product.originalOrderNumber = null; // old position is forgotten on purpose
      product.restoredFromArchive = true;
      product.orderNumber = newOrderNumber;
      // Quantity reset to 0 — restore is the moment the warehouse worker
      // declares "this product is back"; the actual incoming count is unknown
      // until they physically check it. They bump it via ProductRow in the
      // Надходження UI. The incoming-products endpoint relaxes its qty>0 filter
      // for restoredFromArchive=true so the row remains visible at qty=0.
      product.quantity = 0;
      // Intentionally NOT pushing into any Block — placement is decided in
      // Надходження by the warehouse worker, not silently by this endpoint.
      await product.save({ session });

      // Restore deliberately reverses the out-of-stock. Consume this product's
      // completed OOS picking tasks so the orphan-archive sweep
      // (services/pickingService.archiveOrphanedOutOfStockProducts) stops treating
      // them as a standing "(re)archive me" signal. Without this, the next
      // next-task/start-session poll for the group re-archives the just-restored
      // product — a completed task with an unpacked item + a non-archived product is
      // exactly what the sweep matches. Scoped to this product across all groups,
      // and atomic with the restore itself (same transaction).
      await PickingTask.updateMany(
        { productId: product._id, status: 'completed', 'items.packed': false, archiveReconciled: { $ne: true } },
        { $set: { archiveReconciled: true } },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  try { getIO().emit('incoming_updated'); } catch (e) { console.warn('[archive/restore] socket incoming_updated failed:', e.message); }

  res.json(product);
}));

module.exports = { router };

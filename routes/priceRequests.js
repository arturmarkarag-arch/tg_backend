'use strict';

const router   = require('express').Router();
const mongoose = require('mongoose');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler } = require('../utils/errors');
const PriceRequest = require('../models/PriceRequest');
const Product      = require('../models/Product');

const anyRole   = requireTelegramRoles(['admin', 'warehouse', 'seller']);
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

function sellerName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
}

// ─── POST / — seller flags a wrong price ──────────────────────────────────────
router.post('/', anyRole, asyncHandler(async (req, res) => {
  const { productId, suggestedPrice, note } = req.body;
  if (!productId || !mongoose.isValidObjectId(String(productId))) {
    return res.status(400).json({ error: 'product_required', message: 'Не вказано товар' });
  }
  const product = await Product.findById(productId).lean();
  if (!product) return res.status(404).json({ error: 'product_not_found', message: 'Товар не знайдено' });

  // One open request per (product, user) — re-flagging just returns the existing.
  const existing = await PriceRequest.findOne({
    product: productId, createdBy: String(req.telegramId || ''), status: 'open',
  }).lean();
  if (existing) return res.status(200).json(existing);

  const sp = Number(suggestedPrice);
  const pr = await PriceRequest.create({
    product:        productId,
    productName:    product.name || product.brand || product.model || product.category || '',
    currentPrice:   Number(product.price) || 0,
    suggestedPrice: Number.isFinite(sp) && sp > 0 ? sp : null,
    note:           String(note || '').trim(),
    createdBy:      String(req.telegramId || ''),
    createdByName:  sellerName(req.user),
    createdByShop:  req.user?.shopNumber || '',
    status:         'open',
  });
  res.status(201).json(pr);
}));

// ─── GET / — review board (staff) ─────────────────────────────────────────────
router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const status = ['open', 'approved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip   = Math.max(0, parseInt(req.query.skip, 10) || 0);
  const filter = status === 'all' ? {} : { status };

  const [items, total, openCount] = await Promise.all([
    PriceRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    PriceRequest.countDocuments(filter),
    PriceRequest.countDocuments({ status: 'open' }),
  ]);
  res.json({ items, total, openCount });
}));

// ─── POST /:id/approve — set the product price (staff) ────────────────────────
router.post('/:id/approve', staffOnly, asyncHandler(async (req, res) => {
  const pr = await PriceRequest.findById(req.params.id);
  if (!pr) return res.status(404).json({ error: 'not_found' });
  if (pr.status !== 'open') return res.status(409).json({ error: 'already_resolved', message: 'Запит уже опрацьовано' });

  const price = Number(req.body?.price);
  if (!Number.isFinite(price) || price < 0) {
    return res.status(400).json({ error: 'invalid_price', message: 'Невірна ціна' });
  }

  await Product.findByIdAndUpdate(pr.product, { $set: { price } });
  pr.status        = 'approved';
  pr.resolvedPrice = price;
  pr.decidedBy     = String(req.telegramId || '');
  pr.decidedAt     = new Date();
  await pr.save();
  res.json(pr.toObject());
}));

// ─── POST /:id/reject (staff) ─────────────────────────────────────────────────
router.post('/:id/reject', staffOnly, asyncHandler(async (req, res) => {
  const pr = await PriceRequest.findById(req.params.id);
  if (!pr) return res.status(404).json({ error: 'not_found' });
  if (pr.status !== 'open') return res.status(409).json({ error: 'already_resolved', message: 'Запит уже опрацьовано' });

  pr.status    = 'rejected';
  pr.decidedBy = String(req.telegramId || '');
  pr.decidedAt = new Date();
  await pr.save();
  res.json(pr.toObject());
}));

module.exports = router;

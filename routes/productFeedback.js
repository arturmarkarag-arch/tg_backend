'use strict';

const router   = require('express').Router();
const mongoose = require('mongoose');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const { asyncHandler } = require('../utils/errors');
const ProductFeedback = require('../models/ProductFeedback');
const Product         = require('../models/Product');

const anyRole   = requireTelegramRoles(['admin', 'warehouse', 'seller']);
const staffOnly = requireTelegramRoles(['admin', 'warehouse']);

function sellerName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
}

function cleanTopics(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((t) => ProductFeedback.TOPICS.includes(t)))];
}

// ─── POST / — seller reports a problem with a product ─────────────────────────
router.post('/', anyRole, asyncHandler(async (req, res) => {
  const { productId } = req.body;
  if (!productId || !mongoose.isValidObjectId(String(productId))) {
    return res.status(400).json({ error: 'product_required', message: 'Не вказано товар' });
  }
  const topics = cleanTopics(req.body.topics);
  const note   = String(req.body.note || '').trim();
  if (!topics.length && !note) {
    return res.status(400).json({ error: 'empty_feedback', message: 'Оберіть проблему або опишіть її' });
  }

  const product = await Product.findById(productId).lean();
  if (!product) return res.status(404).json({ error: 'product_not_found', message: 'Товар не знайдено' });

  // One open report per (product, user) — re-flagging updates the existing one
  // instead of piling up duplicates.
  const existing = await ProductFeedback.findOne({
    product: productId, createdBy: String(req.telegramId || ''), status: 'open',
  });
  if (existing) {
    existing.topics = topics;
    existing.note   = note;
    await existing.save();
    return res.status(200).json(existing.toObject());
  }

  const fb = await ProductFeedback.create({
    product:       productId,
    productName:   product.name || product.brand || product.model || product.category || '',
    topics,
    note,
    createdBy:     String(req.telegramId || ''),
    createdByName: sellerName(req.user),
    createdByShop: req.user?.shopNumber || '',
    status:        'open',
  });
  res.status(201).json(fb);
}));

// ─── GET / — review board (staff) ─────────────────────────────────────────────
router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const status = ['open', 'resolved', 'rejected', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip   = Math.max(0, parseInt(req.query.skip, 10) || 0);
  const filter = status === 'all' ? {} : { status };

  const [items, total, openCount] = await Promise.all([
    ProductFeedback.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ProductFeedback.countDocuments(filter),
    ProductFeedback.countDocuments({ status: 'open' }),
  ]);
  res.json({ items, total, openCount });
}));

// ─── POST /:id/resolve — staff handled it (edited the product or decided to) ──
router.post('/:id/resolve', staffOnly, asyncHandler(async (req, res) => {
  const fb = await ProductFeedback.findById(req.params.id);
  if (!fb) return res.status(404).json({ error: 'not_found' });
  if (fb.status !== 'open') return res.status(409).json({ error: 'already_decided', message: 'Фідбек уже опрацьовано' });

  fb.status    = 'resolved';
  fb.decidedBy = String(req.telegramId || '');
  fb.decidedAt = new Date();
  await fb.save();
  res.json(fb.toObject());
}));

// ─── POST /:id/reject — staff dismissed it ────────────────────────────────────
router.post('/:id/reject', staffOnly, asyncHandler(async (req, res) => {
  const fb = await ProductFeedback.findById(req.params.id);
  if (!fb) return res.status(404).json({ error: 'not_found' });
  if (fb.status !== 'open') return res.status(409).json({ error: 'already_decided', message: 'Фідбек уже опрацьовано' });

  fb.status    = 'rejected';
  fb.decidedBy = String(req.telegramId || '');
  fb.decidedAt = new Date();
  await fb.save();
  res.json(fb.toObject());
}));

module.exports = router;

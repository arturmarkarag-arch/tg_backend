'use strict';

const mongoose = require('mongoose');
const CommerceCategory = require('../../models/CommerceCategory');
const CommerceProduct = require('../../models/CommerceProduct');
const { appError } = require('../../utils/errors');

function text(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function slugify(value) {
  return text(value, 180)
    .toLocaleLowerCase('pl-PL')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

async function validateParent(parentId, selfId = '') {
  const raw = text(parentId, 80);
  if (!raw) return null;
  if (!mongoose.isValidObjectId(raw) || raw === String(selfId || '')) throw appError('commerce_category_parent_invalid');
  const parent = await CommerceCategory.findById(raw).select('_id parentId status').lean();
  if (!parent || parent.status === 'archived') throw appError('commerce_category_parent_invalid');
  let cursor = parent;
  const seen = new Set([String(selfId || '')].filter(Boolean));
  while (cursor?.parentId) {
    const id = String(cursor.parentId);
    if (seen.has(id)) throw appError('commerce_category_parent_invalid');
    seen.add(id);
    cursor = await CommerceCategory.findById(id).select('_id parentId').lean();
  }
  return raw;
}

function publicCategory(row, productCount = 0) {
  return {
    id: String(row._id),
    name: row.name || '',
    slug: row.slug || '',
    parentId: row.parentId ? String(row.parentId) : '',
    status: row.status || 'active',
    sortOrder: Number(row.sortOrder || 0),
    description: row.description || '',
    productCount: Number(productCount || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

async function listCategories({ includeArchived = false } = {}) {
  const filter = includeArchived ? {} : { status: 'active' };
  const rows = await CommerceCategory.find(filter).sort({ sortOrder: 1, name: 1, _id: 1 }).lean();
  const counts = await CommerceProduct.aggregate([
    { $match: { categoryId: { $in: rows.map((row) => row._id) } } },
    { $group: { _id: '$categoryId', count: { $sum: 1 } } },
  ]);
  const countById = new Map(counts.map((row) => [String(row._id), Number(row.count || 0)]));
  return rows.map((row) => publicCategory(row, countById.get(String(row._id)) || 0));
}

async function createCategory(raw = {}) {
  const name = text(raw.name, 200);
  if (!name) throw appError('commerce_category_name_required');
  const parentId = await validateParent(raw.parentId);
  const slug = slugify(raw.slug || name);
  const doc = new CommerceCategory({
    name,
    slug,
    parentId,
    status: raw.status === 'archived' ? 'archived' : 'active',
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0,
    description: text(raw.description, 2000),
  });
  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.slugKey) throw appError('commerce_category_slug_duplicate');
    throw err;
  }
  return publicCategory(doc.toObject(), 0);
}

async function updateCategory(id, raw = {}) {
  if (!mongoose.isValidObjectId(id)) throw appError('commerce_category_not_found');
  const doc = await CommerceCategory.findById(id);
  if (!doc) throw appError('commerce_category_not_found');
  if (raw.name !== undefined) {
    const name = text(raw.name, 200);
    if (!name) throw appError('commerce_category_name_required');
    doc.name = name;
  }
  if (raw.slug !== undefined || raw.name !== undefined) doc.slug = slugify(raw.slug || doc.name);
  if (raw.parentId !== undefined) doc.parentId = await validateParent(raw.parentId, id);
  if (raw.status !== undefined) doc.status = raw.status === 'archived' ? 'archived' : 'active';
  if (raw.sortOrder !== undefined) doc.sortOrder = Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0;
  if (raw.description !== undefined) doc.description = text(raw.description, 2000);
  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000 && err?.keyPattern?.slugKey) throw appError('commerce_category_slug_duplicate');
    throw err;
  }
  const productCount = await CommerceProduct.countDocuments({ categoryId: doc._id });
  return publicCategory(doc.toObject(), productCount);
}

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
};

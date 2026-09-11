'use strict';

const mongoose = require('mongoose');

const CommerceCategorySchema = new mongoose.Schema({
  name: { type: String, trim: true, required: true },
  slug: { type: String, trim: true, default: '' },
  slugKey: { type: String, select: false, default: '' },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommerceCategory', default: null, index: true },
  status: { type: String, enum: ['active', 'archived'], default: 'active', index: true },
  sortOrder: { type: Number, default: 0 },
  description: { type: String, trim: true, default: '' },
}, { timestamps: true });

CommerceCategorySchema.pre('validate', function normalizeCategory(next) {
  this.name = String(this.name || '').trim();
  this.slug = String(this.slug || '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9ąćęłńóśźż]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
  this.slugKey = this.slug.toLocaleLowerCase('en-US');
  next();
});

CommerceCategorySchema.index(
  { slugKey: 1 },
  { unique: true, partialFilterExpression: { slugKey: { $gt: '' } } },
);
CommerceCategorySchema.index({ parentId: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('CommerceCategory', CommerceCategorySchema);

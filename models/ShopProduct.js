const mongoose = require('mongoose');

const ShopProductSchema = new mongoose.Schema(
  {
    barcode:            { type: String, default: '' },
    name:               { type: String, default: '' },
    price:              { type: Number, default: 0 },
    quantityPerPackage: { type: Number, default: 0 },
    notes:              { type: String, default: '' },
    // Clean base photo — never has labels burned in
    originalImageUrl:   { type: String, default: '' },
    // Annotated photo (labels overlaid) — shown in UI and sent to Telegram
    imageUrl:           { type: String, default: '' },
    labelPositions:     { type: mongoose.Schema.Types.Mixed, default: {} },
    // ── Visual search (vector) ────────────────────────────────────────────────
    // GPT-vision text description of the product photo, used as the embedding
    // source. embedding is its vector; matching is cosine similarity against the
    // query photo's embedding. embeddedAt/embeddingModel let us re-embed on model
    // upgrades or stale photos.
    descriptor:     { type: String, default: '' },
    embedding:      { type: [Number], default: undefined },
    embeddingModel: { type: String, default: '' },
    embeddedAt:     { type: Date, default: null },
    // Where this record came from
    source: {
      type: String,
      enum: ['receive', 'seller', 'manual'],
      default: 'manual',
    },
    // Telegram id of whoever created this record. Drives future edit-permission
    // rules (e.g. a seller may edit only their own entries).
    createdBy: { type: String, default: '' },
    // Optional back-reference to the warehouse Product it originated from
    linkedProductId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
  },
  { timestamps: true }
);

// barcode is unique only among NON-EMPTY values. `sparse` is not enough here:
// barcode defaults to '' (a present value), so sparse would still index every
// empty-barcode doc and collide. A partial index on barcode > '' enforces
// uniqueness for real barcodes while letting unlimited empty-barcode docs coexist.
ShopProductSchema.index(
  { barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $gt: '' } } },
);
ShopProductSchema.index({ linkedProductId: 1 });
ShopProductSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ShopProduct', ShopProductSchema);

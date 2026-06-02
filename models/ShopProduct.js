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
    // The image vector lives in the ProductVector collection, NOT here (2026-06-03).
    // A MIRROR (linkedProductId set) references its warehouse owner's vector at search
    // time; a SHOP-OWNED item gets its own ProductVector row keyed by shopProductId.
    // OpenAI (descriptor/embedding) was retired at the same cutover.
    // Human-friendly Ukrainian product description for the card UI. Generated on demand
    // (staff presses "Згенерувати") from explainProductImage. For a shop-OWNED product
    // (linkedProductId: null) it's editable here; for a warehouse MIRROR it's owned by
    // the warehouse and pushed in via pushSharedFieldsToMirror — same product, same description.
    aiDescription:  { type: String, default: '' },
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
    // Set ONLY for a shop-OWNED product created from a `destination: 'shops'`
    // receipt item. This is the idempotency anchor: re-confirming the same
    // receipt item refreshes THIS doc instead of creating a duplicate (which a
    // barcodeless item would otherwise do on every confirm). `default: undefined`
    // so warehouse mirrors and seller/manual products omit the field entirely
    // and are excluded from the partial unique index below.
    receiptItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReceiptItem',
      default: undefined,
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
// One shop-owned product per receipt item. Partial so only receipt-sourced docs
// (which have the field) are constrained — hard guarantee against double-confirm
// duplicates, including barcodeless items.
ShopProductSchema.index(
  { receiptItemId: 1 },
  { unique: true, partialFilterExpression: { receiptItemId: { $exists: true } } },
);

module.exports = mongoose.model('ShopProduct', ShopProductSchema);

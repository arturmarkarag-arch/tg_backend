const mongoose = require('mongoose');

// structure.type — how the arrived quantity is described:
//   'direct'             → totalQty entered manually
//   'pallets_boxes_items'→ totalQty = pallets * boxesPerPallet * itemsPerBox
//   'pallets_items'      → totalQty = pallets * itemsPerPallet
const ReceiptItemStructureSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['direct', 'pallets_boxes_items', 'pallets_items'],
      default: 'direct',
    },
    pallets: { type: Number, default: null },
    boxesPerPallet: { type: Number, default: null },
    itemsPerBox: { type: Number, default: null },
    itemsPerPallet: { type: Number, default: null },
  },
  { _id: false },
);

const ReceiptItemSchema = new mongoose.Schema(
  {
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },

    // Multi-worker ownership: only this user (or admin) may edit quantity /
    // structure / destination and delete the item. Required for new items;
    // legacy rows created before this field existed simply have it unset.
    createdBy: { type: String, default: '' },

    // Per-item confirmation. A receipt can only be committed once every
    // (non-deleted) item is 'confirmed' by its owner.
    status: { type: String, enum: ['draft', 'confirmed'], default: 'draft' },

    // UI abstraction over the existing shelfQty/transitQty split. Mutually
    // exclusive — the item goes EITHER to the warehouse incoming strip
    // ('shelf') OR straight to shops via transit ('shops'). The route layer
    // derives shelfQty/transitQty from this so commit logic stays unchanged.
    destination: { type: String, enum: ['shelf', 'shops'], default: 'shelf' },

    structure: { type: ReceiptItemStructureSchema, default: () => ({ type: 'direct' }) },

    photoUrl: { type: String, default: '' },
    photoName: { type: String, default: '' },
    // Clean, un-annotated capture. Kept so that editing price/qty later can
    // re-render the overlay from scratch instead of stacking labels on top of
    // an already-annotated image.
    originalPhotoUrl: { type: String, default: '' },
    // Overlay state needed to faithfully re-draw the annotation on edit
    // (price/qty come from the item fields themselves).
    photoMeta: {
      comment: { type: String, default: '' },
      commentPos: {
        x: { type: Number, default: 0.5 },
        y: { type: Number, default: 0.5 },
      },
    },
    totalQty: { type: Number, required: true, min: 1 },
    // What the worker EXPECTED to arrive (for reconciling shortages/defects).
    expectedQty: { type: Number, default: null },
    // Free-text note about this delivery line: defects count, what didn't
    // arrive, etc. (distinct from photoMeta.comment which is drawn on the photo).
    notes: { type: String, default: '' },
    // Optional defect evidence photos (max 3) — stored in a separate R2
    // "defects/" folder so they don't mix with catalogue product images.
    defectPhotoUrls: [{ type: String }],
    transitQty: { type: Number, default: 0 },
    deliveryGroupIds: [{ type: String }],
    qtyPerShop: { type: Number, default: 0 },
    shelfQty: { type: Number, required: true },
    name: { type: String, default: '' },
    price: { type: Number, default: null },
    qtyPerPackage: { type: Number, default: 1 },
    barcode: { type: String, default: '' },
    existingProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    createdProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    warehousePending: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReceiptItem', ReceiptItemSchema);

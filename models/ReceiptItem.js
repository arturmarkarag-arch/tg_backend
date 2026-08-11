const mongoose = require('mongoose');

const ReceiptItemSchema = new mongoose.Schema(
  {
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },

    // Multi-worker ownership: only this user (or admin) may edit owner-only
    // receiving fields and delete the item. Required for new items; legacy rows
    // created before this field existed simply have it unset.
    createdBy: { type: String, default: '' },

    // Per-item confirmation. A receipt can only be committed once every
    // (non-deleted) item is 'confirmed' by its owner.
    status: { type: String, enum: ['draft', 'confirmed'], default: 'draft' },

    // True once this item's warehouse quantity has been applied to Product stock.
    // `destination` + `totalQty` are the source of truth.
    stockApplied: { type: Boolean, default: false },

    // Current routing contract is mutually exclusive: either warehouse or shops.
    // A future split (warehouse + shops at once) is deliberately NOT encoded yet.
    destination: { type: String, enum: ['shelf', 'shops'], default: 'shelf' },

    // ПРИМІТКА: поля `supplementOffer` тут БІЛЬШЕ НЕМАЄ. Дозамовлення тепер —
    // властивість усієї накладної (Receipt.type='supplement'), а не окремої
    // позиції. Позиція в такій накладній завжди має destination='shelf'.

    photoUrl: { type: String, default: '' },
    photoName: { type: String, default: '' },
    // Clean, un-annotated capture. Kept so that editing price/qty later can
    // re-render the overlay from scratch instead of stacking labels.
    originalPhotoUrl: { type: String, default: '' },
    photoMeta: {
      comment: { type: String, default: '' },
      commentPos: {
        x: { type: Number, default: 0.5 },
        y: { type: Number, default: 0.5 },
      },
      pricePos: { type: mongoose.Schema.Types.Mixed, default: null },
      qtyPos:   { type: mongoose.Schema.Types.Mixed, default: null },
    },

    // Physical quantity received. This is intentionally stored directly — no
    // pallet/box structure and no derived shelf/transit quantity copies.
    totalQty: { type: Number, required: true, min: 1 },

    // Routing details kept for the current shops workflow. They are not used to
    // derive a second quantity copy; totalQty remains the only received quantity.
    deliveryGroupIds: [{ type: String }],
    qtyPerShop: { type: Number, default: 0 },

    // Internal/background identity generated from the photo. There is no manual
    // "Назва товару" field in the receipt form; AI may populate this later.
    name: { type: String, default: '' },
    aiDescription: { type: String, default: '' },

    price: { type: Number, default: null },
    qtyPerPackage: { type: Number, default: 1 },

    // Product created by this receipt item.
    createdProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    // For `destination: 'shops'` brand-new items: the shop-OWNED ShopProduct this
    // item created (linkedProductId: null). Tracked for idempotency + unconfirm.
    createdShopProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReceiptItem', ReceiptItemSchema);

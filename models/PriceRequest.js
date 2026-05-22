const mongoose = require('mongoose');

// A seller-raised flag that a warehouse Product's price looks wrong. Warehouse/
// admin review the open ones and either approve (sets Product.price) or reject.
// Snapshots of name/price/seller are kept so the board reads correctly even if
// the underlying product later changes.
const PriceRequestSchema = new mongoose.Schema(
  {
    product:        { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName:    { type: String, default: '' },
    currentPrice:   { type: Number, default: 0 },     // Product.price at flag time
    suggestedPrice: { type: Number, default: null },  // optional seller suggestion
    note:           { type: String, default: '' },

    createdBy:      { type: String, default: '' },     // telegram id
    createdByName:  { type: String, default: '' },
    createdByShop:  { type: String, default: '' },

    status:         { type: String, enum: ['open', 'approved', 'rejected'], default: 'open' },
    decidedBy:      { type: String, default: '' },
    decidedAt:      { type: Date, default: null },
    resolvedPrice:  { type: Number, default: null },   // price set on approve
  },
  { timestamps: true }
);

PriceRequestSchema.index({ status: 1, createdAt: -1 });
PriceRequestSchema.index({ product: 1, createdBy: 1, status: 1 });

module.exports = mongoose.model('PriceRequest', PriceRequestSchema);

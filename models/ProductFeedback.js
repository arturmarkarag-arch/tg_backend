const mongoose = require('mongoose');

// A seller-raised problem report about a warehouse Product. Sellers CANNOT edit
// products — they only flag what looks wrong (опис / назва / ціна / фото / інше)
// with a short note. Staff read the feedback on their board and edit the product
// themselves whenever convenient. productName is snapshotted so the board still
// reads correctly even if the underlying product later changes or is removed.
const FEEDBACK_TOPICS = ['description', 'name', 'price', 'photo', 'other'];

const ProductFeedbackSchema = new mongoose.Schema(
  {
    product:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, default: '' },
    topics:      { type: [{ type: String, enum: FEEDBACK_TOPICS }], default: [] },
    note:        { type: String, default: '' },

    createdBy:     { type: String, default: '' },     // telegram id
    createdByName: { type: String, default: '' },
    createdByShop: { type: String, default: '' },

    // Feedback is informational — staff just mark it опрацьовано/відхилено after
    // editing (or deciding not to edit) the product on their own.
    status:    { type: String, enum: ['open', 'resolved', 'rejected'], default: 'open' },
    decidedBy: { type: String, default: '' },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ProductFeedbackSchema.index({ status: 1, createdAt: -1 });
ProductFeedbackSchema.index({ product: 1, createdBy: 1, status: 1 });

const ProductFeedback = mongoose.model('ProductFeedback', ProductFeedbackSchema);
ProductFeedback.TOPICS = FEEDBACK_TOPICS;
module.exports = ProductFeedback;

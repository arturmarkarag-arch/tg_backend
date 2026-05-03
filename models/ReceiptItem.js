const mongoose = require('mongoose');

const ReceiptItemSchema = new mongoose.Schema(
  {
    receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },
    photoUrl: { type: String, required: true },
    photoName: { type: String, required: true },
    totalQty: { type: Number, required: true, min: 1 },
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReceiptItem', ReceiptItemSchema);

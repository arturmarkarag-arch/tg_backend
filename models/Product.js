const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema(
  {
    price: { type: Number, required: true, default: 0 },
    quantity: { type: Number, required: true, default: 0 },
    name: { type: String, default: '' },
    qrCode: { type: String, default: '' },
    warehouse: { type: String, default: '' },
    category: { type: String, default: '' },
    brand: { type: String, default: '' },
    model: { type: String, default: '' },
    barcode: { type: String, default: '' },
    barcodeChecked: { type: Boolean, default: false },
    orderNumber: { type: Number, required: true, default: 1 },
    status: { type: String, enum: ['pending', 'active', 'archived'], default: 'pending' },
    localImageUrl: { type: String, default: '' },
    imageUrls: [{ type: String, default: [] }],
    imageNames: [{ type: String, default: [] }],
    telegramFileId: { type: String, default: '' },
    telegramMessageId: { type: String, default: '' },
    telegramMessageIds: [{ type: String }],
    storeLinks: [{ type: String }],
    quantityPerPackage: { type: Number, default: 0 },
    notes: { type: String, default: '' },
    source: { type: String, default: '' },
    originalImageUrl: { type: String, default: '' },
    labelPositions: { type: mongoose.Schema.Types.Mixed, default: {} },
    archivedAt: { type: Date, default: null },
    originalOrderNumber: { type: Number, default: null },
    restoredFromArchive: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Унікальний частковий індекс: orderNumber унікальний тільки серед не-archived
// Захищає від race condition при одночасному restore двох товарів на одну позицію
ProductSchema.index(
  { orderNumber: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'archived' } } }
);

module.exports = mongoose.model('Product', ProductSchema);

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
    // Timestamp of the first time this product was shelved (status flipped to
    // 'active' during a receipt commit). Drives the "Новий товар" tag and the
    // "Товари" nav badge — a product counts as new for 7 days after shelving.
    // Set once; not reset on re-shelving.
    shelvedAt: { type: Date, default: null },
    originalOrderNumber: { type: Number, default: null },
    restoredFromArchive: { type: Boolean, default: false },
    // Human-friendly Ukrainian description for the card UI. Generated on demand
    // (staff presses "Згенерувати") from the product photo via explainProductImage.
    // The warehouse is the single writer: it's pushed to the linked ShopProduct
    // mirror (same physical product → same description) by pushSharedFieldsToMirror.
    aiDescription: { type: String, default: '' },
    // ── Gemini Embedding 2 (multimodal photo→vector) for warehouse search ──────
    // Lets "Прийомка" locate an arriving item already on the warehouse by photo.
    // Embedded from the CLEAN original; geminiFromLabeled flags fallbacks. Has its
    // own Atlas index (product_gemini_vector, path geminiVector).
    geminiVector:         { type: [Number], default: undefined },
    geminiEmbeddingModel: { type: String, default: '' },
    geminiEmbeddingDim:   { type: Number, default: 0 },
    geminiEmbeddedAt:     { type: Date, default: null },
    geminiFromLabeled:    { type: Boolean, default: false },
    // Non-authoritative "recommended update" coming FROM a ShopProduct edit.
    // Never auto-applied — staff review and decide. Shape:
    // { price, name, quantityPerPackage, notes, imageUrl, by, at }.
    pendingShopUpdate: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Унікальний частковий індекс: orderNumber унікальний ТІЛЬКИ для товарів на
// полиці (status='active'). Pending у Надходженні (source='receive') не має
// позиції — два таких документи з однаковим (застарілим) orderNumber дозволені.
// Pending у блоці (block_photo flow) також не блокується тут, бо нормальний
// потік присвоює послідовні номери транзакційно; справжня позиційна
// унікальність enforcиться в момент переходу 'pending' → 'active'.
ProductSchema.index(
  { orderNumber: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

// Унікальний частковий індекс: barcode унікальний тільки серед не-порожніх значень.
// Дозволяє необмежену кількість документів без штрих-коду, але забороняє два
// активних/архівованих товари з однаковим штрих-кодом.
ProductSchema.index(
  { barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $gt: '' } } }
);

module.exports = mongoose.model('Product', ProductSchema);

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
    // Set once when a product that stayed archived for 30+ days is "handed over" to
    // the shop catalogue: its ShopProduct mirror is detached into a standalone
    // shop-OWNED product (or one is created) so the item remains findable in "Товари
    // Магазинів" even though the warehouse no longer needs it. The retention sweep
    // (services/retention.js) filters on this so each product converts exactly once.
    // We never delete data — the archived Product and its vector are kept forever.
    shopConvertedAt: { type: Date, default: null },
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
    // ── Visual search (vector) ────────────────────────────────────────────────
    // The Gemini image vector for "Прийомка" lives in the ProductVector collection
    // (keyed by productId), NOT here (2026-06-03). It is write-once / read-by-Atlas-
    // index-only, so co-locating it with hot read data only bloated every payload.
    // See models/ProductVector.js + utils/productEmbedding.js.
    // Non-authoritative "recommended update" coming FROM a ShopProduct edit.
    // Never auto-applied — staff review and decide. Shape:
    // { price, name, quantityPerPackage, notes, imageUrl, by, at }.
    pendingShopUpdate: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Унікальний частковий індекс: orderNumber унікальний серед не-archived товарів
// (pending + active). Archived виключені, бо їхній orderNumber заморожений як
// історичне значення і може колізіювати з активними. Restore (див. archive.js)
// присвоює свіжий max+1, тому конфлікту по orderNumber з активними блоками
// бути не може.
ProductSchema.index(
  { orderNumber: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'archived' } } }
);

// Унікальний частковий індекс: barcode унікальний тільки серед не-порожніх значень.
// Дозволяє необмежену кількість документів без штрих-коду, але забороняє два
// активних/архівованих товари з однаковим штрих-кодом.
ProductSchema.index(
  { barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $gt: '' } } }
);

module.exports = mongoose.model('Product', ProductSchema);

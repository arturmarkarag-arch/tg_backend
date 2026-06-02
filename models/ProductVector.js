const mongoose = require('mongoose');

// Single source of truth for product image vectors, split OUT of the hot Product /
// ShopProduct documents (2026-06-03). The vector is write-once / read-by-Atlas-index-
// only — it is never shown in the UI, so keeping it on the product doc only bloated
// every list/catalogue/order read (aggregate ignores select:false → it leaked into
// blocking sorts, $project crutches, etc.). Storing it in its own collection removes
// that whole bug class by construction.
//
// Exactly ONE of productId / shopProductId is set per row:
//   - productId      → a warehouse Product owns the vector (the common case, ~1294).
//                      Its linked ShopProduct mirrors reference it at QUERY time via
//                      ShopProduct.linkedProductId — they hold NO copy of their own.
//   - shopProductId  → a shop-OWNED ShopProduct (no warehouse counterpart, ~5).
//
// The Atlas Vector Search index `gemini_vector` is built on the geminiVector path of
// THIS collection. Both searches ($vectorSearch over warehouse / catalogue) run here
// and then $lookup the display doc back.
const ProductVectorSchema = new mongoose.Schema(
  {
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product',     default: undefined },
    shopProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShopProduct', default: undefined },

    // Gemini Embedding 2 image vector (3072 dims, cosine). Indexed by Atlas.
    geminiVector:         { type: [Number], default: undefined },
    geminiEmbeddingModel: { type: String,  default: '' },
    geminiEmbeddingDim:   { type: Number,  default: 0 },
    geminiEmbeddedAt:     { type: Date,    default: null },
    geminiFromLabeled:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One vector row per owner. Partial-unique so the many shopProductId-keyed rows
// (productId absent) don't collide on productId:null, and vice-versa.
ProductVectorSchema.index(
  { productId: 1 },
  { unique: true, partialFilterExpression: { productId: { $exists: true } } }
);
ProductVectorSchema.index(
  { shopProductId: 1 },
  { unique: true, partialFilterExpression: { shopProductId: { $exists: true } } }
);

module.exports = mongoose.model('ProductVector', ProductVectorSchema);

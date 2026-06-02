'use strict';

// Gemini photo→vector embedding for WAREHOUSE products (Товари Складу). Powers the
// "Прийомка" lookup: a photo of an arriving item is matched against the index to see
// if the warehouse already has it (and where it's shelved). Gemini-only.
//
// The vector lives in its OWN collection (ProductVector), NOT on the Product doc —
// see models/ProductVector.js. A warehouse product owns exactly one ProductVector row
// (keyed by productId); its ShopProduct mirrors reference that row at query time and
// hold no copy of their own (so there's nothing to "propagate" anymore).

const { embedImageUrl: geminiEmbedImageUrl, getGeminiStatus } = require('../geminiClient');
const ProductVector = require('../models/ProductVector');

const GEMINI_EMBED_ENABLED = String(process.env.GEMINI_EMBED_ENABLED ?? 'true') !== 'false';

// Clean original = originalImageUrl when it differs from the annotated photo
// (imageUrls[0]); otherwise fall back to whatever photo exists and flag it.
function pickSource(doc) {
  const labeled = (Array.isArray(doc.imageUrls) && doc.imageUrls[0]) || doc.localImageUrl || '';
  const clean = doc.originalImageUrl && doc.originalImageUrl !== labeled ? doc.originalImageUrl : '';
  const url = clean || doc.originalImageUrl || labeled || '';
  return { url, fromLabeled: !clean };
}

// Embed a warehouse product's photo and upsert its ProductVector row. Idempotent:
// skips the Gemini call when a row already exists, UNLESS `force` (a photo edit, where
// the existing vector is stale). Returns true when a vector was (re)written.
async function embedProduct(product, { force = false } = {}) {
  if (!product?._id) return false;
  if (!GEMINI_EMBED_ENABLED || !getGeminiStatus().connected) return false;
  if (!force && (await ProductVector.exists({ productId: product._id }))) return false;
  const { url, fromLabeled } = pickSource(product);
  if (!url) return false;
  const { embedding, model, dimensions } = await geminiEmbedImageUrl(url);
  if (!embedding) return false;
  await ProductVector.updateOne(
    { productId: product._id },
    { $set: {
      productId:            product._id,
      geminiVector:         embedding,
      geminiEmbeddingModel: model,
      geminiEmbeddingDim:   dimensions,
      geminiEmbeddedAt:     new Date(),
      geminiFromLabeled:    fromLabeled,
    } },
    { upsert: true },
  );
  return true;
}

// Fire-and-forget for request handlers: never throws, never blocks the response.
function embedProductAsync(product, ctx = '', opts = undefined) {
  Promise.resolve()
    .then(() => embedProduct(product, opts))
    .catch((err) => console.error(`[embed:product] ${ctx} ${product?._id}:`, err.message));
}

module.exports = { embedProduct, embedProductAsync };

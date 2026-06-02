'use strict';

// Gemini photo→vector embedding for SHOP-OWNED catalogue items (ShopProducts with
// linkedProductId: null — goods that go straight to shops and never touch the
// warehouse). MIRROR ShopProducts (linkedProductId set) are NEVER embedded here:
// they show the same photo as their warehouse owner, so the seller search resolves
// them to the owner's ProductVector row at query time (zero duplicate vectors).
//
// The vector lives in the ProductVector collection (keyed by shopProductId for these
// shop-owned items), not on the ShopProduct doc. OpenAI was retired at the Gemini
// cutover (2026-06-03) — there is no descriptor/embedding path anymore.

const { embedImageUrl: geminiEmbedImageUrl, getGeminiStatus } = require('../geminiClient');
const ProductVector = require('../models/ProductVector');

const GEMINI_EMBED_ENABLED = String(process.env.GEMINI_EMBED_ENABLED ?? 'true') !== 'false';

// Clean original when it differs from the annotated photo, else fall back + flag.
function pickSource(doc) {
  const clean = doc.originalImageUrl && doc.originalImageUrl !== doc.imageUrl ? doc.originalImageUrl : '';
  const url = clean || doc.originalImageUrl || doc.imageUrl || '';
  return { url, fromLabeled: !clean };
}

// Embed a shop-OWNED ShopProduct and upsert its ProductVector row (keyed by
// shopProductId). No-op for mirrors (they reference the warehouse vector) and
// idempotent for shop-owned (skips unless `force`, e.g. a photo edit).
async function embedShopProduct(doc, { force = false } = {}) {
  if (!doc?._id) return false;
  if (doc.linkedProductId) return false; // mirror → references the warehouse vector
  if (!GEMINI_EMBED_ENABLED || !getGeminiStatus().connected) return false;
  if (!force && (await ProductVector.exists({ shopProductId: doc._id }))) return false;
  const { url, fromLabeled } = pickSource(doc);
  if (!url) return false;
  const { embedding, model, dimensions } = await geminiEmbedImageUrl(url);
  if (!embedding) return false;
  await ProductVector.updateOne(
    { shopProductId: doc._id },
    { $set: {
      shopProductId:        doc._id,
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
function embedShopProductAsync(doc, ctx = '', opts = undefined) {
  Promise.resolve()
    .then(() => embedShopProduct(doc, opts))
    .catch((err) => console.error(`[embed:shop-owned] ${ctx} ${doc?._id}:`, err.message));
}

module.exports = { embedShopProduct, embedShopProductAsync };

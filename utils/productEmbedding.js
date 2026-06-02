'use strict';

// Gemini photo→vector embedding for WAREHOUSE products (Товари Складу). Powers the
// "Прийомка" lookup: a photo of an arriving item is matched against this index to
// see if the warehouse already has it (and where it's shelved). Gemini-only — the
// warehouse search never needed the OpenAI descriptor path.

const { embedImageUrl: geminiEmbedImageUrl, getGeminiStatus } = require('../geminiClient');
const ShopProduct = require('../models/ShopProduct');

const GEMINI_EMBED_ENABLED = String(process.env.GEMINI_EMBED_ENABLED ?? 'true') !== 'false';

// Clean original = originalImageUrl when it differs from the annotated photo
// (imageUrls[0]); otherwise we fall back to whatever photo exists and flag it.
function pickSource(doc) {
  const labeled = (Array.isArray(doc.imageUrls) && doc.imageUrls[0]) || doc.localImageUrl || '';
  const clean = doc.originalImageUrl && doc.originalImageUrl !== labeled ? doc.originalImageUrl : '';
  const url = clean || doc.originalImageUrl || labeled || '';
  return { url, fromLabeled: !clean };
}

// Mutates doc in place (caller saves). Returns true when a vector was produced.
async function embedProductGemini(doc) {
  if (!doc) return false;
  if (!GEMINI_EMBED_ENABLED || !getGeminiStatus().connected) return false;
  const { url, fromLabeled } = pickSource(doc);
  if (!url) return false;
  const { embedding, model, dimensions } = await geminiEmbedImageUrl(url);
  if (!embedding) return false;
  doc.geminiVector         = embedding;
  doc.geminiEmbeddingModel = model;
  doc.geminiEmbeddingDim   = dimensions;
  doc.geminiEmbeddedAt     = new Date();
  doc.geminiFromLabeled    = fromLabeled;
  return true;
}

// The warehouse Product OWNS the Gemini vector. Its linked ShopProduct mirrors show
// the SAME photo (copied across by upsertShopProduct), so their vector is byte-identical
// — re-embedding each mirror would burn a second Gemini call for an identical result.
// Instead we COPY the owner's freshly-computed vector onto every linked mirror. The shop
// Gemini search then reads it from `shopproduct_gemini_vector` with zero extra API calls.
// Idempotent; safe to re-run. Returns how many mirrors were updated.
async function propagateGeminiVectorToMirrors(product) {
  if (!product?._id || !Array.isArray(product.geminiVector) || product.geminiVector.length === 0) return 0;
  const res = await ShopProduct.updateMany(
    { linkedProductId: product._id },
    {
      $set: {
        geminiVector:         product.geminiVector,
        geminiEmbeddingModel: product.geminiEmbeddingModel || '',
        geminiEmbeddingDim:   product.geminiEmbeddingDim || product.geminiVector.length,
        geminiEmbeddedAt:     product.geminiEmbeddedAt || new Date(),
        geminiFromLabeled:    product.geminiFromLabeled || false,
      },
    },
  );
  return res.modifiedCount || 0;
}

async function embedProduct(doc) {
  if (!doc) return false;
  let ok = false;
  try { ok = await embedProductGemini(doc); }
  catch (err) { console.error('[embed:product]', String(doc?._id), err.message); }
  if (ok) {
    await doc.save();
    // Fan the just-computed vector out to every linked mirror so they never spend a
    // second (identical) Gemini call. Non-fatal: a failed propagation leaves mirrors
    // stale until the next owner edit / backfill, but never blocks the warehouse embed.
    try {
      const n = await propagateGeminiVectorToMirrors(doc);
      if (n) console.log(`[embed:product] propagated vector to ${n} mirror(s) of ${doc._id}`);
    } catch (err) {
      console.error('[embed:product] mirror propagation failed', String(doc?._id), err.message);
    }
  }
  return ok;
}

// Fire-and-forget for request handlers: never throws, never blocks the response.
function embedProductAsync(doc, ctx = '') {
  Promise.resolve()
    .then(() => embedProduct(doc))
    .catch((err) => console.error(`[embed:product] ${ctx} ${doc?._id}:`, err.message));
}

module.exports = { embedProduct, embedProductGemini, embedProductAsync, propagateGeminiVectorToMirrors };

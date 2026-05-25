'use strict';

// Gemini photo→vector embedding for WAREHOUSE products (Товари Складу). Powers the
// "Прийомка" lookup: a photo of an arriving item is matched against this index to
// see if the warehouse already has it (and where it's shelved). Gemini-only — the
// warehouse search never needed the OpenAI descriptor path.

const { embedImageUrl: geminiEmbedImageUrl, getGeminiStatus } = require('../geminiClient');

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

async function embedProduct(doc) {
  if (!doc) return false;
  let ok = false;
  try { ok = await embedProductGemini(doc); }
  catch (err) { console.error('[embed:product]', String(doc?._id), err.message); }
  if (ok) await doc.save();
  return ok;
}

// Fire-and-forget for request handlers: never throws, never blocks the response.
function embedProductAsync(doc, ctx = '') {
  Promise.resolve()
    .then(() => embedProduct(doc))
    .catch((err) => console.error(`[embed:product] ${ctx} ${doc?._id}:`, err.message));
}

module.exports = { embedProduct, embedProductGemini, embedProductAsync };

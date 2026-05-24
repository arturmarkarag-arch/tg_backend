'use strict';

const { describeProductImageUrl, embedText: openaiEmbedText, getOpenAIStatus } = require('../openaiClient');
const { embedImageUrl: geminiEmbedImageUrl, getGeminiStatus } = require('../geminiClient');

// Provider toggles. During the parallel/transition phase both run so the live
// OpenAI search and the new Gemini search stay in sync. At cutover, set
// OPENAI_EMBED_ENABLED=false to stop paying for gpt-4o-mini + text-embedding.
const OPENAI_EMBED_ENABLED = String(process.env.OPENAI_EMBED_ENABLED ?? 'true') !== 'false';
const GEMINI_EMBED_ENABLED = String(process.env.GEMINI_EMBED_ENABLED ?? 'true') !== 'false';

// Catalog embedding text (OpenAI path only) = photo descriptor + curated product
// name (the name reinforces the brand/variant, the strongest match signal).
function buildEmbedText(doc, descriptor) {
  const parts = [descriptor];
  const name = String(doc?.name || '').trim();
  if (name) parts.push(`Назва товару: ${name}`);
  return parts.join('. ');
}

// Picks the photo to embed and reports whether it's a clean original.
// A clean original exists iff originalImageUrl is present AND differs from the
// annotated imageUrl. When it doesn't, we fall back to whatever photo exists
// (per product decision: index everything now, re-photograph later) and flag it.
function pickEmbedSource(doc) {
  const clean = doc.originalImageUrl && doc.originalImageUrl !== doc.imageUrl ? doc.originalImageUrl : '';
  const url = clean || doc.originalImageUrl || doc.imageUrl || '';
  return { url, fromLabeled: !clean };
}

// ── OpenAI path (legacy, parallel) ──────────────────────────────────────────
// Photo → gpt-4o-mini descriptor → text-embedding-3-small. Mutates doc in place;
// the caller saves. Returns true when it produced a vector.
async function embedOpenAI(doc) {
  if (!OPENAI_EMBED_ENABLED || !getOpenAIStatus().connected) return false;
  const url = doc.originalImageUrl || doc.imageUrl;
  if (!url) return false;
  const { descriptor } = await describeProductImageUrl(url);
  if (!descriptor) return false;
  const { embedding, model } = await openaiEmbedText(buildEmbedText(doc, descriptor));
  if (!embedding) return false;
  doc.descriptor     = descriptor;
  doc.embedding      = embedding;
  doc.embeddingModel = model;
  doc.embeddedAt     = new Date();
  return true;
}

// ── Gemini path (new primary) ───────────────────────────────────────────────
// Clean original photo → gemini-embedding-2 → vector, directly from pixels (no
// intermediate text). Image-only for clean photo↔photo symmetry with the query.
async function embedGemini(doc) {
  if (!GEMINI_EMBED_ENABLED || !getGeminiStatus().connected) return false;
  const { url, fromLabeled } = pickEmbedSource(doc);
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

// Generates embeddings for one ShopProduct and saves it. By default runs BOTH
// providers (whichever are enabled + connected); pass { providers: ['gemini'] }
// to embed only one (used by the Gemini-only migration script / backfill).
// Each provider is independent: one failing never blocks the other.
async function embedShopProduct(doc, { providers = ['gemini', 'openai'] } = {}) {
  if (!doc) return false;
  let any = false;
  if (providers.includes('gemini')) {
    try { if (await embedGemini(doc)) any = true; }
    catch (err) { console.error('[embed:gemini]', String(doc?._id), err.message); }
  }
  if (providers.includes('openai')) {
    try { if (await embedOpenAI(doc)) any = true; }
    catch (err) { console.error('[embed:openai]', String(doc?._id), err.message); }
  }
  if (any) await doc.save();
  return any;
}

// Fire-and-forget for request handlers: never throws, never blocks the response.
function embedShopProductAsync(doc, ctx = '', opts = undefined) {
  Promise.resolve()
    .then(() => embedShopProduct(doc, opts))
    .catch((err) => console.error(`[embed] ${ctx} ${doc?._id}:`, err.message));
}

module.exports = { embedShopProduct, embedShopProductAsync, embedGemini, embedOpenAI };

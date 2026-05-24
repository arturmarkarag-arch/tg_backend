'use strict';

const { describeProductImageUrl, embedText, getOpenAIStatus } = require('../openaiClient');

// Catalog embedding = photo descriptor + curated product name (the name
// reinforces the brand/variant, the strongest match signal). Barcode is
// intentionally left out: the query side is just a photo with no barcode, so its
// digits would only add noise the query can never match. The `descriptor` field
// itself stays clean — only the embedded text is enriched.
function buildEmbedText(doc, descriptor) {
  const parts = [descriptor];
  const name = String(doc?.name || '').trim();
  if (name) parts.push(`Назва товару: ${name}`);
  return parts.join('. ');
}

// Generates a descriptor + embedding for one ShopProduct doc and saves them.
// Returns true on success, false when skipped (OpenAI off, no photo, empty
// embedding). Prefers the clean original image over the annotated one.
//
// The image URL is handed straight to OpenAI (it fetches the bytes itself), so
// the catalog image never travels through our server — important when indexing
// thousands of products (Render egress stays near zero).
async function embedShopProduct(doc) {
  if (!doc) return false;
  if (!getOpenAIStatus().connected) return false;
  const url = doc.originalImageUrl || doc.imageUrl;
  if (!url) return false;

  const { descriptor } = await describeProductImageUrl(url);
  if (!descriptor) return false;
  const { embedding, model } = await embedText(buildEmbedText(doc, descriptor));
  if (!embedding) return false;

  doc.descriptor     = descriptor;
  doc.embedding      = embedding;
  doc.embeddingModel = model;
  doc.embeddedAt     = new Date();
  await doc.save();
  return true;
}

// Fire-and-forget for request handlers: never throws, never blocks the response.
// The product is created/updated immediately; it becomes vector-searchable a few
// seconds later once the embedding lands.
function embedShopProductAsync(doc, ctx = '') {
  Promise.resolve()
    .then(() => embedShopProduct(doc))
    .catch((err) => console.error(`[embed] ${ctx} ${doc?._id}:`, err.message));
}

module.exports = { embedShopProduct, embedShopProductAsync };

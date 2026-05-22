'use strict';

const { describeProductImageUrl, embedText, getOpenAIStatus } = require('../openaiClient');

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
  const { embedding, model } = await embedText(descriptor);
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

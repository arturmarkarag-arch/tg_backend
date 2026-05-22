'use strict';

const { describeProductImage, embedText, getOpenAIStatus } = require('../openaiClient');

async function fetchImageBuffer(url) {
  // Hard timeout so a slow/dead image URL can't stall the caller.
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`image fetch ${r.status}`);
  return { buffer: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get('content-type') || 'image/jpeg' };
}

// Generates a descriptor + embedding for one ShopProduct doc and saves them.
// Returns true on success, false when skipped (OpenAI off, no photo, empty
// embedding). Prefers the clean original image over the annotated one.
async function embedShopProduct(doc) {
  if (!doc) return false;
  if (!getOpenAIStatus().connected) return false;
  const url = doc.originalImageUrl || doc.imageUrl;
  if (!url) return false;

  const { buffer, mimeType } = await fetchImageBuffer(url);
  const { descriptor } = await describeProductImage(buffer, mimeType);
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

module.exports = { embedShopProduct, embedShopProductAsync, fetchImageBuffer };

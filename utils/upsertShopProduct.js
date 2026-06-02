'use strict';

const ShopProduct = require('../models/ShopProduct');
const { embedShopProductAsync } = require('./shopProductEmbedding');

const MIRROR_MAX_RETRIES = 3;

// Retryable = transient infra hiccup (WriteConflict / transient-tx label /
// network blip). The mirror writes are pure idempotent `$set`s, so re-running is
// always safe. Without this a single blip left the mirror silently stale forever
// (fire-and-forget catch just logged). Logic errors (e.g. conflict code 40) are
// NOT retried — they would fail every time.
function isRetryableErr(err) {
  const labels = Array.isArray(err?.errorLabels) ? err.errorLabels : [];
  const name = String(err?.name || '');
  return (
    err?.code === 112 ||
    err?.codeName === 'WriteConflict' ||
    labels.includes('TransientTransactionError') ||
    err?.hasErrorLabel?.('TransientTransactionError') ||
    name.includes('MongoNetworkError') ||
    name.includes('PoolClearedError')
  );
}

// Only used on the NON-transactional (fire-and-forget) path. Transactional
// callers must let errors propagate so the enclosing commit aborts cleanly.
async function withMirrorRetry(fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableErr(err) || attempt >= MIRROR_MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

// Upsert a ShopProduct ("Товари Магазинів") from a warehouse Product. Used when a
// product goes active (products route) and when a receipt item is confirmed.
// $setOnInsert means manually-edited shop catalog data is never overwritten;
// only the linkedProductId is kept in sync. A freshly-created entry with a photo
// is auto-indexed for vector search in the background.
//
// Pass `{ session }` to run inside a caller's transaction (receipt confirm). In
// that mode errors PROPAGATE (the confirm aborts → a warehouse Product can never
// commit without its mirror) and the embedding is NOT scheduled here — the
// caller schedules it AFTER commit, using the returned doc.
async function upsertShopProductFromProduct(product, { session = null } = {}) {
  if (!product?._id) { console.warn('[shop-upsert] skipped: no product'); return null; }
  const barcode = String(product.barcode || '').trim();
  const filter = barcode ? { barcode } : { linkedProductId: product._id };
  const insertData = {
    name:               product.name || product.brand || product.model || product.category || '',
    price:              product.price || 0,
    quantityPerPackage: product.quantityPerPackage || 0,
    notes:              product.notes || '',
    originalImageUrl:   product.originalImageUrl || product.imageUrls?.[0] || '',
    imageUrl:           product.imageUrls?.[0] || '',
    labelPositions:     product.labelPositions || {},
    aiDescription:      product.aiDescription || '',
    source:             'receive',
    barcode,
    // Mirror shows the SAME photo as its warehouse owner → the Gemini vector is
    // identical. Copy it on insert (no second Gemini call). If the owner isn't
    // embedded yet, propagateGeminiVectorToMirrors fills it in once it is.
    ...(Array.isArray(product.geminiVector) && product.geminiVector.length ? {
      geminiVector:         product.geminiVector,
      geminiEmbeddingModel: product.geminiEmbeddingModel || '',
      geminiEmbeddingDim:   product.geminiEmbeddingDim || product.geminiVector.length,
      geminiEmbeddedAt:     product.geminiEmbeddedAt || new Date(),
      geminiFromLabeled:    product.geminiFromLabeled || false,
    } : {}),
    // NOTE: linkedProductId lives ONLY in $set below. Having it in both $set and
    // $setOnInsert triggers MongoDB conflict code 40 and the whole upsert fails.
  };
  const run = () => {
    const q = ShopProduct.findOneAndUpdate(
      filter,
      { $set: { linkedProductId: product._id }, $setOnInsert: insertData },
      { upsert: true, new: true },
    );
    return session ? q.session(session) : q;
  };
  // Transactional caller: let errors abort the confirm; defer embedding to caller.
  if (session) return run();
  try {
    const doc = await withMirrorRetry(run);
    // The mirror's Gemini vector is copied from the warehouse owner (above / via
    // propagateGeminiVectorToMirrors) — NEVER self-embedded. Only the legacy OpenAI
    // vector is self-embedded here, and only during the transition (the warehouse has
    // no OpenAI vector to copy). Inert once OPENAI_EMBED_ENABLED=false at cutover.
    if (doc && !doc.embedding && (doc.imageUrl || doc.originalImageUrl)) {
      embedShopProductAsync(doc, 'upsert-from-product', { providers: ['openai'] });
    }
    return doc;
  } catch (err) {
    console.error('[shop-upsert] failed after retries:', err.code, err.message);
    return null;
  }
}

// Push the SHARED (owner-authoritative) fields from a warehouse Product onto its
// linked ShopProduct MIRROR. Unlike `upsertShopProductFromProduct` (which only
// $setOnInsert), this OVERWRITES the mirror's shared fields, because the
// warehouse is the single writer for these. It targets ONLY the
// linkedProductId-matched doc — shop-OWNED ShopProducts (linkedProductId: null)
// are never touched. Local fields (embedding/descriptor/createdBy) are left
// alone. Pure DB write — no image processing; the labeled photo URL is just
// copied across.
//
// `name` is only overwritten when non-empty: a blank computed name is almost
// never an intentional clear and would silently wipe a good mirror name. Same
// guard for `aiDescription` — a linked mirror is the SAME physical product, so
// its human description is owned by the warehouse and pushed across here; we
// only overwrite when the warehouse actually has one (never wipe with a blank).
//
// Pass `{ session }` to run inside a caller's transaction (receipt confirm/commit).
// In that mode errors PROPAGATE so the mirror can never desync from a committing
// Product, and the embedding is NOT scheduled here — the caller schedules it
// AFTER commit, using the returned doc.
async function pushSharedFieldsToMirror(product, { photoChanged = false, session = null } = {}) {
  if (!product?._id) return null;
  const imageUrl = product.imageUrls?.[0] || '';
  const computedName = product.name || product.brand || product.model || product.category || '';

  const $set = {
    price:              product.price || 0,
    quantityPerPackage: product.quantityPerPackage || 0,
    notes:              product.notes || '',
    imageUrl,
    originalImageUrl:   product.originalImageUrl || imageUrl || '',
    labelPositions:     product.labelPositions || {},
    barcode:            String(product.barcode || '').trim(),
  };
  if (computedName) $set.name = computedName;
  if (product.aiDescription) $set.aiDescription = product.aiDescription;

  const run = () => {
    const q = ShopProduct.findOneAndUpdate(
      { linkedProductId: product._id },
      { $set },
      { new: true },
    );
    return session ? q.session(session) : q;
  };

  // Transactional caller: let errors abort the receipt; defer embedding to caller.
  if (session) return run();

  try {
    const doc = await withMirrorRetry(run);
    // New photo → the mirror's vectors are stale. The Gemini one is refreshed by the
    // warehouse owner's re-embed, which propagates the new vector here (single writer);
    // we only re-index the mirror's legacy OpenAI vector. Inert after cutover.
    if (doc && photoChanged && (doc.imageUrl || doc.originalImageUrl)) {
      embedShopProductAsync(doc, 'mirror-push', { providers: ['openai'] });
    }
    return doc;
  } catch (err) {
    console.error('[shop-mirror-push] failed after retries:', err.code, err.message);
    return null;
  }
}

// Create/refresh the shop-OWNED ShopProduct for a brand-new `destination: 'shops'`
// receipt item (goods that go straight to shops and never touch the warehouse).
// linkedProductId stays NULL → the record is OWNED by the shop catalog (editable
// there), as opposed to a warehouse mirror. Idempotent — matched in this order:
//   1. by receiptItemId (the durable anchor: the same receipt item ALWAYS refreshes
//      its own doc, even for barcodeless items, so a double-tap confirm can never
//      create a duplicate). Backed by a unique partial index on the model.
//   2. by createdShopProductId (kept for docs created before the field existed).
//   3. by barcode (shop-owned only — never hijacks a warehouse mirror).
//   4. else create.
// Returns the doc; the caller persists item.createdShopProductId.
// `item` is a plain object (e.g. ReceiptItem.toObject()).
//
// Pass `{ session }` to run inside the confirm transaction. In that mode errors
// PROPAGATE (the confirm aborts, so a ShopProduct can never half-commit) and the
// embedding is deferred — the caller schedules it AFTER commit via the returned doc.
async function upsertShopOwnedFromReceiptItem(item, { session = null } = {}) {
  if (!item?._id) { console.warn('[shop-owned] skipped: no item'); return null; }
  const barcode = String(item.barcode || '').trim();
  const pm = item.photoMeta || {};
  const labelPositions = {};
  if (pm.commentPos) { labelPositions.commentX = pm.commentPos.x; labelPositions.commentY = pm.commentPos.y; }
  if (pm.pricePos)   { labelPositions.priceX   = pm.pricePos.x;   labelPositions.priceY   = pm.pricePos.y; }
  if (pm.qtyPos)     { labelPositions.qtyX     = pm.qtyPos.x;     labelPositions.qtyY     = pm.qtyPos.y; }

  const data = {
    name:               item.name || '',
    price:              item.price || 0,
    quantityPerPackage: item.qtyPerPackage || 0,
    notes:              String(pm.comment || ''),
    originalImageUrl:   item.originalPhotoUrl || item.photoUrl || '',
    imageUrl:           item.photoUrl || '',
    labelPositions,
    source:             'receive',
    barcode,
    receiptItemId:      item._id,
    // linkedProductId intentionally NOT set → shop-owned (null).
  };
  // Only propagate a non-empty description: `data` is applied with $set on every
  // re-confirm, so an empty value would wipe a description regenerated on the shop side.
  if (item.aiDescription) data.aiDescription = item.aiDescription;
  const ses = (q) => (session ? q.session(session) : q);

  const exec = async () => {
    // 1. Durable idempotency anchor: the doc already created for THIS receipt item.
    const byItem = await ses(ShopProduct.findOneAndUpdate(
      { receiptItemId: item._id, linkedProductId: null },
      { $set: data },
      { new: true },
    ));
    if (byItem) return byItem;

    // 2. Known doc from a previous confirm (pre-receiptItemId) → refresh in place.
    if (item.createdShopProductId) {
      const byId = await ses(ShopProduct.findOneAndUpdate(
        { _id: item.createdShopProductId, linkedProductId: null },
        { $set: data },
        { new: true },
      ));
      if (byId) return byId;
      // else it was deleted/converted — fall through to (re)create.
    }

    // 3. Match an existing shop-OWNED doc by barcode (never a warehouse mirror).
    if (barcode) {
      const existing = await ses(ShopProduct.findOne({ barcode }));
      if (existing) {
        // A warehouse mirror already represents this barcode — don't duplicate/hijack.
        if (existing.linkedProductId) return existing;
        return ses(ShopProduct.findByIdAndUpdate(existing._id, { $set: data }, { new: true }));
      }
    }

    // 4. Create fresh.
    if (session) {
      const arr = await ShopProduct.create([{ ...data, linkedProductId: null }], { session });
      return arr[0];
    }
    return ShopProduct.create({ ...data, linkedProductId: null });
  };

  // Transactional caller: propagate errors; defer embedding to the caller.
  if (session) return exec();
  try {
    const doc = await exec();
    if (doc && (doc.imageUrl || doc.originalImageUrl)) embedShopProductAsync(doc, 'shop-owned-upsert');
    return doc;
  } catch (err) {
    if (err.code === 11000) {
      console.warn('[shop-owned] duplicate, skipped:', barcode);
      return null;
    }
    console.error('[shop-owned] failed:', err.code, err.message);
    return null;
  }
}

module.exports = {
  upsertShopProductFromProduct,
  pushSharedFieldsToMirror,
  upsertShopOwnedFromReceiptItem,
};

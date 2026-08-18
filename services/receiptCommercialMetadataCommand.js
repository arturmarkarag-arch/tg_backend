'use strict';

const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const { normalizeReceiptPhotoMeta, photoMetaFromProductDisplay } = require('../utils/receiptPhotoMeta');
const { assertItemReadyToConfirm } = require('../utils/receiptPermissions');
const { snapshotItem, propagateItemEdit } = require('./receiptSync');

const RECEIPT_COMMERCIAL_INPUT_FIELDS = new Set([
  'price',
  'quantityPerPackage',
  'filename',
  'filenames',
  'originalFilename',
  'notes',
  'labelPositions',
  'name',
  'aiDescription',
]);

function hasReceiptCommercialMutation(fields = {}) {
  return [...RECEIPT_COMMERCIAL_INPUT_FIELDS].some((field) => fields[field] !== undefined);
}

function actorForLog(actor = {}) {
  return {
    telegramId: String(actor.telegramId || actor.by || ''),
    firstName: String(actor.firstName || ''),
    lastName: String(actor.lastName || ''),
  };
}

function comparable(item) {
  return {
    price: item.price,
    qtyPerPackage: item.qtyPerPackage,
    photoUrl: item.photoUrl || '',
    originalPhotoUrl: item.originalPhotoUrl || '',
    photoMeta: JSON.stringify(normalizeReceiptPhotoMeta(item.photoMeta) || {}),
    name: item.name || '',
    aiDescription: item.aiDescription || '',
  };
}

function receiptChanges(before, after) {
  const labels = {
    price: 'Ціна',
    qtyPerPackage: 'В упаковці',
    photoUrl: 'Фото',
    originalPhotoUrl: 'Оригінальне фото',
    photoMeta: 'Підписи/коментарі фото',
    name: 'Назва',
    aiDescription: 'Опис',
  };
  return Object.keys(before)
    .filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''))
    .map((field) => ({ field, label: labels[field] || field, from: before[field], to: after[field] }));
}

/**
 * V48.S3.1 reverse write-through for receipt-derived catalogue edits.
 *
 * ReceiptItem owns receiving/commercial provenance. Warehouse Product and its
 * ShopProduct mirror are editable views of that same live item, so shared metadata
 * edits from those views are written back to ReceiptItem and then propagated through
 * the existing ReceiptItem -> Product -> ShopProduct -> current SupplementOffer path.
 *
 * IMPORTANT: this command never changes Receipt routing and never cancels requests.
 */
async function syncReceiptItemCommercialMetadataFromProduct(product, fields = {}, {
  session = null,
  actor = {},
  source = 'warehouse_product',
} = {}) {
  if (!product?.receiptItemId || !hasReceiptCommercialMutation(fields)) return null;

  let q = ReceiptItem.findById(product.receiptItemId);
  if (session) q = q.session(session);
  const item = await q;
  if (!item) return null;

  const before = comparable(item);
  const prev = snapshotItem(item);

  if (fields.price !== undefined) item.price = Number(product.price);
  if (fields.quantityPerPackage !== undefined) item.qtyPerPackage = Number(product.quantityPerPackage);
  if (fields.name !== undefined) item.name = String(product.name || '');
  if (fields.aiDescription !== undefined) item.aiDescription = String(product.aiDescription || '');

  const imageChanged = fields.filename !== undefined || fields.filenames !== undefined;
  if (imageChanged) {
    item.photoUrl = product.imageUrls?.[0] || '';
    item.photoName = product.imageNames?.[0] || '';
  }
  if (fields.originalFilename !== undefined) item.originalPhotoUrl = product.originalImageUrl || '';

  if (fields.notes !== undefined || fields.labelPositions !== undefined) {
    item.photoMeta = photoMetaFromProductDisplay({
      notes: product.notes || '',
      labelPositions: product.labelPositions || {},
    }, item.photoMeta);
  }

  if (item.status === 'confirmed') {
    let rq = Receipt.findById(item.receiptId, '_id type');
    if (session) rq = rq.session(session);
    const receipt = await rq.lean();
    assertItemReadyToConfirm(item, receipt);
  }

  await item.save({ session });
  const propagation = await propagateItemEdit(item, prev, { session });
  const after = comparable(item);
  const changes = receiptChanges(before, after);

  if (changes.length) {
    const log = {
      receiptId: item.receiptId,
      itemId: item._id,
      itemName: item.name || '',
      action: 'update',
      actor: actorForLog(actor),
      changes,
      meta: {
        source,
        productId: String(product._id || ''),
        supplementOfferIds: propagation.supplementOfferIds || [],
      },
    };
    if (session) await ReceiptItemLog.create([log], { session });
    else await ReceiptItemLog.create(log);
  }

  return { item, propagation, changes };
}


async function syncReceiptItemCommercialMetadataFromShopProduct(shopProduct, fields = {}, {
  session = null,
  actor = {},
  source = 'shop_product',
} = {}) {
  if (!shopProduct?.receiptItemId || !hasReceiptCommercialMutation(fields)) return null;

  let q = ReceiptItem.findById(shopProduct.receiptItemId);
  if (session) q = q.session(session);
  const item = await q;
  if (!item) return null;

  const before = comparable(item);
  const prev = snapshotItem(item);

  if (fields.price !== undefined) item.price = Number(shopProduct.price);
  if (fields.quantityPerPackage !== undefined) item.qtyPerPackage = Number(shopProduct.quantityPerPackage);
  if (fields.name !== undefined) item.name = String(shopProduct.name || '');
  if (fields.aiDescription !== undefined) item.aiDescription = String(shopProduct.aiDescription || '');
  if (fields.filename !== undefined || fields.filenames !== undefined) {
    item.photoUrl = shopProduct.imageUrl || '';
    item.photoName = String(shopProduct.imageUrl || '').split('/').pop() || item.photoName || '';
  }
  if (fields.originalFilename !== undefined) item.originalPhotoUrl = shopProduct.originalImageUrl || '';
  if (fields.notes !== undefined || fields.labelPositions !== undefined) {
    item.photoMeta = photoMetaFromProductDisplay({
      notes: shopProduct.notes || '',
      labelPositions: shopProduct.labelPositions || {},
    }, item.photoMeta);
  }

  if (item.status === 'confirmed') {
    let rq = Receipt.findById(item.receiptId, '_id type');
    if (session) rq = rq.session(session);
    const receipt = await rq.lean();
    assertItemReadyToConfirm(item, receipt);
  }

  await item.save({ session });
  const propagation = await propagateItemEdit(item, prev, { session });
  const after = comparable(item);
  const changes = receiptChanges(before, after);

  if (changes.length) {
    const log = {
      receiptId: item.receiptId,
      itemId: item._id,
      itemName: item.name || '',
      action: 'update',
      actor: actorForLog(actor),
      changes,
      meta: {
        source,
        shopProductId: String(shopProduct._id || ''),
        supplementOfferIds: propagation.supplementOfferIds || [],
      },
    };
    if (session) await ReceiptItemLog.create([log], { session });
    else await ReceiptItemLog.create(log);
  }

  return { item, propagation, changes };
}

module.exports = {
  RECEIPT_COMMERCIAL_INPUT_FIELDS,
  hasReceiptCommercialMutation,
  syncReceiptItemCommercialMetadataFromProduct,
  syncReceiptItemCommercialMetadataFromShopProduct,
};

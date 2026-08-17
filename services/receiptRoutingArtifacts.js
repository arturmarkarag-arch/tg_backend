'use strict';

/**
 * Canonical artifact projector for ReceiptItem.routing.
 * Routes and correction commands delegate here; no endpoint invents Product /
 * ShopProduct ownership rules on its own.
 */
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const { syncMirror } = require('../utils/upsertShopProduct');
const { photoCommentsText } = require('../utils/receiptPhotoMeta');
const { labelPositionsFromMeta } = require('./receiptSync');
const {
  normalizeReceiptItemRouting,
  needsWarehouseProduct,
  isNormalOrderingEnabled,
} = require('../utils/receiptRouting');
const { appError } = require('../utils/errors');

async function ensureReceiptItemProduct(item, session, receipt = null) {
  const routing = normalizeReceiptItemRouting(item, receipt);
  if (!needsWarehouseProduct(routing)) return null;

  const orderingEnabled = isNormalOrderingEnabled(routing);
  let product = null;
  if (item.createdProductId) {
    product = await Product.findById(item.createdProductId).session(session);
    if (product) {
      if (!item.stockApplied) product.quantity = Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty;
      if (item.price !== null) product.price = item.price;
      if (item.qtyPerPackage) product.quantityPerPackage = item.qtyPerPackage;
      product.notes = photoCommentsText(item.photoMeta);
      product.labelPositions = labelPositionsFromMeta(item.photoMeta);
      if (!product.shelvedAt) product.shelvedAt = new Date();
      product.orderingEnabled = orderingEnabled;
      product.mandatoryDistribution = !!routing.mandatory;
      product.mayNotReachAllShops = !!routing.mayNotReachAllShops;
      product.receiptItemId = item._id;
      await product.save({ session });
      if (!item.stockApplied) {
        item.stockApplied = true;
        await item.save({ session });
      }
      return product;
    }
  }

  const maxProduct = await Product.findOne(
    { status: { $ne: 'archived' } },
    'orderNumber',
  ).sort({ orderNumber: -1 }).session(session).lean();
  const nextOrderNumber = (maxProduct?.orderNumber ?? 0) + 1;

  product = new Product({
    orderNumber: nextOrderNumber,
    price: item.price ?? 0,
    quantity: Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty,
    warehouse: '', category: '', name: item.name || '', brand: item.name || '', model: '',
    status: 'pending', shelvedAt: new Date(), source: 'receipt', orderingEnabled,
    mandatoryDistribution: !!routing.mandatory,
    mayNotReachAllShops: !!routing.mayNotReachAllShops,
    receiptItemId: item._id,
    imageUrls: [item.photoUrl], imageNames: [item.photoName],
    originalImageUrl: item.originalPhotoUrl || '',
    labelPositions: labelPositionsFromMeta(item.photoMeta),
    notes: photoCommentsText(item.photoMeta),
    quantityPerPackage: item.qtyPerPackage || 0,
    aiDescription: item.aiDescription || '',
  });

  try { await product.save({ session }); }
  catch (err) {
    if (err.code === 11000 && err.keyPattern?.orderNumber) throw appError('product_order_number_conflict');
    throw err;
  }

  item.createdProductId = product._id;
  item.stockApplied = true;
  await item.save({ session });
  return product;
}

async function convertReceiptShopOwnedToWarehouseMirror(item, product, session) {
  const oldShopProductId = item.createdShopProductId;
  if (oldShopProductId) {
    const converted = await ShopProduct.findOneAndUpdate(
      { _id: oldShopProductId, linkedProductId: null },
      { $set: { linkedProductId: product._id }, $unset: { receiptItemId: 1 } },
      { new: true, session },
    );
    if (converted) {
      const existingProductVector = await ProductVector.exists({ productId: product._id }).session(session);
      if (existingProductVector) {
        await ProductVector.deleteMany({ shopProductId: oldShopProductId }).session(session);
      } else {
        await ProductVector.updateOne(
          { shopProductId: oldShopProductId },
          { $set: { productId: product._id }, $unset: { shopProductId: 1 } },
          { session },
        );
      }
    }
    item.createdShopProductId = null;
    await item.save({ session });
  }
  return syncMirror(product, { session });
}

module.exports = { ensureReceiptItemProduct, convertReceiptShopOwnedToWarehouseMirror };

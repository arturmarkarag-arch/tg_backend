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
const { allocateProductOrderNumber } = require('./productOrderNumber');

async function ensureReceiptItemProduct(item, session, receipt = null) {
  const routing = normalizeReceiptItemRouting(item, receipt);
  if (!needsWarehouseProduct(routing)) return null;

  const orderingEnabled = isNormalOrderingEnabled(routing);
  let product = null;
  if (item.createdProductId) {
    product = await Product.findById(item.createdProductId).session(session);
    if (product) {
      if (product.status === 'archived') {
        throw appError('receipt_item_in_use', { reasons: 'товар уже в архіві' });
      }
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

  // Repair a lost ReceiptItem -> Product pointer before creating anything new.
  // `receiptItemId` is the durable identity anchor; a missing pointer must never
  // create a second physical Product for the same received item.
  const byReceiptItem = await Product.findOne({ receiptItemId: item._id }).session(session);
  if (byReceiptItem) {
    if (byReceiptItem.status === 'archived') {
      throw appError('receipt_item_in_use', { reasons: 'товар уже в архіві' });
    }
    item.createdProductId = byReceiptItem._id;
    if (!item.stockApplied) item.stockApplied = true;
    await item.save({ session });
    product = byReceiptItem;
    if (item.price !== null) product.price = item.price;
    if (item.qtyPerPackage) product.quantityPerPackage = item.qtyPerPackage;
    product.notes = photoCommentsText(item.photoMeta);
    product.labelPositions = labelPositionsFromMeta(item.photoMeta);
    product.orderingEnabled = orderingEnabled;
    product.mandatoryDistribution = !!routing.mandatory;
    product.mayNotReachAllShops = !!routing.mayNotReachAllShops;
    await product.save({ session });
    return product;
  }

  // Order number allocation is global and serialized outside the transaction.
  // Never derive max+1 from the transaction snapshot: two simultaneous confirms
  // may share that snapshot and would otherwise choose the same number.
  const nextOrderNumber = await allocateProductOrderNumber();

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


async function convertReceiptWarehouseToShopOwned(item, product, session) {
  if (!product?._id) return null;
  const productId = product._id;
  let shopProduct = await ShopProduct.findOne({ linkedProductId: productId }).session(session);

  if (shopProduct) {
    const conflicting = await ShopProduct.findOne({
      receiptItemId: item._id,
      linkedProductId: null,
      _id: { $ne: shopProduct._id },
    }).session(session);
    if (conflicting) {
      // Integrity fail-closed: never silently choose between two receipt-owned
      // catalogue identities.
      throw appError('receipt_item_in_use', { reasons: 'для позиції існує дубль товару в «Товари Магазинів»' });
    }

    shopProduct.linkedProductId = null;
    shopProduct.receiptItemId = item._id;
    await shopProduct.save({ session });

    const productVector = await ProductVector.findOne({ productId }).session(session);
    if (productVector) {
      const existingShopVector = await ProductVector.exists({ shopProductId: shopProduct._id }).session(session);
      if (existingShopVector) {
        await ProductVector.deleteOne({ _id: productVector._id }).session(session);
      } else {
        productVector.shopProductId = shopProduct._id;
        productVector.productId = undefined;
        await productVector.save({ session });
      }
    }
  }

  // No mirror yet: the caller will create the standalone ShopProduct from the
  // ReceiptItem after the Product is removed; the stale warehouse vector cannot
  // survive a hard projection rollback.
  if (!shopProduct) {
    await ProductVector.deleteMany({ productId }).session(session);
  }

  await Product.deleteOne({ _id: productId }).session(session);
  item.createdProductId = null;
  item.stockApplied = false;
  item.createdShopProductId = shopProduct?._id || null;
  await item.save({ session });
  return shopProduct;
}

module.exports = { ensureReceiptItemProduct, convertReceiptShopOwnedToWarehouseMirror, convertReceiptWarehouseToShopOwned };

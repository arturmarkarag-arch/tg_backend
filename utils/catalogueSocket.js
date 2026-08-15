'use strict';

// Socket payloads are intentionally limited to fields already shown in the
// catalogue. Do not broadcast the full Product/ShopProduct document: warehouse
// metadata and internal flags do not belong in a global seller-visible event.
function productCataloguePatch(product) {
  if (!product) return {};
  return {
    name: product.name || '',
    barcode: product.barcode || '',
    price: Number(product.price || 0),
    quantityPerPackage: Number(product.quantityPerPackage || 0),
    notes: product.notes || '',
    aiDescription: product.aiDescription || '',
    imageUrls: Array.isArray(product.imageUrls) ? product.imageUrls : [],
    originalImageUrl: product.originalImageUrl || '',
    orderNumber: Number(product.orderNumber || 0),
  };
}

function shopProductCataloguePatch(item) {
  if (!item) return {};
  return {
    name: item.name || '',
    barcode: item.barcode || '',
    price: Number(item.price || 0),
    quantityPerPackage: Number(item.quantityPerPackage || 0),
    notes: item.notes || '',
    aiDescription: item.aiDescription || '',
    imageUrl: item.imageUrl || '',
    originalImageUrl: item.originalImageUrl || '',
  };
}

module.exports = { productCataloguePatch, shopProductCataloguePatch };

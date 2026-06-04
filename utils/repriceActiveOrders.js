'use strict';

const Order = require('../models/Order');

// Re-price ACTIVE orders (new/in_progress) that contain this product so the whole
// order stays in ONE price epoch. Without this, an existing order keeps the old
// per-item price while a newly merged line gets the new price → the invoice/total
// mixes price epochs and diverges from the catalogue. confirmed/fulfilled orders are
// finalized and intentionally NOT touched. Two atomic pipeline updates → no
// read-modify-write race with set-item-qty.
//
// Shared by the warehouse PATCH (routes/products.js) and the write-through shop edit
// (routes/shopProducts.js) so a price change from EITHER side reprices identically.
async function repriceActiveOrders(productId, newPrice) {
  const price = Number(newPrice);
  if (!Number.isFinite(price)) return;
  const activeFilter = {
    status: { $in: ['new', 'in_progress'] },
    'items.productId': productId,
  };
  await Order.updateMany(
    activeFilter,
    { $set: { 'items.$[elem].price': price } },
    { arrayFilters: [{ 'elem.productId': productId, 'elem.cancelled': { $ne: true } }] },
  );
  await Order.updateMany(activeFilter, [
    {
      $set: {
        totalPrice: {
          $round: [
            {
              $sum: {
                $map: {
                  input: {
                    $filter: {
                      input: '$items',
                      as: 'i',
                      cond: { $ne: ['$$i.cancelled', true] },
                    },
                  },
                  as: 'i',
                  in: {
                    $multiply: [
                      { $ifNull: ['$$i.price', 0] },
                      { $ifNull: ['$$i.quantity', 0] },
                    ],
                  },
                },
              },
            },
            2,
          ],
        },
      },
    },
  ]);
}

module.exports = { repriceActiveOrders };

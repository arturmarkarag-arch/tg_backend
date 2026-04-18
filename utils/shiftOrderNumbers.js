const Product = require('../models/Product');

async function shiftUp(query) {
  await Product.updateMany(query, { $inc: { orderNumber: 1 } });
}

async function shiftDown(query) {
  await Product.updateMany(query, { $inc: { orderNumber: -1 } });
}

module.exports = { shiftUp, shiftDown };


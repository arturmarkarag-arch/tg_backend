const Product = require('../models/Product');

async function shiftUp(query, session) {
  const opts = session ? { session } : {};
  await Product.updateMany(query, { $inc: { orderNumber: 1 } }, opts);
}

async function shiftDown(query, session) {
  const opts = session ? { session } : {};
  await Product.updateMany(query, { $inc: { orderNumber: -1 } }, opts);
}

module.exports = { shiftUp, shiftDown };


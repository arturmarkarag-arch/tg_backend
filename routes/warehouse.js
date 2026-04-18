const express = require('express');
const Product = require('../models/Product');
const WarehouseTask = require('../models/WarehouseTask');

const router = express.Router();

router.post('/assign', async (req, res) => {
  const { productIds, workerId } = req.body;
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return res.status(400).json({ error: 'productIds must be a non-empty array' });
  }

  const products = await Product.find({ _id: { $in: productIds } });
  if (products.length === 0) {
    return res.status(404).json({ error: 'No products found for assignment' });
  }

  // Simple assignment stub: mark products as active and return task summary
  const assigned = await Product.updateMany(
    { _id: { $in: productIds } },
    { $set: { status: 'active' } }
  );

  const task = new WarehouseTask({
    workerId: workerId || 'unknown',
    productItems: products.map((product) => ({ productId: product._id, quantity: 1 })),
  });
  await task.save();

  res.json({
    message: 'Products assigned to warehouse task',
    workerId: workerId || null,
    matched: products.length,
    modifiedCount: assigned.modifiedCount || assigned.nModified || 0,
    taskId: task._id,
  });
});

module.exports = router;

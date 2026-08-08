const mongoose = require('mongoose');

const BlockSchema = new mongoose.Schema(
  {
    blockId: { type: Number, required: true, min: 1 },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    version: { type: Number, default: 0 },
  },
  { timestamps: true }
);

BlockSchema.index({ blockId: 1 }, { unique: true });
// Один товар не може одночасно бути у двох блоках. `sparse:true` тут НЕ
// достатній: після `$pull` останнього товару MongoDB може індексувати порожній
// масив як `undefined`, і другий порожній Block падає з E11000. Partial index
// включає тільки реально непорожні масиви (`productIds.0` існує), але зберігає
// DB-level race protection для кожного Product між різними блоками.
BlockSchema.index(
  { productIds: 1 },
  {
    unique: true,
    name: 'one_product_per_nonempty_block',
    partialFilterExpression: { 'productIds.0': { $exists: true } },
  },
);

module.exports = mongoose.model('Block', BlockSchema);

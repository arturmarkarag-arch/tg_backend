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
// Унікальний multikey-індекс гарантує, що один товар не може бути одночасно
// у двох блоках. Mongo створює окремий запис індексу на кожен елемент масиву;
// порожні масиви не створюють записів, тому декілька блоків з порожнім
// productIds співіснують вільно. Тестова перевірка перед оновленням productIds
// (Block.findOne({ productIds })) залишається — для людських повідомлень про
// конфлікт; цей індекс — захист від race condition між паралельними запитами.
BlockSchema.index({ productIds: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Block', BlockSchema);

const mongoose = require('mongoose');
const DeliveryGroup = require('./DeliveryGroup');

const UserHistoryEntrySchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  by: { type: String, default: 'system' },
  byName: { type: String, default: '' },
  byRole: { type: String, default: 'system' },
  action: { type: String, required: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const UserSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true },
    role: { type: String, enum: ['seller', 'warehouse', 'admin'], default: 'seller' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    shopNumber: { type: String, default: '' },
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', default: null },
    // Legacy fields — kept for backward compatibility during migration, will be removed after
    shopName: { type: String, default: '' },
    shopAddress: { type: String, default: '' },
    shopCity: { type: String, default: '' },
    deliveryGroupId: { type: String, default: '' },
    warehouseZone: { type: String, default: '' },
    isWarehouseManager: { type: Boolean, default: false },
    isOnShift: { type: Boolean, default: false },
    shiftZone: {
      startBlock: { type: Number, default: null },
      endBlock: { type: Number, default: null },
    },
    botBlocked: { type: Boolean, default: false },
    botLastActivityAt: { type: Date, default: null },
    botLastSessionAt: { type: Date, default: null },
    miniAppState: {
      lastViewedProductId: { type: String, default: '' },
      currentIndex: { type: Number, default: 0 },
      currentPage: { type: Number, default: 0 },
      viewMode: { type: String, enum: ['carousel', 'grid'], default: 'carousel' },
      updatedAt: { type: Date, default: null },
    },
    isOnline: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
    history: { type: [UserHistoryEntrySchema], default: [] },
  },
  { timestamps: true }
);

async function removeFromDeliveryGroups(telegramId) {
  if (!telegramId) return;
  await DeliveryGroup.updateMany(
    { members: telegramId },
    { $pull: { members: telegramId } }
  );
}

UserSchema.post('findOneAndDelete', async function (doc) {
  if (doc?.telegramId) {
    await removeFromDeliveryGroups(doc.telegramId);
  }
});

UserSchema.post('deleteOne', { document: true, query: false }, async function () {
  if (this?.telegramId) {
    await removeFromDeliveryGroups(this.telegramId);
  }
});

module.exports = mongoose.model('User', UserSchema);

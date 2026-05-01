const mongoose = require('mongoose');
const DeliveryGroup = require('./DeliveryGroup');

const UserSchema = new mongoose.Schema(
  {
    telegramId: { type: String, required: true, unique: true },
    role: { type: String, enum: ['seller', 'warehouse', 'admin'], default: 'seller' },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phoneNumber: { type: String, default: '' },
    shopNumber: { type: String, default: '' },
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
    lastBotState: {
      type: new mongoose.Schema(
        {
          shop: {
            type: new mongoose.Schema(
              {
                currentIndex: { type: Number, default: 0 },
                messageId: { type: String, default: '' },
                hasPhoto: { type: Boolean, default: false },
              },
              { _id: false }
            ),
            default: {},
          },
          shelf: {
            type: new mongoose.Schema(
              {
                page: { type: Number, default: 0 },
                messageIds: { type: [String], default: [] },
              },
              { _id: false }
            ),
            default: {},
          },
          receive: {
            type: new mongoose.Schema(
              {
                step: { type: String, enum: ['await_photo', 'await_has_barcode', 'await_barcode_photo', 'await_price', 'await_quantity', 'await_qty_per_package', null], default: null },
                photoFileId: { type: String, default: '' },
                barcodePhotoFileId: { type: String, default: '' },
                barcode: { type: String, default: '' },
                qrCode: { type: String, default: '' },
                price: { type: Number, default: null },
                quantity: { type: Number, default: null },
                quantityPerPackage: { type: Number, default: null },
              },
              { _id: false }
            ),
            default: {},
          },
          pick: {
            type: new mongoose.Schema(
              {
                currentTaskId: { type: String, default: '' },
                messageId: { type: String, default: '' },
                hasPhoto: { type: Boolean, default: false },
              },
              { _id: false }
            ),
            default: {},
          },
          ship: {
            type: new mongoose.Schema(
              {
                currentProductId: { type: String, default: '' },
                currentIndex: { type: Number, default: 0 },
              },
              { _id: false }
            ),
            default: {},
          },
        },
        { _id: false }
      ),
      default: {},
    },
    miniAppState: {
      lastViewedProductId: { type: String, default: '' },
      currentIndex: { type: Number, default: 0 },
      currentPage: { type: Number, default: 0 },
      orderItems: {
        type: Map,
        of: Number,
        default: {},
      },
      orderItemIds: {
        type: [String],
        default: [],
      },
      viewMode: { type: String, enum: ['carousel', 'grid'], default: 'carousel' },
      updatedAt: { type: Date, default: null },
    },
    isOnline: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
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

UserSchema.index({ 'lastBotState.receive.step': 1 });

module.exports = mongoose.model('User', UserSchema);

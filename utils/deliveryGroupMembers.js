'use strict';

const Shop = require('../models/Shop');
const User = require('../models/User');

/**
 * «Хто належить до групи доставки» — обчислюється НА ЛЬОТУ з Shop.deliveryGroupId
 * і ніколи не зберігається.
 *
 * Раніше це дублювалося в DeliveryGroup.members — ручному масиві telegramId, який
 * ніхто не оновлював, коли продавця відв'язували від магазину або коли магазин
 * переїжджав в іншу групу. Аудит живої БД (2026-08-05) показав, наскільки далеко
 * той масив розійшовся з реальністю: 25 записів вказували на продавців БЕЗ
 * магазину, 4 — на продавців, чий магазин уже в ІНШІЙ групі, 1 — на telegramId,
 * якого взагалі немає серед користувачів, і при цьому 42 живі продавці в масиві
 * не значилися зовсім.
 *
 * Замовлення весь час гейтилися через Shop.deliveryGroupId (routes/orders.js),
 * тобто масив був другим джерелом правди, яке тихо брехало, і єдиний його
 * споживач (розсилка) був закоментований. Тепер ланцюг один:
 *
 *     DeliveryGroup ← Shop.deliveryGroupId ← User.shopId
 *
 * Зміна магазину або групи магазину автоматично й негайно змінює склад групи —
 * синхронізувати нічого не треба, бо дублікату більше немає.
 */

/** _id усіх магазинів групи. */
async function getGroupShopIds(groupId) {
  const gid = String(groupId || '');
  if (!gid) return [];
  const shops = await Shop.find({ deliveryGroupId: gid }, '_id').lean();
  return shops.map((s) => s._id);
}

/**
 * Продавці групи. `projection` передається у Mongo як є.
 * Роль звужена до 'seller' свідомо: адміни та склад не «належать» до групи
 * доставки — вони працюють поперек усіх груп.
 */
async function getGroupSellers(groupId, projection = 'telegramId firstName lastName shopId') {
  const shopIds = await getGroupShopIds(groupId);
  if (!shopIds.length) return [];
  return User.find({ role: 'seller', shopId: { $in: shopIds }, accountState: { $ne: 'removed' } }, projection).lean();
}

/** Лише telegramId — те, що раніше лежало в DeliveryGroup.members. */
async function getGroupSellerIds(groupId) {
  const sellers = await getGroupSellers(groupId, 'telegramId');
  return sellers.map((u) => String(u.telegramId)).filter(Boolean);
}

/**
 * Кількість продавців по ВСІХ групах одним запитом — для списків, щоб не робити
 * N+1. Повертає Map<groupId, count>.
 */
async function getSellerCountsByGroup() {
  const rows = await User.aggregate([
    { $match: { role: 'seller', shopId: { $ne: null }, accountState: { $ne: 'removed' } } },
    { $lookup: { from: 'shops', localField: 'shopId', foreignField: '_id', as: 'shop' } },
    { $unwind: '$shop' },
    { $group: { _id: '$shop.deliveryGroupId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
}

module.exports = {
  getGroupShopIds,
  getGroupSellers,
  getGroupSellerIds,
  getSellerCountsByGroup,
};

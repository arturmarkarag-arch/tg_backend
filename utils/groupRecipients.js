'use strict';

/**
 * Хто отримує Telegram-розсилку по групі доставки.
 *
 * Ці дві вибірки однакові для будь-якої розсилки (дозамовлення, старт вікна
 * замовлень), тому живуть в одному місці: якщо правило «кому писати» колись
 * зміниться — наприклад, додасться ще одна роль або новий фільтр блокувань —
 * його треба буде поправити рівно один раз.
 */

const User = require('../models/User');
const Shop = require('../models/Shop');

/**
 * Продавці (і адміни, прив'язані до магазину) активних магазинів групи.
 * `botBlocked` відсіюється тут, а не в місці відправки: користувач, який
 * заблокував бота, — це не помилка доставки, його просто немає серед адресатів.
 */
async function sellersOfGroup(deliveryGroupId) {
  const shops = await Shop.find(
    { deliveryGroupId: String(deliveryGroupId), isActive: true },
    '_id',
  ).lean();
  if (!shops.length) return [];
  return User.find(
    {
      role: { $in: ['seller', 'admin'] },
      shopId: { $in: shops.map((shop) => shop._id) },
      botBlocked: { $ne: true },
      accountState: { $ne: 'removed' },
    },
    'telegramId',
  ).lean();
}

/**
 * Робочі Telegram-чати. Це ПЛОСКИЙ спільний список (config `telegram.allowedGroupIds`
 * з фолбеком на env), він НЕ розбитий по групах доставки — тому текст посту
 * зобов'язаний сам називати, про яку групу йдеться.
 *
 * require всередині функції: routes/admin.js тягне пів застосунку, а цей модуль
 * підключають сервіси, які стартують раніше за роутер.
 */
async function serviceGroupChatIds() {
  try {
    const { getAllowedGroupIds } = require('../routes/admin');
    return await getAllowedGroupIds();
  } catch (err) {
    console.warn('[groupRecipients] не вдалося прочитати список робочих чатів:', err.message);
    return [];
  }
}

module.exports = { sellersOfGroup, serviceGroupChatIds };

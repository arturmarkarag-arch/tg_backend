'use strict';
const ShopAuditLog = require('../models/ShopAuditLog');
const Order = require('../models/Order');
const { activeOrderShopFilter } = require('../utils/orderShopFilter');

// Best-effort durable audit of a seller↔shop transition + order outcome.
// Writes within the passed session so the record is consistent with the actual
// committed outcome (a rolled-back transition leaves no misleading log).
// NEVER throws — auditing must not break the business flow.
async function logShopTransition(session, entry) {
  try {
    let conflictDetected = false;
    const shopForConflict = entry.orderShopAfter || entry.toShopId;
    if (shopForConflict) {
      const active = await Order.find(
        activeOrderShopFilter(shopForConflict),
        'buyerTelegramId',
      ).session(session).lean();
      const buyers = new Set(active.map((o) => String(o.buyerTelegramId || '')).filter(Boolean));
      conflictDetected = buyers.size > 1;
    }

    await ShopAuditLog.create([{ ...entry, conflictDetected }], { session });

    // Повний слід (хто, з якого магазину, яке замовлення) живе в ShopAuditLog.
    // У консоль іде лише знеособлений факт — вона не є місцем зберігання аудиту.
    const tag = entry.orderAction === 'left_behind' || conflictDetected ? 'WARN' : 'INFO';
    return conflictDetected;
  } catch (e) {
    return false;
  }
}

module.exports = { logShopTransition };

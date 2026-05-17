'use strict';
const ShopAuditLog = require('../models/ShopAuditLog');
const Order = require('../models/Order');

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
        { shopId: String(shopForConflict), status: { $in: ['new', 'in_progress'] } },
        'buyerTelegramId',
      ).session(session).lean();
      const buyers = new Set(active.map((o) => String(o.buyerTelegramId || '')).filter(Boolean));
      conflictDetected = buyers.size > 1;
    }

    await ShopAuditLog.create([{ ...entry, conflictDetected }], { session });

    const tag = entry.orderAction === 'left_behind' || conflictDetected ? 'WARN' : 'INFO';
    console.log(
      `[SHOP_AUDIT:${tag}] seller=${entry.sellerTelegramId}(${entry.sellerName || ''}) ` +
      `${entry.fromShopName || entry.fromShopId || '∅'} → ${entry.toShopName || entry.toShopId || '∅'} ` +
      `| order=${entry.orderId || '-'} action=${entry.orderAction} ` +
      `${entry.orderShopBefore || '-'}→${entry.orderShopAfter || '-'} ` +
      `| reason=${entry.reason} source=${entry.source} conflict=${conflictDetected}`,
    );
    return conflictDetected;
  } catch (e) {
    console.error('[SHOP_AUDIT] failed to write audit log:', e?.message);
    return false;
  }
}

module.exports = { logShopTransition };

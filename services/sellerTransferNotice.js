'use strict';

const { randomUUID } = require('crypto');

const NOTICE_ACTOR_ROLES = new Set(['admin', 'warehouse']);

/**
 * Compute the CURRENT transfer-banner state for one assignment transition.
 *
 * The assignment command owns lifecycle; history is audit-only. Any real
 * assignment transition invalidates an older notice. Only an actual
 * manager/warehouse move A -> B creates a replacement notice. Initial
 * assignment, unassignment and seller/self movement leave no warning.
 */
function buildShopTransferNoticeForAssignment({ oldShop, newShop, actor }) {
  const fromId = oldShop?._id ? String(oldShop._id) : '';
  const toId = newShop?._id ? String(newShop._id) : '';

  if (fromId === toId) {
    return { assignmentChanged: false, shouldWrite: false, notice: undefined };
  }

  if (!fromId || !toId || !NOTICE_ACTOR_ROLES.has(String(actor?.role || actor?.byRole || ''))) {
    return { assignmentChanged: true, shouldWrite: true, notice: null };
  }

  return {
    assignmentChanged: true,
    shouldWrite: true,
    notice: {
      id: randomUUID(),
      fromShopId: oldShop._id,
      fromShopName: oldShop.name || '',
      toShopId: newShop._id,
      toShopName: newShop.name || '',
      createdAt: new Date(),
    },
  };
}

/**
 * Read-side safety barrier. A pending notice is displayable only while its
 * target still equals CURRENT User.shopId. Direct/manual DB changes can therefore
 * never resurrect a stale transfer banner. This function performs no repair.
 */
function buildShopTransferPayload(user) {
  const notice = user?.shopTransferNotice;
  if (
    !notice?.id
    || !notice?.fromShopId
    || !notice?.toShopId
    || !notice?.fromShopName
    || !notice?.toShopName
    || !user?.shopId
    || String(notice.toShopId) !== String(user.shopId)
  ) {
    return {};
  }

  return {
    note: `Вас переміщено з магазину "${notice.fromShopName}" на магазин "${notice.toShopName}", ви робите замовлення на інший магазин. Якщо ви нічого не знаєте про це, зверніться до вашого менеджера або в групу в телеграмі!`,
    transferNoteId: String(notice.id),
  };
}

module.exports = {
  buildShopTransferNoticeForAssignment,
  buildShopTransferPayload,
};

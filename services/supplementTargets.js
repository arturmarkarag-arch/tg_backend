'use strict';

/**
 * V48.S2 canonical supplement target resolver.
 *
 * No "morning", "closed N minutes ago" or next-window heuristic may decide
 * eligibility. A target is one CURRENT delivery-cycle OrderingSession. A normally
 * completed cycle stays closed, but a completed CURRENT session with a cancelled
 * supplement publication may be explicitly reopened by a new publication.
 * Historical/non-current sessions are never eligible. Staff choose explicitly;
 * publish revalidates the exact session server-side.
 */
const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');
const OrderingSession = require('../models/OrderingSession');
const Shop = require('../models/Shop');
const SupplementOffer = require('../models/SupplementOffer');
const { findCurrentSessionId } = require('../utils/getOrCreateSession');
const { isOrderingOpen, DAY_FULL_UK } = require('../utils/orderingSchedule');
const { appError } = require('../utils/errors');
const {
  ITEM_STATUS,
  blocksGenericRepublish,
} = require('../utils/supplementState');

function str(v) { return v == null ? '' : String(v); }

function stateForSession(session, group, now = new Date(), { reopenableSupplement = false } = {}) {
  if (!session) return 'upcoming_not_started';
  if (session.openAt && new Date(session.openAt).getTime() > now.getTime()) return 'upcoming_not_started';
  if (session.pickingStatus === 'completed') return reopenableSupplement ? 'supplement_reopenable' : 'completed';
  if (session.pickingStatus === 'confirmed' || session.pickingStatus === 'in_progress') return 'picking';
  return isOrderingOpen(group.orderingSchedule, now).isOpen ? 'ordering_open' : 'awaiting_picking';
}

/**
 * A completed CURRENT delivery session may be reopened only when its current
 * supplement state proves that a publication was cancelled. OPEN and FROZEN
 * cancellation both release the item; COMPLETED remains final. This is persisted
 * exact-session state, not a clock heuristic. Once the group rolls to another
 * current session, this old one cannot be targeted because findCurrentSessionId
 * no longer returns it.
 */
async function hasReopenableSupplementCancellation(orderingSessionId, { session = null } = {}) {
  if (!orderingSessionId) return false;
  let q = SupplementOffer.find({
    orderingSessionId: str(orderingSessionId),
    waveId: { $ne: null },
    status: ITEM_STATUS.CANCELLED,
  }, 'receiptItemId status itemStatus frozenAt completedAt revisionHistory');
  if (session) q = q.session(session);
  const cancelled = await q.lean();
  const correctable = cancelled.filter((offer) => !blocksGenericRepublish(offer));
  if (!correctable.length) return false;

  // A cancelled record in this session must not remain a permanent reopen key
  // after its ReceiptItem has already been published elsewhere. Revalidate the
  // item-global lifecycle before using cancellation as session authority.
  const receiptItemIds = [...new Set(correctable.map((offer) => str(offer.receiptItemId)).filter(Boolean))];
  let publicationsQuery = SupplementOffer.find({
    receiptItemId: { $in: receiptItemIds },
    waveId: { $ne: null },
  }, 'receiptItemId status itemStatus frozenAt completedAt revisionHistory');
  if (session) publicationsQuery = publicationsQuery.session(session);
  const publications = await publicationsQuery.lean();
  const blockedItemIds = new Set(
    publications.filter(blocksGenericRepublish).map((offer) => str(offer.receiptItemId)),
  );
  return correctable.some((offer) => !blockedItemIds.has(str(offer.receiptItemId)));
}

function titleForState(state) {
  if (state === 'ordering_open') return 'Поточна доставка · замовлення відкриті';
  if (state === 'awaiting_picking') return 'Поточна доставка · замовлення закриті';
  if (state === 'picking') return 'Поточна доставка · збирання';
  if (state === 'supplement_reopenable') return 'Поточна доставка · дозамовлення можна відкрити знову';
  if (state === 'completed') return 'Доставка завершена';
  return 'Наступна сесія ще не почалася';
}

async function describeGroup(group, now = new Date()) {
  const groupId = str(group?._id);
  let sessionId = null;
  try { sessionId = await findCurrentSessionId(groupId, group.orderingSchedule); } catch (_) {}
  const session = sessionId
    ? await OrderingSession.findById(sessionId, '_id seq openDate openAt closeAt pickingStatus').lean()
    : null;

  const reopenableSupplement = session?.pickingStatus === 'completed'
    ? await hasReopenableSupplementCancellation(session._id)
    : false;
  const state = stateForSession(session, group, now, { reopenableSupplement });
  const shopCount = await Shop.countDocuments({ deliveryGroupId: groupId, isActive: true });
  const selectable = !!session
    && state !== 'completed'
    && state !== 'upcoming_not_started'
    && state !== 'ordering_open'
    && shopCount > 0;

  return {
    deliveryGroupId: groupId,
    name: group.name || '',
    dayOfWeek: group.dayOfWeek,
    dayName: DAY_FULL_UK[group.dayOfWeek] || '',
    selectable,
    state,
    title: titleForState(state),
    orderingSessionId: session ? str(session._id) : null,
    sessionSeq: session?.seq ?? null,
    sessionOpenDate: session?.openDate || null,
    pickingStatus: session?.pickingStatus || null,
    orderingOpen: state === 'ordering_open',
    shopCount,
    details: session
      ? [
        `Сесія${session.seq != null ? ` №${session.seq}` : ''}: ${session.openDate || '—'}`,
        state === 'ordering_open'
          ? 'Звичайне замовлення ще відкрите'
          : state === 'awaiting_picking'
            ? 'Звичайне замовлення закрите, збирання ще не почалось'
            : state === 'picking'
              ? 'Збирання цієї доставки вже триває'
              : state === 'supplement_reopenable'
                ? 'Попереднє дозамовлення скасовано; цю поточну доставку можна відкрити повторно'
                : 'Сесія завершена',
      ]
      : ['Дозамовлення не потрібне: ця група отримає товар у своїй звичайній сесії'],
    note: selectable ? (state === 'supplement_reopenable'
      ? 'Повторний запуск створить нову чисту revision позиції; старі заявки залишаться тільки в історії.'
      : '') : (state === 'ordering_open'
      ? 'Спочатку дочекайтесь закриття звичайного прийому замовлень цієї групи.'
      : state === 'completed'
        ? 'Завершену без скасованого дозамовлення доставку не можна повторно відкривати через дозамовлення.'
        : 'Майбутня сесія не є ціллю дозамовлення.'),
  };
}

async function describeSupplementTargets(now = new Date()) {
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule')
    .sort({ dayOfWeek: 1, name: 1 })
    .lean();
  const described = [];
  for (const group of groups) {
    if (!Number.isInteger(group.dayOfWeek) || !group.orderingSchedule) continue;
    described.push(await describeGroup(group, now));
  }
  return { groups: described, serverTime: now.toISOString() };
}

/**
 * Resolves and pins the CURRENT session. `expectedOrderingSessionId` protects the
 * confirmation screen from a cycle rollover between GET targets and POST publish.
 */
async function resolveSupplementTarget(
  deliveryGroupId,
  { expectedOrderingSessionId = null, now = new Date() } = {},
) {
  const gid = str(deliveryGroupId).trim();
  if (!gid || !mongoose.Types.ObjectId.isValid(gid)) throw appError('supplement_target_required');

  const group = await DeliveryGroup.findById(gid, 'name dayOfWeek orderingSchedule').lean();
  if (!group) throw appError('supplement_target_not_found');

  const sessionId = await findCurrentSessionId(gid, group.orderingSchedule);
  if (!sessionId) {
    throw appError('supplement_target_session_not_started', { group: group.name || '' });
  }
  if (expectedOrderingSessionId && str(expectedOrderingSessionId) !== str(sessionId)) {
    throw appError('supplement_target_session_changed', { group: group.name || '' });
  }

  const session = await OrderingSession.findById(
    sessionId,
    '_id groupId seq openDate openAt closeAt pickingStatus',
  ).lean();
  if (!session || str(session.groupId) !== gid) throw appError('supplement_target_session_not_started', { group: group.name || '' });

  // A future pre-created session is not eligible. Normal current sessions are
  // proactively materialised by orderingOpenScheduler at/after openAt.
  if (session.openAt && new Date(session.openAt).getTime() > now.getTime()) {
    throw appError('supplement_target_session_not_started', { group: group.name || '' });
  }

  const reopenableSupplement = session.pickingStatus === 'completed'
    ? await hasReopenableSupplementCancellation(session._id)
    : false;
  if (session.pickingStatus === 'completed' && !reopenableSupplement) {
    throw appError('supplement_target_session_completed', { group: group.name || '' });
  }

  const state = stateForSession(session, group, now, { reopenableSupplement });
  if (state === 'ordering_open') {
    throw appError('supplement_ordering_still_open', { group: group.name || '' });
  }

  const hasActiveShop = await Shop.exists({ deliveryGroupId: gid, isActive: true });
  if (!hasActiveShop) throw appError('supplement_target_no_shops', { group: group.name || '' });

  return {
    deliveryGroupId: gid,
    orderingSessionId: str(session._id),
    sessionSeq: session.seq ?? null,
    sessionOpenDate: session.openDate || null,
    state,
    orderingOpen: state === 'ordering_open',
    groupName: group.name || '',
    reopenCompleted: Boolean(session.pickingStatus === 'completed' && reopenableSupplement),
  };
}

module.exports = {
  describeSupplementTargets,
  resolveSupplementTarget,
  stateForSession,
  hasReopenableSupplementCancellation,
};

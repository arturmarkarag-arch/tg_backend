'use strict';

/**
 * Seller access projection for the configured Telegram work groups.
 *
 * Design goals:
 * - steady-state auth must NOT call Telegram or add another Mongo read;
 * - confirmed chat_member/audit/registration signals are projected onto User;
 * - uncertainty never overwrites a previously confirmed state unless the group
 *   configuration itself changes;
 * - legacy/manual seller rows start `unverified` and are verified once on first
 *   access (persisted GroupMember evidence first, live Telegram fallback second).
 */

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');
const { getAllowedGroupIds } = require('../utils/telegramGroupSettings');
const { checkMembershipAcrossGroups } = require('./registrationMembershipGate');

const ACCESS_UNVERIFIED = 'unverified';
const ACCESS_ALLOWED = 'allowed';
const ACCESS_DENIED = 'denied';

const PRESENT_STATUSES = new Set(['member', 'administrator', 'creator', 'restricted']);
const ABSENT_STATUSES = new Set(['left', 'kicked', 'not_found']);

function positiveEnvInt(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// A denied seller normally recovers from the realtime chat_member join event.
// If that webhook was missed, one bounded live retry after this cooldown lets a
// legitimate rejoin self-heal without turning every denied request into a
// Telegram API call.
const DENIED_RECHECK_MS = positiveEnvInt('SELLER_GROUP_DENIED_RECHECK_MS', 60_000);

function normalizeGroupIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeState(value) {
  const state = String(value || '');
  return [ACCESS_ALLOWED, ACCESS_DENIED, ACCESS_UNVERIFIED].includes(state)
    ? state
    : ACCESS_UNVERIFIED;
}

function presenceOf(row) {
  if (!row) return null;
  const status = String(row.telegramStatus || '');
  if (PRESENT_STATUSES.has(status)) return true;
  if (ABSENT_STATUSES.has(status)) return false;
  if (status === 'unknown') return null;

  // Backwards compatibility for passive GroupMember rows created before the
  // explicit telegramStatus projection existed.
  if (!status && row.left === false) return true;
  if (!status && row.left === true) return false;
  return null;
}

/**
 * Pure decision from persisted rows only.
 *
 * Any confirmed presence wins. Denial is emitted only when EVERY configured
 * group is deterministically absent. Missing/unknown evidence is unverified,
 * never absence.
 */
function deriveSellerTelegramGroupAccess(rows = [], allowedGroupIds = []) {
  const groupIds = normalizeGroupIds(allowedGroupIds);
  if (!groupIds.length) {
    return {
      state: ACCESS_UNVERIFIED,
      reason: 'group_not_configured',
      groupId: '',
    };
  }

  const byGroup = new Map((rows || []).map((row) => [String(row.groupChatId || ''), row]));
  const states = groupIds.map((groupId) => ({ groupId, present: presenceOf(byGroup.get(groupId)) }));

  const present = states.find((entry) => entry.present === true);
  if (present) {
    return {
      state: ACCESS_ALLOWED,
      reason: 'member',
      groupId: present.groupId,
    };
  }

  if (states.every((entry) => entry.present === false)) {
    return {
      state: ACCESS_DENIED,
      reason: 'not_in_group',
      groupId: '',
    };
  }

  return {
    state: ACCESS_UNVERIFIED,
    reason: 'membership_unknown',
    groupId: '',
  };
}

function projectionFields(decision, source, now = new Date()) {
  return {
    telegramGroupAccessState: normalizeState(decision?.state),
    telegramGroupAccessCheckedAt: now,
    telegramGroupAccessGroupId: decision?.state === ACCESS_ALLOWED
      ? String(decision?.groupId || '')
      : '',
    telegramGroupAccessSource: String(source || '').slice(0, 64),
  };
}

async function persistSellerAccessDecision(telegramId, decision, { source = 'projection' } = {}) {
  const tid = String(telegramId || '').trim();
  if (!tid) return null;

  const fields = projectionFields(decision, source);
  const result = await User.updateOne(
    {
      telegramId: tid,
      role: 'seller',
      accountState: { $ne: 'removed' },
    },
    { $set: fields },
  );

  if (!result?.matchedCount) return null;
  return { ...decision, ...fields };
}

async function projectSellerAccessFromPersisted(telegramId, {
  source = 'group_projection',
  allowedGroupIds = null,
} = {}) {
  const tid = String(telegramId || '').trim();
  if (!tid) return null;

  const groupIds = normalizeGroupIds(allowedGroupIds || await getAllowedGroupIds());
  const rows = groupIds.length
    ? await GroupMember.find(
        { telegramId: tid, groupChatId: { $in: groupIds } },
        'groupChatId telegramStatus left',
      ).lean()
    : [];

  const decision = deriveSellerTelegramGroupAccess(rows, groupIds);
  const persisted = await persistSellerAccessDecision(tid, decision, { source });
  return persisted ? decision : null;
}

/**
 * Bulk re-projection used by admin audits/config changes. No Telegram calls.
 * Returns the final persisted decision per active seller.
 */
async function projectSellerAccessBulkFromPersisted(telegramIds = null, {
  source = 'group_projection_bulk',
  allowedGroupIds = null,
} = {}) {
  const explicitIds = telegramIds == null
    ? null
    : [...new Set((telegramIds || []).map(String).filter(Boolean))];
  if (explicitIds && !explicitIds.length) return new Map();

  const sellerFilter = {
    role: 'seller',
    accountState: { $ne: 'removed' },
    ...(explicitIds ? { telegramId: { $in: explicitIds } } : {}),
  };
  const sellers = await User.find(sellerFilter, 'telegramId').lean();
  if (!sellers.length) return new Map();

  const ids = sellers.map((seller) => String(seller.telegramId));
  const groupIds = normalizeGroupIds(allowedGroupIds || await getAllowedGroupIds());
  const rows = groupIds.length
    ? await GroupMember.find(
        { telegramId: { $in: ids }, groupChatId: { $in: groupIds } },
        'telegramId groupChatId telegramStatus left',
      ).lean()
    : [];

  const rowsByTelegramId = new Map();
  for (const row of rows) {
    const tid = String(row.telegramId || '');
    if (!rowsByTelegramId.has(tid)) rowsByTelegramId.set(tid, []);
    rowsByTelegramId.get(tid).push(row);
  }

  const now = new Date();
  const decisions = new Map();
  const operations = [];
  for (const tid of ids) {
    const decision = deriveSellerTelegramGroupAccess(rowsByTelegramId.get(tid) || [], groupIds);
    decisions.set(tid, decision);
    operations.push({
      updateOne: {
        filter: { telegramId: tid, role: 'seller', accountState: { $ne: 'removed' } },
        update: { $set: projectionFields(decision, source, now) },
      },
    });
  }

  if (operations.length) await User.bulkWrite(operations, { ordered: false });
  return decisions;
}

/**
 * Group configuration is part of the authorization contract. Every change
 * invalidates the previous projection first; stale "allowed" must never survive
 * a changed allow-list. Persisted evidence is then re-applied without hitting
 * Telegram. Remaining unverified sellers will perform one live check on their
 * next auth attempt.
 */
async function reconcileSellerAccessAfterGroupConfigChange(allowedGroupIds = []) {
  const groupIds = normalizeGroupIds(allowedGroupIds);
  const sellers = await User.find(
    { role: 'seller', accountState: { $ne: 'removed' } },
    'telegramId',
  ).lean();
  const ids = sellers.map((seller) => String(seller.telegramId || '')).filter(Boolean);
  if (!ids.length) return new Map();

  const now = new Date();
  await User.updateMany(
    { telegramId: { $in: ids }, role: 'seller', accountState: { $ne: 'removed' } },
    {
      $set: {
        telegramGroupAccessState: ACCESS_UNVERIFIED,
        telegramGroupAccessCheckedAt: now,
        telegramGroupAccessGroupId: '',
        telegramGroupAccessSource: 'group_config_changed',
      },
    },
  );

  let decisions = new Map(ids.map((tid) => [tid, {
    state: ACCESS_UNVERIFIED,
    reason: groupIds.length ? 'membership_unknown' : 'group_not_configured',
    groupId: '',
  }]));

  try {
    decisions = await projectSellerAccessBulkFromPersisted(ids, {
      source: 'group_config_changed',
      allowedGroupIds: groupIds,
    });
  } catch (_) {
    // Safe fallback is already persisted above: nobody keeps stale "allowed"
    // from the previous configuration. First subsequent auth will live-check.
  }

  await disconnectSellerSessions(ids, {
    event: 'telegram_group_access_recheck_required',
    reason: 'group_config_changed',
  });
  return decisions;
}

async function disconnectSellerSessions(telegramIds, {
  event = 'telegram_group_access_revoked',
  reason = 'telegram_group_membership_required',
} = {}) {
  const ids = [...new Set((Array.isArray(telegramIds) ? telegramIds : [telegramIds])
    .map(String)
    .filter(Boolean))];
  if (!ids.length) return;

  try {
    // Lazy import avoids a module cycle during server boot.
    const { getIO } = require('../socket');
    const io = getIO();
    if (!io) return;
    for (const tid of ids) {
      const room = `user_${tid}`;
      io.to(room).emit(event, { reason });
      io.in(room).disconnectSockets(true);
    }
  } catch (_) {
    // HTTP auth remains authoritative even if realtime disconnect is unavailable.
  }
}

async function resolveSellerTelegramGroupAccess(user, {
  source = 'auth',
  allowLiveCheck = true,
} = {}) {
  if (!user || user.role !== 'seller') {
    return { allowed: true, state: 'not_applicable', reason: 'role_not_seller', groupId: '' };
  }

  const telegramId = String(user.telegramId || '').trim();
  const currentState = normalizeState(user.telegramGroupAccessState);
  if (currentState === ACCESS_ALLOWED) {
    return {
      allowed: true,
      state: ACCESS_ALLOWED,
      reason: 'member',
      groupId: String(user.telegramGroupAccessGroupId || ''),
    };
  }
  const deniedCheckedAt = user.telegramGroupAccessCheckedAt
    ? new Date(user.telegramGroupAccessCheckedAt).getTime()
    : 0;
  const deniedStillFresh = currentState === ACCESS_DENIED
    && Number.isFinite(deniedCheckedAt)
    && deniedCheckedAt > 0
    && Date.now() - deniedCheckedAt < DENIED_RECHECK_MS;
  if (deniedStillFresh) {
    return { allowed: false, state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' };
  }

  let groupIds = [];
  try {
    groupIds = normalizeGroupIds(await getAllowedGroupIds());
  } catch (_) {
    return currentState === ACCESS_DENIED
      ? { allowed: false, state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' }
      : { allowed: false, state: ACCESS_UNVERIFIED, reason: 'check_failed', groupId: '' };
  }
  if (!groupIds.length) {
    return { allowed: false, state: ACCESS_UNVERIFIED, reason: 'group_not_configured', groupId: '' };
  }

  let decision = { state: ACCESS_UNVERIFIED, reason: 'membership_unknown', groupId: '' };

  // Legacy/manual seller: first try our local projection. A stale DENIED state
  // skips this step deliberately: its persisted row may be the very signal that
  // missed the later rejoin, so the cooldown path below performs one live check.
  if (currentState !== ACCESS_DENIED) {
    let rows = [];
    try {
      rows = await GroupMember.find(
        { telegramId, groupChatId: { $in: groupIds } },
        'groupChatId telegramStatus left',
      ).lean();
    } catch (_) {
      return { allowed: false, state: ACCESS_UNVERIFIED, reason: 'check_failed', groupId: '' };
    }
    decision = deriveSellerTelegramGroupAccess(rows, groupIds);
    if (decision.state !== ACCESS_UNVERIFIED) {
      await persistSellerAccessDecision(telegramId, decision, { source: `${source}_persisted` });
      return {
        allowed: decision.state === ACCESS_ALLOWED,
        ...decision,
      };
    }
  }

  if (!allowLiveCheck) {
    return currentState === ACCESS_DENIED
      ? { allowed: false, state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' }
      : { allowed: false, ...decision };
  }

  // Only unverified sellers (plus a denied seller after the bounded recovery
  // cooldown) pay for a Telegram call. A previously known `allowed` state is
  // never downgraded merely because Telegram is temporarily unavailable;
  // config changes deliberately reset it to unverified first.
  let bot = null;
  try {
    const telegramBot = require('../telegramBot');
    bot = telegramBot.getBot?.() || null;
  } catch (_) {}
  if (!bot) {
    return currentState === ACCESS_DENIED
      ? { allowed: false, state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' }
      : { allowed: false, state: ACCESS_UNVERIFIED, reason: 'check_failed', groupId: '' };
  }

  const live = await checkMembershipAcrossGroups({ bot, telegramId, groupIds });
  if (live.allowed) {
    decision = { state: ACCESS_ALLOWED, reason: 'member', groupId: String(live.groupId || '') };
    await persistSellerAccessDecision(telegramId, decision, { source: `${source}_live` });
    return { allowed: true, ...decision };
  }

  if (live.reason === 'not_in_group') {
    decision = { state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' };
    await persistSellerAccessDecision(telegramId, decision, { source: `${source}_live` });
    await disconnectSellerSessions(telegramId);
    return { allowed: false, ...decision };
  }

  // A transient live-check failure never upgrades a previously denied seller.
  // For an unverified seller it stays retryable/503 instead of being misread as
  // confirmed absence.
  if (currentState === ACCESS_DENIED) {
    return { allowed: false, state: ACCESS_DENIED, reason: 'not_in_group', groupId: '' };
  }
  return {
    allowed: false,
    state: ACCESS_UNVERIFIED,
    reason: live.reason === 'group_not_configured' ? 'group_not_configured' : 'check_failed',
    groupId: '',
  };
}

module.exports = {
  ACCESS_UNVERIFIED,
  ACCESS_ALLOWED,
  ACCESS_DENIED,
  DENIED_RECHECK_MS,
  PRESENT_STATUSES,
  ABSENT_STATUSES,
  presenceOf,
  deriveSellerTelegramGroupAccess,
  persistSellerAccessDecision,
  projectSellerAccessFromPersisted,
  projectSellerAccessBulkFromPersisted,
  reconcileSellerAccessAfterGroupConfigChange,
  disconnectSellerSessions,
  resolveSellerTelegramGroupAccess,
};

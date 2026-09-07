'use strict';
// Passive group-member tracking + admin list enrichment.
//
// Telegram has no "list all members" endpoint, so GroupMember is filled from
// messages / chat_member events. The admin audit additionally synthesizes every
// registered seller into the selected group view and can verify them one-by-one.

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');
const Shop = require('../models/Shop');
const RegistrationRequest = require('../models/RegistrationRequest');

const PRESENT_STATUSES = ['member', 'administrator', 'creator', 'restricted'];

function maxDate(...values) {
  let best = null;
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) continue;
    if (!best || date > best) best = date;
  }
  return best;
}

/** Upsert a member record from a Telegram `from` object. */
async function trackMemberFromMessage(groupChatId, from) {
  if (!from?.id) return;
  const telegramId = String(from.id);
  const now = new Date();

  await GroupMember.findOneAndUpdate(
    { groupChatId: String(groupChatId), telegramId },
    {
      $set: {
        username: from.username || '',
        firstName: from.first_name || '',
        lastName: from.last_name || '',
        isBot: from.is_bot || false,
        lastSeenAt: now,
        left: false,
        // A message proves presence even though it does not expose whether the
        // sender is member/admin. "member" is therefore the safe display value.
        telegramStatus: 'member',
        statusCheckedAt: now,
        statusCheckError: '',
      },
      $setOnInsert: { joinedAt: null },
    },
    { upsert: true, new: false },
  ).catch((e) => {});
}

/** Handle a chat_member update (join / leave / kick). */
async function handleChatMemberUpdate(update) {
  const chat = update.chat;
  const member = update.new_chat_member;
  const from = member?.user;
  if (!chat?.id || !from?.id) return null;

  const groupChatId = String(chat.id);
  const telegramId = String(from.id);
  const status = String(member.status || '');
  const isActive = PRESENT_STATUSES.includes(status);
  const now = new Date();

  const before = await GroupMember.findOneAndUpdate(
    { groupChatId, telegramId },
    {
      $set: {
        username: from.username || '',
        firstName: from.first_name || '',
        lastName: from.last_name || '',
        isBot: from.is_bot || false,
        lastSeenAt: now,
        left: !isActive,
        telegramStatus: ['member', 'administrator', 'creator', 'restricted', 'left', 'kicked'].includes(status)
          ? status
          : (isActive ? 'member' : 'unknown'),
        statusCheckedAt: now,
        statusCheckError: '',
      },
      $setOnInsert: { joinedAt: isActive ? now : null },
    },
    { upsert: true, new: false },
  ).catch((e) => {
    return null;
  });

  if (!isActive || from.is_bot) return null;
  const isNew = !before || before.left;
  if (!isNew) return null;
  return { telegramId, from, groupChatId };
}

async function setMemberPhoto(groupChatId, telegramId, fileId) {
  await GroupMember.updateOne(
    { groupChatId: String(groupChatId), telegramId: String(telegramId) },
    { $set: { photoFileId: fileId || '' } },
  ).catch(() => {});
}


/**
 * Lightweight badge projection across all configured Telegram groups.
 *
 * Unlike getMembersWithStatus(), this deliberately does NOT synthesize sellers,
 * resolve shops or registration-request state. The navigation badge only needs
 * persisted group presence + whether a non-removed User exists for telegramId.
 * Two bounded queries keep the cost constant as the number of groups grows.
 */
async function countUnregisteredPresentMembers(groupChatIds) {
  const gids = [...new Set((groupChatIds || []).map(String).filter(Boolean))];
  if (!gids.length) return 0;

  const persistedMembers = await GroupMember.find(
    { groupChatId: { $in: gids }, isBot: false, hiddenAt: null },
    'telegramId telegramStatus left',
  ).lean();

  // Keep legacy semantics exactly: before telegramStatus existed, `left:false`
  // meant present. Unknown/failed live checks are not counted as confirmed
  // presence unless that legacy empty-status rule applies.
  const members = persistedMembers.filter((member) => {
    const status = String(member.telegramStatus || '');
    return PRESENT_STATUSES.includes(status) || (!status && member.left === false);
  });
  if (!members.length) return 0;

  const telegramIds = [...new Set(members.map((member) => String(member.telegramId || '')).filter(Boolean))];
  if (!telegramIds.length) return 0;

  const registeredRows = await User.find(
    { telegramId: { $in: telegramIds }, accountState: { $ne: 'removed' } },
    'telegramId',
  ).lean();
  const registered = new Set(registeredRows.map((user) => String(user.telegramId || '')));

  // Preserve the previous badge semantics: the same person present in two
  // configured groups contributes two group-member rows to the badge.
  return members.reduce(
    (count, member) => count + (registered.has(String(member.telegramId || '')) ? 0 : 1),
    0,
  );
}

/**
 * Full admin view for one Telegram group.
 *
 * Includes:
 *   • every non-bot GroupMember row, including people who left;
 *   • every registered seller even if the bot has never seen them in the group.
 *
 * That second source is what makes "є в додатку, але немає в групі" auditable.
 */
const ABSENT_STATUSES = new Set(['left', 'kicked', 'not_found']);
const VALID_MEMBER_FILTERS = new Set(['all', 'present', 'outside', 'unregistered', 'unknown', 'unchecked']);
const VALID_ACTIVITY_FILTERS = new Set(['all', 'today', '7d', '30d', 'stale', 'never']);

function liveStateOf(member) {
  const status = String(member?.telegramStatus || '');
  if (PRESENT_STATUSES.includes(status)) return status === 'restricted' ? 'restricted' : 'present';
  if (ABSENT_STATUSES.has(status)) return 'absent';
  if (status === 'unknown') return 'unknown';
  return 'unchecked';
}

function warsawDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function activityMatchesRow(row, filter, now = new Date()) {
  if (filter === 'all') return true;
  if (!row.isRegistered) return false;
  const value = row.lastAppActivityAt;
  if (!value) return filter === 'never';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return filter === 'never';
  const age = Math.max(0, now.getTime() - at.getTime());
  const day = 24 * 60 * 60 * 1000;
  if (filter === 'today') return warsawDateKey(at) === warsawDateKey(now);
  if (filter === '7d') return age <= 7 * day;
  if (filter === '30d') return age <= 30 * day;
  if (filter === 'stale') return age > 30 * day;
  return filter === 'never' ? false : true;
}

function matchesMemberFilter(row, filter) {
  const state = liveStateOf(row.member);
  if (filter === 'present') return state === 'present' || state === 'restricted';
  if (filter === 'outside') return row.isRegistered && state === 'absent';
  if (filter === 'unregistered') {
    return !row.isRegistered && (
      state === 'present'
      || state === 'restricted'
      || (state === 'unchecked' && row.member?.left === false)
    );
  }
  if (filter === 'unknown') return state === 'unknown';
  if (filter === 'unchecked') return state === 'unchecked';
  return true;
}

function memberSortWeight(row) {
  const state = liveStateOf(row.member);
  if (state === 'unknown') return 0;
  if (row.isRegistered && state === 'absent') return 1;
  if (!row.isRegistered && (state === 'present' || state === 'restricted')) return 2;
  if (state === 'unchecked') return 3;
  if (state === 'restricted') return 4;
  return 5;
}

/**
 * Paginated admin view for one Telegram group.
 *
 * Candidate identities are still synthesized from two authoritative sources:
 * persisted GroupMember rows + active seller Users. Filtering, sorting and
 * pagination happen on the server, so the browser never receives the full
 * roster just to render one page. Shop/request enrichment is deferred until
 * after the requested page is known wherever possible.
 */
async function getMembersWithStatus(groupChatId, options = {}) {
  const gid = String(groupChatId);
  const requestedPage = Math.max(1, Number.parseInt(options.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(options.pageSize, 10) || 25));
  const filter = VALID_MEMBER_FILTERS.has(String(options.filter || 'all')) ? String(options.filter || 'all') : 'all';
  const activity = VALID_ACTIVITY_FILTERS.has(String(options.activity || 'all')) ? String(options.activity || 'all') : 'all';
  const q = String(options.q || '').trim().toLocaleLowerCase('uk').slice(0, 120);

  // Only fields required to classify/search/render candidates are read here.
  // Hidden history stays durable in Mongo but does not enter the live roster.
  const allGroupMembers = await GroupMember.find(
    { groupChatId: gid, isBot: false },
    'telegramId username firstName lastName left telegramStatus statusCheckedAt statusCheckError hiddenAt',
  ).lean();
  const hiddenIds = new Set(
    allGroupMembers.filter((m) => m.hiddenAt).map((m) => String(m.telegramId)),
  );
  const groupMembers = allGroupMembers.filter((m) => !m.hiddenAt);
  const observedIds = groupMembers.map((m) => String(m.telegramId));

  const users = await User.find(
    {
      accountState: { $ne: 'removed' },
      $or: [
        { role: 'seller' },
        ...(observedIds.length ? [{ telegramId: { $in: observedIds } }] : []),
      ],
    },
    'telegramId role firstName lastName shopId lastAppOpenedAt miniAppState.updatedAt cartState.updatedAt createdAt botBlocked',
  ).lean();

  const userByTid = new Map(users.map((u) => [String(u.telegramId), u]));
  const memberByTid = new Map(groupMembers.map((m) => [String(m.telegramId), m]));
  const allIds = [...new Set([
    ...memberByTid.keys(),
    ...users
      .filter((u) => u.role === 'seller' && !hiddenIds.has(String(u.telegramId)))
      .map((u) => String(u.telegramId)),
  ])].filter((tid) => !hiddenIds.has(String(tid)));

  // Shop names are part of the search contract, so resolve the small unique shop
  // topology once; unlike the old endpoint, registration requests are NOT loaded
  // for the full roster and are fetched only for visible page rows below.
  const shopIds = [...new Set(users.map((u) => u.shopId).filter(Boolean).map(String))];
  const shopById = new Map();
  if (shopIds.length) {
    const shops = await Shop.find({ _id: { $in: shopIds } }, 'name').lean();
    for (const shop of shops) shopById.set(String(shop._id), shop.name || '');
  }

  const candidates = allIds.map((tid) => {
    const rawMember = memberByTid.get(tid) || null;
    const user = userByTid.get(tid) || null;
    const fallbackActivity = maxDate(user?.miniAppState?.updatedAt, user?.cartState?.updatedAt);
    const lastAppOpenedAt = user?.lastAppOpenedAt || null;
    const lastAppActivityAt = maxDate(lastAppOpenedAt, fallbackActivity);
    const member = rawMember || {
      groupChatId: gid,
      telegramId: tid,
      username: '',
      firstName: user?.firstName || '',
      lastName: user?.lastName || '',
      left: null,
      telegramStatus: '',
      statusCheckedAt: null,
      statusCheckError: '',
    };
    const shopName = user?.shopId ? (shopById.get(String(user.shopId)) || '') : '';

    return {
      tid,
      member,
      user,
      shopName,
      isRegistered: Boolean(user),
      lastAppOpenedAt,
      lastAppActivityAt,
      lastAppActivityApproximate: !lastAppOpenedAt && Boolean(fallbackActivity),
      synthesizedFromApp: !rawMember && Boolean(user?.role === 'seller'),
    };
  });

  const stats = { all: candidates.length, present: 0, outside: 0, unregistered: 0, unknown: 0, unchecked: 0 };
  for (const row of candidates) {
    const state = liveStateOf(row.member);
    if (state === 'present' || state === 'restricted') stats.present += 1;
    if (row.isRegistered && state === 'absent') stats.outside += 1;
    if (!row.isRegistered && (
      state === 'present'
      || state === 'restricted'
      || (state === 'unchecked' && row.member?.left === false)
    )) stats.unregistered += 1;
    if (state === 'unknown') stats.unknown += 1;
    if (state === 'unchecked') stats.unchecked += 1;
  }

  const now = new Date();
  const filtered = candidates.filter((row) => {
    if (!matchesMemberFilter(row, filter)) return false;
    if (!activityMatchesRow(row, activity, now)) return false;
    if (!q) return true;
    const haystack = [
      row.member?.firstName,
      row.member?.lastName,
      row.member?.username,
      row.member?.telegramId,
      row.shopName,
    ].filter(Boolean).join(' ').toLocaleLowerCase('uk');
    return haystack.includes(q);
  }).sort((a, b) => {
    const weight = memberSortWeight(a) - memberSortWeight(b);
    if (weight) return weight;
    const an = [a.member?.firstName, a.member?.lastName].filter(Boolean).join(' ');
    const bn = [b.member?.firstName, b.member?.lastName].filter(Boolean).join(' ');
    return an.localeCompare(bn, 'uk');
  });

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * pageSize;
  const pageRows = filtered.slice(offset, offset + pageSize);

  const pageUnregisteredIds = pageRows.filter((row) => !row.isRegistered).map((row) => row.tid);
  const requestByTid = new Map();
  if (pageUnregisteredIds.length) {
    const requests = await RegistrationRequest.find(
      { telegramId: { $in: pageUnregisteredIds }, status: { $in: ['pending', 'rejected', 'blocked'] } },
      'telegramId status updatedAt',
    ).sort({ updatedAt: -1 }).lean();
    for (const request of requests) {
      const tid = String(request.telegramId);
      if (!requestByTid.has(tid)) requestByTid.set(tid, request.status);
    }
  }

  const items = pageRows.map((row) => {
    const registrationStatus = row.user ? 'registered' : (requestByTid.get(row.tid) || 'none');
    return {
      member: row.member,
      isRegistered: row.isRegistered,
      registrationPending: registrationStatus === 'pending',
      registrationStatus,
      user: row.user ? {
        telegramId: row.tid,
        role: row.user.role,
        firstName: row.user.firstName || '',
        lastName: row.user.lastName || '',
        shopId: row.user.shopId ? String(row.user.shopId) : null,
        shopName: row.shopName,
        botBlocked: Boolean(row.user.botBlocked),
        registeredAt: row.user.createdAt || null,
        lastAppOpenedAt: row.lastAppOpenedAt,
        lastAppActivityAt: row.lastAppActivityAt,
        lastAppActivityApproximate: row.lastAppActivityApproximate,
      } : null,
      synthesizedFromApp: row.synthesizedFromApp,
    };
  });

  return {
    items,
    page,
    pageSize,
    total,
    totalPages,
    stats,
    filter,
    activity,
    q,
  };
}

module.exports = {
  trackMemberFromMessage,
  handleChatMemberUpdate,
  setMemberPhoto,
  getMembersWithStatus,
  countUnregisteredPresentMembers,
};

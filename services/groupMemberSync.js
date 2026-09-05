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
 * Full admin view for one Telegram group.
 *
 * Includes:
 *   • every non-bot GroupMember row, including people who left;
 *   • every registered seller even if the bot has never seen them in the group.
 *
 * That second source is what makes "є в додатку, але немає в групі" auditable.
 */
async function getMembersWithStatus(groupChatId) {
  const gid = String(groupChatId);
  const allGroupMembers = await GroupMember.find({ groupChatId: gid, isBot: false }).lean();
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
    'telegramId role firstName lastName phoneNumber shopId lastAppOpenedAt miniAppState.updatedAt cartState.updatedAt createdAt botBlocked',
  ).lean();

  const userByTid = new Map(users.map((u) => [String(u.telegramId), u]));
  const memberByTid = new Map(groupMembers.map((m) => [String(m.telegramId), m]));
  const allIds = [...new Set([
    ...memberByTid.keys(),
    ...users
      .filter((u) => u.role === 'seller' && !hiddenIds.has(String(u.telegramId)))
      .map((u) => String(u.telegramId)),
  ])].filter((tid) => !hiddenIds.has(String(tid)));

  const shopIds = [...new Set(users.map((u) => u.shopId).filter(Boolean).map(String))];
  const shopById = new Map();
  if (shopIds.length) {
    const shops = await Shop.find({ _id: { $in: shopIds } }, 'name').lean();
    for (const shop of shops) shopById.set(String(shop._id), shop.name || '');
  }

  const unregisteredIds = allIds.filter((tid) => !userByTid.has(tid));
  const requestByTid = new Map();
  if (unregisteredIds.length) {
    const requests = await RegistrationRequest.find(
      { telegramId: { $in: unregisteredIds }, status: { $in: ['pending', 'rejected', 'blocked'] } },
      'telegramId status updatedAt',
    ).sort({ updatedAt: -1 }).lean();
    for (const request of requests) {
      const tid = String(request.telegramId);
      if (!requestByTid.has(tid)) requestByTid.set(tid, request.status);
    }
  }

  return allIds.map((tid) => {
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
      photoFileId: '',
      isBot: false,
      lastSeenAt: null,
      joinedAt: null,
      left: null,
      telegramStatus: '',
      statusCheckedAt: null,
      statusCheckError: '',
    };

    const registrationStatus = user ? 'registered' : (requestByTid.get(tid) || 'none');

    return {
      member,
      isRegistered: Boolean(user),
      registrationPending: registrationStatus === 'pending',
      registrationStatus,
      user: user ? {
        telegramId: tid,
        role: user.role,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        shopId: user.shopId ? String(user.shopId) : null,
        shopName: user.shopId ? (shopById.get(String(user.shopId)) || '') : '',
        botBlocked: Boolean(user.botBlocked),
        registeredAt: user.createdAt || null,
        lastAppOpenedAt,
        lastAppActivityAt,
        lastAppActivityApproximate: !lastAppOpenedAt && Boolean(fallbackActivity),
      } : null,
      synthesizedFromApp: !rawMember && Boolean(user?.role === 'seller'),
    };
  }).sort((a, b) => {
    const an = [a.member.firstName, a.member.lastName].filter(Boolean).join(' ').trim();
    const bn = [b.member.firstName, b.member.lastName].filter(Boolean).join(' ').trim();
    return an.localeCompare(bn, 'uk');
  });
}

module.exports = { trackMemberFromMessage, handleChatMemberUpdate, setMemberPhoto, getMembersWithStatus };

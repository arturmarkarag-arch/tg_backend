'use strict';
// Passive group-member tracking + new-member notification.
//
// The Telegram Bot API has no "list all members" endpoint. We build the
// member set incrementally: every message and every join/leave event in an
// authorized group upserts a GroupMember record. Over time the set converges
// to the real membership.

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');

/**
 * Upsert a member record from a Telegram `from` object.
 * Call this on every message received in an authorized group.
 */
async function trackMemberFromMessage(groupChatId, from) {
  if (!from?.id) return;
  const telegramId = String(from.id);

  await GroupMember.findOneAndUpdate(
    { groupChatId: String(groupChatId), telegramId },
    {
      $set: {
        username:   from.username  || '',
        firstName:  from.first_name || '',
        lastName:   from.last_name  || '',
        isBot:      from.is_bot     || false,
        lastSeenAt: new Date(),
        left:       false,
      },
      $setOnInsert: { joinedAt: null },
    },
    { upsert: true, new: false },
  ).catch((e) => console.warn('[groupMemberSync] trackMember failed:', e.message));
}

/**
 * Handle a chat_member update (join / leave / kick).
 * Returns { isNew, telegramId, from } when a non-bot user just joined so
 * the caller can schedule the welcome message.
 */
async function handleChatMemberUpdate(update) {
  const chat   = update.chat;
  const member = update.new_chat_member;
  const from   = member?.user;
  if (!chat?.id || !from?.id) return null;

  const groupChatId = String(chat.id);
  const telegramId  = String(from.id);
  const status      = member.status; // 'member' | 'administrator' | 'creator' | 'left' | 'kicked' | 'restricted'

  const isActive = ['member', 'administrator', 'creator', 'restricted'].includes(status);
  const now      = new Date();

  const before = await GroupMember.findOneAndUpdate(
    { groupChatId, telegramId },
    {
      $set: {
        username:   from.username   || '',
        firstName:  from.first_name || '',
        lastName:   from.last_name  || '',
        isBot:      from.is_bot     || false,
        lastSeenAt: now,
        left:       !isActive,
        ...(isActive ? {} : {}),
      },
      $setOnInsert: { joinedAt: isActive ? now : null },
    },
    { upsert: true, new: false },
  ).catch((e) => {
    console.warn('[groupMemberSync] handleChatMemberUpdate failed:', e.message);
    return null;
  });

  if (!isActive || from.is_bot) return null;

  // "isNew" = record didn't exist before, or user had previously left
  const isNew = !before || before.left;
  if (!isNew) return null;

  return { telegramId, from, groupChatId };
}

/**
 * Update photo file_id for a member (call after getUserProfilePhotos).
 */
async function setMemberPhoto(groupChatId, telegramId, fileId) {
  await GroupMember.updateOne(
    { groupChatId: String(groupChatId), telegramId: String(telegramId) },
    { $set: { photoFileId: fileId || '' } },
  ).catch(() => {});
}

/**
 * Returns all GroupMember records for a group enriched with registration status.
 * { member, isRegistered, registrationPending }
 */
async function getMembersWithStatus(groupChatId) {
  const members = await GroupMember.find({ groupChatId: String(groupChatId), left: false, isBot: false })
    .sort({ firstName: 1 })
    .lean();

  if (!members.length) return [];

  const ids = members.map((m) => m.telegramId);

  const [registeredIds, pendingIds] = await Promise.all([
    User.find({ telegramId: { $in: ids } }, 'telegramId').lean()
      .then((docs) => new Set(docs.map((d) => d.telegramId))),
    require('../models/RegistrationRequest')
      .find({ telegramId: { $in: ids }, status: 'pending' }, 'telegramId').lean()
      .then((docs) => new Set(docs.map((d) => d.telegramId))),
  ]);

  return members.map((m) => ({
    member: m,
    isRegistered:        registeredIds.has(m.telegramId),
    registrationPending: pendingIds.has(m.telegramId),
  }));
}

module.exports = { trackMemberFromMessage, handleChatMemberUpdate, setMemberPhoto, getMembersWithStatus };

'use strict';

// Admin-facing, notification-free Telegram membership audit.
// This service deliberately does ONE thing: ask Telegram for the current status
// and persist that technical answer. It never posts/deletes messages and never
// changes registration state or user access.

const GroupMember = require('../models/GroupMember');
const User = require('../models/User');

const PRESENT_STATUSES = ['member', 'administrator', 'creator', 'restricted'];
const ABSENT_ERROR_RE = /user not found|PARTICIPANT_ID_INVALID|USER_ID_INVALID|user_not_participant/i;
const CALL_SPACING_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(err) {
  return String(err?.response?.body?.description || err?.message || err || '');
}

function retryAfterSeconds(err) {
  const n = Number(err?.response?.body?.parameters?.retry_after);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Check one user in one concrete group.
 * known=false is an infrastructure/API uncertainty, NOT absence.
 */
async function checkOneGroup(bot, groupChatId, telegramId) {
  const gid = String(groupChatId);
  const tid = Number(telegramId);

  const perform = async () => {
    const member = await bot.getChatMember(gid, tid);
    const status = String(member?.status || '');
    return {
      known: true,
      present: PRESENT_STATUSES.includes(status),
      status,
      telegramUser: member?.user || null,
      error: '',
    };
  };

  try {
    return await perform();
  } catch (err) {
    const wait = retryAfterSeconds(err);
    if (wait) {
      await sleep((wait + 1) * 1000);
      try {
        return await perform();
      } catch (retryErr) {
        const msg = describeError(retryErr);
        if (ABSENT_ERROR_RE.test(msg)) {
          return { known: true, present: false, status: 'not_found', telegramUser: null, error: '' };
        }
        return { known: false, present: false, status: 'unknown', telegramUser: null, error: msg };
      }
    }

    const msg = describeError(err);
    if (ABSENT_ERROR_RE.test(msg)) {
      return { known: true, present: false, status: 'not_found', telegramUser: null, error: '' };
    }
    return { known: false, present: false, status: 'unknown', telegramUser: null, error: msg };
  }
}

function profileFields(result, fallback = {}) {
  const u = result.telegramUser || {};
  return {
    username: u.username || fallback.username || '',
    firstName: u.first_name || fallback.firstName || '',
    lastName: u.last_name || fallback.lastName || '',
    isBot: Boolean(u.is_bot ?? fallback.isBot ?? false),
  };
}

/** Persist a check without causing any user-facing side effect. */
async function persistCheck(groupChatId, telegramId, result, fallback = {}) {
  const gid = String(groupChatId);
  const tid = String(telegramId);
  const now = new Date();
  const identity = profileFields(result, fallback);

  const set = {
    ...identity,
    telegramStatus: result.known ? result.status : 'unknown',
    statusCheckedAt: now,
    statusCheckError: result.known ? '' : String(result.error || '').slice(0, 500),
  };

  // Critical fail-open rule: unknown must not mutate `left`.
  if (result.known) set.left = !result.present;

  await GroupMember.findOneAndUpdate(
    { groupChatId: gid, telegramId: tid },
    {
      $set: set,
      $setOnInsert: {
        joinedAt: null,
        lastSeenAt: null,
        photoFileId: '',
        welcomeChatId: '',
        welcomeMessageId: null,
      },
    },
    { upsert: true, new: true },
  ).lean();

  return { ...result, statusCheckedAt: now };
}

async function checkAndPersistGroupMember(groupChatId, telegramId, fallback = {}) {
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) return { ok: false, reason: 'bot_unavailable' };

  const result = await checkOneGroup(bot, groupChatId, telegramId);
  const persisted = await persistCheck(groupChatId, telegramId, result, fallback);
  return { ok: true, ...persisted };
}

/**
 * Audit everyone we can meaningfully know about for one group:
 *  - every user ever observed by the bot in that group (including left rows),
 *  - every registered SELLER, so "є в додатку, але немає в групі" is detectable.
 *
 * Admin/warehouse accounts are not synthesized as missing members: their access
 * is not coupled to seller work-group membership. If they actually participate
 * in the group, their passive GroupMember row is still audited and displayed.
 */
async function auditGroup(groupChatId) {
  const { getBot } = require('../telegramBot');
  const bot = getBot();
  if (!bot) return { ok: false, reason: 'bot_unavailable' };

  const gid = String(groupChatId);
  const [allKnownMembers, sellers] = await Promise.all([
    GroupMember.find({ groupChatId: gid, isBot: false }).lean(),
    User.find({ role: 'seller', accountState: { $ne: 'removed' } }, 'telegramId firstName lastName role').lean(),
  ]);

  const hiddenIds = new Set(
    allKnownMembers.filter((m) => m.hiddenAt).map((m) => String(m.telegramId)),
  );
  const knownMembers = allKnownMembers.filter((m) => !m.hiddenAt);
  const memberByTid = new Map(knownMembers.map((m) => [String(m.telegramId), m]));
  const sellerByTid = new Map(
    sellers
      .filter((u) => !hiddenIds.has(String(u.telegramId)))
      .map((u) => [String(u.telegramId), u]),
  );
  const ids = [...new Set([...memberByTid.keys(), ...sellerByTid.keys()])]
    .filter((tid) => !hiddenIds.has(String(tid)));
  const registeredDocs = ids.length
    ? await User.find({ telegramId: { $in: ids }, accountState: { $ne: 'removed' } }, 'telegramId').lean()
    : [];
  const registeredIds = new Set(registeredDocs.map((u) => String(u.telegramId)));

  const stats = {
    checked: 0,
    ok: 0,
    unregistered: 0,
    absent: 0,
    restricted: 0,
    unknown: 0,
  };

  for (let i = 0; i < ids.length; i += 1) {
    const tid = ids[i];
    const member = memberByTid.get(tid) || {};
    const seller = sellerByTid.get(tid) || null;
    const fallback = {
      username: member.username || '',
      firstName: member.firstName || seller?.firstName || '',
      lastName: member.lastName || seller?.lastName || '',
      isBot: false,
    };

    const result = await checkOneGroup(bot, gid, tid);
    await persistCheck(gid, tid, result, fallback);
    stats.checked += 1;

    const isRegistered = registeredIds.has(tid);
    if (!result.known) stats.unknown += 1;
    else if (!result.present) stats.absent += 1;
    else if (result.status === 'restricted') stats.restricted += 1;
    else if (!isRegistered) stats.unregistered += 1;
    else stats.ok += 1;

    if (i < ids.length - 1) await sleep(CALL_SPACING_MS);
  }

  return { ok: true, groupId: gid, ...stats, checkedAt: new Date() };
}

module.exports = {
  PRESENT_STATUSES,
  checkOneGroup,
  persistCheck,
  checkAndPersistGroupMember,
  auditGroup,
};

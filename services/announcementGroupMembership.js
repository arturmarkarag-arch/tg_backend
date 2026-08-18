'use strict';

/**
 * Persisted membership projection for the shared work group «Оголошення».
 *
 * This deliberately does not call Telegram from a picking/readiness request.
 * GroupMember chat_member events and explicit admin audits are the authority.
 * `unknown` is infrastructure uncertainty and must never become an absence.
 */
const GroupMember = require('../models/GroupMember');
const { serviceGroupChatIds } = require('../utils/groupRecipients');

const PRESENT_STATUSES = new Set(['member', 'administrator', 'creator', 'restricted']);
const ABSENT_STATUSES = new Set(['left', 'kicked', 'not_found']);

function persistedPresence(row) {
  if (!row) return null;
  const status = String(row.telegramStatus || '');
  if (PRESENT_STATUSES.has(status)) return true;
  if (ABSENT_STATUSES.has(status)) return false;
  // Compatibility for passive rows created before telegramStatus existed.
  if (!status && row.left === false) return true;
  if (!status && row.left === true) return false;
  return null;
}

function resolveAnnouncementGroupMembership(rows = [], allowedGroupIds = []) {
  const ids = [...new Set((allowedGroupIds || []).map(String).filter(Boolean))];
  if (!ids.length) return null;

  const byGroup = new Map((rows || []).map((row) => [String(row.groupChatId || ''), row]));
  const states = ids.map((groupId) => persistedPresence(byGroup.get(groupId)));
  if (states.includes(true)) return true;
  // Only a determinate absence from EVERY allowed work group is operationally
  // unavailable. Missing/unknown rows fail open to avoid false staff warnings.
  return states.every((state) => state === false) ? false : null;
}

async function loadAnnouncementMembershipByTelegramId(telegramIds = []) {
  const ids = [...new Set((telegramIds || []).map(String).filter(Boolean))];
  const allowedGroupIds = await serviceGroupChatIds();
  if (!ids.length || !allowedGroupIds.length) return new Map();

  const rows = await GroupMember.find({
    telegramId: { $in: ids },
    groupChatId: { $in: allowedGroupIds.map(String) },
  }, 'telegramId groupChatId telegramStatus left').lean();
  const rowsByUser = new Map();
  for (const row of rows) {
    const telegramId = String(row.telegramId || '');
    if (!rowsByUser.has(telegramId)) rowsByUser.set(telegramId, []);
    rowsByUser.get(telegramId).push(row);
  }

  return new Map(ids.map((telegramId) => [
    telegramId,
    resolveAnnouncementGroupMembership(rowsByUser.get(telegramId) || [], allowedGroupIds),
  ]));
}

module.exports = {
  persistedPresence,
  resolveAnnouncementGroupMembership,
  loadAnnouncementMembershipByTelegramId,
};

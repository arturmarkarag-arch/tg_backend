'use strict';

const { checkOneGroup } = require('./groupMemberAudit');

/**
 * Returns a user-facing registration decision without confusing a Telegram/API
 * failure with a confirmed absence from the work group.
 */
async function checkMembershipAcrossGroups({ bot, telegramId, groupIds = [] }) {
  if (!bot || !telegramId) {
    return { allowed: false, reason: 'check_failed' };
  }

  const ids = [...new Set((groupIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    return { allowed: false, reason: 'group_not_configured' };
  }

  let hadUnknownResult = false;
  for (const groupId of ids) {
    const result = await checkOneGroup(bot, groupId, telegramId);
    if (result.known && result.present) {
      return {
        allowed: true,
        reason: 'member',
        groupId,
        telegramStatus: result.status,
      };
    }
    if (!result.known) hadUnknownResult = true;
  }

  if (hadUnknownResult) {
    return { allowed: false, reason: 'check_failed' };
  }
  return { allowed: false, reason: 'not_in_group' };
}

module.exports = { checkMembershipAcrossGroups };

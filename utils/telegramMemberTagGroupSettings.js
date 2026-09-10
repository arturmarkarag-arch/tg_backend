'use strict';

const AppSetting = require('../models/AppSetting');
const { normalizeGroupId, normalizeGroupIds } = require('./telegramGroupSettings');

// Separate, DB-only target list for shop member tags. This must never fall back
// to telegram.allowedGroupIds: bot-authorized groups and member-tag groups are
// independent settings with independent behavior.
const TELEGRAM_MEMBER_TAG_GROUPS_KEY = 'telegram.memberTagGroupIds';

async function getTelegramMemberTagGroupIds() {
  const row = await AppSetting.findOne({ key: TELEGRAM_MEMBER_TAG_GROUPS_KEY }).lean();
  return Array.isArray(row?.value) ? normalizeGroupIds(row.value) : [];
}

async function setTelegramMemberTagGroupIds(values) {
  const ids = normalizeGroupIds(values);
  await AppSetting.findOneAndUpdate(
    { key: TELEGRAM_MEMBER_TAG_GROUPS_KEY },
    { $set: { value: ids } },
    { upsert: true, new: true },
  );
  return ids;
}

async function isTelegramMemberTagGroupId(value) {
  const id = normalizeGroupId(value);
  if (!id) return false;
  const ids = await getTelegramMemberTagGroupIds();
  return ids.includes(id);
}

module.exports = {
  TELEGRAM_MEMBER_TAG_GROUPS_KEY,
  getTelegramMemberTagGroupIds,
  setTelegramMemberTagGroupIds,
  isTelegramMemberTagGroupId,
};

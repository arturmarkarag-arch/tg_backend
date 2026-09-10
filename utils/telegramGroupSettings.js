'use strict';

const AppSetting = require('../models/AppSetting');

const TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds';
const TELEGRAM_MAIN_GROUP_KEY = 'telegram.mainGroupId';

function normalizeGroupId(value) {
  const id = String(value ?? '').trim();
  if (!id) return '';
  if (!/^-?\d+$/.test(id)) return '';
  return id;
}

function normalizeGroupIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeGroupId)
    .filter(Boolean))];
}

async function getAllowedGroupIds() {
  const row = await AppSetting.findOne({ key: TELEGRAM_GROUPS_KEY }).lean();
  if (Array.isArray(row?.value) && row.value.length > 0) return normalizeGroupIds(row.value);
  // Preserve the existing compatibility contract for authorized work groups.
  return normalizeGroupIds((process.env.TELEGRAM_ALLOWED_GROUP_IDS || '').split(','));
}

async function setAllowedGroupIds(values) {
  const ids = normalizeGroupIds(values);
  await AppSetting.findOneAndUpdate(
    { key: TELEGRAM_GROUPS_KEY },
    { $set: { value: ids } },
    { upsert: true, new: true },
  );
  return ids;
}

/**
 * The main work group is intentionally explicit. Never infer it from the first
 * telegram.allowedGroupIds entry: list order is not an identity contract.
 */
async function getMainTelegramGroupId() {
  const row = await AppSetting.findOne({ key: TELEGRAM_MAIN_GROUP_KEY }).lean();
  return normalizeGroupId(row?.value);
}

async function setMainTelegramGroupId(value) {
  const groupId = normalizeGroupId(value);
  if (String(value ?? '').trim() && !groupId) {
    const err = new Error('telegram_main_group_invalid');
    err.code = 'telegram_main_group_invalid';
    throw err;
  }

  if (groupId) {
    const allowed = await getAllowedGroupIds();
    if (!allowed.includes(groupId)) {
      const err = new Error('telegram_main_group_not_allowed');
      err.code = 'telegram_main_group_not_allowed';
      throw err;
    }
  }

  await AppSetting.findOneAndUpdate(
    { key: TELEGRAM_MAIN_GROUP_KEY },
    { $set: { value: groupId } },
    { upsert: true, new: true },
  );
  return groupId;
}

module.exports = {
  TELEGRAM_GROUPS_KEY,
  TELEGRAM_MAIN_GROUP_KEY,
  normalizeGroupId,
  normalizeGroupIds,
  getAllowedGroupIds,
  setAllowedGroupIds,
  getMainTelegramGroupId,
  setMainTelegramGroupId,
};

'use strict';

const AppSetting = require('../models/AppSetting');

const TELEGRAM_GROUPS_KEY = 'telegram.allowedGroupIds';

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
  // Once the DB setting exists, even [] is authoritative. Otherwise removing
  // every group would silently resurrect legacy TELEGRAM_ALLOWED_GROUP_IDS.
  if (Array.isArray(row?.value)) return normalizeGroupIds(row.value);
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

module.exports = {
  TELEGRAM_GROUPS_KEY,
  normalizeGroupId,
  normalizeGroupIds,
  getAllowedGroupIds,
  setAllowedGroupIds,
};

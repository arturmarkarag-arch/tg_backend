const AppSetting = require('../models/AppSetting');

const TELEGRAM_SUPPORT_ADMINS_KEY = 'telegram.supportAdmins';
const MAX_SUPPORT_ADMINS = 10;

function normalizeTelegramUsername(value) {
  let username = String(value || '').trim();
  if (!username) return '';
  username = username.replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, '');
  username = username.replace(/^tg:\/\/resolve\?domain=/i, '');
  username = username.replace(/^@+/, '');
  username = username.split(/[/?#]/)[0].trim();
  return username;
}

function isValidTelegramUsername(value) {
  const username = normalizeTelegramUsername(value);
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username);
}

function normalizeSupportAdmin(item) {
  const name = String(item?.name || '').trim().slice(0, 80);
  const username = normalizeTelegramUsername(item?.username);
  if (!name || !isValidTelegramUsername(username)) return null;
  return { name, username };
}

function normalizeSupportAdmins(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const admin = normalizeSupportAdmin(raw);
    if (!admin) continue;
    const key = admin.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(admin);
    if (result.length >= MAX_SUPPORT_ADMINS) break;
  }
  return result;
}

async function getSupportAdmins() {
  const row = await AppSetting.findOne({ key: TELEGRAM_SUPPORT_ADMINS_KEY }).lean();
  return normalizeSupportAdmins(row?.value);
}

async function saveSupportAdmins(value) {
  const normalized = normalizeSupportAdmins(value);
  await AppSetting.findOneAndUpdate(
    { key: TELEGRAM_SUPPORT_ADMINS_KEY },
    { value: normalized },
    { upsert: true, new: true },
  );
  return normalized;
}

function toPublicSupportAdmins(value) {
  return normalizeSupportAdmins(value).map(({ name, username }) => ({
    name,
    username,
    url: `https://t.me/${username}`,
  }));
}

module.exports = {
  TELEGRAM_SUPPORT_ADMINS_KEY,
  MAX_SUPPORT_ADMINS,
  normalizeTelegramUsername,
  isValidTelegramUsername,
  normalizeSupportAdmin,
  normalizeSupportAdmins,
  getSupportAdmins,
  saveSupportAdmins,
  toPublicSupportAdmins,
};

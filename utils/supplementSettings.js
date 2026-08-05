'use strict';

/**
 * Налаштування дозамовлень.
 *
 * У поточній версії дозамовлення закривається ВРУЧНУ кнопкою складу/адміна,
 * тому таймера і windowMinutes більше немає.
 *
 * Єдине налаштування — пряме посилання на Mini App, яке вставляється в
 * Telegram-повідомлення. Фолбеків немає свідомо: якщо посилання заблокували або
 * змінили, адмін замінює його тут і наступні повідомлення одразу використовують
 * нове значення.
 */

const AppSetting = require('../models/AppSetting');
const cache = require('./cache');

const SUPPLEMENT_SETTINGS_KEY = 'supplement.settings';

function normalize(raw) {
  return {
    appUrl: String(raw?.appUrl || '').trim(),
  };
}

function isValidAppUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function getSupplementSettings() {
  const cached = await cache.get(cache.KEYS.SUPPLEMENT_SETTINGS);
  if (cached) return structuredClone(cached);

  const doc = await AppSetting.findOne({ key: SUPPLEMENT_SETTINGS_KEY }).lean();
  const value = normalize(doc?.value);
  await cache.set(cache.KEYS.SUPPLEMENT_SETTINGS, value);
  return structuredClone(value);
}

async function invalidateSupplementSettingsCache() {
  await cache.invalidate(cache.KEYS.SUPPLEMENT_SETTINGS);
}

module.exports = {
  getSupplementSettings,
  invalidateSupplementSettingsCache,
  normalizeSupplementSettings: normalize,
  isValidSupplementAppUrl: isValidAppUrl,
  SUPPLEMENT_SETTINGS_KEY,
};

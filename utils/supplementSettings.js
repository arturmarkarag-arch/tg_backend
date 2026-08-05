'use strict';

/**
 * Налаштування дозамовлень. У першій версії воно рівно ОДНЕ (§6, §27):
 * скільки часу після проведення накладної пропозиція лишається відкритою.
 *
 * Читається з AppSetting('supplement.settings') через спільний двошаровий кеш.
 * На відміну від ordering.schedule тут Є дефолт: відсутність запису означає
 * «адмін ще не заходив у налаштування», і падати з помилкою посеред проведення
 * накладної через це не можна — накладна не має жодного стосунку до того, чи
 * встиг адмін відкрити налаштування.
 */

const AppSetting = require('../models/AppSetting');
const cache = require('./cache');

const SUPPLEMENT_SETTINGS_KEY = 'supplement.settings';

const DEFAULTS = {
  // 30 хв — типова «хвиля» ранкового приймання: товар приїхав ~07:40, склад
  // ще збирається, магазини встигають відреагувати до виїзду.
  windowMinutes: 30,
};

const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 12 * 60;

function normalize(raw) {
  const n = Math.trunc(Number(raw?.windowMinutes));
  const windowMinutes = Number.isFinite(n)
    ? Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, n))
    : DEFAULTS.windowMinutes;
  return { windowMinutes };
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
  SUPPLEMENT_SETTINGS_KEY,
  SUPPLEMENT_DEFAULTS: DEFAULTS,
  MIN_WINDOW_MINUTES,
  MAX_WINDOW_MINUTES,
};

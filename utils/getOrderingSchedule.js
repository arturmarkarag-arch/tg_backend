'use strict';

/**
 * Shared utility — reads the ordering schedule from AppSetting.
 *
 * Intentionally has NO hardcoded fallback defaults.
 * If the record is missing from the database, an error is thrown so the failure
 * is visible immediately rather than silently running on phantom values.
 *
 * To set the schedule use the admin route:
 *   POST /api/admin/ordering-schedule  { openHour, openMinute, closeHour, closeMinute }
 */

const AppSetting = require('../models/AppSetting');
const cache = require('./cache');

const ORDERING_SCHEDULE_KEY = 'ordering.schedule';

/**
 * Reads the ordering schedule from the database (cached in memory).
 * Call invalidateOrderingScheduleCache() after admin update to refresh.
 * @throws {Error} if the 'ordering.schedule' key is not present in AppSetting.
 * @returns {Promise<{ openHour: number, openMinute: number, closeHour: number, closeMinute: number }>}
 */
async function getOrderingSchedule() {
  const cached = await cache.get(cache.KEYS.ORDERING_SCHEDULE);
  if (cached) return structuredClone(cached);

  const doc = await AppSetting.findOne({ key: ORDERING_SCHEDULE_KEY }).lean();
  if (!doc || !doc.value) {
    throw new Error(
      "Налаштування вікна замовлень відсутні в базі даних (ключ: 'ordering.schedule'). " +
      'Адміністратор має їх налаштувати через розділ Налаштування → Розклад замовлень.'
    );
  }

  const value = structuredClone(doc.value);
  await cache.set(cache.KEYS.ORDERING_SCHEDULE, value);
  return structuredClone(value);
}

async function invalidateOrderingScheduleCache() {
  await cache.invalidate(cache.KEYS.ORDERING_SCHEDULE);
}

module.exports = { getOrderingSchedule, invalidateOrderingScheduleCache, ORDERING_SCHEDULE_KEY };

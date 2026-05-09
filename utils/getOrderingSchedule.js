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

const ORDERING_SCHEDULE_KEY = 'ordering.schedule';

/**
 * Reads the ordering schedule from the database.
 * @throws {Error} if the 'ordering.schedule' key is not present in AppSetting.
 * @returns {Promise<{ openHour: number, openMinute: number, closeHour: number, closeMinute: number }>}
 */
async function getOrderingSchedule() {
  const doc = await AppSetting.findOne({ key: ORDERING_SCHEDULE_KEY }).lean();
  if (!doc || !doc.value) {
    throw new Error(
      "Налаштування вікна замовлень відсутні в базі даних (ключ: 'ordering.schedule'). " +
      'Адміністратор має їх налаштувати через розділ Налаштування → Розклад замовлень.'
    );
  }
  return doc.value;
}

module.exports = { getOrderingSchedule, ORDERING_SCHEDULE_KEY };

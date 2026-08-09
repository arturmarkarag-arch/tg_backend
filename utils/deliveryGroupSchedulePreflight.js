'use strict';

const DeliveryGroup = require('../models/DeliveryGroup');
const { validateOrderingScheduleDeliveryDay } = require('./orderingSchedule');

async function auditDeliveryGroupSchedules() {
  const groups = await DeliveryGroup.find({}, 'name dayOfWeek orderingSchedule').lean();
  const invalid = [];
  for (const group of groups) {
    try {
      validateOrderingScheduleDeliveryDay(group.orderingSchedule, group.dayOfWeek);
    } catch (err) {
      invalid.push({
        id: String(group._id),
        name: group.name || '',
        reason: err.message,
      });
    }
  }
  return { total: groups.length, invalid };
}

async function assertDeliveryGroupSchedulesReady() {
  const report = await auditDeliveryGroupSchedules();
  if (report.invalid.length) {
    const sample = report.invalid.slice(0, 5)
      .map((g) => `${g.name || g.id} (${g.id}): ${g.reason}`)
      .join('; ');
    throw new Error(
      `DeliveryGroup orderingSchedule preflight failed: ${report.invalid.length}/${report.total} groups invalid. ` +
      `Run: node scripts/migrateDeliveryGroupSchedules.js --apply. ${sample}`,
    );
  }
  return report;
}

module.exports = { auditDeliveryGroupSchedules, assertDeliveryGroupSchedulesReady };

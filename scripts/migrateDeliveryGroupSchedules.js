'use strict';

/**
 * One-time migration from the legacy GLOBAL ordering.schedule to explicit
 * per-DeliveryGroup orderingSchedule.
 *
 * DRY RUN (default):
 *   node scripts/migrateDeliveryGroupSchedules.js
 *
 * APPLY:
 *   node scripts/migrateDeliveryGroupSchedules.js --apply
 *
 * Exact compatibility mapping of the OLD behaviour:
 *   start = day before DeliveryGroup.dayOfWeek, except Sunday -> Saturday
 *   end   = DeliveryGroup.dayOfWeek
 *   hours/minutes are copied from AppSetting('ordering.schedule')
 *
 * After this migration the runtime never reads ordering.schedule again.
 */

const path = require('path');
const dotenv = require('dotenv');
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}
const mongoose = require('mongoose');
const DeliveryGroup = require('../models/DeliveryGroup');
const AppSetting = require('../models/AppSetting');
const { normalizeOrderingSchedule, validateOrderingScheduleDeliveryDay } = require('../utils/orderingSchedule');
const { buildLegacyCompatibleGroupSchedule } = require('../utils/legacyOrderingScheduleMigration');
const { auditDeliveryGroupSchedules } = require('../utils/deliveryGroupSchedulePreflight');

const APPLY = process.argv.includes('--apply');
const LEGACY_KEY = 'ordering.schedule';

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri);

  const groups = await DeliveryGroup.find({}).lean();
  const missing = [];
  for (const group of groups) {
    try {
      validateOrderingScheduleDeliveryDay(group.orderingSchedule, group.dayOfWeek);
    } catch {
      missing.push(group);
    }
  }

  // Existing valid per-group schedules are NEVER rewritten just because their
  // endDay differs from dayOfWeek: delivery weekday and ordering close weekday
  // are independent business settings.
  let legacyValue = null;
  if (missing.length > 0) {
    const legacy = await AppSetting.findOne({ key: LEGACY_KEY }).lean();
    if (!legacy?.value) {
      throw new Error(`Missing AppSetting('${LEGACY_KEY}'). Migration cannot preserve existing behaviour for ${missing.length} old group(s) without it.`);
    }
    legacyValue = legacy.value;
  }

  const changes = [];
  for (const group of missing) {
    // Enforces 00/15/30/45; refuse to silently round an existing production time.
    const proposed = buildLegacyCompatibleGroupSchedule(group.dayOfWeek, legacyValue);
    normalizeOrderingSchedule(proposed);
    validateOrderingScheduleDeliveryDay(proposed, group.dayOfWeek);
    changes.push({ group, proposed });
  }

  if (changes.length === 0) {
    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
    console.log(`Groups total: ${groups.length}; need migration: 0`);
    console.log('✅ Every DeliveryGroup has a valid individual schedule. Delivery day and close day may differ.');
    return;
  }

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`Groups total: ${groups.length}; need migration: ${changes.length}`);
  for (const { group, proposed } of changes) {
    console.log(`- ${group.name} (${group._id}) deliveryDay=${group.dayOfWeek} -> ${JSON.stringify(proposed)}`);
  }

  if (APPLY) {
    for (const { group, proposed } of changes) {
      await DeliveryGroup.updateOne(
        { _id: group._id },
        { $set: { orderingSchedule: proposed } },
        { runValidators: true },
      );
    }
    const report = await auditDeliveryGroupSchedules();
    if (report.invalid.length) {
      throw new Error(`Post-migration preflight failed: ${JSON.stringify(report.invalid)}`);
    }
    console.log(`✅ Migration applied. ${report.total} groups have valid individual schedules.`);
  } else {
    console.log('No changes written. Re-run with --apply after reviewing the plan.');
  }
}

main()
  .catch((err) => { console.error('❌', err.message); process.exitCode = 1; })
  .finally(async () => { try { await mongoose.disconnect(); } catch {} });

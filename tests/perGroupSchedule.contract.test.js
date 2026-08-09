'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function jsFiles(dir) {
  const base = path.join(ROOT, dir);
  const out = [];
  const walk = (p) => {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
    }
  };
  walk(base);
  return out;
}

describe('per-group ordering schedule contracts', () => {
  it('runtime has no legacy global schedule utility or route/service dependency', () => {
    expect(fs.existsSync(path.join(ROOT, 'utils/getOrderingSchedule.js'))).toBe(false);
    const offenders = [...jsFiles('routes'), ...jsFiles('services')]
      .filter((file) => /getOrderingSchedule|utils\/getOrderingSchedule/.test(fs.readFileSync(file, 'utf8')));
    expect(offenders.map((x) => path.relative(ROOT, x))).toEqual([]);
  });

  it('the Monday/Sunday hardcode is isolated to migration compatibility only', () => {
    const runtime = [
      ...jsFiles('routes'),
      ...jsFiles('services'),
      read('utils/orderingSchedule.js'),
      read('utils/getOrCreateSession.js'),
    ].map((x) => typeof x === 'string' && x.includes('\n') ? x : fs.readFileSync(x, 'utf8')).join('\n');
    expect(runtime).not.toMatch(/dayBefore\s*===\s*0\s*\?\s*6/);
    expect(read('utils/legacyOrderingScheduleMigration.js')).toMatch(/dayBefore\s*===\s*0\s*\?\s*6/);
  });

  it('DeliveryGroup requires explicit quarter-hour schedule fields', () => {
    const model = read('models/DeliveryGroup.js');
    expect(model).toContain('orderingSchedule');
    expect(model).toContain('enum: [0, 15, 30, 45]');
    expect(model).toMatch(/startDay:[\s\S]*required: true/);
    expect(model).toMatch(/endDay:[\s\S]*required: true/);
  });

  it('server startup fails fast before serving groups without schedules', () => {
    const index = read('index.js');
    expect(index).toContain('assertDeliveryGroupSchedulesReady');
    expect(index).toContain('delivery-group schedules OK');
  });

  it('group create/update keeps delivery day independent from close day and guards timing changes', () => {
    const route = read('routes/deliveryGroups.js');
    expect(route).toContain('validateOrderingScheduleDeliveryDay(orderingSchedule, dayOfWeek)');
    expect(route).not.toContain('normalizeOrderingScheduleForDeliveryDay');
    expect(route).toContain('requestedDayOfWeek');
    expect(route).toContain('scheduleIsChanging');
    expect(route).toContain('nextOpenDate');
    expect(route).toContain('pickingLifecycleActive');
  });

  it('picking schedule endpoint is group-scoped', () => {
    const route = read('routes/picking.js');
    expect(route).toMatch(/router\.get\('\/schedule'[\s\S]*req\.query\.groupId/);
    expect(route).toContain("res.json(group.orderingSchedule)");
  });

  it('global schedule mutation endpoint is disabled', () => {
    const admin = read('routes/admin.js');
    expect(admin).toContain('ordering_schedule_global_disabled');
    expect(admin).toContain('status(410)');
  });
  it('critical session consumers are group-scoped and live E2E never mutates the legacy global setting', () => {
    for (const rel of [
      'services/orderingOpenNotify.js',
      'services/migrateSellerShop.js',
      'services/archiveProduct.js',
      'services/sessionCoverage.js',
      'services/supplementTargets.js',
      'routes/orders.js',
      'routes/products.js',
      'routes/shops.js',
      'routes/users.js',
      'routes/picking.js',
      'routes/v1/telegram.js',
    ]) {
      expect(read(rel)).toContain('orderingSchedule');
    }
    for (const rel of ['scripts/liveOrderPickingE2E.js', 'scripts/liveOrderPickingMassE2E.js']) {
      const source = read(rel);
      expect(source).not.toContain("key: 'ordering.schedule'");
      expect(source).toContain('orderingSchedule');
    }
  });

  it('safe schedule edits protect session identity and only rewrite an empty pending target snapshot', () => {
    const route = read('routes/deliveryGroups.js');
    expect(route).toContain('Order.exists({ orderingSessionId: { $in: protectedSessionIds } })');
    expect(route).toContain('PickingTask.exists({ orderingSessionId: { $in: protectedSessionIds } })');
    expect(route).toContain("currentSession.pickingStatus !== 'pending'");
    expect(route).toContain('targetUsed');
    expect(route).toContain('openNotifiedAt');
    expect(route).toContain('getOrderingWindowBoundsForOpenDate');
    expect(route).toContain('scheduleSnapshot: requestedSchedule');
    expect(route).toContain('повторно відкрив би вже завершену поточну сесію');
  });

  it('empty clock-open groups may be rescheduled, but real session data still blocks edits', () => {
    const route = read('routes/deliveryGroups.js');
    expect(route).toContain('Clock-time alone must not freeze an empty TEST/configuration group');
    expect(route).not.toContain("const reason = isOpen ? 'вікно замовлень відкрите'");
    expect(route).toContain('sessionOrder || sessionTask || pickingLifecycleActive');
  });

  it('DeliveryGroup schema keeps delivery weekday and close weekday independent while validating cycle order', () => {
    const model = read('models/DeliveryGroup.js');
    expect(model).toContain("pre('validate'");
    expect(model).toContain('validateOrderingScheduleDeliveryDay');
    expect(model).not.toContain('this.orderingSchedule.endDay = Number(this.dayOfWeek)');
    expect(model).toContain('orderingSchedule');
    expect(model).toContain('dayOfWeek');
  });

  it('migration never rewrites a valid independent endDay just to match delivery day', () => {
    const migration = read('scripts/migrateDeliveryGroupSchedules.js');
    expect(migration).not.toContain('closeDayMismatch');
    expect(migration).not.toContain('endDay: Number(group.dayOfWeek)');
    expect(migration).toContain('delivery weekday and ordering close weekday');
  });

  it('group deletion cascades only empty materialised sessions and never orphans history', () => {
    const route = read('routes/deliveryGroups.js');
    const errors = read('utils/errors.js');
    expect(route).toContain("throw appError('group_has_history'");
    expect(route).toContain('CatalogReview.exists({ sessionId: { $in: sessionIds } })');
    expect(route).toContain('OrderingSession.deleteMany(');
    expect(route).toContain("row.pickingStatus !== 'pending'");
    expect(errors).toContain('group_has_history');
  });

});

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const app = read('app.js');
const userModel = read('models/User.js');
const telegram = read('routes/v1/telegram.js');
const picking = read('routes/picking.js');
const errors = read('utils/errors.js');

describe('legacy warehouse shift removal contract', () => {
  test('legacy /api/warehouse shift router is gone', () => {
    expect(fs.existsSync(path.join(__dirname, '..', 'routes', 'warehouse.js'))).toBe(false);
    expect(app).not.toContain("require('./routes/warehouse')");
    expect(app).not.toContain("app.use('/api/warehouse',");
  });

  test('legacy shift flags are gone from user/profile contract', () => {
    for (const token of ['isWarehouseManager', 'isOnShift', 'shiftZone']) {
      expect(userModel).not.toContain(token);
      expect(telegram).not.toContain(token);
    }
  });

  test('retired warehouse-shift error vocabulary is gone', () => {
    for (const token of [
      'warehouse_worker_id_required',
      'warehouse_worker_not_found',
      'warehouse_remove_failed',
      'warehouse_only_manager_confirm',
      'warehouse_workerids_required',
      'warehouse_workerids_invalid',
      'warehouse_no_matching_workers',
      'warehouse_no_blocks',
      'warehouse_insufficient_blocks',
      'warehouse_only_manager_close',
    ]) {
      expect(errors).not.toContain(token);
    }
  });

  test('current picking shift-board remains available', () => {
    expect(picking).toContain("router.get('/shift-board'");
  });
});

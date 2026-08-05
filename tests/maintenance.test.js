'use strict';

const {
  enterMaintenance,
  getMaintenanceState,
  maintenanceReadOnlyMiddleware,
} = require('../services/maintenanceState');

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

describe('maintenance read-only', () => {
  beforeAll(() => {
    enterMaintenance({
      key: 'test_index',
      title: 'Тестовий індекс не створився',
      whatBroke: 'Порушена тестова гарантія.',
      technicalDetails: 'E11000 duplicate key test_index',
      howToFix: ['Прибрати тестовий дубль.', 'Перезапустити сервер.'],
    });
  });

  it('показує точну причину та інструкцію', () => {
    const state = getMaintenanceState();
    expect(state.active).toBe(true);
    expect(state.mode).toBe('read_only');
    expect(state.issues[0].technicalDetails).toContain('E11000');
    expect(state.issues[0].howToFix).toHaveLength(2);
  });

  it('дозволяє GET', () => {
    const req = { method: 'GET', path: '/api/products' };
    const res = responseRecorder();
    let nextCalled = false;
    maintenanceReadOnlyMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(res.payload).toBe(null);
  });

  it('блокує бізнесовий POST з 503', () => {
    const req = { method: 'POST', path: '/api/receipts' };
    const res = responseRecorder();
    let nextCalled = false;
    maintenanceReadOnlyMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.payload.error).toBe('maintenance_read_only');
    expect(res.payload.maintenance.issues[0].technicalDetails).toContain('E11000');
  });

  it('дозволяє read-only bootstrap входу', () => {
    const req = { method: 'POST', path: '/api/v1/telegram/me' };
    const res = responseRecorder();
    let nextCalled = false;
    maintenanceReadOnlyMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
  });
});

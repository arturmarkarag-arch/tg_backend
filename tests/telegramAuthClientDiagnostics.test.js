'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'telegram-client-diagnostics-test-secret';

const express = require('express');
const request = require('supertest');
const { telegramAuthClientDiagnostic, sanitizeClientDiagnostic } = require('../middleware/telegramAuthDiagnostics');

function buildTestApp() {
  const app = express();
  app.post('/diagnostic', express.text({ type: 'text/plain', limit: '8kb' }), (req, res) => {
    let payload = {};
    try { payload = JSON.parse(String(req.body || '{}')); } catch { payload = {}; }
    telegramAuthClientDiagnostic(req, payload);
    res.status(204).end();
  });
  return app;
}

describe('Telegram client auth diagnostics', () => {
  it('keeps only the safe diagnostic allow-list', () => {
    const result = sanitizeClientDiagnostic({
      flowId: 'abc123',
      seq: 7,
      stage: 'bootstrap_identity_check',
      clientBuild: 'index-abc.js',
      identityMatch: false,
      errorCode: 'auth_identity_mismatch',
      initData: 'secret-init-data',
      cookie: 'secret-cookie',
      telegramId: '123456789',
      sessionSlot: 'secret-slot',
    });

    expect(result).toMatchObject({
      flowId: 'abc123',
      seq: 7,
      stage: 'bootstrap_identity_check',
      clientBuild: 'index-abc.js',
      identityMatch: false,
      errorCode: 'auth_identity_mismatch',
    });
    expect(result.initData).toBeUndefined();
    expect(result.cookie).toBeUndefined();
    expect(result.telegramId).toBeUndefined();
    expect(result.sessionSlot).toBeUndefined();
  });

  it('logs one sanitized CLIENT record and returns 204', async () => {
    const app = buildTestApp();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const response = await request(app)
        .post('/diagnostic')
        .set('Content-Type', 'text/plain;charset=UTF-8')
        .send(JSON.stringify({ stage: 'profile_request', flowId: 'flow-1', initData: 'do-not-log' }));

      expect(response.status).toBe(204);
      const line = spy.mock.calls.map((args) => String(args[0] || '')).find((value) => value.includes('"event":"CLIENT"'));
      expect(line).toContain('"stage":"profile_request"');
      expect(line).toContain('"flowId":"flow-1"');
      expect(line).not.toContain('do-not-log');
    } finally {
      spy.mockRestore();
    }
  });
});

'use strict';

const express = require('express');
const request = require('supertest');
const {
  telegramAuthRequestDiagnostics,
  telegramAuthErrorDiagnostics,
} = require('../middleware/telegramAuthDiagnostics');

function diagnosticApp({ fail = false } = {}) {
  const app = express();
  app.use(telegramAuthRequestDiagnostics);
  app.use(express.json());
  app.post('/api/v1/auth/telegram/bootstrap', (req, res, next) => {
    if (fail) return next(Object.assign(new Error('diagnostic failure'), { code: 'boom' }));
    return res.json({ ok: true });
  });
  app.post('/api/v1/telegram/me', (req, res) => res.json({ role: 'admin' }));
  app.use(telegramAuthErrorDiagnostics);
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

describe('Telegram auth diagnostics', () => {
  it('logs safe request metadata without Telegram credentials', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const secretInitData = 'query_id=secret&hash=super-secret';

    await request(diagnosticApp())
      .post('/api/v1/auth/telegram/bootstrap')
      .set('Origin', 'https://app.example.test')
      .set('CF-Ray', 'ray-123')
      .set('Cookie', 'tg_session=secret-cookie')
      .send({ initData: secretInitData, sessionSlot: 'secret-slot' })
      .expect(200);

    const output = log.mock.calls.flat().join('\n');
    log.mockRestore();

    expect(output).toContain('"event":"START"');
    expect(output).toContain('"event":"FINISH"');
    expect(output).toContain('"cfRay":"ray-123"');
    expect(output).toContain('"hasInitData":true');
    expect(output).toContain(`"initDataLength":${secretInitData.length}`);
    expect(output).not.toContain(secretInitData);
    expect(output).not.toContain('secret-cookie');
    expect(output).not.toContain('secret-slot');
  });

  it('logs the error and final status for a failed bootstrap', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await request(diagnosticApp({ fail: true }))
      .post('/api/v1/auth/telegram/bootstrap')
      .send({ initData: 'x' })
      .expect(500);

    const errors = error.mock.calls.flat().join('\n');
    const logs = log.mock.calls.flat().join('\n');
    log.mockRestore();
    error.mockRestore();

    expect(errors).toContain('"event":"ERROR"');
    expect(errors).toContain('"errorCode":"boom"');
    expect(errors).toContain('diagnostic failure');
    expect(logs).toContain('"event":"FINISH"');
    expect(logs).toContain('"status":500');
  });

  it('shows whether the profile request returned the selected Telegram cookie', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const slot = 'abcdefghijklmnopqrstuvwx';
    const cookieName = process.env.NODE_ENV === 'production'
      ? `__Host-zlotoweczka_telegram_${slot}`
      : `zlotoweczka_telegram_${slot}`;

    await request(diagnosticApp())
      .post('/api/v1/telegram/me')
      .set('x-auth-context', 'telegram')
      .set('x-telegram-client-id', '123456')
      .set('x-telegram-session-slot', slot)
      .set('Cookie', `${cookieName}=signed-session-value`)
      .expect(200);

    const output = log.mock.calls.flat().join('\n');
    log.mockRestore();

    expect(output).toContain('"path":"/api/v1/telegram/me"');
    expect(output).toContain('"hasTelegramContext":true');
    expect(output).toContain('"hasTelegramClientId":true');
    expect(output).toContain('"hasSessionSlotHeader":true');
    expect(output).toContain('"hasSelectedTelegramSessionCookie":true');
    expect(output).not.toContain('123456');
    expect(output).not.toContain(slot);
    expect(output).not.toContain('signed-session-value');
  });

  it('stays silent for unrelated endpoints', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = express();
    app.use(telegramAuthRequestDiagnostics);
    app.get('/api/health', (req, res) => res.json({ ok: true }));

    await request(app).get('/api/health').expect(200);

    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

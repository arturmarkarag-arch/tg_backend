const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Telegram account switch bootstrap contract', () => {
  it('validates current initData before reusing an existing Telegram cookie', () => {
    const route = read('routes/v1/auth.js');
    const initPos = route.indexOf("const initData = String(req.body?.initData || '')");
    const existingPos = route.indexOf('const existing = verifyTelegramSession(readTelegramSessionCookie(req))');
    const bootstrapPos = route.indexOf('existingTelegramId: existing?.telegramId');
    expect(initPos).toBeGreaterThan(-1);
    expect(existingPos).toBeGreaterThan(initPos);
    expect(bootstrapPos).toBeGreaterThan(existingPos);
    expect(route).not.toContain('if (existing) return res.json({ ok: true, telegramId: existing.telegramId });');
  });

  it('reuses a cookie only for the same signed Telegram identity', () => {
    const service = read('services/telegramSession.js');
    expect(service).toContain("String(existingTelegramId) === String(telegramId)");
    expect(service).toContain('reusedExistingSession: true');
    expect(service).toContain('sessionToken: null');
  });

  it('replaces the cookie when a different account presents fresh valid initData', () => {
    const route = read('routes/v1/auth.js');
    expect(route).toContain('if (result.sessionToken) setTelegramSessionCookie(res, result.sessionToken);');
  });
});

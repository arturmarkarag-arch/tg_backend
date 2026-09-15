const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Telegram account switch bootstrap contract', () => {
  it('validates current initData before reusing an existing Telegram cookie', () => {
    const route = read('routes/v1/auth.js');
    expect(route).toMatch(/const initData = String\(req\.body\?\.initData \|\| ''\)[\s\S]*const existing = verifyTelegramSession\(readTelegramSessionCookie\(req, sessionSlot\)\)[\s\S]*existingTelegramId: existing\?\.telegramId/);
    expect(route).not.toContain('if (existing) return res.json({ ok: true, telegramId: existing.telegramId });');
  });

  it('reuses a cookie only for the same signed Telegram identity', () => {
    const service = read('services/telegramSession.js');
    expect(service).toContain("String(existingTelegramId) === String(telegramId)");
    expect(service).toContain('reusedExistingSession: true');
    expect(service).toContain('sessionToken: null');
  });

  it('namespaces Telegram cookies by the WebView session slot', () => {
    const route = read('routes/v1/auth.js');
    expect(route).toContain('setTelegramSessionCookie(res, result.sessionToken, sessionSlot)');
    expect(route).toContain('normalizeTelegramSessionSlot(rawSessionSlot)');
  });
});

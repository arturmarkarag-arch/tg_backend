const fs = require('fs');
const path = require('path');

function src(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('Telegram multi-account session recovery contract', () => {
  test('HTTP auth selects a per-WebView Telegram cookie and fails closed on identity mismatch', () => {
    const auth = src('middleware/telegramAuth.js');
    const identity = src('middleware/telegramIdentity.js');
    const proof = src('middleware/sessionProof.js');
    expect(auth).toContain('readTelegramSessionSlot(req)');
    expect(auth).toContain('sessionProof = readContextSessionProof(req)');
    expect(proof).toContain('readTelegramSessionCookie(req, slot)');
    expect(auth).toContain("appError('auth_telegram_session_mismatch'");
    expect(identity).toContain('readTelegramSessionSlot(req)');
    expect(identity).toContain("appError('auth_telegram_session_mismatch'");
  });

  test('Telegram session cookies are namespaced by the non-secret WebView slot', () => {
    const cookies = src('utils/sessionCookie.js');
    expect(cookies).toContain('TELEGRAM_SESSION_COOKIE_PREFIX');
    expect(cookies).toContain('telegramSessionCookieName(sessionSlot');
    expect(cookies).toContain('readTelegramSessionCookie(req, sessionSlot');
    expect(cookies).toContain('setTelegramSessionCookie(res, token, sessionSlot');
  });

  test('a consumed initData proof can resume only inside its bound WebView slot', () => {
    const service = src('services/telegramSession.js');
    const model = src('models/TelegramInitDataUse.js');
    expect(service).toContain('digestSessionSlot(sessionSlot)');
    expect(service).toContain('previous?.sessionSlotHash === sessionSlotHash');
    expect(service).toContain('resumedSameWebView: true');
    expect(service).toContain("error: 'initData already used'");
    expect(model).toContain('sessionSlotHash');
  });

  test('Socket.IO selects the same per-WebView Telegram cookie and rejects cross-account mismatch', () => {
    const socket = src('socket.js');
    expect(socket).toContain('readSocketTelegramSessionSlot(socket)');
    expect(socket).toContain("code: 'auth_telegram_session_mismatch'");
  });
});

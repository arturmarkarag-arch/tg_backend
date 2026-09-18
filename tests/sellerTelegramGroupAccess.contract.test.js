'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('seller Telegram membership is an application access invariant', () => {
  it('stores a seller-only access projection on User', () => {
    const user = read('models/User.js');
    expect(user).toContain('telegramGroupAccessState');
    expect(user).toContain("enum: ['unverified', 'allowed', 'denied']");
    expect(user).toContain('telegramGroupAccessCheckedAt');
    expect(user).toContain('telegramGroupAccessGroupId');
  });

  it('enforces the projection in normal HTTP auth and Socket.IO auth', () => {
    const httpAuth = read('middleware/telegramAuth.js');
    const socket = read('socket.js');
    expect(httpAuth).toContain("resolveSellerTelegramGroupAccess(user, { source: 'http_auth' })");
    expect(httpAuth).toContain("appError('auth_telegram_group_required')");
    expect(socket).toContain("resolveSellerTelegramGroupAccess(dbUser, { source: 'socket_auth' })");
    expect(socket).toContain("'auth_telegram_group_required'");
  });

  it('also gates auth bootstrap paths that intentionally bypass full telegramAuth', () => {
    const browserAuth = read('routes/v1/auth.js');
    const telegram = read('routes/v1/telegram.js');
    expect(browserAuth).toContain("requireSellerTelegramGroupAccess(user, 'google_login')");
    expect(browserAuth).toContain("requireSellerTelegramGroupAccess(user, 'browser_me')");
    expect(telegram).toContain("requireSellerTelegramGroupAccess(user, 'telegram_me')");
  });

  it('projects deterministic Telegram membership events without per-request Telegram calls', () => {
    const sync = read('services/groupMemberSync.js');
    const access = read('services/sellerTelegramGroupAccess.js');
    expect(sync).toContain("projectSellerAccessFromPersisted(telegramId, { source: 'chat_member' })");
    expect(access).toContain('if (currentState === ACCESS_ALLOWED)');
    expect(access).toContain('if (currentState === ACCESS_DENIED)');
    expect(access).toContain('checkMembershipAcrossGroups({ bot, telegramId, groupIds })');
  });

  it('never converts audit/API uncertainty into a seller revocation', () => {
    const audit = read('services/groupMemberAudit.js');
    expect(audit).toContain('if (result.known && options.syncSellerAccess !== false)');
    expect(audit).toContain('Critical fail-open rule: unknown must not mutate `left`');
  });

  it('invalidates seller projections when the configured work-group allow-list changes', () => {
    const admin = read('routes/admin.js');
    const access = read('services/sellerTelegramGroupAccess.js');
    expect(admin.match(/reconcileSellerAccessAfterGroupConfigChange\(updated\)/g)?.length).toBe(2);
    expect(access).toContain("telegramGroupAccessState: ACCESS_UNVERIFIED");
    expect(access).toContain("event: 'telegram_group_access_recheck_required'");
  });

  it('newly registered sellers start from the live membership proof, not unverified', () => {
    const registration = read('routes/v1/telegram.js');
    const createUser = read('services/createUserFromRequest.js');
    expect(registration).toContain("state: 'allowed'");
    expect(registration).toContain("source: 'registration'");
    expect(createUser).toContain('sellerGroupAccess?.state === \'allowed\'');
  });
});

'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('registration moderation reason contract', () => {
  it('persists an administrator reason and requires it for reject/block', () => {
    const model = read('models/RegistrationRequest.js');
    const routes = read('routes/v1/telegram.js');

    expect(model).toContain('moderationReason');
    expect(model).toContain("role: { type: String, enum: ['seller', 'warehouse'], required: true }");
    expect(model).not.toContain("role: { type: String, enum: ['seller', 'warehouse'], default: 'seller' }");
    expect(routes).toContain("throw appError('registration_reason_required')");
    expect(routes).toContain("status: 'rejected', moderationReason");
    expect(routes).toContain("status: 'blocked', moderationReason");
    expect(routes).toContain("status: 'pending', moderationReason: ''");
  });

  it('exposes the stored reason on both Telegram and browser auth paths', () => {
    const telegram = read('routes/v1/telegram.js');
    const browser = read('routes/v1/auth.js');
    const errors = read('utils/errors.js');

    expect(telegram).toContain("registration_blocked', { reason: request.moderationReason || '' }");
    expect(telegram).toContain("registration_rejected', { reason: request.moderationReason || '' }");
    expect(browser).toContain("registration_blocked', { telegramId, reason: request.moderationReason || '' }");
    expect(browser).toContain("registration_rejected', { telegramId, reason: request.moderationReason || '' }");
    expect(errors).toContain('Причина: ${reason}');
  });
});

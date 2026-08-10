const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

const botSource = fs.readFileSync(path.join(__dirname, 'telegramBot.js'), 'utf8');
const adminSource = fs.readFileSync(path.join(__dirname, 'routes/admin.js'), 'utf8');
const telegramRoute = fs.readFileSync(path.join(__dirname, 'routes/v1/telegram.js'), 'utf8');

 describe('telegram support admins registration gate contract', () => {
  it('stores admin contacts in AppSetting and exposes admin-only management routes', () => {
    expect(adminSource).toContain("/telegram-support-admins");
    expect(adminSource).toContain("requireTelegramRole('admin')");
    expect(adminSource).toContain('saveSupportAdmins');
  });

  it('shows configured admin chat links when /start user is outside Оголошення', () => {
    expect(botSource).toContain('sendNotInAnnouncementsGroupMessage');
    expect(botSource).toContain('Адміністратори для зв’язку');
    expect(botSource).toContain('Написати: ${admin.name}');
    expect(botSource).toContain('url: admin.url');
  });

  it('members get a single Open button into registration', () => {
    expect(botSource).toContain('A token proves who the registration link belongs to, NOT current');
    expect(botSource).toContain('✅ Вас знайдено в групі «Оголошення»');
    expect(botSource).toContain("text: 'Відкрити'");
    expect(botSource).toContain("web_app: { url: regUrl }");
  });

  it('registration-invite returns configured support admins for not_in_group', () => {
    expect(telegramRoute).toContain("reason: 'not_in_group', supportAdmins");
    expect(telegramRoute).toContain("appError('registration_not_in_group', { supportAdmins })");
  });
});

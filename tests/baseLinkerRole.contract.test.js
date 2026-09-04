const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('dedicated BaseLinker role boundary', () => {
  it('adds baselinker to User but not to self-registration roles', () => {
    const user = read('models/User.js');
    const registration = read('models/RegistrationRequest.js');
    const telegram = read('routes/v1/telegram.js');
    expect(user).toContain("'seller', 'warehouse', 'baselinker', 'admin'");
    expect(registration).not.toContain("'baselinker'");
    expect(telegram).toContain("if (!['seller', 'warehouse'].includes(role))");
  });

  it('lets only the admin-owned users router assign the role', () => {
    const users = read('routes/users.js');
    expect(users).toContain("router.use(requireTelegramRole('admin'))");
    expect(users).not.toContain('baseLinkerPicking');
  });


  it('gives the dedicated role its own Telegram entry point instead of seller/admin fallbacks', () => {
    const bot = read('telegramBot.js');
    expect(bot).toContain("baselinker: 'BaseLinker'");
    expect(bot).toContain("'/miniapp - Відкрити BaseLinker'");
    expect(bot).toContain("description: 'Відкрити BaseLinker'");
    expect(bot).toContain("user.role === 'baselinker'");
  });

  it('hard-isolates authenticated baselinker users to the BaseLinker API namespace', () => {
    const app = read('app.js');
    expect(app).toContain("req.telegramUser?.role !== 'baselinker'");
    expect(app).toContain("/^\\/api\\/baselinker");
    expect(app).toContain("allowed: ['admin', 'baselinker']");
  });
});

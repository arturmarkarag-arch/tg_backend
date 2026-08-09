const fs = require('fs');
const path = require('path');

describe('registration help copy', () => {
  test('bot and API tell non-members exactly what to do', () => {
    const bot = fs.readFileSync(path.join(__dirname, '..', 'telegramBot.js'), 'utf8');
    const errors = fs.readFileSync(path.join(__dirname, '..', 'utils', 'errors.js'), 'utf8');
    expect(bot).toContain('робочій групі «Оголошення»');
    expect(bot).toContain('менеджера або адміністратора');
    expect(bot).toContain('/start ще раз');
    expect(errors).toContain('попросіть додати вас до групи «Оголошення»');
  });
});

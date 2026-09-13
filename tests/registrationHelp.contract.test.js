const fs = require('fs');
const path = require('path');

describe('registration help copy', () => {
  test('bot and API give one plain action without technical registration terms', () => {
    const bot = fs.readFileSync(path.join(__dirname, '..', 'telegramBot.js'), 'utf8');
    const errors = fs.readFileSync(path.join(__dirname, '..', 'utils', 'errors.js'), 'utf8');
    expect(bot).toContain('Вас ще немає в групі «Оголошення»');
    expect(bot).toContain('менеджера або адміністратора');
    expect(bot).toContain('/start ще раз');
    expect(errors).toContain('Попросіть менеджера або адміністратора додати вас до групи');
    expect(errors).toContain('Не вдалося перевірити, чи ви є в групі «Оголошення»');
  });
});

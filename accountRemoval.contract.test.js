const fs = require('fs');
const path = require('path');
const { describe, it, expect } = require('vitest');

const userModel = fs.readFileSync(path.join(__dirname, 'models/User.js'), 'utf8');
const removeService = fs.readFileSync(path.join(__dirname, 'services/softRemoveUser.js'), 'utf8');
const createService = fs.readFileSync(path.join(__dirname, 'services/createUserFromRequest.js'), 'utf8');
const auth = fs.readFileSync(path.join(__dirname, 'middleware/telegramAuth.js'), 'utf8');
const telegramRoute = fs.readFileSync(path.join(__dirname, 'routes/v1/telegram.js'), 'utf8');
const ordersRoute = fs.readFileSync(path.join(__dirname, 'routes/orders.js'), 'utf8');
const bot = fs.readFileSync(path.join(__dirname, 'telegramBot.js'), 'utf8');

 describe('soft account removal + re-registration contract', () => {
  it('preserves User rows but marks access removed', () => {
    expect(userModel).toContain("enum: ['active', 'removed']");
    expect(removeService).toContain("accountState: 'removed'");
    expect(removeService).not.toContain('User.deleteOne');
    expect(removeService).not.toContain('User.findOneAndDelete');
  });

  it('revokes runtime access and hides group rows', () => {
    expect(removeService).toContain('sessionsValidFrom: now');
    expect(removeService).toContain('GroupMember.updateMany');
    expect(removeService).toContain('hiddenAt: now');
    expect(auth).toContain('isRemovedUser(user)');
  });

  it('allows normal registration to reactivate the same telegramId', () => {
    expect(telegramRoute).toContain('existingUser && !isRemovedUser(existingUser)');
    expect(createService).toContain("existing.accountState = 'active'");
    expect(createService).toContain("action: 'account_reregistered'");
    expect(createService).toContain('hiddenAt: null');
  });

  it('reattaches parked seller work through canonical migration', () => {
    expect(createService).toContain('migrateSellerShop({');
    expect(createService).toContain("reason: 'account_reregistered'");
  });

  it('blocks the custom order POST and old bot admin buttons after removal', () => {
    expect(ordersRoute).toContain('!buyer || isRemovedUser(buyer)');
    expect(bot).toContain("if (!user || user.role !== 'admin')");
    expect(bot).toContain("text: 'Доступ закрито'");
  });
});

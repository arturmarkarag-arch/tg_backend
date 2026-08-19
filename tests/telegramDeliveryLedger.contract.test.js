'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('durable Telegram delivery ledger contract', () => {
  it('never treats OrderingSession.openNotifiedAt as per-recipient delivery truth', () => {
    const source = read('services/orderingOpenNotify.js');
    expect(source).toContain('ensureNotificationEvent');
    expect(source).not.toContain('deliveredAny');
    expect(source).not.toContain('claimSession(');
  });

  it('has a DB uniqueness backstop for one event-recipient delivery', () => {
    const source = read('models/TelegramNotificationDelivery.js');
    expect(source).toContain('{ eventKey: 1, channel: 1, recipientId: 1 }');
    expect(source).toContain('{ unique: true }');
  });

  it('persists Telegram acknowledgement and retry/error state', () => {
    const source = read('services/telegramDeliveryLedger.js');
    expect(source).toContain('telegramMessageId');
    expect(source).toContain('message?.message_id');
    expect(source).toContain("status: 'retry_wait'");
    expect(source).toContain('possibleDuplicate');
  });
});

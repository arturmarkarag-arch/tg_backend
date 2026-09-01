'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { classifyTelegramSendError } = require('../utils/telegramDeliveryPolicy');

function telegramError(statusCode, description, parameters = {}) {
  const error = new Error(description);
  error.response = { body: { error_code: statusCode, description, parameters } };
  return error;
}

describe('Telegram new-product semantic lifecycle', () => {
  it('recognizes all supported missing-message spellings', () => {
    expect(classifyTelegramSendError(
      telegramError(400, 'Bad Request: message to edit not found'),
    ).kind).toBe('message_not_found');
    expect(classifyTelegramSendError(
      telegramError(400, 'Bad Request: MESSAGE_ID_INVALID'),
    ).kind).toBe('message_not_found');
  });

  it('recognizes id migration and rate limits as structured signals', () => {
    const migrated = classifyTelegramSendError(telegramError(
      400,
      'Bad Request: group chat was upgraded to a supergroup chat',
      { migrate_to_chat_id: -1001234567890 },
    ));
    expect(migrated.migrateToChatId).toBe('-1001234567890');

    const limited = classifyTelegramSendError(telegramError(429, 'Too Many Requests', { retry_after: 17 }));
    expect(limited.kind).toBe('rate_limited');
    expect(limited.retryAfterSeconds).toBe(17);
  });

  it('does not classify a missing bot instance as an ambiguous create', () => {
    const error = new Error('telegram bot is not initialized');
    error.code = 'EBOTUNAVAILABLE';
    const classification = classifyTelegramSendError(error);
    expect(classification.kind).toBe('bot_unavailable');
    expect(classification.retryable).toBe(true);
    expect(classification.ambiguous).toBe(false);
  });

  it('passes the dedicated architecture/source gate', () => {
    const script = path.join(__dirname, '..', 'scripts', 'checkTelegramNewProductsArchitecture20260901.js');
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).not.toThrow();
  });
});

const crypto = require('crypto');

// Telegram Login Widget uses a DIFFERENT signature scheme than Mini App
// initData. Here the secret key is the RAW SHA-256 digest of the bot token
// (not HMAC-SHA256("WebAppData", token)), and the data-check-string is the
// sorted "key=value" pairs joined by "\n".
// https://core.telegram.org/widgets/login#checking-authorization
function verifyTelegramWidget(data, botToken, { maxAgeSeconds = 86400, maxFutureSkewSeconds = 60 } = {}) {
  if (!data || typeof data !== 'object' || !botToken) {
    return { valid: false, error: 'Missing data or bot token' };
  }

  const providedHash = data.hash;
  if (!providedHash || typeof providedHash !== 'string') {
    return { valid: false, error: 'Missing hash' };
  }

  const authDate = Number.parseInt(data.auth_date, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { valid: false, error: 'Invalid auth_date' };
  }
  if (authDate > nowSeconds + maxFutureSkewSeconds) {
    return { valid: false, error: 'Widget auth_date is in the future' };
  }
  if ((nowSeconds - authDate) > maxAgeSeconds) {
    return { valid: false, error: 'Widget auth expired' };
  }

  const dataCheckString = Object.keys(data)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!/^[0-9a-f]{64}$/i.test(providedHash)) {
    return { valid: false, error: 'Hash mismatch' };
  }
  const expectedBuffer = Buffer.from(hmac, 'hex');
  const providedBuffer = Buffer.from(providedHash, 'hex');
  if (expectedBuffer.length !== 32 || providedBuffer.length !== 32) {
    return { valid: false, error: 'Hash mismatch' };
  }
  const ok = crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  return {
    valid: ok,
    error: ok ? null : 'Hash mismatch',
    telegramId: ok ? String(data.id || '') : '',
  };
}

module.exports = { verifyTelegramWidget };

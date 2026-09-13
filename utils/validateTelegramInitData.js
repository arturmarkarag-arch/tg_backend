const crypto = require('crypto');

function parseTelegramInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const parsedData = {};
  const rawData = {};

  for (const [key, value] of params.entries()) {
    rawData[key] = value;
    try {
      parsedData[key] = JSON.parse(value);
    } catch {
      parsedData[key] = value;
    }
  }

  return { parsedData, rawData };
}

function getTelegramId(parsedData) {
  if (!parsedData) return '';
  return String(parsedData.user?.id || '');
}

function buildDataCheckString(rawData) {
  return Object.keys(rawData)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${rawData[key]}`)
    .join('\n');
}

function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) {
    return { valid: false, error: 'Missing initData or bot token', parsedData: null, rawData: null };
  }

  const { parsedData, rawData } = parseTelegramInitData(initData);
  const providedHash = rawData.hash;
  if (!providedHash) {
    return { valid: false, parsedData, rawData, error: 'Missing hash value' };
  }

  const MAX_AGE_SECONDS = 24 * 60 * 60;
  const MAX_FUTURE_SKEW_SECONDS = 60;
  const authDate = Number.parseInt(rawData.auth_date, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) {
    return { valid: false, error: 'Invalid auth_date', parsedData, rawData };
  }
  if (authDate > nowSeconds + MAX_FUTURE_SKEW_SECONDS) {
    return { valid: false, error: 'initData auth_date is in the future', parsedData, rawData };
  }
  if ((nowSeconds - authDate) > MAX_AGE_SECONDS) {
    return { valid: false, error: 'initData expired', parsedData, rawData };
  }

  // Telegram вимагає HMAC-SHA256("WebAppData", botToken) як ключ
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = buildDataCheckString(rawData);
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Strict hex validation happens BEFORE Buffer conversion. A 64-character
  // non-hex string used to pass the string-length check and then make
  // timingSafeEqual throw RangeError because Buffer.from(..., 'hex') decoded
  // to a shorter buffer. Invalid anonymous input must be a clean 401, not 500.
  if (!/^[0-9a-f]{64}$/i.test(providedHash)) {
    return { valid: false, parsedData, rawData, error: 'Hash mismatch' };
  }
  const expectedBuffer = Buffer.from(hmac, 'hex');
  const providedBuffer = Buffer.from(providedHash, 'hex');
  if (expectedBuffer.length !== 32 || providedBuffer.length !== 32) {
    return { valid: false, parsedData, rawData, error: 'Hash mismatch' };
  }
  const ok = crypto.timingSafeEqual(expectedBuffer, providedBuffer);

  return {
    valid: ok,
    parsedData,
    rawData,
    error: ok ? null : 'Hash mismatch',
  };
}

module.exports = {
  validateTelegramInitData,
  parseTelegramInitData,
  getTelegramId,
};
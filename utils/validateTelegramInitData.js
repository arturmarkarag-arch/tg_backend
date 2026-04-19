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

  // ВИПРАВЛЕНО: Telegram вимагає HMAC-SHA256("WebAppData", botToken) як ключ
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = buildDataCheckString(rawData);
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return {
    valid: hmac === providedHash,
    parsedData,
    rawData,
    error: hmac === providedHash ? null : 'Hash mismatch',
  };
}

module.exports = {
  validateTelegramInitData,
  parseTelegramInitData,
};
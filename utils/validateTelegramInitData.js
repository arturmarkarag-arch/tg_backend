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

function getInitDataFromRequest(req) {
  if (!req) return null;
  // initData приймається ТІЛЬКИ з заголовків — не з query/body,
  // щоб уникнути витоку в nginx/Vercel access logs та браузерну історію
  return req.headers?.['x-telegram-initdata'] || req.headers?.['x-telegram-init-data'] || null;
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

  const MAX_AGE_SECONDS = 24 * 60 * 60; // Telegram офіційна рекомендація
  const authDate = parseInt(rawData.auth_date, 10);
  if (!authDate || (Date.now() / 1000 - authDate) > MAX_AGE_SECONDS) {
    return { valid: false, error: 'initData expired', parsedData, rawData };
  }

  // Telegram вимагає HMAC-SHA256("WebAppData", botToken) як ключ
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const dataCheckString = buildDataCheckString(rawData);
  const hmac = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timingSafeEqual кидає RangeError якщо буфери різної довжини
  if (providedHash.length !== hmac.length) {
    return { valid: false, parsedData, rawData, error: 'Hash mismatch' };
  }
  const ok = crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(providedHash, 'hex'));

  return {
    valid: ok,
    parsedData,
    rawData,
    error: ok ? null : 'Hash mismatch',
  };
}

function getTelegramAuth(req, botToken) {
  const initData = getInitDataFromRequest(req);
  const validation = validateTelegramInitData(initData, botToken);
  return {
    ...validation,
    initData,
    telegramId: getTelegramId(validation.parsedData),
  };
}

module.exports = {
  validateTelegramInitData,
  parseTelegramInitData,
  getInitDataFromRequest,
  getTelegramId,
  getTelegramAuth,
};
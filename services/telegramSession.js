'use strict';
const crypto = require('crypto');
const TelegramInitDataUse = require('../models/TelegramInitDataUse');
const { validateTelegramInitData, getTelegramId } = require('../utils/validateTelegramInitData');
const { signTelegramSession } = require('../utils/jwt');

const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function digestInitData(initData) {
  return crypto.createHash('sha256').update(String(initData || ''), 'utf8').digest('hex');
}

async function bootstrapTelegramSession(initData, botToken) {
  const validation = validateTelegramInitData(initData, botToken);
  if (!validation.valid) return { ...validation, replayed: false };

  const telegramId = getTelegramId(validation.parsedData);
  if (!telegramId) {
    return { ...validation, valid: false, error: 'Missing Telegram user id', replayed: false };
  }

  const authDate = Number.parseInt(validation.rawData?.auth_date, 10);
  const expiresAt = new Date((authDate + INIT_DATA_MAX_AGE_SECONDS) * 1000);
  const digest = digestInitData(initData);

  try {
    await TelegramInitDataUse.create({ digest, telegramId, expiresAt });
  } catch (err) {
    if (err?.code === 11000) {
      return { ...validation, valid: false, error: 'initData already used', replayed: true, telegramId };
    }
    throw err;
  }

  return {
    ...validation,
    telegramId,
    replayed: false,
    sessionToken: signTelegramSession(telegramId),
  };
}

module.exports = {
  bootstrapTelegramSession,
  digestInitData,
  INIT_DATA_MAX_AGE_SECONDS,
};

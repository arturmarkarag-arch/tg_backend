'use strict';
const crypto = require('crypto');
const TelegramInitDataUse = require('../models/TelegramInitDataUse');
const { validateTelegramInitData, getTelegramId } = require('../utils/validateTelegramInitData');
const { signTelegramSession } = require('../utils/jwt');
const { normalizeTelegramSessionSlot } = require('../utils/telegramRequestIdentity');

const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

function digestInitData(initData) {
  return crypto.createHash('sha256').update(String(initData || ''), 'utf8').digest('hex');
}

function digestSessionSlot(sessionSlot) {
  const normalized = normalizeTelegramSessionSlot(sessionSlot);
  return normalized
    ? crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
    : '';
}

async function bootstrapTelegramSession(initData, botToken, {
  existingTelegramId = '',
  sessionSlot = '',
} = {}) {
  const validation = validateTelegramInitData(initData, botToken);
  if (!validation.valid) return { ...validation, replayed: false };

  const telegramId = getTelegramId(validation.parsedData);
  if (!telegramId) {
    return { ...validation, valid: false, error: 'Missing Telegram user id', replayed: false };
  }

  // A session cookie is reusable only when the CURRENT signed initData proves
  // the same Telegram identity. With per-WebView cookie slots this is normally
  // the fast path on reload/resume and does not touch the replay ledger.
  if (existingTelegramId && String(existingTelegramId) === String(telegramId)) {
    return {
      ...validation,
      telegramId,
      replayed: false,
      reusedExistingSession: true,
      sessionToken: null,
    };
  }

  const authDate = Number.parseInt(validation.rawData?.auth_date, 10);
  const expiresAt = new Date((authDate + INIT_DATA_MAX_AGE_SECONDS) * 1000);
  const digest = digestInitData(initData);
  const sessionSlotHash = digestSessionSlot(sessionSlot);

  try {
    await TelegramInitDataUse.create({
      digest,
      telegramId,
      expiresAt,
      ...(sessionSlotHash ? { sessionSlotHash } : {}),
    });
  } catch (err) {
    if (err?.code !== 11000) throw err;

    // Updated clients bind a consumed initData proof to one per-WebView slot.
    // This lets the SAME minimized WebView rebuild its HttpOnly session after a
    // cookie loss/account switch without making the signed initData replayable
    // from a different WebView. Legacy ledger rows are claimed atomically by the
    // first upgraded WebView that presents the same still-valid signed proof.
    if (sessionSlotHash) {
      let previous = await TelegramInitDataUse.findOne({ digest })
        .select('telegramId sessionSlotHash')
        .lean();

      if (previous && String(previous.telegramId) === String(telegramId)) {
        if (!previous.sessionSlotHash) {
          previous = await TelegramInitDataUse.findOneAndUpdate(
            {
              digest,
              telegramId,
              $or: [
                { sessionSlotHash: { $exists: false } },
                { sessionSlotHash: '' },
              ],
            },
            { $set: { sessionSlotHash } },
            { new: true },
          ).select('telegramId sessionSlotHash').lean();
        }

        if (previous?.sessionSlotHash === sessionSlotHash) {
          return {
            ...validation,
            telegramId,
            replayed: false,
            resumedSameWebView: true,
            sessionToken: signTelegramSession(telegramId),
          };
        }
      }
    }

    return { ...validation, valid: false, error: 'initData already used', replayed: true, telegramId };
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
  digestSessionSlot,
  INIT_DATA_MAX_AGE_SECONDS,
};

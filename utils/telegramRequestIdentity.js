'use strict';

const TELEGRAM_CLIENT_ID_HEADER = 'x-telegram-client-id';
const TELEGRAM_SESSION_SLOT_HEADER = 'x-telegram-session-slot';
const SESSION_SLOT_RE = /^[A-Za-z0-9_-]{20,80}$/;

function normalizeTelegramClientId(value) {
  const id = String(value || '').trim();
  return /^\d{1,32}$/.test(id) ? id : '';
}

function normalizeTelegramSessionSlot(value) {
  const slot = String(value || '').trim();
  return SESSION_SLOT_RE.test(slot) ? slot : '';
}

function readTelegramClientId(req) {
  return normalizeTelegramClientId(req?.get?.(TELEGRAM_CLIENT_ID_HEADER));
}

function readTelegramSessionSlot(req) {
  return normalizeTelegramSessionSlot(req?.get?.(TELEGRAM_SESSION_SLOT_HEADER));
}

function readSocketTelegramClientId(socket) {
  return normalizeTelegramClientId(socket?.handshake?.auth?.telegramId);
}

function readSocketTelegramSessionSlot(socket) {
  return normalizeTelegramSessionSlot(socket?.handshake?.auth?.sessionSlot);
}

module.exports = {
  TELEGRAM_CLIENT_ID_HEADER,
  TELEGRAM_SESSION_SLOT_HEADER,
  normalizeTelegramClientId,
  normalizeTelegramSessionSlot,
  readTelegramClientId,
  readTelegramSessionSlot,
  readSocketTelegramClientId,
  readSocketTelegramSessionSlot,
};

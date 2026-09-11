'use strict';

function roomUser(telegramId) {
  const id = String(telegramId || '').trim();
  return id ? `user_${id}` : '';
}

function emitStaff(io, event, payload) {
  if (!io || !event) return;
  io.to('staff').emit(event, payload);
}

function emitUserAndStaff(io, telegramId, event, payload) {
  if (!io || !event) return;
  emitStaff(io, event, payload);
  const room = roomUser(telegramId);
  if (room) io.to(room).emit(event, payload);
}

module.exports = {
  roomUser,
  emitStaff,
  emitUserAndStaff,
};

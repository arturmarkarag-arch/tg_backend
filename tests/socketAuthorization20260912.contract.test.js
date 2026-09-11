'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('Socket authorization 2026-09-12', () => {
  it('applies browser JWT revocation to Socket.IO too', () => {
    const source = read('socket.js');
    expect(source).toContain("verifySession, isSessionNotRevoked");
    expect(source).toContain('!isSessionNotRevoked(jwtIat, dbUser)');
  });

  it('does not expose locks or warehouse topology outside staff', () => {
    const source = read('socket.js');
    expect(source).toContain("socket.emit('locks_error', { error: 'forbidden' })");
    expect(source).toContain("socket.to('staff').emit('item_locked'");
    expect(source).toContain("io.to('staff').emit('block_updated'");
    expect(source).not.toMatch(/socket\.broadcast\.emit\(['"]item_locked['"]/);
  });

  it('uses authenticated per-user rooms for identity-bearing seller events', () => {
    const socket = read('socket.js');
    const scope = read('utils/socketScope.js');
    expect(socket).toContain('socket.join(`user_${socket.telegramId}`)');
    expect(socket).toContain("socket.join('app_users')");
    expect(scope).toContain('io.to(room).emit(event, payload)');
  });
});

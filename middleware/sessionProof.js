'use strict';

const { verifySession, verifyTelegramSession } = require('../utils/jwt');
const { readSessionCookie, readTelegramSessionCookie } = require('../utils/sessionCookie');
const { readTelegramSessionSlot } = require('../utils/telegramRequestIdentity');

const CACHE = Symbol('firstPartySessionProof');

function cacheFor(req) {
  if (!req[CACHE]) {
    Object.defineProperty(req, CACHE, {
      value: { browserResolved: false, browser: null, telegram: new Map() },
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return req[CACHE];
}

function readBrowserSessionProof(req) {
  const cache = cacheFor(req);
  if (!cache.browserResolved) {
    cache.browser = verifySession(readSessionCookie(req));
    cache.browserResolved = true;
  }
  return cache.browser;
}

function readTelegramSessionProof(req, sessionSlot = readTelegramSessionSlot(req)) {
  const cache = cacheFor(req);
  const slot = String(sessionSlot || '');
  if (!cache.telegram.has(slot)) {
    cache.telegram.set(slot, verifyTelegramSession(readTelegramSessionCookie(req, slot)));
  }
  return cache.telegram.get(slot) || null;
}

function readContextSessionProof(req) {
  const telegramContext = String(req?.get?.('x-auth-context') || '').toLowerCase() === 'telegram';
  if (telegramContext) {
    const sessionSlot = readTelegramSessionSlot(req);
    return {
      kind: 'telegram',
      sessionSlot,
      session: readTelegramSessionProof(req, sessionSlot),
    };
  }
  return {
    kind: 'browser',
    sessionSlot: '',
    session: readBrowserSessionProof(req),
  };
}

module.exports = {
  readBrowserSessionProof,
  readTelegramSessionProof,
  readContextSessionProof,
};

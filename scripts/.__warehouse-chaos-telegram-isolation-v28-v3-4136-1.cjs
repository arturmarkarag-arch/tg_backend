'use strict';

const Module = require('module');
const https = require('https');

global.__LIVE_E2E_TELEGRAM_ISOLATED__ = true;
global.__LIVE_E2E_TELEGRAM_MOCK_CALLS__ = [];
global.__LIVE_E2E_TELEGRAM_NETWORK_ATTEMPTS__ = [];

function safeArg(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 120 ? value.slice(0, 117) + '...' : value;
  if (value && value.constructor && value.constructor.name) return '[' + value.constructor.name + ']';
  return '[' + typeof value + ']';
}
function noteMock(name, args) {
  global.__LIVE_E2E_TELEGRAM_MOCK_CALLS__.push({
    name: String(name),
    args: Array.from(args || []).slice(0, 4).map(safeArg),
  });
}
function asyncNoop(name, returnValue = null) {
  return async function () {
    noteMock(name, arguments);
    return returnValue;
  };
}

const isolatedStatus = {
  status: 'disconnected',
  active: false,
  connected: false,
  mode: 'e2e-isolated',
  startedAt: null,
  error: null,
  hasToken: false,
};

const telegramStubBase = {
  initBot: asyncNoop('initBot'),
  getBotStatus: () => ({ ...isolatedStatus }),
  getWebhookConfig: () => ({ path: '/__e2e_telegram_disabled__', secretToken: 'e2e-disabled' }),
  handleWebhookUpdate: asyncNoop('handleWebhookUpdate', { ok: true }),
  getBot: () => null,

  sendMessageWithRetry: asyncNoop('sendMessageWithRetry'),
  sendPhotoWithRetry: asyncNoop('sendPhotoWithRetry'),
  sendAdminNotification: asyncNoop('sendAdminNotification'),
  sendRegistrationApprovedMessage: asyncNoop('sendRegistrationApprovedMessage'),
  deleteWelcomeFor: asyncNoop('deleteWelcomeFor'),
  recheckAndRepushWelcome: asyncNoop('recheckAndRepushWelcome'),

  isUserInAllowedGroup: async function () {
    noteMock('isUserInAllowedGroup', arguments);
    return true;
  },
};

const telegramStub = new Proxy(telegramStubBase, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (prop === '__esModule') return false;
    const fn = asyncNoop('telegramBot.' + String(prop));
    target[prop] = fn;
    return fn;
  },
});

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = '';
  try {
    resolved = Module._resolveFilename(request, parent, isMain);
  } catch (_) {
    resolved = '';
  }
  if (resolved && /[\\/]telegramBot\.js$/i.test(resolved)) {
    return telegramStub;
  }
  return originalLoad.apply(this, arguments);
};

function telegramHostFromRequestArg(arg) {
  try {
    if (typeof arg === 'string') return new URL(arg).hostname.toLowerCase();
    if (arg instanceof URL) return String(arg.hostname || '').toLowerCase();
    if (arg && typeof arg === 'object') {
      return String(arg.hostname || arg.host || '').split(':')[0].toLowerCase();
    }
  } catch (_) {}
  return '';
}
function blockTelegramNetwork(kind, args) {
  const host = telegramHostFromRequestArg(args[0]);
  if (host === 'api.telegram.org' || host.endsWith('.api.telegram.org')) {
    global.__LIVE_E2E_TELEGRAM_NETWORK_ATTEMPTS__.push({
      kind: String(kind),
      host,
      at: new Date().toISOString(),
    });
    const err = new Error('E2E_TELEGRAM_NETWORK_BLOCKED: ' + kind + ' -> ' + host);
    err.code = 'E2E_TELEGRAM_NETWORK_BLOCKED';
    throw err;
  }
}

const originalHttpsRequest = https.request;
https.request = function () {
  blockTelegramNetwork('https.request', arguments);
  return originalHttpsRequest.apply(this, arguments);
};

const originalHttpsGet = https.get;
https.get = function () {
  blockTelegramNetwork('https.get', arguments);
  return originalHttpsGet.apply(this, arguments);
};

if (typeof global.fetch === 'function') {
  const originalFetch = global.fetch;
  global.fetch = async function (input, init) {
    let host = '';
    try {
      const value = input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input && input.url ? input.url : String(input));
      host = String(value.hostname || '').toLowerCase();
    } catch (_) {}
    if (host === 'api.telegram.org' || host.endsWith('.api.telegram.org')) {
      global.__LIVE_E2E_TELEGRAM_NETWORK_ATTEMPTS__.push({
        kind: 'fetch',
        host,
        at: new Date().toISOString(),
      });
      const err = new Error('E2E_TELEGRAM_NETWORK_BLOCKED: fetch -> ' + host);
      err.code = 'E2E_TELEGRAM_NETWORK_BLOCKED';
      throw err;
    }
    return originalFetch.call(this, input, init);
  };
}

console.log('[E2E isolation] Telegram HARD-BLOCKED: telegramBot.js mocked; api.telegram.org denied.');

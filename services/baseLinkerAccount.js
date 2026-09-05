'use strict';

const crypto = require('crypto');

const ACCOUNT_SETTING_PREFIX = 'baselinker.account';

function hashScope(kind, value) {
  const digest = crypto.createHash('sha256')
    .update(`${kind}:${String(value || '')}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
  return `bl:${kind}:${digest}`;
}

function getBaseLinkerAccountBinding(env = process.env) {
  const configuredKey = String(env.BASELINKER_ACCOUNT_KEY || '').trim();
  if (configuredKey) {
    return {
      accountScope: hashScope('configured', configuredKey),
      source: 'configured',
      stable: true,
    };
  }

  const token = String(env.BASELINKER_API_TOKEN || '').trim();
  if (token) {
    // API tokens are credentials, not account identity. BaseLinker does not
    // document any token substring as a stable account identifier. Without an
    // explicit binding, fail closed: every token gets an isolated namespace.
    return {
      accountScope: hashScope('token', token),
      source: 'token_fingerprint',
      stable: false,
    };
  }

  return {
    accountScope: hashScope('unconfigured', 'none'),
    source: 'unconfigured',
    stable: false,
  };
}

function getBaseLinkerAccountScope() {
  return getBaseLinkerAccountBinding().accountScope;
}

function scopedSettingKey(baseKey, accountScope = getBaseLinkerAccountScope()) {
  return `${baseKey}:${accountScope}`;
}

function scopedLockKey(baseKey, accountScope = getBaseLinkerAccountScope()) {
  return `${baseKey}:${accountScope}`;
}

module.exports = {
  ACCOUNT_SETTING_PREFIX,
  getBaseLinkerAccountBinding,
  getBaseLinkerAccountScope,
  scopedSettingKey,
  scopedLockKey,
};

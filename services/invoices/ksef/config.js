'use strict';

const { appError } = require('../../../utils/errors');

const KSEF_API_VERSION = 'v2';
const KSEF_SCHEMA = Object.freeze({ systemCode: 'FA (3)', schemaVersion: '1-0E', value: 'FA' });
const ENVIRONMENTS = Object.freeze({
  test: Object.freeze({ id: 'test', apiBaseUrl: 'https://api-test.ksef.mf.gov.pl/v2' }),
  demo: Object.freeze({ id: 'demo', apiBaseUrl: 'https://api-demo.ksef.mf.gov.pl/v2' }),
  prod: Object.freeze({ id: 'prod', apiBaseUrl: 'https://api.ksef.mf.gov.pl/v2' }),
});
const PUBLIC_KEY_USAGE = Object.freeze({ TOKEN: 'KsefTokenEncryption', SESSION: 'SymmetricKeyEncryption' });

function normalizeEnvironment(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!ENVIRONMENTS[id]) throw appError('ksef_environment_invalid');
  return id;
}

function getEnvironment(value) {
  return ENVIRONMENTS[normalizeEnvironment(value)];
}

module.exports = { KSEF_API_VERSION, KSEF_SCHEMA, ENVIRONMENTS, PUBLIC_KEY_USAGE, normalizeEnvironment, getEnvironment };

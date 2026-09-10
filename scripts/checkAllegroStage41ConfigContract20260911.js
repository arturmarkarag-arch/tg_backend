'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

const config = read('services/allegroConfiguration.js');
const oauth = read('services/allegroOAuth.js');
const admin = read('routes/admin.js');
const startup = read('index.js');
const errors = read('utils/errors.js');

check('Allegro application configuration is persisted separately from seller accounts', () => {
  assert(config.includes("SETTING_KEY = 'allegro.oauth.config.v1'"));
  assert(config.includes('AppSetting.findOneAndUpdate'));
  assert(!config.includes('BaseLinkerAccount'));
});
check('Client Secret and token encryption key are encrypted at rest', () => {
  assert(config.includes("crypto.createCipheriv('aes-256-gcm'"));
  assert(config.includes('clientSecretEncrypted'));
  assert(config.includes('tokenEncryptionKeyEncrypted'));
});
check('public configuration never returns either secret', () => {
  const block = config.slice(config.indexOf('function publicAllegroConfigurationState'), config.indexOf('module.exports'));
  assert(!block.includes('clientSecret:'));
  assert(!block.includes('tokenEncryptionKey:'));
  assert(block.includes('clientSecretConfigured'));
  assert(block.includes('tokenEncryptionConfigured'));
});
check('admin can save shared Allegro application settings without changing seller accounts', () => {
  assert(admin.includes("router.put('/allegro-settings/oauth'"));
  assert(admin.includes('saveAllegroConfiguration'));
});
check('legacy Allegro env config can migrate once into DB', () => {
  assert(config.includes('legacyConfiguration'));
  assert(config.includes('migrateLegacy'));
  assert(startup.includes('loadAllegroConfiguration({ migrateLegacy: true })'));
});
check('dangerous provider identity/key changes are locked after durable credentials exist', () => {
  assert(config.includes('hasDurableCredentials'));
  assert(config.includes('allegro_config_environment_locked'));
  assert(config.includes('allegro_config_client_id_locked'));
  assert(config.includes('allegro_config_token_key_locked'));
  assert(errors.includes('allegro_config_token_key_locked:'));
});
check('OAuth runtime consumes current DB-backed configuration', () => {
  assert(oauth.includes('currentAllegroConfiguration()'));
  assert(oauth.includes('stored.clientId'));
  assert(oauth.includes('stored.clientSecret'));
  assert(oauth.includes('stored.redirectUri'));
});
console.log(`\nAllegro Stage 4.1 backend config contract: ${pass}/${pass} PASS`);

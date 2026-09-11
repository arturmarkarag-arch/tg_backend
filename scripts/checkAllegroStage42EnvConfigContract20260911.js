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

check('shared Allegro application config is env-only', () => {
  for (const env of ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET', 'ALLEGRO_REDIRECT_URI', 'ALLEGRO_USER_AGENT', 'ALLEGRO_TOKEN_ENCRYPTION_KEY']) assert(config.includes(env));
  assert(config.includes("source: 'env'"));
  assert(!config.includes('findOneAndUpdate'));
});
check('browser cannot write Allegro application credentials', () => {
  assert(!admin.includes("router.put('/allegro-settings/oauth'"));
  assert(!admin.includes('saveAllegroConfiguration'));
});
check('temporary Stage 4.1 DB application settings are purged without touching accounts', () => {
  assert(config.includes("LEGACY_SETTING_KEY = 'allegro.oauth.config.v1'"));
  assert(config.includes('AppSetting.deleteOne({ key: LEGACY_SETTING_KEY })'));
  assert(startup.includes('loadAllegroConfiguration()'));
});
check('seller OAuth token encryption still uses backend token key', () => {
  assert(oauth.includes('currentAllegroConfiguration().tokenEncryptionKey'));
  assert(oauth.includes("encryptSecret(tokenPair.accessToken, row.accountId, 'access')"));
  assert(oauth.includes("encryptSecret(tokenPair.refreshToken, row.accountId, 'refresh')"));
});
check('public OAuth state exposes configuration status, never application secrets', () => {
  const publicBlock = oauth.slice(oauth.indexOf('function publicOAuthConfiguration'), oauth.indexOf('function requireOAuthConfiguration'));
  assert(!publicBlock.includes('clientSecret:'));
  assert(!publicBlock.includes('tokenEncryptionKey:'));
  assert(publicBlock.includes('clientSecretConfigured'));
  assert(publicBlock.includes('tokenEncryptionConfigured'));
});
console.log(`\nAllegro Stage 4.2 backend env-config contract: ${pass}/${pass} PASS`);

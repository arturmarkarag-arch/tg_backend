'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const check = (name, fn) => { fn(); checks.push(name); console.log(`PASS ${name}`); };

const model = read('models/AllegroAccount.js');
const service = read('services/allegroAccounts.js');
const oauth = read('services/allegroOAuth.js');
const config = read('services/allegroConfiguration.js');
const admin = read('routes/admin.js');
const route = read('routes/allegro.js');
const app = read('app.js');
const allegroAdmin = admin.slice(admin.indexOf("router.get('/allegro-settings'"), admin.indexOf("router.get('/baselinker-settings'"));

check('Allegro account owns a durable UUID independent from BaseLinker', () => {
  assert(model.includes("accountId: { type: String, required: true"));
  assert(model.includes('AllegroAccountSchema.index({ accountId: 1 }, { unique: true })'));
  assert(!model.includes('baseLinkerAccountId'));
  assert(!service.includes('getBaseLinkerAccount'));
});

check('multiple Allegro accounts are first-class isolated seller connections', () => {
  assert(model.includes('AllegroAccountSchema.index({ allegroUserId: 1 }, { unique: true, sparse: true })'));
  assert(model.includes('enabled: { type: Boolean, default: false'));
  assert(service.includes('async function listAllegroAccounts'));
});

check('standalone admin create route does not require a BaseLinker parent', () => {
  assert(admin.includes("router.post('/allegro-settings/accounts'"));
  assert(!allegroAdmin.includes('/baselinker-settings/accounts/'));
  assert(!allegroAdmin.includes('baseLinkerAccountId'));
});

check('seller OAuth tokens are server-managed and never accepted from admin request bodies', () => {
  assert(model.includes('accessTokenEncrypted'));
  assert(model.includes('refreshTokenEncrypted'));
  assert(model.includes('select: false'));
  assert(!allegroAdmin.match(/req\.body\?\.(accessToken|refreshToken|token)(?:|\?)/));
});

check('Allegro application credentials stay backend-only in env', () => {
  for (const env of ['ALLEGRO_CLIENT_ID', 'ALLEGRO_CLIENT_SECRET', 'ALLEGRO_REDIRECT_URI', 'ALLEGRO_USER_AGENT', 'ALLEGRO_TOKEN_ENCRYPTION_KEY']) assert(config.includes(env));
  assert(!allegroAdmin.includes("router.put('/allegro-settings/oauth'"));
  const publicBlock = oauth.slice(oauth.indexOf('function publicOAuthConfiguration()'), oauth.indexOf('function requireOAuthConfiguration()'));
  assert(publicBlock.includes('oauthConfigured: config.oauthConfigured'));
  assert(!publicBlock.includes('clientSecret: config.clientSecret'));
  assert(!publicBlock.includes('tokenEncryptionKey:'));
});

check('Allegro provider is mounted separately and warehouse routes are role-guarded', () => {
  assert(route.includes("requireMarketplaceWarehouseAccess"));
  assert(route.includes("router.get('/status', requireMarketplaceWarehouseAccess"));
  assert(route.includes("router.get('/api-usage', requireTelegramRole('admin')"));
  assert(route.includes("router.get('/status'"));
  assert(route.includes("provider: 'allegro'"));
  assert(route.includes('independentProvider: true'));
  assert(app.includes("app.use('/api/allegro', allegroRouter)"));
});

check('unconnected drafts cannot be activated', () => {
  assert(service.includes("if (nextEnabled && row.authState !== 'connected')"));
});

console.log(`\n${checks.length}/${checks.length} Allegro independent-provider backend contract checks passed`);

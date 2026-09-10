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

check('OAuth credentials are server-managed and never accepted from admin request bodies', () => {
  assert(model.includes('accessTokenEncrypted'));
  assert(model.includes('refreshTokenEncrypted'));
  assert(model.includes('select: false'));
  assert(!allegroAdmin.match(/req\.body\?\.(accessToken|refreshToken|token|clientSecret)/));
});

check('Allegro secrets stay server-side and only configuration flags are public', () => {
  assert(oauth.includes('process.env.ALLEGRO_CLIENT_ID'));
  assert(oauth.includes('process.env.ALLEGRO_CLIENT_SECRET'));
  assert(oauth.includes('process.env.ALLEGRO_REDIRECT_URI'));
  const publicBlock = oauth.slice(oauth.indexOf('function publicOAuthConfiguration()'), oauth.indexOf('function requireOAuthConfiguration()'));
  assert(publicBlock.includes('oauthConfigured: config.oauthConfigured'));
  assert(!publicBlock.includes('clientSecret: config.clientSecret'));
});

check('Allegro operational page is admin-only and mounted separately', () => {
  assert(route.includes("router.use(requireTelegramRole('admin'))"));
  assert(route.includes("router.get('/status'"));
  assert(route.includes("provider: 'allegro'"));
  assert(route.includes('independentProvider: true'));
  assert(app.includes("app.use('/api/allegro', allegroRouter)"));
});

check('unconnected drafts cannot be activated', () => {
  assert(service.includes("if (nextEnabled && row.authState !== 'connected')"));
});

console.log(`\n${checks.length}/${checks.length} Allegro independent-provider backend contract checks passed`);

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

check('Allegro account has our durable UUID and required BaseLinker parent identity', () => {
  assert(model.includes("accountId: { type: String, required: true"));
  assert(model.includes("baseLinkerAccountId: { type: String, required: true"));
  assert(model.includes('AllegroAccountSchema.index({ accountId: 1 }, { unique: true })'));
});

check('many Allegro accounts may share one BaseLinker account', () => {
  assert(!model.includes('AllegroAccountSchema.index({ baseLinkerAccountId: 1 }, { unique: true'));
  assert(model.includes('AllegroAccountSchema.index({ baseLinkerAccountId: 1, createdAt: 1 })'));
});

check('a draft must point to an existing BaseLinker account', () => {
  assert(service.includes("await getBaseLinkerAccount(parentId, { lean: true })"));
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
  assert(oauth.includes('clientSecretConfigured: Boolean(config.clientSecret)'));
  const publicBlock = oauth.slice(oauth.indexOf('function publicOAuthConfiguration()'), oauth.indexOf('function requireOAuthConfiguration()'));
  assert(publicBlock.includes('oauthConfigured: config.oauthConfigured'));
  assert(!publicBlock.includes('clientSecret: config.clientSecret'));
});

check('nested admin create route preserves BaseLinker -> Allegro mapping', () => {
  assert(admin.includes("router.post('/baselinker-settings/accounts/:baseLinkerAccountId/allegro-accounts'"));
  assert(admin.includes('baseLinkerAccountId: req.params.baseLinkerAccountId'));
});

check('Allegro operational page is admin-only and mounted separately', () => {
  assert(route.includes("router.use(requireTelegramRole('admin'))"));
  assert(route.includes("router.get('/status'"));
  assert(app.includes("app.use('/api/allegro', allegroRouter)"));
});

check('unconnected drafts cannot be activated', () => {
  assert(service.includes("if (nextEnabled && row.authState !== 'connected')"));
});

console.log(`\n${checks.length}/${checks.length} Allegro Stage 1 backend contract checks passed`);

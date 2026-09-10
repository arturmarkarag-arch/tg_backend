'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
let pass = 0;
const check = (name, fn) => { fn(); pass += 1; console.log(`PASS ${name}`); };

const model = read('models/AllegroAccount.js');
const stateModel = read('models/AllegroOAuthState.js');
const oauth = read('services/allegroOAuth.js');
const accounts = read('services/allegroAccounts.js');
const route = read('routes/allegro.js');
const app = read('app.js');
const errors = read('utils/errors.js');

check('encrypted access + refresh credentials are select:false', () => {
  assert(model.includes("accessTokenEncrypted: { type: EncryptedSecretSchema, default: undefined, select: false }"));
  assert(model.includes("refreshTokenEncrypted: { type: EncryptedSecretSchema, default: undefined, select: false }"));
});

check('OAuth state persists only SHA-256 digest and expires via TTL index', () => {
  assert(stateModel.includes('stateHash'));
  assert(stateModel.includes("expireAfterSeconds: 0"));
  assert(oauth.includes("crypto.createHash('sha256')"));
  assert(!stateModel.includes('state: {'));
});

check('callback is the only Allegro pre-auth API path', () => {
  assert(app.includes("/^\\/api\\/allegro\\/oauth\\/callback$/"));
  assert(route.indexOf("router.get('/oauth/callback'") < route.indexOf("router.use(requireTelegramRole('admin'))"));
  assert(!app.includes("/^\\/api\\/allegro(?:\\/.*)?$/"));
});

check('authorization start is admin-only and uses one-time state + prompt confirm', () => {
  assert(route.includes("router.post('/accounts/:accountId/oauth/start'"));
  assert(oauth.includes("authorize.searchParams.set('state', state)"));
  assert(oauth.includes("authorize.searchParams.set('prompt', 'confirm')"));
  assert(oauth.includes("AllegroOAuthState.deleteMany({ accountId: id })"));
});

check('minimum planned scopes cover identity, direct orders and shipment workflow', () => {
  for (const scope of [
    'allegro:api:profile:read',
    'allegro:api:orders:read',
    'allegro:api:orders:write',
    'allegro:api:shipments:read',
    'allegro:api:shipments:write',
  ]) assert(oauth.includes(scope));
});

check('production config requires User-Agent and dedicated encryption key', () => {
  assert(oauth.includes("ALLEGRO_USER_AGENT"));
  assert(oauth.includes("ALLEGRO_TOKEN_ENCRYPTION_KEY"));
  assert(oauth.includes("ALLEGRO_CLIENT_SECRET"));
});

check('access and refresh secrets use AES-256-GCM with kind-bound AAD', () => {
  assert(oauth.includes("crypto.createCipheriv('aes-256-gcm'"));
  assert(oauth.includes('`${id}:${normalizedKind}`'));
  assert(oauth.includes("encryptSecret(tokenPair.accessToken, row.accountId, 'access')"));
  assert(oauth.includes("encryptSecret(tokenPair.refreshToken, row.accountId, 'refresh')"));
});

check('refresh rotation is distributed-locked and CAS guarded', () => {
  assert(oauth.includes('withAllegroTokenLock'));
  assert(oauth.includes('$inc: { tokenRevision: 1 }'));
  assert(oauth.includes('tokenRevisionFilter(row)'));
  assert(oauth.includes('CAS lost'));
});

check('real Allegro identity cannot silently change behind our UUID', () => {
  assert(oauth.includes('allegro_oauth_identity_mismatch'));
  assert(oauth.includes("allegroUserId: identity.id"));
  assert(oauth.includes("accountId: { $ne: row.accountId }"));
});

check('public Allegro DTO does not expose encrypted tokens or token revision', () => {
  const dtoBody = accounts.slice(accounts.indexOf('function publicAllegroAccount'), accounts.indexOf('function oauthConfiguration'));
  assert(!dtoBody.includes('accessTokenEncrypted'));
  assert(!dtoBody.includes('refreshTokenEncrypted'));
  assert(!dtoBody.includes('tokenRevision'));
});

check('connection check exists and may refresh an expired access token', () => {
  assert(route.includes("router.post('/accounts/:accountId/connection-check'"));
  assert(oauth.includes('forceRefresh: true'));
  assert(oauth.includes('fetchAllegroIdentity'));
});

check('Stage 2 status exposes only public OAuth configuration', () => {
  assert(route.includes('stage: 2'));
  assert(accounts.includes('publicOAuthConfiguration'));
  assert(!accounts.includes('clientSecret:'));
});

check('stable OAuth errors are centralized', () => {
  for (const code of [
    'allegro_oauth_not_configured',
    'allegro_oauth_state_invalid',
    'allegro_oauth_exchange_failed',
    'allegro_oauth_refresh_failed',
    'allegro_oauth_identity_mismatch',
  ]) assert(errors.includes(`${code}:`));
});

console.log(`\nAllegro Stage 2 backend contract: ${pass}/${pass} PASS`);

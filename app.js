const express = require('express');
const cors = require('cors');
const path = require('path');
const productsRouter = require('./routes/products');
const usersRouter = require('./routes/users');
const ordersRouter = require('./routes/orders');
const deliveryGroupsRouter = require('./routes/deliveryGroups');
const { router: archiveRouter } = require('./routes/archive');
const blocksRouter = require('./routes/blocks');
const telegramV1Router = require('./routes/v1/telegram');
const authV1Router = require('./routes/v1/auth');
const adminRouter = require('./routes/admin');
const searchProductsRouter = require('./routes/searchProducts');
const { getBotStatus, getWebhookConfig, handleWebhookUpdate } = require('./telegramBot');
const { verifyOpenAIConnection } = require('./openaiClient');
const { verifyGeminiConnection } = require('./geminiClient');
const receiptsRouter = require('./routes/receipts');
const pickingRouter = require('./routes/picking');
const shopsRouter = require('./routes/shops');
const shopTransferRouter  = require('./routes/shopTransfer');
const shopProductsRouter  = require('./routes/shopProducts');
const visionSearchRouter  = require('./routes/visionSearch');
const productFeedbackRouter = require('./routes/productFeedback');
const navBadgesRouter = require('./routes/navBadges');
const supplementRouter = require('./routes/supplement');
const baseLinkerRouter = require('./routes/baseLinker');
const { getPublicMaintenanceState, maintenanceReadOnlyMiddleware } = require('./services/maintenanceState');

// The warehouse test harness (destructive: cleanup/seed/reset of real
// collections) must NEVER be reachable in production. Outside production it is
// still disabled unless ENABLE_TEST_API=true is explicitly set. Even then it is
// NOT a public API path and requires an authenticated admin.
const ENABLE_TEST_API = process.env.NODE_ENV !== 'production'
  && process.env.ENABLE_TEST_API === 'true';

const { expressCorsOptions } = require('./utils/corsOptions');

const app = express();
// Не розповідаємо кожній відповіді, на чому працює бекенд.
app.disable('x-powered-by');
app.use(cors(expressCorsOptions));
app.use(express.json());
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
}, express.static(path.join(__dirname, 'uploads')));
if (ENABLE_TEST_API) {
  app.use('/warehouse-test', express.static(path.join(__dirname, '../Тести Е2Е/test-warehouse')));
}

// Telegram webhook delivery. Mounted BEFORE the API auth gate: Telegram posts
// server-to-server with no telegram initData / JWT, so the auth here is the
// unguessable token-derived path + the secret-token header. Body is already
// JSON-parsed by express.json() above. Always mounted (dormant in polling mode,
// since no webhook URL is registered then) — the path is unguessable regardless.
{
  const wh = getWebhookConfig();
  app.post(wh.path, (req, res) => {
    if (wh.secretToken && req.get('x-telegram-bot-api-secret-token') !== wh.secretToken) {
      return res.sendStatus(403);
    }
    // Ack immediately, then process — never make Telegram wait on (or retry over)
    // our handler work. processUpdate emits synchronously; handlers run detached.
    res.sendStatus(200);
    try { handleWebhookUpdate(req.body); } catch (err) {
    }
  });
}

const { telegramAuth, requireTelegramRole } = require('./middleware/telegramAuth');

const publicApiPaths = [
  /^\/api\/v1\/auth(\/.*)?$/,
  /^\/api\/search-products(\/.*)?$/,
  /^\/api\/v1\/telegram\/validate$/,
  /^\/api\/v1\/telegram\/register-request$/,
  // Self-service invite for a group member who opened the mini-app without a
  // ?regToken. Necessarily pre-registration (the caller has no User row yet),
  // so it cannot sit behind telegramAuth. It authenticates the caller itself
  // via signed initData and re-checks group membership live before minting.
  /^\/api\/v1\/telegram\/registration-invite$/,
  /^\/api\/v1\/telegram\/me$/,
  /^\/api\/delivery-groups\/summary$/,
  /^\/api\/shops\/cities$/,
  // Minimal, seller-PII-free shop list for the registration screen. The full
  // GET /api/shops (with seller data) now requires auth and is staff-only.
  /^\/api\/shops\/registry$/,
  /^\/api\/shop-products\/barcode\/.+$/,
  /^\/api\/health$/,
  /^\/api\/maintenance$/,

];

function requireAuthForApi(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  const isPublic = publicApiPaths.some((pattern) => pattern.test(req.path));
  if (isPublic) return next();
  return telegramAuth(req, res, next);
}

app.use(requireAuthForApi);

// Dedicated BaseLinker workers are intentionally isolated from every other
// authenticated application domain. Public pre-auth endpoints stay public, but
// once telegramAuth resolved this role the only operational API namespace it may
// use is /api/baselinker. This is the server-side boundary behind the one-page UI.
app.use((req, res, next) => {
  if (req.telegramUser?.role !== 'baselinker') return next();
  if (/^\/api\/baselinker(?:\/|$)/.test(req.path)) return next();
  const { appError } = require('./utils/errors');
  return next(appError('auth_role_required', { allowed: ['admin', 'baselinker'] }));
});

app.get('/api/health', (req, res) => {
  const maintenance = getPublicMaintenanceState();
  res.json({
    status: maintenance.active ? 'maintenance' : 'ok',
    maintenance: { active: maintenance.active, mode: maintenance.mode, since: maintenance.since },
  });
});

app.get('/api/maintenance', (req, res) => {
  res.json(getPublicMaintenanceState());
});

app.get('/api/bot-status', requireTelegramRole('admin'), (req, res) => {
  res.json(getBotStatus());
});

app.get('/api/openai-status', requireTelegramRole('admin'), async (req, res) => {
  try {
    const result = await verifyOpenAIConnection();
    res.json(result);
  } catch (error) {
    const { t } = require('./utils/errors');
    res.status(500).json({
      status: 'error',
      error: 'openai_connection_failed',
      message: t('openai_connection_failed', { reason: error?.message }),
    });
  }
});

app.get('/api/gemini-status', requireTelegramRole('admin'), async (req, res) => {
  try {
    const result = await verifyGeminiConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: 'gemini_connection_failed',
      message: error?.message || 'Gemini connection failed',
    });
  }
});

// Критичні індекси: docs/operations/maintenance-mode.md
app.use(maintenanceReadOnlyMiddleware);

app.use('/api/products', productsRouter);
app.use('/api/v1/products', productsRouter);
app.use('/api/users', usersRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/delivery-groups', deliveryGroupsRouter);
app.use('/api/archive', archiveRouter);
app.use('/api/blocks', blocksRouter);
app.use('/api/search-products', searchProductsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/picking', pickingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/shops', shopsRouter);
app.use('/api/shop-transfer', shopTransferRouter);
app.use('/api/shop-products',  shopProductsRouter);
app.use('/api/vision-search', visionSearchRouter);
app.use('/api/product-feedback', productFeedbackRouter);
app.use('/api/nav-badges', navBadgesRouter);
app.use('/api/supplement', supplementRouter);
app.use('/api/baselinker', baseLinkerRouter);
app.use('/api/v1/telegram', telegramV1Router);
app.use('/api/v1/auth', authV1Router);
if (ENABLE_TEST_API) {
  // eslint-disable-next-line global-require
  app.use('/api/warehouse-test', requireTelegramRole('admin'), require('./routes/warehouseTest'));
}

// Centralised error handler — converts AppError (and known Mongoose errors)
// into a consistent JSON envelope { error: <code>, message: <ukrainian text>, ... }.
// All routes that throw `appError(...)` (utils/errors.js) end up here.
const { errorHandler } = require('./utils/errors');
app.use(errorHandler);

// Frontend is hosted on Vercel — this server is API-only.
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: 'Не знайдено' });
});

module.exports = app;

const { Sentry, sentryEnabled } = require('./instrument');
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
const allegroRouter = require('./routes/allegro');
const commerceRouter = require('./routes/commerce');
const invoicesRouter = require('./routes/invoices');
const baseLinkerPrintAgentRouter = require('./routes/baseLinkerPrintAgent');
const { getPublicMaintenanceState, maintenanceReadOnlyMiddleware } = require('./services/maintenanceState');
const { getPublicInvoiceKsefWriteState } = require('./services/invoices/invoiceKsefWriteState');
const { telegramAuth, requireTelegramRole, requireTelegramRoles } = require('./middleware/telegramAuth');
const { egressRequestContextMiddleware } = require('./services/egressTrafficMonitor');
const { createApiAbuseGuard } = require('./middleware/apiAbuseGuard');

// The warehouse test harness (destructive: cleanup/seed/reset of real
// collections) must NEVER be reachable in production. Outside production it is
// still disabled unless ENABLE_TEST_API=true is explicitly set. Even then it is
// NOT a public API path and requires an authenticated admin.
const ENABLE_TEST_API = process.env.NODE_ENV !== 'production'
  && process.env.ENABLE_TEST_API === 'true';

const { expressCorsOptions } = require('./utils/corsOptions');

const publicApiPaths = [
  /^\/api\/v1\/auth\/config$/,
  /^\/api\/v1\/auth\/telegram\/bootstrap$/,
  /^\/api\/v1\/auth\/google$/,
  /^\/api\/v1\/auth\/google\/link\/bootstrap$/,
  /^\/api\/v1\/auth\/google\/link\/complete$/,
  /^\/api\/v1\/auth\/me$/,
  /^\/api\/v1\/auth\/logout$/,
  /^\/api\/v1\/telegram\/validate$/,
  /^\/api\/v1\/telegram\/register-request$/,
  // Self-service invite for a group member who opened the mini-app without a
  // ?regToken. Necessarily pre-registration (the caller has no User row yet),
  // so it cannot sit behind telegramAuth. It authenticates the caller itself
  // via the first-party Telegram proof session and re-checks group membership live before minting.
  /^\/api\/v1\/telegram\/registration-invite$/,
  /^\/api\/v1\/telegram\/me$/,
  /^\/api\/shops\/cities$/,
  // Minimal, seller-PII-free shop list for the registration screen. The full
  // GET /api/shops (with seller data) now requires auth and is staff-only.
  /^\/api\/shops\/registry$/,
  /^\/api\/health$/,
  /^\/api\/maintenance$/,
  // Local Windows Print Agent authenticates with its own long random token.
  /^\/api\/print-agent(?:\/.*)?$/,
  // Allegro OAuth returns from allegro.pl without our Telegram/JWT session.
  // Only this exact callback is public; one-time server-side state authenticates it.
  /^\/api\/allegro\/oauth\/callback$/,

];

function requireAuthForApi(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (isPublicApiPath(req.path)) return next();
  return telegramAuth(req, res, next);
}

function isPublicApiPath(pathname) {
  return publicApiPaths.some((pattern) => pattern.test(String(pathname || '')));
}

const app = express();
// Не розповідаємо кожній відповіді, на чому працює бекенд.
app.disable('x-powered-by');
app.use(cors(expressCorsOptions));
// Reject anonymous API floods before JSON parsing, MongoDB auth lookups or route work.
// Valid first-party sessions bypass this anonymous guard completely, so normal page
// bootstrap/polling fan-out keeps its existing behaviour.
app.use(createApiAbuseGuard({ isPublicApiPath }));
app.use(express.json());
// Tags automatic outbound HTTP metadata with the inbound API route that caused
// it. Background schedulers remain source=background without manual registration.
app.use(egressRequestContextMiddleware);
// Legacy local uploads are warehouse-domain. Keep them behind auth instead of
// exposing every existing file as anonymous static content. Public product media
// is served from the explicitly public R2 domain instead.
app.use('/uploads', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), express.static(path.join(__dirname, 'uploads')));
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


app.use(requireAuthForApi);

// The dedicated `baselinker` worker is intentionally scoped to BaseLinker
// operations, with only the exact self-service account endpoints needed to edit
// its own profile / link Google. Commerce Core and other marketplace providers
// remain admin-only. BaseLinker routes apply their own endpoint-level guard as a
// second authorization layer.
const baseLinkerSelfServicePaths = [
  /^\/api\/v1\/telegram\/me\/profile$/,
  /^\/api\/v1\/telegram\/google\/link\/start$/,
  /^\/api\/v1\/telegram\/google\/unlink$/,
];
app.use((req, res, next) => {
  if (req.telegramUser?.role !== 'baselinker') return next();
  if (/^\/api\/baselinker(?:\/|$)/.test(req.path)) return next();
  if (baseLinkerSelfServicePaths.some((pattern) => pattern.test(req.path))) return next();
  const { appError } = require('./utils/errors');
  return next(appError('auth_role_required', { allowed: ['admin'] }));
});

app.get('/api/health', (req, res) => {
  const maintenance = getPublicMaintenanceState();
  const invoiceKsef = getPublicInvoiceKsefWriteState();
  res.json({
    status: maintenance.active ? 'maintenance' : (invoiceKsef.blocked ? 'degraded' : 'ok'),
    maintenance: { active: maintenance.active, mode: maintenance.mode, since: maintenance.since },
    domains: {
      invoiceKsef: { blocked: invoiceKsef.blocked, mode: invoiceKsef.mode, since: invoiceKsef.since },
    },
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
app.use('/api/allegro', allegroRouter);
app.use('/api/commerce', commerceRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/print-agent', baseLinkerPrintAgentRouter);
app.use('/api/v1/telegram', telegramV1Router);
app.use('/api/v1/auth', authV1Router);
if (ENABLE_TEST_API) {
  // eslint-disable-next-line global-require
  app.use('/api/warehouse-test', requireTelegramRole('admin'), require('./routes/warehouseTest'));
}

// @sentry/node 10.x requires the Express error handler to be mounted after
// routes and before our own JSON error handler. It captures server failures but
// then forwards the same error, so the existing API response contract is intact.
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app);
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

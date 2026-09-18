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
const {
  createStrictAccessBoundary,
  isAnonymousEntryApiPath,
  isUserAuthBypassApiPath,
} = require('./middleware/accessBoundary');

// The warehouse test harness (destructive: cleanup/seed/reset of real
// collections) must NEVER be reachable in production. Outside production it is
// still disabled unless ENABLE_TEST_API=true is explicitly set. Even then it is
// NOT a public API path and requires an authenticated admin.
const ENABLE_TEST_API = process.env.NODE_ENV !== 'production'
  && process.env.ENABLE_TEST_API === 'true';

const { expressCorsOptions } = require('./utils/corsOptions');

function requireAuthForApi(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  if (isUserAuthBypassApiPath(req.path)) return next();
  return telegramAuth(req, res, next);
}

const app = express();
// Не розповідаємо кожній відповіді, на чому працює бекенд.
app.disable('x-powered-by');
app.use(cors(expressCorsOptions));

// Tag all inbound work before any special ingress route can branch away from
// the normal API stack. This is body-independent and keeps webhook/provider
// egress attributable without making those callbacks pass user auth.
app.use(egressRequestContextMiddleware);

// Telegram webhook is a machine-authenticated ingress, not a public app route.
// Verify the secret header BEFORE parsing JSON so a caller who somehow learns
// the token-derived path cannot spend our CPU/RAM on arbitrary request bodies.
{
  const wh = getWebhookConfig();
  app.post(wh.path,
    (req, res, next) => {
      if (wh.secretToken && req.get('x-telegram-bot-api-secret-token') !== wh.secretToken) {
        return res.sendStatus(403);
      }
      return next();
    },
    express.json({ limit: '256kb' }),
    (req, res) => {
      // Ack immediately, then process — never make Telegram wait on (or retry over)
      // our handler work. processUpdate emits synchronously; handlers run detached.
      res.sendStatus(200);
      try { handleWebhookUpdate(req.body); } catch (err) {
      }
    },
  );
}

// Anonymous flood protection remains the outer API budget. Exact auth-entry
// routes get their own bucket; invalid callers aimed at any protected path get
// the tighter budget. Valid first-party/service proofs bypass it completely.
app.use(createApiAbuseGuard({ isAnonymousEntryPath: isAnonymousEntryApiPath }));

// Hard fail-closed ingress boundary for the ENTIRE server, not just /api. It
// runs before the general JSON parser, static folders and Mongo-backed auth.
// Only explicit login/registration/check capabilities and machine-authenticated
// callbacks can proceed without a normal user proof.
app.use(createStrictAccessBoundary());
app.use(express.json());

// Legacy local uploads are warehouse-domain. Keep them behind full user auth +
// staff role. Public product media stays on the separate R2 image domain.
app.use('/uploads', telegramAuth, requireTelegramRoles(['admin', 'warehouse']), express.static(path.join(__dirname, 'uploads')));
if (ENABLE_TEST_API) {
  // Even in local/test mode the test harness static files are never anonymous.
  app.use(
    '/warehouse-test',
    telegramAuth,
    requireTelegramRole('admin'),
    express.static(path.join(__dirname, '../Тести Е2Е/test-warehouse')),
  );
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

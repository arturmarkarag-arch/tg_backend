const dotenv = require('dotenv');
const path = require('path');

// Load local .env from repo root only when running locally.
// In production (Render), environment variables are provided by the service.
if (process.env.NODE_ENV !== 'production') {
  dotenv.config({ path: path.resolve(__dirname, '../.env') });
}

const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const { initBot } = require('./telegramBot');
const { initOpenAI } = require('./openaiClient');
const { initGemini } = require('./geminiClient');
const { initSocket } = require('./socket');
const AppSetting = require('./models/AppSetting');
const { migrateOrdersToSessionIds } = require('./utils/getOrCreateSession');
const { ensureShopProductIndexes } = require('./utils/ensureShopProductIndexes');
const { isEnabled: redisEnabled } = require('./utils/redis');
const Order = require('./models/Order');
const PickingTask = require('./models/PickingTask');
const { startRetentionScheduler } = require('./services/retention');

let httpServer = null;
let shuttingDown = false;

// Graceful shutdown: stop accepting new connections, close Mongo, then exit.
// Bounded by a hard timeout so a hung connection can't block the platform's
// stop signal forever.
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — closing gracefully`);
  const hardExit = setTimeout(() => {
    console.error('[shutdown] forced exit (timeout)');
    process.exit(code || 1);
  }, 10_000);
  hardExit.unref();
  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.connection.close(false);
  } catch (err) {
    console.error('[shutdown] error while closing:', err?.message);
  } finally {
    clearTimeout(hardExit);
    process.exit(code);
  }
}

// A rejected promise nobody handled is a bug but not necessarily fatal — log
// it loudly and keep serving. An uncaught exception leaves the process in an
// undefined state — log and shut down so the platform restarts us clean.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  shutdown('uncaughtException', 1);
});
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || null;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function startServer() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is required in production');
    }

    // Fail-fast: the order-placement de-dup relies on a cross-worker Redis lock.
    // Without REDIS_URL that lock degrades to a per-PROCESS mutex, so running more
    // than one worker without Redis lets two workers each accept a "first" order
    // for the same buyer/session → duplicate active orders (the unique index below
    // is the DB backstop, but we refuse to boot a config that knowingly races).
    // WEB_CONCURRENCY is the standard worker-count env on Render/Heroku-style hosts.
    const workerCount = Number(process.env.WEB_CONCURRENCY) || 1;
    if (workerCount > 1 && !redisEnabled()) {
      throw new Error(
        `Refusing to start: WEB_CONCURRENCY=${workerCount} (>1) without REDIS_URL. ` +
        'The distributed lock for order placement, socket fan-out and cache ' +
        'invalidation requires Redis in multi-worker mode. Set REDIS_URL or run a single worker.',
      );
    }

    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');
    await migrateOrdersToSessionIds();
    await ensureShopProductIndexes();

    // Build the Order indexes explicitly (incl. one_active_order_per_buyer_shop_session).
    // syncIndexes surfaces a failure here loudly instead of letting Mongoose's
    // background autoIndex swallow it on connection.on('index'). If pre-existing
    // active-order duplicates exist the unique build throws E11000 — we log the
    // exact error so it can be cleaned up, but do NOT crash the whole server over
    // an index that is a backstop (the Redis lock still guards the live path).
    try {
      await Order.syncIndexes();
      console.log('[indexes] Order indexes synced');
    } catch (err) {
      console.error(
        '[indexes] Order.syncIndexes failed — likely pre-existing duplicate active ' +
        'orders blocking one_active_order_per_buyer_shop_session. Resolve duplicates ' +
        'then restart. Continuing without the unique backstop. Error:', err.message,
      );
    }

    // PickingTask indexes are syncIndexes()'d (not just background autoIndex) so a
    // STALE index removed from the schema is actually DROPPED, not left behind.
    // Specifically this drops the legacy `productId_1` unique index: a remnant of
    // the pre-delivery-group schema that enforced ONE active task per product
    // GLOBALLY. While it lingered, a product ordered in two delivery groups whose
    // picking overlapped lost the second group's task to a swallowed E11000 in
    // taskBuilder — the item was silently never picked. The schema only declares
    // the correct per-(product, deliveryGroup) unique index.
    try {
      await PickingTask.syncIndexes();
      console.log('[indexes] PickingTask indexes synced');
    } catch (err) {
      console.error(
        '[indexes] PickingTask.syncIndexes failed. Continuing — the legacy global ' +
        'productId_1 unique index may still be present and can strand a product ' +
        'ordered across two concurrently-picked delivery groups. Error:', err.message,
      );
    }

    // User: build the partial-unique googleSub index (Google login is keyed on
    // sub). GoogleLinkToken: build its TTL index so spent/expired link tokens are
    // reaped automatically. Non-fatal — log and continue if a build fails.
    try {
      await require('./models/User').syncIndexes();
      await require('./models/GoogleLinkToken').syncIndexes();
      await require('./models/RegistrationToken').syncIndexes();
      console.log('[indexes] User + GoogleLinkToken + RegistrationToken indexes synced');
    } catch (err) {
      console.error('[indexes] User/GoogleLinkToken/RegistrationToken.syncIndexes failed:', err.message);
    }

    // Log-retention TTL indexes. syncIndexes() drops the old plain index on each
    // field and rebuilds it WITH expireAfterSeconds, so MongoDB reaps stale audit
    // rows on its own (ShopAuditLog 180d, ReceiptItemLog + VisionTestLog 365d).
    // Non-fatal: a failed build just means the collection keeps growing until the
    // next clean boot, not an outage.
    try {
      await require('./models/ShopAuditLog').syncIndexes();
      await require('./models/ReceiptItemLog').syncIndexes();
      await require('./models/VisionTestLog').syncIndexes();
      console.log('[indexes] log-retention TTL indexes synced');
    } catch (err) {
      console.error('[indexes] log-retention TTL syncIndexes failed:', err.message);
    }


    // Prefer key stored in DB (via admin settings), fall back to env
    const keyFromDb = await AppSetting.findOne({ key: 'openai.apiKey' }).lean();
    const OPENAI_API_KEY = keyFromDb?.value || process.env.OPENAI_API_KEY;
    initOpenAI(OPENAI_API_KEY);

    // Gemini (embeddings / vector search). Prefer a DB-stored key, fall back to env.
    const geminiKeyFromDb = await AppSetting.findOne({ key: 'gemini.apiKey' }).lean();
    const GEMINI_API_KEY = geminiKeyFromDb?.value || process.env.GEMINI_API_KEY;
    initGemini(GEMINI_API_KEY);

    initBot(TELEGRAM_BOT_TOKEN);

    const server = http.createServer(app);
    httpServer = server;
    initSocket(server);

    // Daily sweep of long-dead completed picking tasks (TTL can't filter by
    // status, so this runs application-side). Logs reap themselves via TTL.
    startRetentionScheduler();

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Failed to listen on port ${PORT}: port already in use. Stop the other process or use a different PORT.`);
        process.exit(1);
      }
      throw err;
    });

    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };

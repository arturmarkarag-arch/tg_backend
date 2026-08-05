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
const { startSupplementScheduler } = require('./services/supplementScheduler');
const { enterMaintenance, isMaintenanceActive } = require('./services/maintenanceState');

let httpServer = null;
let shuttingDown = false;

// Graceful shutdown із жорстким таймаутом.
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

// Uncaught exception завершує процес; unhandled rejection журналюється.
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

    try {
      await ensureShopProductIndexes();
      console.log('[indexes] shop_products synced');
    } catch (err) {
      console.error('[indexes] shop_products failed:', err?.message);
      enterMaintenance({
        key: 'shop_products',
        title: 'Не створився критичний індекс каталогу магазинів',
        whatBroke: 'Товари без штрихкоду можуть не додаватися до каталогу або дублюватися.',
        technicalDetails: err?.message || String(err),
        howToFix: [
          'Перевірте db.shopproducts.getIndexes().',
          'Звірте індекс barcode_1 і дублікати непорожніх barcode.',
          'Виправте дані та перезапустіть сервер.',
        ],
        docsPath: 'docs/operations/maintenance-mode.md',
      });
    }

    // Критичні індекси: docs/operations/maintenance-mode.md
    const syncCritical = async ({ key, title, whatBroke, howToFix, models }) => {
      try {
        for (const model of models) await model.syncIndexes();
        console.log(`[indexes] ${key} synced`);
      } catch (err) {
        console.error(`[indexes] ${key} failed:`, err?.message);
        enterMaintenance({
          key,
          title,
          whatBroke,
          technicalDetails: err?.message || String(err),
          howToFix,
          docsPath: 'docs/operations/maintenance-mode.md',
        });
      }
    };

    await syncCritical({
      key: 'orders',
      title: 'Не створився критичний індекс замовлень',
      whatBroke: 'Не підтверджено правило: одне активне замовлення на покупця, магазин і сесію.',
      howToFix: [
        'Відкрийте логи сервера та знайдіть [indexes] orders failed.',
        'Перевірте дублікати активних замовлень за інструкцією в docs/operations/maintenance-mode.md.',
        'Виправте дублікати та перезапустіть сервер.',
      ],
      models: [Order],
    });

    await syncCritical({
      key: 'picking_tasks',
      title: 'Не створився критичний індекс складських задач',
      whatBroke: 'Не підтверджено унікальність активної задачі товару в групі або лишився застарілий індекс.',
      howToFix: [
        'Перевірте db.pickingtasks.getIndexes().',
        'Видаліть застарілий productId_1 лише якщо він реально існує.',
        'Виправте дублікати активних задач і перезапустіть сервер.',
      ],
      models: [PickingTask],
    });

    await syncCritical({
      key: 'supplements',
      title: 'Не створилися критичні індекси дозамовлень',
      whatBroke: 'Не підтверджено ідемпотентність пропозицій або правило однієї заявки магазину.',
      howToFix: [
        'Перевірте db.supplementoffers.getIndexes() і db.supplementrequests.getIndexes().',
        'Старого унікального індексу productId + deliveryGroupId більше не повинно бути.',
        'Звірте дублікати, виправте дані та перезапустіть сервер.',
      ],
      models: [require('./models/SupplementOffer'), require('./models/SupplementRequest')],
    });

    await syncCritical({
      key: 'users',
      title: 'Не створилися критичні індекси користувачів',
      whatBroke: 'Не підтверджено унікальність прив’язаної Google identity.',
      howToFix: [
        'Знайдіть дублікати googleEmail/googleSub.',
        'Об’єднайте або виправте акаунти.',
        'Перезапустіть сервер.',
      ],
      models: [require('./models/User')],
    });

    // Некритичні TTL-індекси токенів.
    try {
      await require('./models/GoogleLinkToken').syncIndexes();
      await require('./models/RegistrationToken').syncIndexes();
      console.log('[indexes] token TTL indexes synced');
    } catch (err) {
      console.error('[indexes] token TTL sync failed:', err.message);
    }

    // Некритичні TTL-індекси журналів.
    try {
      await require('./models/ShopAuditLog').syncIndexes();
      await require('./models/ReceiptItemLog').syncIndexes();
      await require('./models/VisionTestLog').syncIndexes();
      await require('./models/CatalogReview').syncIndexes();
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

    if (!isMaintenanceActive()) initBot(TELEGRAM_BOT_TOKEN);

    const server = http.createServer(app);
    httpServer = server;
    initSocket(server);

    if (isMaintenanceActive()) {
      console.error('[maintenance] Фонові планувальники й Telegram-бот вимкнені до відновлення індексів.');
    } else {
      startRetentionScheduler();
      startSupplementScheduler();
    }

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

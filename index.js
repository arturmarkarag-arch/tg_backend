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
const { assertDeliveryGroupSchedulesReady } = require('./utils/deliveryGroupSchedulePreflight');
const { isEnabled: redisEnabled } = require('./utils/redis');
const Order = require('./models/Order');
const PickingTask = require('./models/PickingTask');
const Product = require('./models/Product');
const Block = require('./models/Block');
const { startRetentionScheduler } = require('./services/retention');
const { startSupplementScheduler } = require('./services/supplementScheduler');
const { startOrderingOpenScheduler } = require('./services/orderingOpenScheduler');
const { startPickingMaintenanceScheduler } = require('./services/pickingMaintenanceScheduler');
const { startTelegramDeliveryScheduler } = require('./services/telegramDeliveryScheduler');
const { enterMaintenance, isMaintenanceActive } = require('./services/maintenanceState');

let httpServer = null;
let shuttingDown = false;

// Graceful shutdown із жорстким таймаутом.
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const hardExit = setTimeout(() => {
    process.exit(code || 1);
  }, 10_000);
  hardExit.unref();
  try {
    if (httpServer) await new Promise((resolve) => httpServer.close(resolve));
    await mongoose.connection.close(false);
  } catch (err) {
  } finally {
    clearTimeout(hardExit);
    process.exit(code);
  }
}

// Uncaught exception завершує процес; unhandled rejection журналюється.
process.on('unhandledRejection', (reason) => {
});
process.on('uncaughtException', (err) => {
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
    await assertDeliveryGroupSchedulesReady();
    await migrateOrdersToSessionIds();
    const parkedOrderMigration = await require('./services/orderUnassignStateMigration').migrateLegacyParkedOrders();
    console.log(`[order-unassign] legacyParked matched=${parkedOrderMigration.matched} modified=${parkedOrderMigration.modified}`);
    const supplementV3Migration = await require('./services/supplementV3Migration').migrateSupplementV3();
    console.log(`[supplement-v3] containers=${supplementV3Migration.containers} merged=${supplementV3Migration.merged}`);

    try {
      await ensureShopProductIndexes();
    } catch (err) {
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
      } catch (err) {
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
      key: 'receipt_product_identity',
      title: 'Не створився критичний індекс зв’язку накладна → складський товар',
      whatBroke: 'Не підтверджено правило: одна позиція накладної може мати лише один фізичний Product.',
      howToFix: [
        'Перевірте дублікати products.receiptItemId (не null).',
        'Для кожного receiptItemId має лишитися рівно один канонічний Product, а ReceiptItem.createdProductId має вказувати на нього.',
        'Після repair перезапустіть сервер — Product.syncIndexes() створить UNIQUE partial index.',
      ],
      models: [Product],
    });

    await syncCritical({
      key: 'blocks',
      title: 'Не створився критичний індекс блоків складу',
      whatBroke: 'Не підтверджено правило: один товар може бути тільки в одному непорожньому блоці, а порожніх блоків може бути декілька.',
      howToFix: [
        'Перевірте db.blocks.getIndexes().',
        'Має існувати one_product_per_nonempty_block UNIQUE PARTIAL по productIds.0 exists.',
        'Застарілого productIds_1 UNIQUE sparse після syncIndexes бути не повинно.',
        'Виправте дублікати товарів між блоками або індекс і перезапустіть сервер.',
      ],
      models: [Block],
    });

    await syncCritical({
      key: 'picking_tasks',
      title: 'Не створився критичний індекс складських задач',
      whatBroke: 'Не підтверджено правило: одна активна задача товару на групу І конкретну ordering-сесію, або лишився застарілий індекс.',
      howToFix: [
        'Перевірте db.pickingtasks.getIndexes().',
        'Перевірте, що активний unique index містить productId + deliveryGroupId + orderingSessionId.',
        'Видаліть застарілий productId_1 або старий group-scoped active index лише якщо syncIndexes не зміг зробити це автоматично.',
        'Виправте дублікати активних задач і перезапустіть сервер.',
      ],
      models: [PickingTask],
    });

    await syncCritical({
      key: 'supplements',
      title: 'Не створилися критичні індекси дозамовлень',
      whatBroke: 'Не підтверджено ідемпотентність Wave, позицій дозамовлення або правило однієї заявки магазину.',
      howToFix: [
        'Перевірте db.supplementwaves.getIndexes(), db.supplementoffers.getIndexes() і db.supplementrequests.getIndexes().',
        'SupplementWave.containerKey має бути UNIQUE для group+session; modern SupplementOffer = waveId+receiptItemId; SupplementRequest = offerId+revision+shopId.',
        'Звірте дублікати Wave/items/requests, виправте дані та перезапустіть сервер.',
      ],
      models: [require('./models/SupplementWave'), require('./models/SupplementOffer'), require('./models/SupplementRequest')],
    });


    await syncCritical({
      key: 'telegram_delivery_ledger',
      title: 'Не створилися критичні індекси журналу Telegram-доставки',
      whatBroke: 'Не підтверджено правило: одна системна подія має лише один delivery-row на конкретного адресата.',
      howToFix: [
        'Перевірте db.telegramnotificationevents.getIndexes() і db.telegramnotificationdeliveries.getIndexes().',
        'Мають існувати UNIQUE eventKey та UNIQUE eventKey+channel+recipientId.',
        'Виправте дублікати журналу та перезапустіть сервер.',
      ],
      models: [require('./models/TelegramNotificationEvent'), require('./models/TelegramNotificationDelivery')],
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
    } catch (err) {
    }

    // Некритичні TTL-індекси журналів.
    try {
      await require('./models/ShopAuditLog').syncIndexes();
      await require('./models/ReceiptItemLog').syncIndexes();
      await require('./models/VisionTestLog').syncIndexes();
      await require('./models/CatalogReview').syncIndexes();
    } catch (err) {
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
    } else {
      startRetentionScheduler();
      startSupplementScheduler();
      startOrderingOpenScheduler();
      startTelegramDeliveryScheduler();
      startPickingMaintenanceScheduler();
    }

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        process.exit(1);
      }
      throw err;
    });

    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };

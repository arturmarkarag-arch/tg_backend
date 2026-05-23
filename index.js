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
const { initSocket } = require('./socket');
const AppSetting = require('./models/AppSetting');
const { migrateOrdersToSessionIds } = require('./utils/getOrCreateSession');
const { ensureShopProductIndexes } = require('./utils/ensureShopProductIndexes');

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
const MONGODB_URI = process.env.MONGODB_URI || (process.env.NODE_ENV === 'production' ? null : 'mongodb://localhost:27017/tg_manager');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function startServer() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is required in production');
    }
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');
    await migrateOrdersToSessionIds();
    await ensureShopProductIndexes();


    // Prefer key stored in DB (via admin settings), fall back to env
    const keyFromDb = await AppSetting.findOne({ key: 'openai.apiKey' }).lean();
    const OPENAI_API_KEY = keyFromDb?.value || process.env.OPENAI_API_KEY;
    initOpenAI(OPENAI_API_KEY);
    initBot(TELEGRAM_BOT_TOKEN);

    const server = http.createServer(app);
    httpServer = server;
    initSocket(server);

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

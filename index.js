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

    // Prefer key stored in DB (via admin settings), fall back to env
    const keyFromDb = await AppSetting.findOne({ key: 'openai.apiKey' }).lean();
    const OPENAI_API_KEY = keyFromDb?.value || process.env.OPENAI_API_KEY;
    initOpenAI(OPENAI_API_KEY);
    initBot(TELEGRAM_BOT_TOKEN);

    const server = http.createServer(app);
    initSocket(server);

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

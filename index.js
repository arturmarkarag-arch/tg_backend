const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

const http = require('http');
const mongoose = require('mongoose');
const app = require('./app');
const { initBot } = require('./telegramBot');
const { initOpenAI } = require('./openaiClient');
const { runArchiveCleanup } = require('./routes/archive');
const { initSocket } = require('./socket');

const PORT = Number(process.env.PORT) || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected to MongoDB');

    initOpenAI(OPENAI_API_KEY);
    initBot(TELEGRAM_BOT_TOKEN);

    // Run archive cleanup once on startup, then every 24 hours
    runArchiveCleanup().catch((err) => console.error('Archive cleanup error:', err));
    setInterval(() => {
      runArchiveCleanup().catch((err) => console.error('Archive cleanup error:', err));
    }, 24 * 60 * 60 * 1000);

    const server = http.createServer(app);
    initSocket(server);

    server.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
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

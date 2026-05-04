const express = require('express');
const cors = require('cors');
const path = require('path');
const productsRouter = require('./routes/products');
const usersRouter = require('./routes/users');
const activityRouter = require('./routes/activity');
const warehouseRouter = require('./routes/warehouse');
const ordersRouter = require('./routes/orders');
const deliveryGroupsRouter = require('./routes/deliveryGroups');
const { router: archiveRouter } = require('./routes/archive');
// const broadcastRouter = require('./routes/broadcast');
const blocksRouter = require('./routes/blocks');
const telegramV1Router = require('./routes/v1/telegram');
const adminRouter = require('./routes/admin');
const searchProductsRouter = require('./routes/searchProducts');
const { getBotStatus } = require('./telegramBot');
const { verifyOpenAIConnection } = require('./openaiClient');
const receiptsRouter = require('./routes/receipts');
const pickingRouter = require('./routes/picking');

let broadcastInitialized = false;

function ensureBroadcast(app) {
  if (broadcastInitialized) return;
  broadcastInitialized = true;
  try {
    const { initBroadcast } = require('./broadcast');
    initBroadcast(app);
  } catch (err) {
    console.warn('[Broadcast] Init failed (Redis not available?):', err.message);
    broadcastInitialized = false;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const { telegramAuth } = require('./middleware/telegramAuth');

const publicApiPaths = [
  /^\/api\/search-products(\/.*)?$/,
  /^\/api\/products\/report-missing$/,
  /^\/api\/products\/images(\/.*)?$/,
  /^\/api\/v1\/telegram\/validate$/,
  /^\/api\/v1\/telegram\/register-request$/,
  /^\/api\/v1\/telegram\/me$/,
  /^\/api\/v1\/telegram\/mini-app\/state$/,
  /^\/api\/v1\/telegram\/mini-app\/reset-state$/,
  /^\/api\/delivery-groups\/summary$/,
];

function requireAuthForApi(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  const isPublic = publicApiPaths.some((pattern) => pattern.test(req.path));
  if (isPublic) return next();
  return telegramAuth(req, res, next);
}

app.use(requireAuthForApi);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', environment: process.env.NODE_ENV || 'development' });
});

app.get('/api/bot-status', (req, res) => {
  res.json(getBotStatus());
});

app.get('/api/openai-status', async (req, res) => {
  try {
    const result = await verifyOpenAIConnection();
    res.json(result);
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message || 'OpenAI connection failed' });
  }
});

app.use('/api/products', productsRouter);
app.use('/api/v1/products', productsRouter);
app.use('/api/users', usersRouter);
app.use('/api/activity', activityRouter);
app.use('/api/warehouse', warehouseRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/v1/orders', ordersRouter);
app.use('/api/delivery-groups', deliveryGroupsRouter);
app.use('/api/archive', archiveRouter);
// Broadcast API disabled for now.
// app.use('/api/broadcast', broadcastRouter);
app.use('/api/blocks', blocksRouter);
app.use('/api/search-products', searchProductsRouter);
app.use('/api/receipts', receiptsRouter);
app.use('/api/picking', pickingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/v1/telegram', telegramV1Router);

// Broadcast workers disabled for now.
// if (process.env.REDIS_URL || process.env.ENABLE_BROADCAST === 'true') {
//   ensureBroadcast(app);
// }

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;

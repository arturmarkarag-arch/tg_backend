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
const broadcastRouter = require('./routes/broadcast');
const blocksRouter = require('./routes/blocks');
const { getBotStatus } = require('./telegramBot');
const { verifyOpenAIConnection } = require('./openaiClient');

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
app.use('/api/users', usersRouter);
app.use('/api/activity', activityRouter);
app.use('/api/warehouse', warehouseRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/delivery-groups', deliveryGroupsRouter);
app.use('/api/archive', archiveRouter);
app.use('/api/broadcast', broadcastRouter);
app.use('/api/blocks', blocksRouter);

// Initialize broadcast workers + Bull Board UI (only if Redis is available)
if (process.env.REDIS_URL || process.env.ENABLE_BROADCAST === 'true') {
  ensureBroadcast(app);
}

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;

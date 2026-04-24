const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('./models/User');

const dotenv = require('dotenv');
const envPath = fs.existsSync(path.resolve(__dirname, '.env'))
  ? path.resolve(__dirname, '.env')
  : path.resolve(__dirname, '../.env');
dotenv.config({ path: envPath });

const TARGET_HOST = process.env.TARGET_HOST || 'https://tg-backend-j27i.onrender.com';
const API_BASE = `${TARGET_HOST}/api`;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tg_manager';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

const VIRTUAL_USERS = Number(process.env.LT_USERS) || 30;
const WAREHOUSE_USERS = Number(process.env.LT_WAREHOUSE_USERS) || VIRTUAL_USERS;
const DURATION_SEC = Number(process.env.LT_DURATION) || 60;
const ORDERS_USER_COUNT = Number(process.env.LT_ORDER_USERS) || 5;
const MAX_OFFSET_PAGES = Number(process.env.LT_MAX_OFFSET_PAGES) || 10;
const PAGE_SIZE = 24;

const axiosInstance = axios.create({ timeout: 15000 });

const stats = {
  browse: { total: 0, errors: 0, time: 0 },
  orders: { total: 0, errors: 0, time: 0 },
  groups: { total: 0, errors: 0, time: 0 },
  saveState: { total: 0, errors: 0, time: 0 },
  products: { total: 0, errors: 0, time: 0 },
  warehouse: { total: 0, errors: 0, time: 0 },
  images: { total: 0, errors: 0, time: 0 },
};

const counters = {
  mongoRequests: 0,
  cloudflareRequests: 0,
  totalRequests: 0,
  totalErrors: 0,
};

const requestTimeline = [];
const errorDetails = [];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(array) {
  return array[randomInt(0, array.length - 1)];
}

function isCloudflareEndpoint(url) {
  const u = String(url).toLowerCase();
  return u.includes('/api/products/images/') || u.includes('/products/images/') || u.includes('cloudflare') || u.includes('r2');
}

function normalizeEndpoint(endpoint) {
  try {
    const url = new URL(String(endpoint), TARGET_HOST);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(endpoint);
  }
}

function maskConnectionString(uri) {
  if (!uri || typeof uri !== 'string') return uri;
  return uri.replace(/(mongodb(?:\+srv)?:\/\/)([^:@\/]+)(:[^@\/]+)?@/, '$1***:***@');
}

function trackRequest(endpoint, duration, isError = false, category = 'other', meta = {}) {
  counters.totalRequests += 1;
  if (isCloudflareEndpoint(endpoint)) {
    counters.cloudflareRequests += 1;
  } else {
    counters.mongoRequests += 1;
  }
  if (isError) counters.totalErrors += 1;
  requestTimeline.push({
    index: counters.totalRequests,
    duration,
    category,
    isError,
    endpoint: normalizeEndpoint(endpoint),
    meta,
  });
}

function captureError(err, endpoint, category, meta = {}) {
  const message = err?.response?.data?.error || err?.message || String(err);
  const status = err?.response?.status || null;
  const timestamp = new Date().toISOString();
  const detail = {
    timestamp,
    endpoint,
    category,
    status,
    message,
    ...meta,
  };
  errorDetails.push(detail);
  if (category === 'warehouse') {
    console.error(`[warehouse error] ${timestamp} endpoint=${endpoint} status=${status} worker=${meta.workerId || 'unknown'} action=${meta.action || 'unknown'} message=${message}`);
  }
}

async function timedRequest(method, url, category, data = null, config = {}, meta = {}) {
  const start = Date.now();
  try {
    const response = await axiosInstance({ method, url, data, ...config });
    const duration = Date.now() - start;
    stats[category].total += 1;
    stats[category].time += duration;
    trackRequest(url, duration, false, category, meta);
    return response;
  } catch (err) {
    const duration = Date.now() - start;
    stats[category].total += 1;
    stats[category].errors += 1;
    trackRequest(url, duration, true, category, meta);
    captureError(err, url, category, meta);
    throw err;
  }
}

function buildScaledProfiles(groups, targetUsers) {
  const totalGroupUsers = groups.reduce((sum, group) => sum + group.count, 0);
  const profiles = [];

  for (const group of groups) {
    const count = Math.max(1, Math.round((group.count / totalGroupUsers) * targetUsers));
    for (let i = 0; i < count; i += 1) profiles.push({ ...group });
  }

  while (profiles.length > targetUsers) profiles.pop();
  while (profiles.length < targetUsers) profiles.push(groups[groups.length - 1]);
  return profiles;
}

async function ensureBuyerUsers() {
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const buyers = [];

  for (let i = 1; i <= ORDERS_USER_COUNT; i += 1) {
    const telegramId = `loadtest_buyer_${i}`;
    let user = await User.findOne({ telegramId }).lean();
    if (!user) {
      user = await User.create({
        telegramId,
        role: 'seller',
        firstName: `Buyer${i}`,
        lastName: 'LoadTest',
        shopName: `LoadTest Shop ${i}`,
        shopCity: 'TestCity',
      });
    }
    buyers.push(user || { telegramId });
  }

  await mongoose.disconnect();
  return buyers.map((user) => user.telegramId || user);
}

async function fetchProducts(offset, limit = PAGE_SIZE) {
  try {
    const res = await timedRequest('get', `${API_BASE}/v1/products?limit=${limit}&offset=${offset}`, 'browse');
    const products = res.data?.items || res.data;
    if (Array.isArray(products) && products.length) {
      const item = randomChoice(products);
      const imageUrl = item.image_url || (Array.isArray(item.imageUrls) && item.imageUrls[0]) || item.localImageUrl;
      if (imageUrl) {
        await fetchImage(imageUrl);
      }
    }
    return products;
  } catch (err) {
    return null;
  }
}

async function fetchProductDetail(productId) {
  try {
    const res = await timedRequest('get', `${API_BASE}/products/${productId}`, 'browse');
    const product = res.data || {};
    const imageUrl = product.image_url || (Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl;
    if (imageUrl) {
      await fetchImage(imageUrl);
    }
  } catch (err) {
    // ignore
  }
}

async function fetchDeliveryGroups() {
  try {
    await timedRequest('get', `${API_BASE}/delivery-groups`, 'groups');
  } catch (err) {
    // ignore
  }
}

async function fetchImage(imageUrl) {
  if (!imageUrl) return;
  const url = String(imageUrl).startsWith('http') ? imageUrl : `${TARGET_HOST}${imageUrl}`;
  try {
    await timedRequest('get', url, 'images');
  } catch (err) {
    // ignore
  }
}

async function fetchOrders(buyerTelegramId) {
  try {
    await timedRequest('get', `${API_BASE}/orders?buyerTelegramId=${encodeURIComponent(buyerTelegramId)}&page=1&pageSize=20`, 'orders');
  } catch (err) {
    // ignore
  }
}

async function fetchBlocks() {
  try {
    const res = await timedRequest('get', `${API_BASE}/blocks`, 'warehouse');
    return res.data || [];
  } catch (err) {
    return [];
  }
}

async function fetchIncomingProducts() {
  try {
    const res = await timedRequest('get', `${API_BASE}/blocks/incoming/products`, 'warehouse');
    return res.data || [];
  } catch (err) {
    return [];
  }
}

function buildTelegramInitData(telegramId, firstName) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const rawData = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    hash: '',
    user: JSON.stringify({ id: telegramId, first_name: firstName }),
  };
  const dataCheckString = Object.keys(rawData)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${rawData[key]}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TELEGRAM_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  rawData.hash = hash;
  const params = new URLSearchParams(rawData);
  return params.toString();
}

async function saveMiniAppState(buyerTelegramId, pageIndex, items = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    stats.saveState.total += 1;
    stats.saveState.errors += 1;
    trackRequest(`${API_BASE}/v1/telegram/mini-app/state`, 0, true, 'saveState');
    return;
  }

  const initData = buildTelegramInitData(buyerTelegramId, `Buyer${buyerTelegramId}`);
  const productId = `product-${pageIndex}`;
  const orderItems = Object.keys(items).length ? items : { [`item-${pageIndex}`]: randomInt(1, 3) };

  try {
    await timedRequest('post', `${API_BASE}/v1/telegram/mini-app/state`, 'saveState', {
      initData,
      currentIndex: pageIndex * PAGE_SIZE,
      currentPage: pageIndex,
      productId,
      orderItems,
      viewMode: 'carousel',
    }, {}, { action: 'saveState', workerId: buyerTelegramId });
  } catch (err) {
    // ignore
  }
}

async function createOrder(buyerTelegramId, productPool) {
  if (!productPool?.length) {
    stats.orders.total += 1;
    stats.orders.errors += 1;
    trackRequest(`${API_BASE}/v1/orders`, 0, true, 'orders');
    return;
  }

  const count = randomInt(1, Math.min(4, productPool.length));
  const items = [];
  const chosen = new Set();
  while (items.length < count) {
    const index = randomInt(0, productPool.length - 1);
    if (chosen.has(index)) continue;
    chosen.add(index);
    const product = productPool[index];
    if (!product?.id || typeof product.price !== 'number') continue;
    items.push({ productId: product.id, price: product.price, quantity: randomInt(1, 3) });
  }

  try {
    await timedRequest('post', `${API_BASE}/v1/orders`, 'orders', {
      buyerTelegramId,
      items,
      shippingAddress: `LoadTest Street ${randomInt(1, 100)}`,
      contactInfo: `loadtest+${buyerTelegramId}@example.com`,
    }, {}, { action: 'createOrder', workerId: buyerTelegramId });
  } catch (err) {
    // ignore
  }
}

async function createNewProduct(workerId) {
  try {
    await timedRequest('post', `${API_BASE}/products`, 'products', {
      orderNumber: randomInt(1, 1000),
      name: `LoadTest Product ${crypto.randomUUID().slice(0, 8)}`,
      category: 'LoadTest',
      brand: 'LoadTestBrand',
      model: `LTP-${randomInt(100, 999)}`,
      price: randomInt(10, 200),
      quantity: randomInt(1, 20),
      warehouse: 'LoadTest',
      status: 'pending',
    }, {}, { action: 'createProduct', workerId: `warehouse_${workerId}` });
  } catch (err) {
    // ignore
  }
}

async function assignWarehouseTask(workerId) {
  const products = await fetchIncomingProducts();
  if (!products?.length) return;
  const picked = products.slice(0, Math.min(products.length, randomInt(1, 4))).map((product) => product._id || product.id);

  try {
    await timedRequest('post', `${API_BASE}/warehouse/assign`, 'warehouse', {
      productIds: picked,
      workerId: `warehouse_${workerId}`,
    }, {}, { action: 'assign', workerId: `warehouse_${workerId}` });
  } catch (err) {
    // ignore
  }
}

async function moveProductBetweenBlocks(workerId) {
  const blocks = await fetchBlocks();
  const filledBlocks = blocks.filter((b) => Array.isArray(b.productIds) && b.productIds.length > 0);
  if (!filledBlocks.length) return;
  const source = randomChoice(filledBlocks);
  const target = randomChoice(blocks.filter((b) => b.blockId !== source.blockId));
  if (!target) return;

  const eid = source.productIds[randomInt(0, source.productIds.length - 1)];
  const productId = (eid._id || eid.id || eid).toString();
  const toIndex = randomInt(0, (target.productIds?.length || 0));

  try {
    await timedRequest('post', `${API_BASE}/blocks/move`, 'warehouse', {
      productId,
      fromBlock: source.blockId,
      toBlock: target.blockId,
      toIndex,
    }, {}, { action: 'move', workerId: `warehouse_${workerId}` });
  } catch (err) {
    // ignore
  }
}

async function addProductToBlock(workerId) {
  const blocks = await fetchBlocks();
  if (!blocks.length) return;
  const block = randomChoice(blocks);
  const products = await fetchProducts(randomInt(0, MAX_OFFSET_PAGES - 1), 10);
  if (!products?.length) return;
  const product = randomChoice(products);
  if (!product?.id) return;

  try {
    await timedRequest('post', `${API_BASE}/blocks/${block.blockId}/add`, 'warehouse', {
      productId: product.id,
      index: 0,
    }, {}, { action: 'block_add', workerId: `warehouse_${workerId}` });
  } catch (err) {
    // ignore
  }
}

async function swipeAction(profile, currentPage, productPool) {
  const offset = currentPage * PAGE_SIZE;
  const products = await fetchProducts(offset);
  if (products?.length) {
    const detailProduct = randomChoice(products);
    if (detailProduct?.id) await fetchProductDetail(detailProduct.id);
    return { productPool: products, currentPage: (currentPage + 1) % MAX_OFFSET_PAGES };
  }
  return { productPool, currentPage: randomInt(0, MAX_OFFSET_PAGES - 1) };
}

async function cartAction(profile, buyerTelegramIds, currentPage, productPool) {
  const buyerTelegramId = randomChoice(buyerTelegramIds);
  const cartQty = profile.cartQuantity || 1;
  const items = {};
  if (productPool?.length) {
    for (let i = 0; i < cartQty; i += 1) {
      const product = randomChoice(productPool);
      if (product?.id) items[product.id] = (items[product.id] || 0) + 1;
    }
  }
  await saveMiniAppState(buyerTelegramId, currentPage, items);
}

async function warehouseAction(profile, workerId) {
  const action = randomChoice(['assign', 'move', 'create', 'block_add', 'fetchOrders']);
  switch (action) {
    case 'assign':
      await assignWarehouseTask(workerId);
      break;
    case 'move':
      await moveProductBetweenBlocks(workerId);
      break;
    case 'create':
      await createNewProduct(workerId);
      break;
    case 'block_add':
      await addProductToBlock(workerId);
      break;
    case 'fetchOrders':
      await fetchOrders(`warehouse_${workerId}`);
      break;
    default:
      await fetchBlocks();
  }
}

const SHOP_GROUPS = [
  { count: 20, swipeIntervalMs: 333, cartIntervalMs: 1000, cartQuantity: 1 },
  { count: 20, swipeIntervalMs: 500, cartIntervalMs: 1500, cartQuantity: 1 },
  { count: 15, swipeIntervalMs: 1000, cartIntervalMs: 500, cartQuantity: 2 },
];

const WAREHOUSE_GROUPS = [
  { count: 20, actionIntervalMs: 1000 },
  { count: 20, actionIntervalMs: 1500 },
  { count: 15, actionIntervalMs: 2000 },
];

async function shopWorker(id, profile, buyerTelegramIds) {
  const startTime = Date.now();
  let currentPage = 0;
  let productPool = [];
  let nextSwipe = startTime;
  let nextCart = startTime;

  while (Date.now() - startTime < DURATION_SEC * 1000) {
    const now = Date.now();
    if (now >= nextSwipe) {
      const result = await swipeAction(profile, currentPage, productPool);
      productPool = result.productPool;
      currentPage = result.currentPage;
      nextSwipe += profile.swipeIntervalMs;
    }
    if (now >= nextCart) {
      await cartAction(profile, buyerTelegramIds, currentPage, productPool);
      nextCart += profile.cartIntervalMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function warehouseWorker(id, profile) {
  const startTime = Date.now();
  let nextAction = startTime;

  while (Date.now() - startTime < DURATION_SEC * 1000) {
    const now = Date.now();
    if (now >= nextAction) {
      await warehouseAction(profile, id);
      nextAction += profile.actionIntervalMs;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function generateHtmlReport() {
  const rows = Object.entries(stats).map(([key, entry]) => ({
    action: key,
    total: entry.total,
    errors: entry.errors,
    avgMs: entry.total ? (entry.time / entry.total).toFixed(1) : 0,
    errorRate: entry.total ? (entry.errors / entry.total) : 0,
  }));
  const totalRequests = rows.reduce((sum, row) => sum + row.total, 0);
  const totalErrors = rows.reduce((sum, row) => sum + row.errors, 0);

  const bucketSize = Math.max(1, Math.floor(requestTimeline.length / 40));
  const buckets = [];
  let sum = 0;
  let count = 0;
  requestTimeline.forEach((item, index) => {
    sum += item.duration;
    count += 1;
    if ((index + 1) % bucketSize === 0 || index === requestTimeline.length - 1) {
      buckets.push({ x: index + 1, y: Number((sum / count).toFixed(1)) });
      sum = 0;
      count = 0;
    }
  });

  const endpointMap = {};
  requestTimeline.forEach((item) => {
    const key = `${item.category}|${item.endpoint}`;
    if (!endpointMap[key]) {
      endpointMap[key] = {
        category: item.category,
        endpoint: item.endpoint,
        total: 0,
        errors: 0,
        time: 0,
      };
    }
    endpointMap[key].total += 1;
    endpointMap[key].errors += item.isError ? 1 : 0;
    endpointMap[key].time += item.duration;
  });

  const endpointRows = Object.values(endpointMap).map((entry) => ({
    category: entry.category,
    endpoint: entry.endpoint,
    total: entry.total,
    errors: entry.errors,
    avgMs: entry.total ? (entry.time / entry.total).toFixed(1) : 0,
    errorRate: entry.total ? (entry.errors / entry.total) : 0,
  }));

  const topSlowEndpoints = endpointRows
    .filter((entry) => entry.total >= 3)
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 10);

  const topErrorEndpoints = endpointRows
    .filter((entry) => entry.errors > 0)
    .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors)
    .slice(0, 10);

  const errorRows = errorDetails.slice(-15).map((item) => ({
    timestamp: item.timestamp,
    endpoint: item.endpoint,
    category: item.category,
    message: item.message,
    status: item.status || 'N/A',
    workerId: item.workerId || 'unknown',
    action: item.action || 'unknown',
  }));

  const slowCategories = rows.filter((item) => item.total >= 10 && item.avgMs > 3000);
  const errorCategories = rows.filter((item) => item.total >= 10 && item.errorRate >= 0.1);
  const recommendations = [];
  if (slowCategories.length) {
    recommendations.push(`High latency detected in categories: ${slowCategories.map((item) => `${item.action} (${item.avgMs}ms avg)`).join(', ')}.`);
  }
  if (errorCategories.length) {
    recommendations.push(`Elevated error rate in categories: ${errorCategories.map((item) => `${item.action} (${(item.errorRate * 100).toFixed(1)}%)`).join(', ')}.`);
  }
  if (topSlowEndpoints.length) {
    recommendations.push(`Investigate slow endpoints: ${topSlowEndpoints.slice(0, 3).map((entry) => `${entry.endpoint} (${entry.avgMs}ms)`).join(', ')}.`);
  }
  if (topErrorEndpoints.length) {
    recommendations.push(`Investigate error-prone endpoints: ${topErrorEndpoints.slice(0, 3).map((entry) => `${entry.endpoint} (${(entry.errorRate * 100).toFixed(1)}% errors)`).join(', ')}.`);
  }
  if (!recommendations.length) {
    recommendations.push('No obvious hotspots detected from request metrics, but continue checking backend logs and database performance.');
  }

  const chartData = JSON.stringify(buckets);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Load Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; background:#111; color:#eee; padding:24px; }
    table { width:100%; border-collapse:collapse; margin-bottom:24px; }
    th, td { border:1px solid #444; padding:10px; text-align:left; }
    th { background:#222; }
    tr:nth-child(even) { background:#1c1c1c; }
    .section { margin-bottom:24px; }
    .badge { display:inline-block; padding:4px 10px; border-radius:999px; background:#222; color:#fff; margin-right:8px; }
    code { background:#222; padding:2px 6px; border-radius:4px; }
    canvas { background:#0f0f0f; border:1px solid #333; width:100%; max-width:900px; height:320px; }
  </style>
</head>
<body>
  <h1>Load Test Report</h1>
  <div class="section">
    <p><span class="badge">Target</span>${TARGET_HOST}</p>
    <p><span class="badge">Shop users</span>${VIRTUAL_USERS}</p>
    <p><span class="badge">Warehouse users</span>${WAREHOUSE_USERS}</p>
    <p><span class="badge">Duration</span>${DURATION_SEC}s</p>
    <p><span class="badge">Mongo URI</span>${maskConnectionString(MONGODB_URI)}</p>
    <p><span class="badge">Telegram token</span>${TELEGRAM_BOT_TOKEN ? 'present' : 'missing'}</p>
    <p><span class="badge">Mongo requests</span>${counters.mongoRequests}</p>
    <p><span class="badge">Cloudflare requests</span>${counters.cloudflareRequests}</p>
  </div>
  <div class="section">
    <h2>Tested Services</h2>
    <ul>
      <li>Vercel frontend: статичні файли JS/CSS/HTML</li>
      <li>Render backend: API <code>/api/v1/products</code>, <code>/api/orders</code>, <code>/api/delivery-groups</code>, <code>/api/warehouse/assign</code>, <code>/api/blocks/move</code>, <code>/api/products</code>, <code>/v1/telegram/mini-app/state</code></li>
      <li>MongoDB: зберігання користувачів, стану, замовлень, продуктів</li>
      <li>Cloudflare / R2: фотографії не тестуються безпосередньо, але фото кешування працює окремо</li>
    </ul>
  </div>
  <div class="section">
    <h2>What is tested</h2>
    <ul>
      <li>Товарні сторінки: сторінкові запити продуктів і індивідуальні деталі</li>
      <li>Додавання товарів до кошика через mini-app state</li>
      <li>Оформлення замовлень</li>
      <li>Отримання списку замовлень</li>
      <li>Складські дії: призначення завдань, створення товарів, переміщення між блоками</li>
    </ul>
  </div>
  <div class="section">
    <h2>Results</h2>
    <table>
      <thead>
        <tr><th>Action</th><th>Total</th><th>Errors</th><th>Avg ms</th><th>Error %</th></tr>
      </thead>
      <tbody>
        ${rows.map((row) => `<tr><td>${row.action}</td><td>${row.total}</td><td>${row.errors}</td><td>${row.avgMs}</td><td>${(row.errorRate * 100).toFixed(1)}%</td></tr>`).join('')}
      </tbody>
    </table>
    <p>Total requests: ${totalRequests}</p>
    <p>Total errors: ${totalErrors}</p>
  </div>
  <div class="section">
    <h2>Hot spots</h2>
    <ul>
      ${recommendations.map((text) => `<li>${text}</li>`).join('')}
    </ul>
  </div>
  <div class="section">
    <h2>Top slow endpoints</h2>
    <table>
      <thead><tr><th>Category</th><th>Endpoint</th><th>Total</th><th>Errors</th><th>Avg ms</th><th>Error %</th></tr></thead>
      <tbody>
        ${topSlowEndpoints.map((entry) => `<tr><td>${entry.category}</td><td>${entry.endpoint}</td><td>${entry.total}</td><td>${entry.errors}</td><td>${entry.avgMs}</td><td>${(entry.errorRate * 100).toFixed(1)}%</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="section">
    <h2>Top error endpoints</h2>
    <table>
      <thead><tr><th>Category</th><th>Endpoint</th><th>Total</th><th>Errors</th><th>Avg ms</th><th>Error %</th></tr></thead>
      <tbody>
        ${topErrorEndpoints.map((entry) => `<tr><td>${entry.category}</td><td>${entry.endpoint}</td><td>${entry.total}</td><td>${entry.errors}</td><td>${entry.avgMs}</td><td>${(entry.errorRate * 100).toFixed(1)}%</td></tr>`).join('')}
      </tbody>
    </table>
  </div>
  <div class="section">
    <h2>Error samples</h2>
    ${errorRows.length ? `<table><thead><tr><th>Time</th><th>Category</th><th>Endpoint</th><th>Action</th><th>Worker</th><th>Status</th><th>Message</th></tr></thead><tbody>${errorRows.map((row) => `<tr><td>${row.timestamp}</td><td>${row.category}</td><td>${row.endpoint}</td><td>${row.action}</td><td>${row.workerId}</td><td>${row.status}</td><td>${row.message}</td></tr>`).join('')}</tbody></table>` : '<p>No errors captured.</p>'}
  </div>
  <div class="section">
    <h2>Latency growth</h2>
    <canvas id="latencyChart"></canvas>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    const chartData = ${chartData};
    const ctx = document.getElementById('latencyChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartData.map((item) => item.x),
        datasets: [{
          label: 'Avg latency (ms)',
          data: chartData.map((item) => item.y),
          borderColor: '#5bc0de',
          backgroundColor: 'rgba(91,192,222,0.2)',
          fill: true,
          tension: 0.25,
        }],
      },
      options: {
        scales: {
          x: { title: { display: true, text: 'Request count' } },
          y: { title: { display: true, text: 'Average latency (ms)' }, beginAtZero: true },
        },
      },
    });
  </script>
</body>
</html>`;
  fs.writeFileSync('load-test-report.html', html, 'utf8');
  console.log('HTML report written to load-test-report.html');
}

function printSummary() {
  const summary = [];
  for (const [key, entry] of Object.entries(stats)) {
    summary.push({
      action: key,
      total: entry.total,
      errors: entry.errors,
      avgMs: entry.total ? (entry.time / entry.total).toFixed(1) : 0,
    });
  }
  console.table(summary);
  const totalRequests = Object.values(stats).reduce((sum, item) => sum + item.total, 0);
  const totalErrors = Object.values(stats).reduce((sum, item) => sum + item.errors, 0);
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Total errors: ${totalErrors}`);
  console.log(`Estimated Mongo requests: ${counters.mongoRequests}`);
  console.log(`Estimated Cloudflare requests: ${counters.cloudflareRequests}`);
  if (errorDetails.length) {
    console.log('Warehouse error samples:');
    errorDetails.filter((d) => d.category === 'warehouse').slice(-5).forEach((detail) => {
      console.log(`${detail.timestamp} ${detail.workerId || 'unknown'} ${detail.action || 'unknown'} ${detail.endpoint} ${detail.status || 'N/A'} ${detail.message}`);
    });
  }
  generateHtmlReport();
}

(async () => {
  console.log(`Target: ${TARGET_HOST}`);
  console.log(`Shop users: ${VIRTUAL_USERS}`);
  console.log(`Warehouse users: ${WAREHOUSE_USERS}`);
  console.log(`Duration: ${DURATION_SEC}s`);
  console.log('Seeding buyer users...');
  const buyerTelegramIds = await ensureBuyerUsers();
  console.log(`Buyer users: ${buyerTelegramIds.join(', ')}`);

  const shopProfiles = buildScaledProfiles(SHOP_GROUPS, VIRTUAL_USERS);
  const warehouseProfiles = buildScaledProfiles(WAREHOUSE_GROUPS, WAREHOUSE_USERS);

  const workers = [];
  shopProfiles.forEach((profile, index) => workers.push(shopWorker(index + 1, profile, buyerTelegramIds)));
  warehouseProfiles.forEach((profile, index) => workers.push(warehouseWorker(index + 1, profile)));

  await Promise.all(workers);
  printSummary();
  process.exit(0);
})().catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});

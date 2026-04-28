const TelegramBot = require('node-telegram-bot-api');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const crypto = require('crypto');
const { shiftUp: shiftOrderUp } = require('./utils/shiftOrderNumbers');
const { analyzeBarcodeImage, analyzeProductImage } = require('./openaiClient');
const { decodeBarcodeFromImageBuffer, normalizeBarcode } = require('./utils/barcodeScanner');
const User = require('./models/User');
const Product = require('./models/Product');
// WARNING: SearchProduct is a completely independent schema from Product.
// Admin group replies that create SearchProduct records must not be treated as warehouse inventory.
const SearchProduct = require('./models/SearchProduct');
const Order = require('./models/Order');

const PendingReaction = require('./models/PendingReaction');
const BotSession = require('./models/BotSession');
const BotInteractionLog = require('./models/BotInteractionLog');
const RegistrationRequest = require('./models/RegistrationRequest');
const DeliveryGroup = require('./models/DeliveryGroup');
const Block = require('./models/Block');
const { getIO } = require('./socket');
const r2Client = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

// DB-backed session helpers (survive restart)
const SESSION_TTL = {
  receive: 30 * 60 * 1000,       // 30 min
  shelf: 2 * 60 * 60 * 1000,     // 2 hours
  shop: 2 * 60 * 60 * 1000,      // 2 hours
  ship: 4 * 60 * 60 * 1000,      // 4 hours
};

async function getSession(chatId, type, key = '') {
  const doc = await BotSession.findOne({ chatId: String(chatId), type, key }).lean();
  return doc?.data || null;
}

async function setSession(chatId, type, data, key = '') {
  const ttl = SESSION_TTL[type] || 60 * 60 * 1000;
  await BotSession.findOneAndUpdate(
    { chatId: String(chatId), type, key },
    { data, expiresAt: new Date(Date.now() + ttl) },
    { upsert: true, new: true }
  );
}

async function deleteSession(chatId, type, key = '') {
  await BotSession.deleteOne({ chatId: String(chatId), type, key });
}

async function updateUserBotActivity(chatId) {
  try {
    await User.findOneAndUpdate(
      { telegramId: String(chatId) },
      {
        botBlocked: false,
        botLastActivityAt: new Date(),
        botLastSessionAt: new Date(),
      }
    );
  } catch (_) {}
}

async function persistUserBotState(chatId, state) {
  try {
    await User.findOneAndUpdate(
      { telegramId: String(chatId) },
      { $set: state },
      { new: true }
    );
  } catch (_) {}
}

async function markUserBotBlocked(chatId) {
  try {
    await User.findOneAndUpdate({ telegramId: String(chatId) }, { botBlocked: true });
  } catch (_) {}
}

function getProductTitle(product) {
  return product.brand || product.model || product.category || `#${product.orderNumber}`;
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isPriceLookupCaption(caption) {
  if (!caption) return false;
  const text = caption.trim().toLowerCase();
  if (/^(?:ціна|цена|price|\?)+$/.test(text)) return true;
  return /\b(?:ціна|цена|price)\b/.test(text);
}

function isBarcodeLookupCaption(caption) {
  if (!caption) return false;
  const text = caption.trim().toLowerCase();
  return /(?:^|[^A-Za-z0-9_])(штрихкод|barcode|штрих-код)(?:$|[^A-Za-z0-9_])/i.test(text);
}

function isBarcodeLookupText(text) {
  if (!text) return false;
  const normalized = String(text).trim().toLowerCase();
  if (/(?:^|[^A-Za-z0-9_])(штрихкод|barcode|штрих-код)(?:$|[^A-Za-z0-9_])/i.test(normalized)) return true;
  const digits = normalized.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 14 && /^[0-9\s\-]+$/.test(normalized);
}

function parseAdminPriceReply(text) {
  if (!text) return null;
  const raw = String(text).trim();
  if (!/^[0-9]+(?:[\.,][0-9]+)?$/.test(raw)) return null;
  const normalized = raw.replace(',', '.');
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function validateEAN(barcode) {
  if (!/^[0-9]+$/.test(barcode)) return false;
  const len = barcode.length;
  if (![8, 12, 13].includes(len)) return false;
  const digits = barcode.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const positionFromRight = digits.length - i;
    const weight = positionFromRight % 2 === 0 ? 1 : 3;
    sum += digits[i] * weight;
  }
  const mod = sum % 10;
  const expected = mod === 0 ? 0 : 10 - mod;
  return expected === check;
}

function chooseBarcodeCandidate(text) {
  if (!text) return '';
  const normalized = String(text).replace(/[^0-9]/g, ' ');
  const candidates = normalized
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 8 && segment.length <= 14);

  if (!candidates.length) return '';

  const valid = candidates.filter((candidate) => validateEAN(candidate));
  if (valid.length) {
    return valid.sort((a, b) => b.length - a.length)[0];
  }

  return candidates.sort((a, b) => b.length - a.length)[0] || '';
}

async function recognizeBarcodeFromBuffer(buffer) {
  const zxingResult = await decodeBarcodeFromImageBuffer(buffer);
  const rawText = String(zxingResult.text || '').trim();
  const zxingFormat = String(zxingResult.format || 'UNKNOWN');
  const isQr = /qr/i.test(zxingFormat);
  let barcode = '';
  let qrCode = '';
  let recognitionSource = 'ZXing';
  let details = `ZXing format=${zxingFormat}`;

  if (rawText) {
    if (isQr) {
      qrCode = rawText;
    } else {
      barcode = normalizeBarcode(rawText);
    }
  }

  if (!barcode && !qrCode) {
    const result = await analyzeBarcodeImage(buffer);
    const scannedBarcode = normalizeBarcode(result.scannedBarcode || '');
    const digitsOnBarcode = normalizeBarcode(result.digitsOnBarcode || '');
    const chosenBarcode = scannedBarcode || digitsOnBarcode || '';
    barcode = chosenBarcode;
    recognitionSource = 'OpenAI';
    details = `OpenAI scannedBarcode=${scannedBarcode || '—'} digitsOnBarcode=${digitsOnBarcode || '—'}`;
    return { barcode, qrCode, recognitionSource, details, rawText: result.rawText || '' };
  }

  return { barcode, qrCode, recognitionSource, details, rawText, zxingFormat };
}

async function findProductByBarcode(barcode) {
  if (!barcode) return null;
  const normalized = normalizeBarcode(barcode);
  const conditions = [];
  if (normalized) {
    conditions.push({ barcode: { $regex: `^${escapeRegex(normalized)}$`, $options: 'i' } });
  }
  const rawText = String(barcode).trim();
  if (rawText) {
    conditions.push({ qrCode: { $regex: `^${escapeRegex(rawText)}$`, $options: 'i' } });
  }
  if (!conditions.length) return null;
  const product = await Product.findOne({ $or: conditions }).lean();
  return product;
}

function scoreProductMatch(product, data) {
  const weight = {
    brand: 3,
    model: 4,
    category: 2,
    title: 1,
    barcode: 5,
    textOnImage: 1,
  };
  const text = [product.name, product.brand, product.model, product.category, product.textOnImage, product.barcode].join(' ').toLowerCase();
  let score = 0;
  if (data.brand && text.includes(data.brand.toLowerCase())) score += weight.brand;
  if (data.model && text.includes(data.model.toLowerCase())) score += weight.model;
  if (data.category && text.includes(data.category.toLowerCase())) score += weight.category;
  if (data.title && text.includes(data.title.toLowerCase())) score += weight.title;
  if (data.barcode && product.barcode && product.barcode.toLowerCase().includes(data.barcode.toLowerCase())) score += weight.barcode;
  if (data.textOnImage && text.includes(data.textOnImage.toLowerCase())) score += weight.textOnImage;
  return score;
}

async function findProductCandidates(gptData) {
  const conditions = [];
  const fields = ['brand', 'model', 'category'];
  fields.forEach((field) => {
    if (gptData[field]) {
      conditions.push({ [field]: { $regex: escapeRegex(gptData[field]), $options: 'i' } });
    }
  });
  if (gptData.barcode) {
    conditions.push({ barcode: { $regex: escapeRegex(gptData.barcode), $options: 'i' } });
  }
  if (gptData.title) {
    const terms = gptData.title.split(/\s+/).filter(Boolean).slice(0, 5);
    terms.forEach((term) => conditions.push({ $or: [
      { name: { $regex: escapeRegex(term), $options: 'i' } },
      { brand: { $regex: escapeRegex(term), $options: 'i' } },
      { model: { $regex: escapeRegex(term), $options: 'i' } },
      { category: { $regex: escapeRegex(term), $options: 'i' } },
    ] }));
  }
  if (!conditions.length) return [];
  const products = await Product.find({ status: { $ne: 'archived' }, $or: conditions }).lean();
  return products
    .map((product) => ({
      ...product,
      title: getProductTitle(product),
      imageUrl: product.imageUrls?.[0] || product.localImageUrl || '',
      imageUrls: product.imageUrls || [],
      additionalImageUrls: product.additionalImageUrls || [],
      matchScore: scoreProductMatch(product, gptData),
    }))
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}

function getProductPhotoSources(product) {
  const sources = [];
  if (product.telegramFileId) sources.push(product.telegramFileId);
  const mainSource = getPhotoUrl(product.imageUrls?.[0] || product.localImageUrl);
  if (mainSource && !sources.includes(mainSource)) sources.push(mainSource);
  for (const url of product.additionalImageUrls || []) {
    const resolved = getPhotoUrl(url);
    if (resolved && !sources.includes(resolved)) {
      sources.push(resolved);
    }
    if (sources.length >= 5) break;
  }
  return sources;
}

async function sendProductPhotos(chatId, product) {
  const sources = getProductPhotoSources(product);
  if (!sources.length) return;

  const safeCaption = `Фото: ${product.title || 'товар'}${product.price ? ` — ${product.price} zł` : ''}`;
  for (let i = 0; i < sources.length; i += 1) {
    const source = sources[i];
    const sendOpts = { caption: i === 0 ? safeCaption : undefined };
    try {
      await sendPhotoWithRetry(chatId, source, sendOpts);
      await delay(200);
    } catch (error) {
      console.warn('[Bot] Failed to send product photo', product._id, error?.message || error);
    }
  }
}

function buildProductInfoText(product) {
  if (!product) return 'Товар не знайдено.';
  const lines = [
    `🔎 Знайдено товар: ${getProductTitle(product)}`,
    `💰 Ціна: ${product.price} zł`,
    `📦 Кількість: ${product.quantity ?? '—'}`,
    product.brand ? `Бренд: ${product.brand}` : null,
    product.model ? `Модель: ${product.model}` : null,
    product.category ? `Категорія: ${product.category}` : null,
    product.barcode ? `Штрихкод: ${product.barcode}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function buildPriceLookupText(candidates, usage = {}) {
  const header = candidates.length
    ? `🔎 Результат пошуку:
` 
    : '';
  if (!candidates.length) {
    const notFoundText = 'Не вдалося знайти відповідний товар у базі. Спробуйте надіслати інше фото або очистити фон.';
    return `${notFoundText}${formatUsageText(usage)}`;
  }

  const top = candidates[0];
  const lines = [
    `🔎 Ймовірний товар: ${top.title}`,
    `💰 Ціна: ${top.price} zł`,
    `📦 Кількість: ${top.quantity ?? '—'}`,
    top.brand ? `Бренд: ${top.brand}` : null,
    top.model ? `Модель: ${top.model}` : null,
    top.category ? `Категорія: ${top.category}` : null,
  ].filter(Boolean);
  if (candidates.length > 1) {
    lines.push('', 'Інші варіанти:');
    candidates.slice(1).forEach((product, index) => {
      lines.push(`${index + 1}. ${product.title} — ${product.price} zł`);
    });
  }

  return `${lines.join('\n')}${formatUsageText(usage)}`;
}

function formatUsageText(usage = {}) {
  const tokens = Number(usage.totalTokens || usage.total_tokens || 0);
  if (!tokens) return '';
  const totalCost = usage.totalCost ?? null;
  const currency = usage.currency || 'USD';
  const costText = totalCost != null ? `, приблизна ціна: ${currency} ${totalCost}` : '';
  return `\n\nТокенів потрачено: ${tokens}${costText}`;
}

async function logBotInteraction(telegramId, type, action, label = '', context = {}) {
  try {
    await BotInteractionLog.create({ telegramId: String(telegramId), type, action, label, context });
  } catch (_) {}
}

async function handleMyChatMemberUpdate(update) {
  try {
    const payload = update?.my_chat_member || update || {};
    const chatId = String(payload.chat?.id || payload.chat_id || payload.from?.id || '');
    const newStatus = payload.new_chat_member?.status || payload.new_chat_member_status;
    if (!chatId || !newStatus) return;

    if (newStatus === 'kicked') {
      await markUserBotBlocked(chatId);
      await logBotInteraction(chatId, 'system', 'my_chat_member', 'kicked', { payload });
      return;
    }

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      await User.findOneAndUpdate(
        { telegramId: chatId },
        { botBlocked: false, botLastActivityAt: new Date() }
      );
      await logBotInteraction(chatId, 'system', 'my_chat_member', newStatus, { payload });
    }
  } catch (error) {
    console.error('Failed to handle my_chat_member update:', error);
  }
}

async function checkBotAccess(chatId) {
  try {
    await bot.sendChatAction(chatId, 'typing');
    await updateUserBotActivity(chatId);
    return true;
  } catch (error) {
    const errCode = error?.response?.body?.error_code;
    const description = error?.response?.body?.description || '';
    if (errCode === 403 && description.toLowerCase().includes('blocked')) {
      await markUserBotBlocked(chatId);
      return false;
    }
    throw error;
  }
}

async function isChatAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ['administrator', 'creator'].includes(member.status);
  } catch (err) {
    console.warn('Failed to check chat admin status:', err.message || err);
    return false;
  }
}

const SHELF_PAGE_SIZE = 5;
const SHOP_PREFETCH_COUNT = 8;
const SHOP_PREFETCH_THRESHOLD = 5;
const shopPhotoBufferCache = new Map();
const shopPhotoBufferFetchPromises = new Map();

// Guard against double-submit of /order (in-memory is fine, non-critical)
const orderInFlight = new Set();

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || (process.env.NODE_ENV === 'production' ? null : `http://localhost:${process.env.PORT || 5000}`);
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:5173/mini-app';
const ALLOWED_TELEGRAM_GROUP_IDS = (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => Number(id));

function isAuthorizedGroup(chatId) {
  if (!ALLOWED_TELEGRAM_GROUP_IDS.length) return false;
  return ALLOWED_TELEGRAM_GROUP_IDS.includes(Number(chatId));
}

function getMiniAppUrl(role) {
  if (!role) return WEB_APP_URL;
  const url = new URL(WEB_APP_URL);
  url.searchParams.set('role', role);
  return url.toString();
}

let bot = null;
let status = {
  connected: false,
  startedAt: null,
  error: null,
};

const roleCommands = {
  seller: [
    //'/help - Показати доступні команди',
    '/profile - Мій профіль',
    '/miniapp - Відкрити товари',
    // '/shelf - Переглянути товари у вигляді списку',
    '/shop - Переглянути товари в одному товарі з навігацією',
    // '/mylist - Переглянути обрані товари',
    // '/order - Оформити замовлення з обраних товарів',
  ],
  warehouse: [
    //'/help - Показати доступні команди',
    //'/profile - Мій профіль',
    '/receive - Прийняти товар на склад',
    '/ship - Переглянути замовлення для відвантаження',
    '/miniapp - Відкрити склад',
  ],
  admin: [
    //'/help - Показати доступні команди',
    //'/profile - Мій профіль',
    '/miniapp - Відкрити товари',
  ],
};

function buildRoleHelp(role) {
  const commands = roleCommands[role] || roleCommands.admin;
  return `Доступні команди:\n${commands.join('\n')}`;
}

async function sendRegistrationApprovedMessage(chatId, role) {
  await setRoleCommands(chatId, role);
  const roleLabel = role === 'seller' ? 'продавець' : role === 'warehouse' ? 'склад' : role;
  const message = `✅ Ваша заявка на реєстрацію схвалена. Ви тепер зареєстровані як ${roleLabel}.\n\n${buildRoleHelp(role)}`;
  return sendMessageWithRetry(chatId, message);
}

const roleBotCommands = {
  seller: [
    //{ command: '/shelf', description: 'Переглянути товари' },
    { command: '/miniapp', description: 'Відкрити товари в додатку' },
    { command: '/shop', description: 'Переглянути товари в телеграмі' },
    //{ command: '/mylist', description: 'Обрані товари' },
    //{ command: '/order', description: 'Оформити замовлення' },
    { command: '/help', description: 'Показати доступні команди' },
    { command: '/profile', description: 'Мій профіль' },
  ],
  warehouse: [
    { command: '/receive', description: 'Прийняти товар на склад' },
    { command: '/ship', description: 'Замовлення для відвантаження' },
    { command: '/miniapp', description: 'Відкрити склад' },
    { command: '/help', description: 'Показати доступні команди' },
    { command: '/profile', description: 'Мій профіль' },
  ],
  admin: [
    { command: '/miniapp', description: 'Відкрити Адмінку' },
    //{ command: '/help', description: 'Показати доступні команди' },
    { command: '/profile', description: 'Мій профіль' },
  ],
};

async function setRoleCommands(chatId, role) {
  const commands = roleBotCommands[role] || roleBotCommands.admin;
  try {
    await bot.setMyCommands(commands, {
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (err) {
    console.warn('[Bot] Failed to set commands for chat', chatId, err.message);
  }
}

function buildProfileMessage(user) {
  const lines = [
    `Роль: ${user.role}`,
    `Ім'я: ${user.firstName || 'не вказано'}`,
    `Прізвище: ${user.lastName || 'не вказано'}`,
    `Телеграм ID: ${user.telegramId}`,
  ];

  if (user.role === 'seller') {
    lines.push(`Магазин: ${user.shopName || 'не вказано'}`);
    lines.push(`Номер магазину: ${user.shopNumber || 'не вказано'}`);
    lines.push(`Місто: ${user.shopCity || 'не вказано'}`);
  }

  if (user.role === 'warehouse') {
    // warehouse zone display removed
  }

  return lines.join('\n');
}

function getUnknownUserMessage() {
  return 'Вас не знайдено в системі. Будь ласка, зверніться до адміністратора або зареєструйтеся через веб-інтерфейс.';
}

function getPhotoUrl(photoUrl) {
  if (!photoUrl) return null;
  if (photoUrl.startsWith('http://') || photoUrl.startsWith('https://')) {
    return photoUrl;
  }
  if (!SERVER_BASE_URL) {
    throw new Error('SERVER_BASE_URL must be configured in production to build absolute photo URLs');
  }
  return `${SERVER_BASE_URL.replace(/\/+$/, '')}/${photoUrl.replace(/^\/+/, '')}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimShopPhotoCache() {
  while (shopPhotoBufferCache.size > SHOP_PREFETCH_COUNT) {
    const oldestKey = shopPhotoBufferCache.keys().next().value;
    shopPhotoBufferCache.delete(oldestKey);
  }
}

async function cacheShopPhotoBuffer(product) {
  if (!product || product.telegramFileId) return null;
  const photoUrl = getPhotoUrl(product.imageUrls?.[0]);
  if (!photoUrl) return null;

  const productId = String(product._id);
  if (shopPhotoBufferCache.has(productId)) {
    return shopPhotoBufferCache.get(productId);
  }
  if (shopPhotoBufferFetchPromises.has(productId)) {
    return shopPhotoBufferFetchPromises.get(productId);
  }

  const promise = (async () => {
    try {
      const buffer = await fetchPhotoBuffer(photoUrl);
      shopPhotoBufferCache.set(productId, buffer);
      trimShopPhotoCache();
      return buffer;
    } catch (error) {
      return null;
    } finally {
      shopPhotoBufferFetchPromises.delete(productId);
    }
  })();

  shopPhotoBufferFetchPromises.set(productId, promise);
  return promise;
}

function countCachedShopPhotos(productIds = [], currentIndex = 0) {
  if (!Array.isArray(productIds) || !productIds.length) return 0;

  const start = currentIndex + 1;
  const end = Math.min(productIds.length, start + SHOP_PREFETCH_COUNT);
  let count = 0;

  for (let i = start; i < end; i += 1) {
    const id = productIds[i];
    if (id && shopPhotoBufferCache.has(String(id))) {
      count += 1;
    }
  }

  return count;
}

async function preloadShopPhotos(productIds = [], currentIndex = 0) {
  if (!Array.isArray(productIds) || !productIds.length) return;

  const start = currentIndex + 1;
  const end = Math.min(productIds.length, start + SHOP_PREFETCH_COUNT);
  const idsToLoad = [];
  for (let i = start; i < end; i += 1) {
    const id = productIds[i];
    if (!id || shopPhotoBufferCache.has(String(id))) continue;
    idsToLoad.push(String(id));
  }

  if (!idsToLoad.length) return;

  const products = await Product.find({ _id: { $in: idsToLoad } }).lean();
  const productsById = new Map(products.map((p) => [String(p._id), p]));

  await Promise.allSettled(
    idsToLoad.map((id) => cacheShopPhotoBuffer(productsById.get(id)))
  );
}

async function ensureShopPhotoBuffer(productIds = [], currentIndex = 0) {
  if (!Array.isArray(productIds) || !productIds.length) return;

  const start = currentIndex + 1;
  const end = Math.min(productIds.length, start + SHOP_PREFETCH_COUNT);
  const totalWindow = Math.max(0, end - start);
  const cachedAhead = countCachedShopPhotos(productIds, currentIndex);

  if (cachedAhead < totalWindow || cachedAhead <= SHOP_PREFETCH_THRESHOLD) {
    await preloadShopPhotos(productIds, currentIndex);
  }
}

function isLocalUrl(photoUrl) {
  try {
    const parsed = new URL(photoUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchPhotoBuffer(photoUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(photoUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Local image fetch timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendMessageWithRetry(chatId, text, options = {}, attempts = 3) {
  try {
    const result = await bot.sendMessage(chatId, text, options);
    await updateUserBotActivity(chatId);
    return result;
  } catch (error) {
    const errCode = error?.response?.body?.error_code;
    const description = error?.response?.body?.description || '';
    if (errCode === 403 && description.toLowerCase().includes('blocked')) {
      await markUserBotBlocked(chatId);
    }
    const retryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (attempts > 0 && errCode === 429) {
      const delayMs = (retryAfter || 2) * 1000;
      console.warn(`Telegram 429 on sendMessage, retrying after ${delayMs}ms (${attempts - 1} attempts left)`);
      await delay(delayMs);
      return sendMessageWithRetry(chatId, text, options, attempts - 1);
    }
    throw error;
  }
}

async function sendAdminNotification(message, requestId) {
  try {
    const admins = await User.find({ role: 'admin' }).lean();
    if (!admins.length) {
      console.warn('[Bot] No admins found to notify about registration request');
      return;
    }

    const replyMarkup = requestId
      ? {
          inline_keyboard: [[
            { text: '✅ Підтвердити', callback_data: `regreq_approve:${requestId}` },
            { text: '❌ Відхилити', callback_data: `regreq_reject:${requestId}` },
          ]],
        }
      : undefined;

    await Promise.all(
      admins.map(async (admin) => {
        if (!admin.telegramId) return;
        try {
          await sendMessageWithRetry(admin.telegramId, message, replyMarkup ? { reply_markup: replyMarkup } : {});
        } catch (error) {
          console.warn('[Bot] Failed to notify admin', admin.telegramId, error.message || error);
        }
      })
    );
  } catch (error) {
    console.error('[Bot] sendAdminNotification failed:', error.message || error);
  }
}

async function sendOrderConfirmation(chatId, itemCount, totalPrice, orderId) {
  if (!chatId) return null;

  const message = 'Замовлення сформовано!';

  try {
    return await sendMessageWithRetry(chatId, message);
  } catch (err) {
    console.warn('Не вдалося надіслати підтвердження замовлення:', err?.message || err);
    return null;
  }
}

async function sendPhotoWithRetry(chatId, photo, options = {}, attempts = 3) {
  try {
    const result = await bot.sendPhoto(chatId, photo, options);
    await updateUserBotActivity(chatId);
    return result;
  } catch (error) {
    const errCode = error?.response?.body?.error_code;
    const description = error?.response?.body?.description || '';
    if (errCode === 403 && description.toLowerCase().includes('blocked')) {
      await markUserBotBlocked(chatId);
    }
    const retryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (attempts > 0 && errCode === 429) {
      const delayMs = (retryAfter || 2) * 1000;
      console.warn(`Telegram 429 on sendPhoto, retrying after ${delayMs}ms (${attempts - 1} attempts left)`);
      await delay(delayMs);
      return sendPhotoWithRetry(chatId, photo, options, attempts - 1);
    }
    throw error;
  }
}

async function sendShelfProducts(chatId, page = 0) {
  let products = await Product.find({ status: 'active' }).sort({ orderNumber: 1 }).lean();
  products = products.map((product) => ({
    ...product,
    name: product.brand || product.model || product.category || `#${product.orderNumber}`,
  }));
  if (!products.length) {
    await bot.sendMessage(chatId, 'Активних товарів на складі поки що немає.');
    return;
  }

  const user = await User.findOne({ telegramId: chatId });
  const persistentShelfPage = user?.lastBotState?.shelf?.page;
  const effectivePage = arguments.length === 0 && Number.isInteger(persistentShelfPage)
    ? persistentShelfPage
    : page;

  // Delete previous shelf messages first
  const prev = await getSession(chatId, 'shelf');
  if (prev?.messageIds?.length) {
    await deleteShelfMessages(chatId, prev.messageIds);
  }

  const totalPages = Math.ceil(products.length / SHELF_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(effectivePage, totalPages - 1));
  const pageProducts = products.slice(safePage * SHELF_PAGE_SIZE, (safePage + 1) * SHELF_PAGE_SIZE);

  const sentIds = [];

  for (const product of pageProducts) {
    const caption = `📦 #${product.orderNumber} — ${getProductTitle(product)}\n💰 ${product.price} zł | 📦 ${product.quantityPerPackage || '?'} шт/уп`;
    const photoUrl = getPhotoUrl(product.imageUrls?.[0]);

    const qtyButtons = [
      { text: '1️⃣', callback_data: `sq:${product._id}:1` },
      { text: '2️⃣', callback_data: `sq:${product._id}:2` },
      { text: '3️⃣', callback_data: `sq:${product._id}:3` },
      { text: '4️⃣', callback_data: `sq:${product._id}:4` },
      { text: '5️⃣', callback_data: `sq:${product._id}:5` },
    ];
    const replyMarkup = { inline_keyboard: [qtyButtons] };

    try {
      let sent;
      if (photoUrl) {
        const sendOpts = { caption, filename: 'photo.jpg', reply_markup: replyMarkup };
        if (isLocalUrl(photoUrl)) {
          const buffer = await fetchPhotoBuffer(photoUrl);
          const labeled = await addLabelsToImage(buffer, product.price, product.quantityPerPackage);
          sent = await sendPhotoWithRetry(chatId, labeled, sendOpts);
        } else {
          const res = await fetch(photoUrl, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) throw new Error(`Failed to fetch image: ${res.statusText}`);
          const buffer = Buffer.from(await res.arrayBuffer());
          const labeled = await addLabelsToImage(buffer, product.price, product.quantityPerPackage);
          sent = await sendPhotoWithRetry(chatId, labeled, sendOpts);
        }
      } else {
        sent = await bot.sendMessage(chatId, caption, { reply_markup: replyMarkup });
      }

      if (sent?.message_id) {
        sentIds.push(sent.message_id);
        // Save message ID for reply-to matching
        await Product.findByIdAndUpdate(product._id, {
          $addToSet: { telegramMessageIds: String(sent.message_id) },
        });
      }

      await delay(300);
    } catch (error) {
      console.error('Failed to send shelf product', product._id, error);
    }
  }

  // Send navigation bar
  const navButtons = [];
  if (safePage > 0) navButtons.push({ text: '◀️ Назад', callback_data: `shelf_prev:${safePage}` });
  navButtons.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) navButtons.push({ text: 'Далі ▶️', callback_data: `shelf_next:${safePage}` });

  const bottomButtons = [];
  bottomButtons.push(navButtons);
  // shelf action buttons disabled

  const navMsg = await bot.sendMessage(chatId, `Товари ${safePage * SHELF_PAGE_SIZE + 1}–${safePage * SHELF_PAGE_SIZE + pageProducts.length} з ${products.length}`, {
    reply_markup: { inline_keyboard: bottomButtons },
  });
  sentIds.push(navMsg.message_id);

  await setSession(chatId, 'shelf', {
    page: safePage,
    messageIds: sentIds,
  });
  await persistUserBotState(chatId, {
    'lastBotState.shelf': {
      page: safePage,
      updatedAt: new Date(),
    },
  });
}

async function deleteShelfMessages(chatId, messageIds) {
  for (const msgId of messageIds) {
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch (_) { /* message may already be deleted */ }
  }
}

function buildShopCaption(product, currentIndex, totalProducts) {
  return [
    `📦 #${product.orderNumber || 'N/A'} — ${getProductTitle(product)}`,
    `💰 ${product.price || 0} zł`,
    `📦 В упаковці: ${product.quantityPerPackage || '?'} шт`,
    '',
    `${currentIndex + 1} / ${totalProducts}`,
  ].join('\n');
}

function buildShopKeyboard(productId, currentIndex, totalPages, selectedQty = 0, pendingCount = 0) {
  const qtyLabels = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
  const qtyRow = qtyLabels.map((label, idx) => {
    const qty = idx + 1;
    return {
      text: qty === selectedQty ? `✅ ${label}` : label,
      callback_data: `shop_qty:${productId}:${qty}`,
    };
  });

  const navRow = [];
  if (currentIndex > 0) navRow.push({ text: '◀️ Назад', callback_data: `shop_prev:${currentIndex}` });
  navRow.push({ text: `${currentIndex + 1}/${totalPages}`, callback_data: 'noop' });
  if (currentIndex < totalPages - 1) navRow.push({ text: 'Далі ▶️', callback_data: `shop_next:${currentIndex}` });

  const actionRow = [
    { text: `🛒 Мій список (${pendingCount})`, callback_data: 'shop_mylist' },
    { text: '✅ Оформити', callback_data: 'shop_order' },
  ];

  const resetRow = [
    { text: '🔄 Скинути стан', callback_data: 'shop_reset' },
  ];

  const keyboard = [qtyRow];
  if (navRow.length) keyboard.push(navRow);
  if (actionRow.length) keyboard.push(actionRow);
  keyboard.push(resetRow);
  return { inline_keyboard: keyboard };
}

async function deleteShopMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
  } catch (_) { /* message may already be deleted */ }
}

async function setShopMenuButton(chatId, label = 'Товари', resetSession = false) {
  const prev = await getSession(chatId, 'shop');
  if (prev?.menuMessageId) {
    await deleteShopMessage(chatId, prev.menuMessageId);
  }

  if (prev) {
    const newSession = { ...prev };
    delete newSession.menuMessageId;
    delete newSession.menuLabel;
    if (Object.keys(newSession).length === 0) {
      await deleteSession(chatId, 'shop');
    } else {
      await setSession(chatId, 'shop', newSession);
    }
  }

  if (resetSession) {
    await persistUserBotState(chatId, { 'lastBotState.shop': null });
  }

  return null;
}

async function deleteShopMenuMessage(chatId, session) {
  if (!session?.menuMessageId) return;
  await deleteShopMessage(chatId, session.menuMessageId);
}

async function upsertPendingReaction(chatId, messageId, productId, quantity) {
  const doc = {
    sellerTelegramId: chatId,
    productId,
    messageId,
    chatId,
    emoji: `x${quantity}`,
    quantity,
  };

  try {
    return await PendingReaction.findOneAndUpdate(
      { sellerTelegramId: chatId, productId },
      doc,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code === 11000) {
      return await PendingReaction.findOneAndUpdate(
        { sellerTelegramId: chatId, productId },
        doc,
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }
    throw error;
  }
}

async function fixPendingReactionIndexes() {
  try {
    const collection = PendingReaction.collection;
    const indexes = await collection.indexes();
    const oldIndex = indexes.find((idx) => idx.name === 'sellerTelegramId_1_messageId_1');
    if (oldIndex) {
      await collection.dropIndex(oldIndex.name);
      console.log('[Bot] Dropped legacy PendingReaction index:', oldIndex.name);
    }

    const duplicates = await collection.aggregate([
      {
        $group: {
          _id: { sellerTelegramId: '$sellerTelegramId', productId: '$productId' },
          ids: { $push: { id: '$_id', updatedAt: '$updatedAt' } },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).toArray();

    for (const dup of duplicates) {
      dup.ids.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      const removeIds = dup.ids.slice(1).map((item) => item.id);
      if (removeIds.length) {
        await collection.deleteMany({ _id: { $in: removeIds } });
        console.log('[Bot] Removed duplicate PendingReaction docs for', dup._id);
      }
    }

    await collection.createIndex({ sellerTelegramId: 1, productId: 1 }, { unique: true });
    console.log('[Bot] Ensured PendingReaction index: sellerTelegramId_1_productId_1');
  } catch (error) {
    console.warn('[Bot] Failed to fix PendingReaction indexes:', error?.message || error);
  }
}

async function getPendingQuantity(chatId, productId) {
  if (!productId) return 0;
  const pending = await PendingReaction.findOne({ sellerTelegramId: chatId, productId });
  return pending?.quantity || 0;
}

async function makeProductMedia(product, caption) {
  const photoUrl = getPhotoUrl(product.imageUrls?.[0]);
  if (product.telegramFileId) {
    return { type: 'photo', media: product.telegramFileId, caption, isBuffer: false };
  }
  if (!photoUrl) {
    return null;
  }

  const buffer = await cacheShopPhotoBuffer(product);
  if (buffer) {
    return { type: 'photo', media: buffer, caption, isBuffer: true };
  }

  return { type: 'photo', media: photoUrl, caption, isBuffer: false };
}

async function sendShopMedia(chatId, product, caption, replyMarkup) {
  const media = await makeProductMedia(product, caption);
  if (!media) {
    return await bot.sendMessage(chatId, caption, { reply_markup: replyMarkup });
  }

  const sendOpts = { caption, reply_markup: replyMarkup };
  if (media.isBuffer) {
    sendOpts.filename = 'shop.jpg';
  }

  const sent = await bot.sendPhoto(chatId, media.media, sendOpts);
  if (sent?.photo?.length && !product.telegramFileId) {
    const fileId = sent.photo[sent.photo.length - 1].file_id;
    await Product.findByIdAndUpdate(product._id, { telegramFileId: fileId }).catch(() => {});
  }
  return sent;
}

async function updateShopMessage(chatId, msgId, product, caption, replyMarkup) {
  const media = await makeProductMedia(product, caption);
  if (!media) {
    return await bot.editMessageText(caption, { chat_id: chatId, message_id: msgId, reply_markup: replyMarkup });
  }

  if (media.isBuffer) {
    const attachName = 'photo';
    const [formData] = bot._formatSendData(attachName, media.media, { filename: 'shop.jpg', contentType: 'image/jpeg' });
    const payload = { type: 'photo', media: `attach://${attachName}`, caption: media.caption };
    const opts = {
      qs: {
        chat_id: chatId,
        message_id: msgId,
        reply_markup: JSON.stringify(replyMarkup),
        media: JSON.stringify(payload),
      },
      formData,
    };

    try {
      const updated = await bot._request('editMessageMedia', opts);
      if (updated?.photo?.length && !product.telegramFileId) {
        const fileId = updated.photo[updated.photo.length - 1].file_id;
        await Product.findByIdAndUpdate(product._id, { telegramFileId: fileId }).catch(() => {});
      }
      return updated;
    } catch (error) {
      console.warn('editMessageMedia buffer failed, falling back to sendPhoto', error?.message || error);
      const sent = await bot.sendPhoto(chatId, media.media, { caption: media.caption, reply_markup: replyMarkup, filename: 'shop.jpg' });
      if (sent?.photo?.length && !product.telegramFileId) {
        const fileId = sent.photo[sent.photo.length - 1].file_id;
        await Product.findByIdAndUpdate(product._id, { telegramFileId: fileId }).catch(() => {});
      }
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (_) {}
      return sent;
    }
  }

  return await bot.editMessageMedia(media, { chat_id: chatId, message_id: msgId, reply_markup: replyMarkup });
}

async function sendShopProducts(chatId, index = 0, forceIndex = false) {
  let products = await Product.find({ status: 'active' }).sort({ orderNumber: 1 }).lean();
  products = products.map((product) => ({
    ...product,
    name: product.brand || product.model || product.category || `#${product.orderNumber}`,
  }));
  if (!products.length) {
    await bot.sendMessage(chatId, 'Активних товарів на складі поки що немає.');
    return;
  }

  const prev = await getSession(chatId, 'shop');
  const user = await User.findOne({ telegramId: chatId });
  if (prev?.messageId) {
    await deleteShopMessage(chatId, prev.messageId);
  }
  if (prev?.menuMessageId) {
    await deleteShopMessage(chatId, prev.menuMessageId);
  }

  const totalProducts = products.length;
  const persistentShopIndex = user?.lastBotState?.shop?.currentIndex;
  const desiredIndex = forceIndex
    ? index
    : (prev?.currentIndex != null && Number.isInteger(prev.currentIndex))
      ? prev.currentIndex
      : (Number.isInteger(persistentShopIndex) ? persistentShopIndex : index);
  const safeIndex = Math.max(0, Math.min(desiredIndex, totalProducts - 1));
  const product = products[safeIndex];
  const caption = buildShopCaption(product, safeIndex, totalProducts);
  const photoUrl = getPhotoUrl(product.imageUrls?.[0]);
  const pendingCount = await PendingReaction.countDocuments({ sellerTelegramId: chatId });
  const selectedQty = await getPendingQuantity(chatId, product._id);
  const replyMarkup = buildShopKeyboard(String(product._id), safeIndex, totalProducts, selectedQty, pendingCount);

  try {
    const productIds = products.map((p) => String(p._id));
    const preloadPromise = ensureShopPhotoBuffer(productIds, safeIndex);
    const sent = await sendShopMedia(chatId, product, caption, replyMarkup);
    if (sent?.message_id) {
      await setSession(chatId, 'shop', {
        productIds,
        currentIndex: safeIndex,
        messageId: String(sent.message_id),
        hasPhoto: Boolean(product.telegramFileId || photoUrl),
      });
      await persistUserBotState(chatId, {
        'lastBotState.shop': {
          productIds,
          currentIndex: safeIndex,
          updatedAt: new Date(),
        },
      });
      await setShopMenuButton(chatId, 'Товари');
    }
    preloadPromise.catch(() => {});
  } catch (error) {
    console.error('Failed to send shop message', product._id, error);
  }
}

async function addLabelsToImage(inputBuffer, price, quantityPerPackage) {
  const meta = await sharp(inputBuffer).metadata();
  const W = meta.width;
  const H = meta.height;

  const fontSize = Math.round(H * 0.07);
  const padding = Math.round(fontSize * 0.4);
  const rx = 12;

  function makeSvgLabel(text, yTop) {
    // estimate text width: ~0.6 * fontSize per char
    const chars = String(text).length;
    const textW = Math.round(chars * fontSize * 0.62);
    const boxW = textW + padding * 2;
    const boxH = fontSize + padding;
    const x = Math.round(W * 0.04);
    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="${x}" y="${yTop}" width="${boxW}" height="${boxH}" rx="${rx}" fill="white"/>
      <text x="${x + padding}" y="${yTop + fontSize - Math.round(padding * 0.2)}"
        font-family="DejaVu Sans,Arial,sans-serif" font-weight="bold" font-size="${fontSize}px" fill="black">${text}</text>
    </svg>`;
  }

  const topY = Math.round(H * 0.04);
  const fontSize2 = Math.round(H * 0.07);
  const padding2 = Math.round(fontSize2 * 0.4);
  const boxH2 = fontSize2 + padding2;
  const bottomY = Math.round(H * 0.96) - boxH2;

  const topSvg = makeSvgLabel(`${price} zł`, topY);
  const bottomSvg = makeSvgLabel(`${quantityPerPackage} шт`, bottomY);

  return sharp(inputBuffer)
    .composite([
      { input: Buffer.from(topSvg), top: 0, left: 0 },
      { input: Buffer.from(bottomSvg), top: 0, left: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function uploadBufferToR2(buffer, ext, folder = 'products') {
  const filename = `${crypto.randomUUID()}.${ext}`;
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `${folder}/${filename}`,
    Body: buffer,
    ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  }));
  const path = folder === 'products' ? `/api/products/images/${filename}` : `/api/search-products/images/${filename}`;
  return { url: path, name: filename };
}

async function uploadTelegramPhotoToR2(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const response = await fetch(fileUrl);
  if (!response.ok) throw new Error(`Failed to download photo: ${response.statusText}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const ext = (file.file_path.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '');
  return { buffer, ext };
}

async function uploadSearchProductPhotoToR2(fileId) {
  const { buffer, ext } = await uploadTelegramPhotoToR2(fileId);
  return uploadBufferToR2(buffer, ext, 'search-products');
}

async function handleReceiveStep(chatId, msg, state) {
  const msgText = msg.text?.trim() || '';

  if (state.step === 'await_photo') {
    if (!msg.photo?.length) {
      await bot.sendMessage(chatId, 'Будь ласка, надішліть фото товару.');
      return;
    }
    state.photoFileId = msg.photo[msg.photo.length - 1].file_id;
    state.step = 'await_has_barcode';
    await setSession(chatId, 'receive', state);
    await bot.sendMessage(chatId, 'Чи є штрихкод на товарі?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Так', callback_data: 'receive_barcode_yes' },
            { text: 'Ні, немає', callback_data: 'receive_barcode_no' },
          ],
        ],
      },
    });
    return;
  }

  if (state.step === 'await_has_barcode') {
    const normalized = msgText.trim().toLowerCase();
    if (normalized === 'так' || normalized === 'yes') {
      state.step = 'await_barcode_photo';
      await setSession(chatId, 'receive', state);
      await bot.sendMessage(chatId, 'Добре. Надішліть фото штрихкоду або QR-коду.');
      return;
    }

    if (normalized === 'ні' || normalized === 'немає' || normalized === 'no') {
      state.step = 'await_price';
      await setSession(chatId, 'receive', state);
      await bot.sendMessage(chatId, 'Введіть ціну товару (zł):');
      return;
    }

    await bot.sendMessage(chatId, 'Будь ласка, оберіть одну з кнопок: Так або Ні, немає.');
    return;
  }

  if (state.step === 'await_barcode_photo') {
    if (!msg.photo?.length) {
      await bot.sendMessage(chatId, 'Будь ласка, надішліть фото штрихкоду або QR-коду.');
      return;
    }

    state.barcodePhotoFileId = msg.photo[msg.photo.length - 1].file_id;
    await setSession(chatId, 'receive', state);

    try {
      const { buffer } = await uploadTelegramPhotoToR2(state.barcodePhotoFileId);
      const recognition = await recognizeBarcodeFromBuffer(buffer);
      if (recognition.barcode) {
        state.barcode = recognition.barcode;
        await bot.sendMessage(chatId, `Знайдено штрихкод: ${recognition.barcode}`);
      } else if (recognition.qrCode) {
        state.qrCode = recognition.qrCode;
        await bot.sendMessage(chatId, `Знайдено QR-код: ${recognition.qrCode}`);
      } else {
        await bot.sendMessage(chatId, 'Не вдалося розпізнати код. Продовжуємо без штрихкоду.');
      }
      await bot.sendMessage(chatId, `Джерело розпізнавання: ${recognition.recognitionSource}. ${recognition.details}`);
    } catch (err) {
      console.error('barcode receive recognition error:', err);
      await bot.sendMessage(chatId, 'Сталася помилка при розпізнаванні штрихкоду. Продовжуємо далі.');
    }

    state.step = 'await_price';
    await setSession(chatId, 'receive', state);
    await bot.sendMessage(chatId, 'Введіть ціну товару (zł):');
    return;
  }

  if (state.step === 'await_price') {
    const val = Number(msgText);
    if (Number.isNaN(val) || val < 0) {
      await bot.sendMessage(chatId, 'Будь ласка, введіть коректну ціну (число >= 0).');
      return;
    }
    state.price = val;
    state.step = 'await_quantity';
    await setSession(chatId, 'receive', state);
    await bot.sendMessage(chatId, 'Введіть кількість на складі:');
    return;
  }

  if (state.step === 'await_quantity') {
    const val = Number(msgText);
    if (!Number.isInteger(val) || val <= 0) {
      await bot.sendMessage(chatId, 'Будь ласка, введіть ціле число більше 0.');
      return;
    }
    state.quantity = val;
    state.step = 'await_qty_per_package';
    await setSession(chatId, 'receive', state);
    await bot.sendMessage(chatId, 'Введіть кількість в упаковці (шт):');
    return;
  }

  if (state.step === 'await_qty_per_package') {
    const val = Number(msgText);
    if (!Number.isInteger(val) || val <= 0) {
      await bot.sendMessage(chatId, 'Будь ласка, введіть ціле число більше 0.');
      return;
    }
    state.quantityPerPackage = val;
    await deleteSession(chatId, 'receive');

    try {
      await bot.sendMessage(chatId, 'Обробляю фото та зберігаю товар, зачекайте...');
      const { buffer: rawBuffer, ext } = await uploadTelegramPhotoToR2(state.photoFileId);
      // Save the ORIGINAL photo to R2 (without labels).
      // Labels are added dynamically during broadcast/shelf send.
      const uploaded = await uploadBufferToR2(rawBuffer, ext || 'jpg');

      // Auto-assign next available orderNumber
      const maxProduct = await Product.findOne({ status: { $ne: 'archived' } }).sort({ orderNumber: -1 }).lean();
      const nextOrderNumber = (maxProduct?.orderNumber || 0) + 1;

      const product = new Product({
        orderNumber: nextOrderNumber,
        name: `Новий товар #${nextOrderNumber}`,
        description: '',
        price: state.price,
        quantity: state.quantity,
        quantityPerPackage: state.quantityPerPackage,
        barcode: state.barcode || '',
        qrCode: state.qrCode || '',
        status: 'active',
        imageUrls: [uploaded.url],
        imageNames: [uploaded.name],
        telegramFileId: state.photoFileId,
        telegramMessageIds: [],
      });
      await product.save();

      // Send rendered photo with labels as confirmation
      const labeledBuffer = await addLabelsToImage(rawBuffer, state.price, state.quantityPerPackage);
      await sendPhotoWithRetry(chatId, labeledBuffer, {
        caption: `✅ Товар збережено!\nЦіна: ${state.price} zł\nКількість на складі: ${state.quantity}\nКількість в упаковці: ${state.quantityPerPackage} шт`,
        filename: 'preview.jpg',
      });

      const scanResult = await scanAndUpdateProduct(product, rawBuffer, {
        barcodeHint: state.barcode || '',
        qrCodeHint: state.qrCode || '',
      });
      const scanText = buildScanResultText(scanResult.parsed);
      await bot.sendMessage(chatId,
        `📌 Автоматичне сканування завершено.\n\n${scanText}${formatUsageText(scanResult.usage)}`
      );
    } catch (err) {
      console.error('receiveProduct error:', err);
      await bot.sendMessage(chatId, 'Сталася помилка при збереженні товару. Спробуйте ще раз: /receive');
    }
  }
}

/**
 * Build caption + keyboard for the current carousel entry.
 */
function buildCarouselMessage(productName, position, entry, currentIndex, totalEntries) {
  const caption = [
    `📦 ${position || 'N/A'}`,
    `🏪 Магазин: ${entry.shopName}`,
    `📊 Кількість: ${entry.quantity}`,
    '',
    `${currentIndex + 1} / ${totalEntries}`,
  ].join('\n');

  const navRow = [];
  if (totalEntries > 1) {
    navRow.push({ text: `◀️ Попередній`, callback_data: `sprev:` });
    navRow.push({ text: `Наступний ▶️`, callback_data: `snext:` });
  }
  const actionRow = [{ text: '📦 Спаковано', callback_data: `spack:` }];

  const inline_keyboard = [];
  if (navRow.length) inline_keyboard.push(navRow);
  inline_keyboard.push(actionRow);

  return { caption, reply_markup: { inline_keyboard } };
}

async function getShippingBlockPositions(productIds) {
  if (!Array.isArray(productIds) || !productIds.length) return new Map();

  const blocks = await Block.find(
    { productIds: { $in: productIds } },
    'blockId productIds'
  ).sort({ blockId: 1 }).lean();

  const positions = new Map();
  for (const block of blocks) {
    for (let index = 0; index < block.productIds.length; index += 1) {
      const pid = String(block.productIds[index]);
      if (!positions.has(pid)) {
        positions.set(pid, { blockId: block.blockId, index });
      }
    }
  }

  return positions;
}

async function ensureBlocks() {
  const count = await Block.countDocuments();
  if (count >= 120) return;
  const existing = await Block.find({}, 'blockId').lean();
  const existingNumbers = new Set(existing.map((b) => b.blockId));
  const toCreate = [];
  for (let i = 1; i <= 120; i += 1) {
    if (!existingNumbers.has(i)) toCreate.push({ blockId: i, productIds: [] });
  }
  if (toCreate.length) {
    await Block.insertMany(toCreate);
  }
}

async function scanAndUpdateProduct(product, imageBuffer, options = {}) {
  const result = await analyzeProductImage(imageBuffer, options);
  const parsed = result.parsed || {};
  if (parsed.title) product.name = parsed.title;
  if (parsed.brand) product.brand = parsed.brand;
  if (parsed.model) product.model = parsed.model;
  if (parsed.category) product.category = parsed.category;
  if (parsed.barcode) product.barcode = parsed.barcode;
  if (parsed.qrCode) product.qrCode = parsed.qrCode;
  if (parsed.description !== undefined) product.description = parsed.description;
  if (parsed.textOnImage !== undefined) product.textOnImage = parsed.textOnImage;
  await product.save();
  return { parsed, usage: result.usage || {} };
}

function buildScanResultText(parsed) {
  const lines = [];
  if (parsed.title) lines.push(`Назва: ${parsed.title}`);
  if (parsed.brand) lines.push(`Бренд: ${parsed.brand}`);
  if (parsed.model) lines.push(`Модель: ${parsed.model}`);
  if (parsed.category) lines.push(`Категорія: ${parsed.category}`);
  if (parsed.description) lines.push(`Опис: ${parsed.description}`);
  if (parsed.textOnImage) lines.push(`Текст на фото: ${parsed.textOnImage}`);
  if (!lines.length) lines.push('OpenAI не зміг визначити атрибути товару.');
  return lines.join('\n');
}

async function shipOrders(chatId) {
  const orders = await Order.find({ status: 'new' }).populate('items.productId').sort({ createdAt: 1 });
  if (!orders.length) {
    await bot.sendMessage(chatId, 'Поки що нема нових замовлень для відвантаження.');
    return;
  }

  const buyerIds = [...new Set(orders.map((order) => order.buyerTelegramId))];
  const buyers = await User.find({ telegramId: { $in: buyerIds } });
  const buyerMap = new Map(buyers.map((buyer) => [buyer.telegramId, buyer]));

  // Group by product
  const productMap = new Map();
  for (const order of orders) {
    const buyer = buyerMap.get(order.buyerTelegramId);
    for (const item of order.items) {
      const product = item.productId;
      if (!product) continue;
      const pid = String(product._id);
      if (!productMap.has(pid)) {
        productMap.set(pid, { product, entries: [] });
      }
      const buyerName = [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || order.buyerTelegramId;
      const address = [buyer?.shopAddress, buyer?.shopCity].filter(Boolean).join(', ') || 'не вказано';
      productMap.get(pid).entries.push({
        orderId: String(order._id),
        shopName: buyer?.shopName || 'не вказано',
        buyerName,
        address,
        quantity: item.quantity,
        packed: false,
      });
    }
  }

  const productIds = Array.from(productMap.keys());
  const blockPositions = await getShippingBlockPositions(productIds);

  const sorted = Array.from(productMap.values()).sort((a, b) => {
    const aPos = blockPositions.get(String(a.product._id));
    const bPos = blockPositions.get(String(b.product._id));

    if (aPos && bPos) {
      if (aPos.blockId !== bPos.blockId) return aPos.blockId - bPos.blockId;
      return aPos.index - bPos.index;
    }
    if (aPos) return -1;
    if (bPos) return 1;
    return (a.product.orderNumber ?? 0) - (b.product.orderNumber ?? 0);
  });

  for (const { product, entries } of sorted) {
    const positionInfo = blockPositions.get(String(product._id));
    const position = positionInfo
      ? `Блок ${positionInfo.blockId} позиція ${positionInfo.index + 1}`
      : product.orderNumber || 'N/A';
    const { caption, reply_markup } = buildCarouselMessage(getProductTitle(product), position, entries[0], 0, entries.length);

    try {
      let sent;
      const photoUrl = getPhotoUrl(product.imageUrls?.[0]);
      if (product.telegramFileId) {
        sent = await sendPhotoWithRetry(chatId, product.telegramFileId, { caption, reply_markup });
      } else if (photoUrl) {
        if (isLocalUrl(photoUrl)) {
          const buffer = await fetchPhotoBuffer(photoUrl);
          const fileName = photoUrl.split('/').pop().split('?')[0] || `${product._id}.jpg`;
          sent = await sendPhotoWithRetry(chatId, buffer, { caption, reply_markup, filename: fileName });
        } else {
          sent = await sendPhotoWithRetry(chatId, photoUrl, { caption, reply_markup });
        }
      } else {
        sent = await bot.sendMessage(chatId, caption, { reply_markup });
      }

      if (sent?.message_id) {
        await setSession(chatId, 'ship', {
          productId: String(product._id),
          productName: getProductTitle(product),
          position,
          entries,
          currentIndex: 0,
          chatId,
          hasPhoto: !!(product.telegramFileId || photoUrl),
        }, String(sent.message_id));
      }
    } catch (error) {
      console.error('Failed to send shipping carousel message', error);
    }

    // Throttle warehouse order dispatch to avoid rapid-fire Telegram requests and 429 errors
    await delay(500 + Math.floor(Math.random() * 501));
  }

  await bot.sendMessage(chatId, `📋 Відправлено ${sorted.length} позицій для пакування.\n\nЩоб позначити товар як закінчений — відповідте (reply) на повідомлення з товаром словом "Закінчився".`);
}

async function initBot(token) {
  if (!token) {
    status.error = 'TELEGRAM_BOT_TOKEN not configured';
    console.warn(status.error);
    return;
  }

  if (bot) {
    console.warn('Telegram bot is already initialized');
    return;
  }

  let pollingRestartAttempts = 0;
  const MAX_POLLING_RESTARTS = 10;

  try {
    bot = new TelegramBot(token, {
      polling: {
        params: {
          allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        },
      },
    });
    status.connected = true;
    status.startedAt = new Date().toISOString();

    await bot.setMyCommands([
      { command: '/start', description: 'Почати роботу з ботом' },
    ]);

    bot.on('message', async (msg) => {
      try {
      const chatId = String(msg.chat.id);
      const isGroupChat = ['group', 'supergroup'].includes(msg.chat.type);
      const rawText = msg.text?.trim() || '';
      const text = (rawText.match(/^\/\S+/)?.[0] || '').split('@')[0].toLowerCase();
      const messageText = rawText.toLowerCase();
      const user = await User.findOne({ telegramId: chatId });
      if (user) {
        updateUserBotActivity(chatId).catch(() => {});
        if (messageText === 'товари' || messageText === 'продовжити замовлення') {
          await logBotInteraction(chatId, 'reply', messageText, messageText);
        }
      }

      if (isGroupChat && !isAuthorizedGroup(chatId)) {
        if (msg.photo?.length && (isPriceLookupCaption(msg.caption || '') || isBarcodeLookupCaption(msg.caption || ''))) {
          await bot.sendMessage(chatId, 'Цей груповий чат не авторизовано. Зверніться до адміністратора для підключення бота.');
        }
        return;
      }

      if (isGroupChat && msg.reply_to_message && msg.reply_to_message.photo?.length && msg.text) {
        const fromId = String(msg.from?.id || '');
        const isAdmin = await isChatAdmin(chatId, fromId);
        const price = parseAdminPriceReply(msg.text);
        if (isAdmin && price !== null) {
          const captionText = String(msg.reply_to_message.caption || msg.reply_to_message.text || '');
          const barcodeMatch = captionText.match(/штрихкод[:\s]*([0-9\-\s]{8,20})/i) || captionText.match(/barcode[:\s]*([0-9\-\s]{8,20})/i);
          const barcodeValue = barcodeMatch
            ? barcodeMatch[1].replace(/[^0-9]/g, '')
            : chooseBarcodeCandidate(captionText);
          if (barcodeValue) {
            try {
              const photoFileId = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1].file_id;
              const uploadResult = await uploadSearchProductPhotoToR2(photoFileId);
              const normalizedBarcode = normalizeBarcode(barcodeValue);
              await SearchProduct.findOneAndUpdate(
                { barcode: normalizedBarcode, groupChatId: chatId, status: 'active' },
                {
                  barcode: normalizedBarcode,
                  price,
                  title: captionText.substring(0, 200),
                  caption: captionText,
                  imageUrl: uploadResult.url,
                  imageName: uploadResult.name,
                  telegramPhotoFileId: photoFileId,
                  telegramMessageId: String(msg.reply_to_message.message_id),
                  groupChatId: chatId,
                  adminTelegramId: fromId,
                  adminName: `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim(),
                  source: 'group_search',
                  status: 'active',
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
              );
              await bot.sendMessage(chatId, `Ціна ${price} zł для штрихкоду ${barcodeValue} збережена.`);
              return;
            } catch (err) {
              console.error('Failed to save search product from admin reply:', err);
            }
          }
        }
      }

      // Step-by-step /receive flow takes priority (but not for other commands)
      const rState = await getSession(chatId, 'receive');
      if (rState && !text.startsWith('/')) {
        await handleReceiveStep(chatId, msg, rState);
        return;
      }
      // Cancel receive flow if user sends any other command
      if (rState && text.startsWith('/') && text !== '/receive') {
        await deleteSession(chatId, 'receive');
      }

      if (msg.photo?.length && isBarcodeLookupCaption(msg.caption || '')) {
        try {
          const photoFileId = msg.photo[msg.photo.length - 1].file_id;
          const { buffer } = await uploadTelegramPhotoToR2(photoFileId);
          const zxingResult = await decodeBarcodeFromImageBuffer(buffer);
          const zxingText = String(zxingResult.text || '').trim();
          const zxingFormat = String(zxingResult.format || 'UNKNOWN');
          let barcode = '';
          let recognitionSource = 'ZXing';
          let recognitionDetails = `Формат ZXing: ${zxingFormat}`;

          if (zxingText) {
            const normalized = normalizeBarcode(zxingText);
            if (normalized) {
              barcode = normalized;
            }
          }

          if (!barcode) {
            const result = await analyzeBarcodeImage(buffer);
            const scannedBarcode = normalizeBarcode(result.scannedBarcode || '');
            const digitsOnBarcode = normalizeBarcode(result.digitsOnBarcode || '');
            const chosen = scannedBarcode || digitsOnBarcode || '';
            barcode = chosen;
            recognitionSource = 'OpenAI';
            recognitionDetails = `OpenAI: scannedBarcode=${scannedBarcode || '—'}, digitsOnBarcode=${digitsOnBarcode || '—'}`;
            if (scannedBarcode || digitsOnBarcode) {
              const usedVariant = scannedBarcode ? 'Зісканований' : 'Цифри прочитав';
              const details = `Використано: ${usedVariant}\nЗісканований штрихкод: ${scannedBarcode || '—'}\nЦифри на штрихкоді: ${digitsOnBarcode || '—'}`;
              await bot.sendMessage(chatId, details);
            }
          }

          if (!barcode) {
            await bot.sendMessage(chatId, 'Не вдалося розпізнати штрихкод. Спробуйте надіслати чітке фото штрихкоду з підписом "штрихкод".');
            return;
          }

          const product = await findProductByBarcode(barcode);
          if (!product) {
            await bot.sendMessage(chatId, `Товар зі штрихкодом ${barcode} не знайдено. (розпізнано через ${recognitionSource})`);
            return;
          }

          const reply = `${recognitionSource === 'ZXing' ? `✅ Штрихкод розпізнано бібліотекою ZXing. (${recognitionDetails})` : `✅ Штрихкод розпізнано через OpenAI. (${recognitionDetails})`}
${buildProductInfoText(product)}`;
          await bot.sendMessage(chatId, reply);
          await sendProductPhotos(chatId, product);
        } catch (err) {
          console.error('[Bot] Barcode lookup error:', err);
          await bot.sendMessage(chatId, 'Не вдалося обробити фото. Спробуйте надіслати інше фото або зверніться до адміністратора.');
        }
        return;
      }

      if (msg.text && isBarcodeLookupText(rawText)) {
        try {
          const barcode = chooseBarcodeCandidate(rawText);
          if (!barcode) {
            await bot.sendMessage(chatId, 'Будь ласка, надішліть штрихкод цифрами або з підписом "штрихкод".');
            return;
          }

          const product = await findProductByBarcode(barcode);
          if (!product) {
            await bot.sendMessage(chatId, `Товар зі штрихкодом ${barcode} не знайдено.`);
            return;
          }

          const reply = buildProductInfoText(product);
          await bot.sendMessage(chatId, reply);
          await sendProductPhotos(chatId, product);
        } catch (err) {
          console.error('[Bot] Barcode lookup error:', err);
          await bot.sendMessage(chatId, 'Не вдалося обробити штрихкод. Спробуйте надіслати інше повідомлення або зверніться до адміністратора.');
        }
        return;
      }

      if (msg.photo?.length && isPriceLookupCaption(msg.caption || '')) {
        try {
          const photoFileId = msg.photo[msg.photo.length - 1].file_id;
          const { buffer } = await uploadTelegramPhotoToR2(photoFileId);
          const result = await analyzeProductImage(buffer);
          const candidates = await findProductCandidates(result.parsed || {});
          const reply = buildPriceLookupText(candidates, result.usage);
          await bot.sendMessage(chatId, reply);
          if (candidates.length) {
            await sendProductPhotos(chatId, candidates[0]);
          }
        } catch (err) {
          console.error('[Bot] Price lookup error:', err);
          await bot.sendMessage(chatId, 'Не вдалося обробити фото. Спробуйте надіслати інше фото або зверніться до адміністратора.');
        }
        return;
      }

      if (text === '/start') {
        if (isGroupChat) {
          const groupMessage = isAuthorizedGroup(chatId)
            ? 'Бот активовано для цього групового чату. Надішліть фото з підписом "PRICE", щоб знайти товар за базою.'
            : 'Цей груповий чат не підключено. Зверніться до адміністратора для авторизації.';
          await bot.sendMessage(chatId, groupMessage);
          return;
        }

        if (!user) {
          const message = 'Вас не знайдено в системі. Натисніть кнопку, щоб зареєструватися через Mini App.';
          if (WEB_APP_URL.startsWith('https://')) {
            await bot.sendMessage(chatId, message, {
              reply_markup: {
                inline_keyboard: [[{ text: 'Реєстрація в Mini App', web_app: { url: WEB_APP_URL } }]],
              },
            });
          } else {
            await bot.sendMessage(chatId, `Відкрийте Mini App: ${WEB_APP_URL}`);
          }
          return;
        }

        // Set per-chat commands based on role
        await setRoleCommands(chatId, user.role);

        const sent = await bot.sendMessage(
          chatId,
          `Привіт, ${user.firstName || 'користувачу'}! Ви зайшли як ${user.role}.\n\n${buildRoleHelp(user.role)}`
        );
        await setShopMenuButton(chatId, user.role === 'warehouse' ? 'Склад' : 'Товари');
        return;
      }

      if (text === '/help') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        await bot.sendMessage(chatId, buildRoleHelp(user.role));
        await setShopMenuButton(chatId, user.role === 'warehouse' ? 'Склад' : 'Товари');
        return;
      }

      if (text === '/profile') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        await bot.sendMessage(chatId, buildProfileMessage(user));
        return;
      }

      if (text === '/miniapp') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        const miniAppUrl = getMiniAppUrl(user.role);
        const buttonText = user.role === 'warehouse' ? 'Відкрити склад' : 'Відкрити товари';

        if (WEB_APP_URL.startsWith('https://')) {
          await bot.sendMessage(chatId, 'Відкрийте Mini App:', {
            reply_markup: {
              inline_keyboard: [[{ text: buttonText, web_app: { url: miniAppUrl } }]],
            },
          });
          return;
        }

        await bot.sendMessage(chatId, `Відкрийте Mini App: ${miniAppUrl}`);
        return;
      }

      /*
      if (text === '/shelf') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'seller') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише продавцю. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        await sendShelfProducts(chatId);
        return;
      }
      */

      if (text === '/shop' || messageText === 'товари' || messageText === 'продовжити замовлення') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'seller') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише продавцю. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        await sendShopProducts(chatId);
        return;
      }

      if (text === '/receive') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'warehouse') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише складу. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        await setSession(chatId, 'receive', { step: 'await_photo' });
        await bot.sendMessage(chatId, 'Надішліть фото нового товару:');
        return;
      }

      if (text === '/ship') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'warehouse') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише складу. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        await shipOrders(chatId);
        return;
      }

      if (text === '/warehouse') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'warehouse') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише складу. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        await bot.sendMessage(chatId, 'Складські команди поки що не реалізовано.');
        return;
      }

      if (!user) {
        if (isGroupChat) return;
        await bot.sendMessage(chatId, getUnknownUserMessage());
        return;
      }

      // ── Warehouse reply "Закінчився" to archive product ──
      if (user.role === 'warehouse' && msg.reply_to_message && rawText && rawText.toLowerCase() === 'закінчився') {
        const repliedMsgId = String(msg.reply_to_message.message_id);
        const replied = msg.reply_to_message;
        const captionText = replied.caption || replied.text || '';

        // 1) Try to find product from carousel session (if still alive)
        let product = null;
        let carousel = await getSession(chatId, 'ship', repliedMsgId);
        if (carousel) {
          product = await Product.findById(carousel.productId);
        }

        // 2) Fallback: extract product name from caption — "Позиція X — "ProductName""
        if (!product) {
          const nameMatch = captionText.match(/— "(.+?)"/);
          if (nameMatch) {
            const displayName = nameMatch[1];
            product = await Product.findOne({
              status: { $ne: 'archived' },
              $or: [
                { brand: displayName },
                { model: displayName },
                { category: displayName },
              ],
            });
          }
        }

        if (!product) {
          await bot.sendMessage(chatId, 'Не вдалося визначити товар з цього повідомлення. Можливо, він вже архівований.');
          return;
        }

        if (product.status === 'archived') {
          await bot.sendMessage(chatId, `"${getProductTitle(product)}" вже в архіві.`);
          return;
        }

        // Cancel all unpacked (still new) orders for this product
        const newOrders = await Order.find({
          'items.productId': product._id,
          status: 'new',
        });

        const buyerIds = [...new Set(newOrders.map((o) => o.buyerTelegramId))];
        const buyers = await User.find({ telegramId: { $in: buyerIds } });
        const buyerMap = new Map(buyers.map((b) => [b.telegramId, b]));

        let cancelledCount = 0;
        for (const order of newOrders) {
          order.status = 'cancelled';
          await order.save();
          cancelledCount++;
          const buyer = buyerMap.get(order.buyerTelegramId);
          const buyerName = [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || order.buyerTelegramId;
          await bot.sendMessage(order.buyerTelegramId, `⛔ Товар "${getProductTitle(product)}" на складі скінчився. Замовлення для ${buyerName} не буде виконано.`).catch(() => null);
        }

        // Archive product
        const oldOrder = product.orderNumber;
        await Product.findByIdAndUpdate(product._id, {
          status: 'archived',
          archivedAt: new Date(),
          originalOrderNumber: oldOrder,
          orderNumber: 0,
        });
        const { shiftDown } = require('./utils/shiftOrderNumbers');
        await shiftDown({ status: { $ne: 'archived' }, orderNumber: { $gt: oldOrder } });

        // Remove product from warehouse block
        const block = await Block.findOne({ productIds: product._id });
        if (block) {
          block.productIds = block.productIds.filter((id) => id.toString() !== String(product._id));
          block.version += 1;
          await block.save();
          try {
            const updated = await Block.findOne({ blockId: block.blockId }).populate('productIds').lean();
            getIO().emit('block_updated', updated);
          } catch (_) {}
        }

        // Update carousel message
        try {
          const doneCaption = `📦 "${getProductTitle(product)}"\n❌ Скасовано замовлень: ${cancelledCount}\nТовар переміщено в архів.`;
          if (replied.photo) {
            await bot.editMessageCaption(doneCaption, {
              chat_id: chatId, message_id: repliedMsgId,
              reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
            });
          } else {
            await bot.editMessageText(doneCaption, {
              chat_id: chatId, message_id: repliedMsgId,
              reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
            });
          }
        } catch (_) {}

        if (carousel) await deleteSession(chatId, 'ship', repliedMsgId);
        await bot.sendMessage(chatId, `📦 "${getProductTitle(product)}" — скасовано замовлень: ${cancelledCount}. Товар в архіві.`);
        return;
      }

      // Old reaction-based seller flow removed: keep /shop inline ordering only.
      await bot.sendMessage(chatId, 'Невідома команда. Використайте /help, щоб побачити доступні команди.');
      } catch (err) {
        console.error('[Bot] Message handler error:', err);
      }
    });

    bot.on('polling_error', async (err) => {
      console.error('Telegram polling error:', err);
      status.error = err?.message || String(err);
      status.connected = false;

      const retryable = ![401, 403].includes(err?.response?.body?.error_code);
      if (!retryable) {
        console.error('Telegram polling error is not retryable, stopping attempts.');
        return;
      }

      pollingRestartAttempts += 1;
      if (pollingRestartAttempts > MAX_POLLING_RESTARTS) {
        console.error(`Telegram polling failed ${MAX_POLLING_RESTARTS} times, giving up.`);
        return;
      }

      try {
        await bot.stopPolling();
      } catch (stopError) {
        console.warn('Failed to stop polling after error:', stopError);
      }

      const backoff = Math.min(5000 * Math.pow(2, pollingRestartAttempts - 1), 120000);
      console.log(`Restarting polling in ${backoff}ms (attempt ${pollingRestartAttempts}/${MAX_POLLING_RESTARTS})`);
      await delay(backoff);

      try {
        await bot.startPolling();
        status.connected = true;
        status.error = null;
        pollingRestartAttempts = 0;
        console.log('Telegram polling restarted after error');
      } catch (restartError) {
        console.error('Failed to restart Telegram polling:', restartError);
      }
    });

    bot.on('error', (err) => {
      console.error('Telegram bot runtime error:', err);
    });

    bot.on('callback_query', async (query) => {
      try {
      const chatId = String(query.message.chat.id);
      const msgId = String(query.message.message_id);
      const data = String(query.data || '').trim();
      const user = await User.findOne({ telegramId: chatId });
      if (user) {
        updateUserBotActivity(chatId).catch(() => {});
        await logBotInteraction(chatId, 'callback', data, data, {
          messageId: msgId,
          chatId,
        });
      }

      // Handle "noop" for already-processed buttons
      if (data === 'noop') {
        await bot.answerCallbackQuery(query.id);
        return;
      }

      if (data === 'receive_barcode_yes' || data === 'receive_barcode_no') {
        const state = await getSession(chatId, 'receive');
        if (!state) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена або вже завершена.', show_alert: true });
          return;
        }
        if (state.step !== 'await_has_barcode') {
          await bot.answerCallbackQuery(query.id, { text: 'Ця дія вже недоступна.', show_alert: true });
          return;
        }

        if (data === 'receive_barcode_yes') {
          state.step = 'await_barcode_photo';
          await setSession(chatId, 'receive', state);
          await bot.sendMessage(chatId, 'Надішліть фото штрихкоду або QR-коду на товарі.');
        } else {
          state.step = 'await_price';
          await setSession(chatId, 'receive', state);
          await bot.sendMessage(chatId, 'Добре. Введіть ціну товару (zł):');
        }

        await bot.answerCallbackQuery(query.id);
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Обрано', callback_data: 'noop' }]] }, { chat_id: chatId, message_id: msgId });
        } catch (_) {}
        return;
      }

      // ── Registration request review buttons ──
      if (data.startsWith('regreq_')) {
        const parts = data.split(':');
        const action = parts[0];
        const requestId = parts[1];

        if (!requestId) {
          await bot.answerCallbackQuery(query.id, { text: 'Невірні дані заявки', show_alert: true });
          return;
        }

        const request = await RegistrationRequest.findById(requestId).lean();
        if (!request || request.status !== 'pending') {
          await bot.answerCallbackQuery(query.id, { text: 'Заявку вже оброблено або не знайдено', show_alert: true });
          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [[{ text: '❌ Заявка оброблена', callback_data: 'noop' }]] },
              { chat_id: chatId, message_id: msgId }
            );
          } catch (_) {}
          return;
        }

        if (action === 'regreq_approve') {
          const existingUser = await User.findOne({ telegramId: request.telegramId }).lean();
          if (existingUser) {
            await RegistrationRequest.findByIdAndUpdate(requestId, { status: 'rejected' });
            await bot.answerCallbackQuery(query.id, { text: 'Користувач вже зареєстрований', show_alert: true });
          } else {
            const user = new User({
              telegramId: request.telegramId,
              role: request.role,
              firstName: request.firstName,
              lastName: request.lastName,
              shopName: request.role === 'seller' ? request.shopName : '',
              deliveryGroupId: request.role === 'seller' ? request.deliveryGroupId || '' : '',
            });
            await user.save();
            if (request.role === 'seller' && request.deliveryGroupId) {
              await DeliveryGroup.findByIdAndUpdate(
                request.deliveryGroupId,
                { $addToSet: { members: request.telegramId } },
                { new: true }
              );
            }
            await RegistrationRequest.findByIdAndDelete(requestId);
            await bot.answerCallbackQuery(query.id, { text: 'Заявку схвалено', show_alert: false });
            await sendRegistrationApprovedMessage(request.telegramId, request.role);
          }
        } else if (action === 'regreq_reject') {
          await RegistrationRequest.findByIdAndUpdate(requestId, { status: 'rejected' });
          await bot.answerCallbackQuery(query.id, { text: 'Заявку відхилено', show_alert: false });
          await sendMessageWithRetry(request.telegramId, '❌ Ваша заявка на реєстрацію була відхилена.');
        } else {
          await bot.answerCallbackQuery(query.id);
          return;
        }

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [[{ text: '✅ Оброблено', callback_data: 'noop' }]] },
            { chat_id: chatId, message_id: msgId }
          );
        } catch (_) {}
        return;
      }

      // ── Shelf quantity buttons: sq:productId:qty ──
      if (data.startsWith('sq:')) {
        const parts = data.split(':');
        const productId = parts[1];
        const quantity = parseInt(parts[2], 10);
        if (!productId || !quantity) {
          await bot.answerCallbackQuery(query.id);
          return;
        }

        const product = await Product.findById(productId);
        if (!product) {
          await bot.answerCallbackQuery(query.id, { text: 'Товар не знайдено', show_alert: true });
          return;
        }

        await PendingReaction.findOneAndUpdate(
          { sellerTelegramId: chatId, productId: product._id },
          {
            sellerTelegramId: chatId,
            productId: product._id,
            messageId: msgId,
            chatId,
            emoji: `x${quantity}`,
            quantity,
          },
          { upsert: true, new: true }
        );

        // Update the button row to show selected quantity
        const qtyLabels = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
        const updatedButtons = [];
        for (let i = 1; i <= 5; i++) {
          updatedButtons.push({
            text: i === quantity ? `✅ ${qtyLabels[i - 1]}` : qtyLabels[i - 1],
            callback_data: `sq:${productId}:${i}`,
          });
        }

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [updatedButtons] },
            { chat_id: chatId, message_id: msgId }
          );
        } catch (_) { /* message too old or unchanged */ }

        await bot.answerCallbackQuery(query.id, { text: `✅ ${getProductTitle(product)} — ${quantity} шт`, show_alert: false });
        return;
      }

      /*
      // ── Shelf pagination: prev / next ──
      if (data.startsWith('shelf_prev:') || data.startsWith('shelf_next:')) {
        const currentPage = parseInt(data.split(':')[1], 10);
        const newPage = data.startsWith('shelf_next:') ? currentPage + 1 : currentPage - 1;
        await bot.answerCallbackQuery(query.id);
        await sendShelfProducts(chatId, newPage);
        return;
      }

      // ── Shelf: show my list ──
      if (data === 'shelf_mylist') {
        const pending = await PendingReaction.find({ sellerTelegramId: chatId }).populate('productId');
        if (!pending.length) {
          await bot.answerCallbackQuery(query.id, { text: 'Список порожній', show_alert: true });
          return;
        }
        const lines = pending
          .filter((p) => p.productId)
          .map((p, i) => `${i + 1}. ${p.productId.name} — ${p.productId.price} zł x${p.quantity || 1}`);
        const total = pending.filter((p) => p.productId).reduce((sum, p) => sum + p.productId.price * (p.quantity || 1), 0);
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, `🛒 Ваш список:\n\n${lines.join('\n')}\n\nРазом: ${total} zł\n\nНатисніть ✅ Оформити або /order`);
        return;
      }

      // ── Shelf: place order ──
      if (data === 'shelf_order') {
        if (orderInFlight.has(chatId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Замовлення вже обробляється...', show_alert: false });
          return;
        }
        orderInFlight.add(chatId);
        try {
          const result = await finalizeOrder(chatId);
          await bot.answerCallbackQuery(query.id);
          await bot.sendMessage(chatId, result);
        } finally {
          orderInFlight.delete(chatId);
        }
        return;
      }
      */

      // ── Shop quantity buttons: shop_qty:productId:qty ──
      if (data.startsWith('shop_qty:')) {
        const parts = data.split(':');
        const productId = parts[1];
        const quantity = parseInt(parts[2], 10);
        if (!productId || !quantity) {
          await bot.answerCallbackQuery(query.id);
          return;
        }

        const product = await Product.findById(productId);
        if (!product) {
          await bot.answerCallbackQuery(query.id, { text: 'Товар не знайдено', show_alert: true });
          return;
        }

        await upsertPendingReaction(chatId, msgId, product._id, quantity);

        const shopSession = await getSession(chatId, 'shop');
        const totalProducts = shopSession?.productIds?.length || 0;
        const currentIndex = shopSession?.currentIndex || 0;
        const nextIndex = Math.min(currentIndex + 1, totalProducts - 1);

        const nextProductId = shopSession?.productIds?.[nextIndex];
        const nextProduct = nextProductId ? await Product.findById(nextProductId) : null;
        const pendingCount = await PendingReaction.countDocuments({ sellerTelegramId: chatId });

        if (nextProduct && nextIndex !== currentIndex) {
          const caption = buildShopCaption(nextProduct, nextIndex, totalProducts);
          const selectedQty = await getPendingQuantity(chatId, nextProduct._id);
          const replyMarkup = buildShopKeyboard(String(nextProduct._id), nextIndex, totalProducts, selectedQty, pendingCount);

          try {
            const preloadPromise = ensureShopPhotoBuffer(shopSession?.productIds || [], nextIndex);
            const updated = await updateShopMessage(chatId, msgId, nextProduct, caption, replyMarkup);
            await setSession(chatId, 'shop', {
              ...shopSession,
              currentIndex: nextIndex,
              hasPhoto: Boolean(updated?.photo || nextProduct.telegramFileId || getPhotoUrl(nextProduct.imageUrls?.[0])),
              messageId: String(updated?.message_id || shopSession.messageId),
            });
          await persistUserBotState(chatId, {
            'lastBotState.shop': {
              productIds: shopSession.productIds,
              currentIndex: nextIndex,
              updatedAt: new Date(),
            },
          });
            preloadPromise.catch(() => {});
          } catch (error) {
            console.error('Failed to advance shop message', error);
          }
        } else {
          const replyMarkup = buildShopKeyboard(String(product._id), currentIndex, totalProducts, quantity, pendingCount);
          try {
            await bot.editMessageReplyMarkup(replyMarkup, { chat_id: chatId, message_id: msgId });
          } catch (_) {}
        }

        await bot.answerCallbackQuery(query.id, { text: `✅ ${getProductTitle(product)} — ${quantity} шт`, show_alert: false });
        return;
      }

      // ── Shop navigation: prev / next ──
      if (data.startsWith('shop_prev:') || data.startsWith('shop_next:')) {
        const shopSession = await getSession(chatId, 'shop');
        if (!shopSession) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена. Натисніть /shop знову.', show_alert: true });
          return;
        }

        const currentPage = parseInt(data.split(':')[1], 10);
        let newIndex = currentPage;
        if (data.startsWith('shop_next:')) {
          newIndex = currentPage + 1;
        } else {
          newIndex = currentPage - 1;
        }

        const totalProducts = shopSession.productIds?.length || 0;
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= totalProducts) newIndex = totalProducts - 1;

        const productId = shopSession.productIds?.[newIndex];
        const product = productId ? await Product.findById(productId) : null;
        if (!product) {
          await bot.answerCallbackQuery(query.id, { text: 'Товар не знайдено', show_alert: true });
          return;
        }

        const caption = buildShopCaption(product, newIndex, totalProducts);
        const pendingCount = await PendingReaction.countDocuments({ sellerTelegramId: chatId });
        const selectedQty = await getPendingQuantity(chatId, product._id);
        const replyMarkup = buildShopKeyboard(String(product._id), newIndex, totalProducts, selectedQty, pendingCount);

        try {
          const preloadPromise = ensureShopPhotoBuffer(shopSession?.productIds || [], newIndex);
          const updated = await updateShopMessage(chatId, msgId, product, caption, replyMarkup);
          await setSession(chatId, 'shop', {
            ...shopSession,
            currentIndex: newIndex,
            hasPhoto: Boolean(updated?.photo || product.telegramFileId || getPhotoUrl(product.imageUrls?.[0])),
            messageId: String(updated?.message_id || shopSession.messageId),
          });
          await persistUserBotState(chatId, {
            'lastBotState.shop': {
              productIds: shopSession.productIds,
              currentIndex: newIndex,
              updatedAt: new Date(),
            },
          });
          preloadPromise.catch(() => {});
        } catch (error) {
          console.error('Failed to update shop message', error);
        }

        await bot.answerCallbackQuery(query.id);
        return;
      }

      // ── Shop: show my list ──
      if (data === 'shop_mylist') {
        const pending = await PendingReaction.find({ sellerTelegramId: chatId }).populate('productId');
        if (!pending.length) {
          await bot.answerCallbackQuery(query.id, { text: 'Список порожній', show_alert: true });
          return;
        }
        const lines = pending
          .filter((p) => p.productId)
          .map((p, i) => `${i + 1}. ${p.productId.name} — ${p.productId.price} zł x${p.quantity || 1}`);
        const total = pending.filter((p) => p.productId).reduce((sum, p) => sum + p.productId.price * (p.quantity || 1), 0);
        await bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, `🛒 Ваш список:

${lines.join('\n')}

Разом: ${total} zł

Натисніть ✅ Оформити`);
        return;
      }

      // ── Shop: place order ──
      if (data === 'shop_order') {
        if (orderInFlight.has(chatId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Замовлення вже обробляється...', show_alert: false });
          return;
        }
        orderInFlight.add(chatId);
        try {
          const result = await finalizeOrder(chatId);
          await bot.answerCallbackQuery(query.id);
          await bot.sendMessage(chatId, result);
          const shopSession = await getSession(chatId, 'shop');
          const reset = Array.isArray(shopSession?.productIds) && shopSession.currentIndex >= shopSession.productIds.length - 1;
          await setShopMenuButton(chatId, 'Товари', reset);
        } finally {
          orderInFlight.delete(chatId);
        }
        return;
      }

      // ── Shop: reset current shop session ──
      if (data === 'shop_reset') {
        await bot.answerCallbackQuery(query.id, { text: 'Скидаю стан...', show_alert: false });
        const shopSession = await getSession(chatId, 'shop');
        if (shopSession?.messageId) {
          await deleteShopMessage(chatId, shopSession.messageId);
        }
        if (shopSession?.menuMessageId) {
          await deleteShopMessage(chatId, shopSession.menuMessageId);
        }
        await deleteSession(chatId, 'shop');
        await PendingReaction.deleteMany({ sellerTelegramId: chatId });
        await setShopMenuButton(chatId, 'Товари', true);
        await sendShopProducts(chatId, 0, true);
        return;
      }

      const carousel = await getSession(chatId, 'ship', msgId);

      // ── ◀️ PREV / ▶️ NEXT: navigate carousel ──
      if (data === 'sprev:' || data === 'snext:') {
        if (!carousel) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена. Натисніть /ship знову.', show_alert: true });
          return;
        }

        const total = carousel.entries.length;
        if (data === 'snext:') {
          carousel.currentIndex = (carousel.currentIndex + 1) % total;
        } else {
          carousel.currentIndex = (carousel.currentIndex - 1 + total) % total;
        }

        const entry = carousel.entries[carousel.currentIndex];
        const { caption, reply_markup } = buildCarouselMessage(
          carousel.productName, carousel.position, entry, carousel.currentIndex, total
        );

        try {
          if (carousel.hasPhoto) {
            await bot.editMessageCaption(caption, {
              chat_id: chatId,
              message_id: msgId,
              reply_markup,
            });
          } else {
            await bot.editMessageText(caption, {
              chat_id: chatId,
              message_id: msgId,
              reply_markup,
            });
          }
        } catch (_) { /* nothing changed or too old */ }

        await setSession(chatId, 'ship', carousel, msgId);
        await bot.answerCallbackQuery(query.id);
        return;
      }

      // ── ✅ SPACK: confirm current order in carousel ──
      if (data === 'spack:') {
        if (!carousel) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена. Натисніть /ship знову.', show_alert: true });
          return;
        }

        const entry = carousel.entries[carousel.currentIndex];
        if (entry.packed) {
          await bot.answerCallbackQuery(query.id, { text: 'Це замовлення вже спаковано.', show_alert: false });
          return;
        }

        // Mark packed BEFORE any async work to prevent double-click race condition
        entry.packed = true;

        // Confirm order in DB
        const order = await Order.findById(entry.orderId);
        if (order && order.status === 'new') {
          order.status = 'confirmed';
          await order.save();
        }

        // Check if all entries are packed
        const allPacked = carousel.entries.every((e) => e.packed);
        if (allPacked) {
          // All done — update message to show completion
          try {
            const doneCaption = `✅ Позиція ${carousel.position} — "${carousel.productName}"\nУсі ${carousel.entries.length} замовлень спаковано!\n\nЯкщо товар закінчився — відповідте "Закінчився"`;
            if (carousel.hasPhoto) {
              await bot.editMessageCaption(doneCaption, {
                chat_id: chatId, message_id: msgId,
                reply_markup: { inline_keyboard: [[{ text: '✅ Усе спаковано', callback_data: 'noop' }]] },
              });
            } else {
              await bot.editMessageText(doneCaption, {
                chat_id: chatId, message_id: msgId,
                reply_markup: { inline_keyboard: [[{ text: '✅ Усе спаковано', callback_data: 'noop' }]] },
              });
            }
          } catch (_) {}
          carousel.allPacked = true;
          await setSession(chatId, 'ship', carousel, msgId);
          await bot.answerCallbackQuery(query.id, { text: '✅ Усі замовлення спаковано!', show_alert: false });
          return;
        }

        // Auto-advance to next unpacked
        let nextIdx = (carousel.currentIndex + 1) % carousel.entries.length;
        while (carousel.entries[nextIdx].packed && nextIdx !== carousel.currentIndex) {
          nextIdx = (nextIdx + 1) % carousel.entries.length;
        }
        carousel.currentIndex = nextIdx;

        const nextEntry = carousel.entries[carousel.currentIndex];
        const remaining = carousel.entries.filter((e) => !e.packed).length;
        const { caption, reply_markup } = buildCarouselMessage(
          carousel.productName, carousel.position, nextEntry, carousel.currentIndex, carousel.entries.length
        );

        try {
          if (carousel.hasPhoto) {
            await bot.editMessageCaption(`${caption}\n\n⏳ Залишилось: ${remaining}`, {
              chat_id: chatId, message_id: msgId, reply_markup,
            });
          } else {
            await bot.editMessageText(`${caption}\n\n⏳ Залишилось: ${remaining}`, {
              chat_id: chatId, message_id: msgId, reply_markup,
            });
          }
        } catch (_) {}

        await setSession(chatId, 'ship', carousel, msgId);
        await bot.answerCallbackQuery(query.id, { text: `✅ Спаковано для ${entry.shopName}`, show_alert: false });
        return;
      }

      console.warn('[Bot] Unknown callback query action:', { data, chatId, msgId });
      await bot.answerCallbackQuery(query.id, { text: 'Невідома дія.', show_alert: true });
      } catch (err) {
        console.error('[Bot] Callback query handler error:', err);
        try { await bot.answerCallbackQuery(query.id); } catch (_) {}
      }
    });

    bot.on('my_chat_member', async (update) => {
      await handleMyChatMemberUpdate(update).catch((err) => {
        console.error('my_chat_member handler failed:', err);
      });
    });

    // Reaction handling by Telegram message_reaction has been disabled.

    async function finalizeOrder(userId) {
      const user = await User.findOne({ telegramId: userId });
      if (!user) return 'Вас не знайдено в системі.';

      const pending = await PendingReaction.find({ sellerTelegramId: userId }).populate('productId');
      if (!pending.length) return 'У вас немає обраних товарів. Додайте товар кнопками в /shop, щоб зібрати список.';

      // Merge duplicate products (same productId → sum quantities)
      const merged = new Map();
      for (const p of pending) {
        if (!p.productId) continue;
        const pid = String(p.productId._id);
        if (merged.has(pid)) {
          merged.get(pid).quantity += (p.quantity || 1);
        } else {
          merged.set(pid, {
            productId: p.productId._id,
            name: p.productId.name,
            price: p.productId.price,
            quantity: p.quantity || 1,
          });
        }
      }

      const items = Array.from(merged.values());

      if (!items.length) {
        await PendingReaction.deleteMany({ sellerTelegramId: userId });
        return 'Товари не знайдено. Можливо, вони були видалені.';
      }

      const totalPrice = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
      const shippingAddress = [user.shopAddress, user.shopCity].filter(Boolean).join(', ');
      const contactInfo = [user.shopName, [user.firstName, user.lastName].filter(Boolean).join(' '), user.phoneNumber]
        .filter(Boolean)
        .join(' | ');

      const order = new Order({
        buyerTelegramId: user.telegramId,
        items,
        shippingAddress,
        contactInfo,
        totalPrice,
      });
      await order.save();

      // Clear pending shop selections
      await PendingReaction.deleteMany({ sellerTelegramId: userId });

      const itemsList = items.map((i) => `• ${i.name} — ${i.price} zł x${i.quantity}`).join('\n');
      return `✅ Замовлення оформлено!\n\n${itemsList}\n\nРазом: ${totalPrice} zł`;
    }

    console.log('Telegram bot started');
  } catch (error) {
    status.error = error.message || String(error);
    status.connected = false;
    console.error('Failed to start Telegram bot:', error);
  }
}

function getBotStatus() {
  const statusLabel = status.error ? 'error' : status.connected ? 'connected' : 'disconnected';

  return {
    status: statusLabel,
    active: status.connected,
    mode: 'polling',
    startedAt: status.startedAt,
    error: status.error,
    hasToken: Boolean(bot),
  };
}

module.exports = {
  initBot,
  getBotStatus,
  getBot: () => bot,
  sendOrderConfirmation,
  sendAdminNotification,
  sendRegistrationApprovedMessage,
  fixPendingReactionIndexes,
  getShippingBlockPositions,
};

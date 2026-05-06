const TelegramBot = require('node-telegram-bot-api');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const crypto = require('crypto');
const { shiftUp: shiftOrderUp, shiftDown } = require('./utils/shiftOrderNumbers');
const { analyzeBarcodeImage, analyzeProductImage } = require('./openaiClient');
const { decodeBarcodeFromImageBuffer, normalizeBarcode } = require('./utils/barcodeScanner');
const User = require('./models/User');
const Product = require('./models/Product');
// WARNING: SearchProduct is a completely independent schema from Product.
// Admin group replies that create SearchProduct records must not be treated as warehouse inventory.
const SearchProduct = require('./models/SearchProduct');
const Order = require('./models/Order');

const BotSession = require('./models/BotSession');
const BotInteractionLog = require('./models/BotInteractionLog');
const RegistrationRequest = require('./models/RegistrationRequest');
const DeliveryGroup = require('./models/DeliveryGroup');
const Block = require('./models/Block');
const PickingTask = require('./models/PickingTask');
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
  pick: 4 * 60 * 60 * 1000,      // 4 hours
  order: 15 * 60 * 1000,         // 15 min
};

const PICK_TASK_LOCK_TIMEOUT_MS = Number(process.env.PICK_TASK_LOCK_TIMEOUT_MS || 20 * 60 * 1000);

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

async function getReceiveState(chatId) {
  return getSession(chatId, 'receive');
}

async function setReceiveState(chatId, state) {
  await setSession(chatId, 'receive', state);
}

async function clearReceiveState(chatId) {
  await deleteSession(chatId, 'receive');
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
      await handleBotBlocked(chatId);
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
    '/miniapp - Відкрити товари та зробити замовлення',
  ],
  warehouse: [
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
    { command: '/miniapp', description: 'Товари та замовлення' },
  ],
  warehouse: [
    { command: '/miniapp', description: 'Відкрити склад' },
  ],
  admin: [
    { command: '/miniapp', description: 'Відкрити Адмінку' },
    //{ command: '/help', description: 'Показати доступні команди' },
    //{ command: '/profile', description: 'Мій профіль' },
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
    //lines.push(`Номер магазину: ${user.shopNumber || 'не вказано'}`);
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

function isBotBlockedError(error) {
  const code = error?.response?.statusCode || error?.response?.body?.error_code;
  const desc = String(error?.response?.body?.description || error?.message || '').toLowerCase();
  return (
    code === 403 ||
    desc.includes('bot was blocked') ||
    desc.includes('user is deactivated') ||
    desc.includes('chat not found')
  );
}

async function sendMessageWithRetry(chatId, text, options = {}, attempts = 3) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (error) {
    const code = error?.response?.statusCode || error?.code;
    if (attempts > 1 && (code === 429 || code === 'ETELEGRAM') && !isBotBlockedError(error)) {
      const retryAfter = error?.response?.body?.parameters?.retry_after || 5;
      await delay(retryAfter * 1000);
      return sendMessageWithRetry(chatId, text, options, attempts - 1);
    }
    if (isBotBlockedError(error)) {
      handleBotBlocked(String(chatId)).catch((err) => {
        console.error('[Bot] handleBotBlocked threw unexpectedly:', err.message);
      });
    }
    throw error;
  }
}

async function sendPhotoWithRetry(chatId, photo, options = {}, attempts = 3) {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  } catch (error) {
    const code = error?.response?.statusCode || error?.code;
    if (attempts > 1 && (code === 429 || code === 'ETELEGRAM')) {
      const retryAfter = error?.response?.body?.parameters?.retry_after || 5;
      await delay(retryAfter * 1000);
      return sendPhotoWithRetry(chatId, photo, options, attempts - 1);
    }
    throw error;
  }
}

async function handleBotBlocked(telegramId) {
  try {
    await User.findOneAndUpdate({ telegramId: String(telegramId) }, { botBlocked: true });
    const blockedUser = await User.findOne({ telegramId: String(telegramId) }).lean();
    const name = [blockedUser?.firstName, blockedUser?.lastName].filter(Boolean).join(' ') || telegramId;
    const roleLabels = { seller: 'Продавець', warehouse: 'Склад', admin: 'Адмін' };
    const roleLabel = roleLabels[blockedUser?.role] || blockedUser?.role || 'Невідома роль';
    const shopParts = [blockedUser?.shopName, blockedUser?.shopCity].filter(Boolean);
    const lines = [`⛔ БОТ ЗАБЛОКОВАНО!`, `${roleLabel}: ${name}`];
    if (shopParts.length) lines.push(`Магазин: ${shopParts.join(', ')}`);
    lines.push(`заблокував бота.`);
    const admins = await User.find({ role: 'admin' }, 'telegramId').lean();
    const adminIds = admins.map((a) => a.telegramId).filter(Boolean);
    console.log(`[Bot] Bot blocked by ${telegramId} (${name}). Notifying admins: [${adminIds.join(', ')}]`);
    await sendAdminNotification(lines.join('\n'));
    console.log(`[Bot] Admin notification sent for blocked user ${telegramId}`);
  } catch (err) {
    console.error('[Bot] handleBotBlocked failed:', err.message, err.stack);
  }
}

async function sendAdminNotification(text) {
  const admins = await User.find({ role: 'admin' }, 'telegramId').lean();
  const adminIds = admins.map((a) => a.telegramId).filter(Boolean);
  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(adminId, text);
    } catch (err) {
      console.warn('[Bot] sendAdminNotification failed for', adminId, err.message);
    }
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
    await setReceiveState(chatId, state);
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
      await setReceiveState(chatId, state);
      await bot.sendMessage(chatId, 'Добре. Надішліть фото штрихкоду або QR-коду.');
      return;
    }

    if (normalized === 'ні' || normalized === 'немає' || normalized === 'no') {
      state.step = 'await_price';
      await setReceiveState(chatId, state);
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
    await setReceiveState(chatId, state);

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
    await setReceiveState(chatId, state);
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
    await setReceiveState(chatId, state);
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
    await setReceiveState(chatId, state);
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
    await clearReceiveState(chatId);

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
function buildCarouselMessage(productName, position, entry, currentIndex, totalEntries, productId, hasRemaining) {
  const caption = [
    `📦 ${position || 'N/A'}`,
    `🏪 Магазин: ${entry.shopName}`,
    `📊 Кількість: ${entry.quantity}`,
    '',
    `${currentIndex + 1} / ${totalEntries}`,
    '',
    `[ID: ${productId}]`,
  ].join('\n');

  const navRow = [];
  if (totalEntries > 1) {
    navRow.push({ text: `◀️ Попередній`, callback_data: `sprev:${productId}` });
    navRow.push({ text: `Наступний ▶️`, callback_data: `snext:${productId}` });
  }

  const actionRow = [];
  actionRow.push({
    text: entry && entry.packed ? '✅ Спаковано' : '⬜ Спаковано',
    callback_data: `spack:${productId}`,
  });

  if (hasRemaining) {
    actionRow.push({ text: '❌ Закінчився', callback_data: `pick_sold_out:${productId}` });
  }

  const inline_keyboard = [];
  if (navRow.length) inline_keyboard.push(navRow);
  inline_keyboard.push(actionRow);

  return { caption, reply_markup: { inline_keyboard } };
}

function buildSoldOutConfirmationMarkup(confirmData, cancelData) {
  return {
    inline_keyboard: [[
      { text: '✅ Так, товару немає', callback_data: confirmData },
      { text: '❌ Ні, скасувати', callback_data: cancelData },
    ]],
  };
}

async function getShippingBlockPositions(productIds) {
  if (!Array.isArray(productIds) || !productIds.length) return new Map();

  const blocks = await Block.find(
    { productIds: { $in: productIds } },
    'blockId productIds'
  )
    // Populate with the same status filter the warehouse UI uses so positions match
    // what workers physically see (archived products are excluded from the count)
    .populate({ path: 'productIds', match: { status: { $in: ['active', 'pending'] } } })
    .sort({ blockId: 1 })
    .lean();

  const positions = new Map();
  for (const block of blocks) {
    // After populate+match, non-matching (archived) entries become null — skip them
    const visibleProducts = (block.productIds || []).filter(Boolean);
    for (let index = 0; index < visibleProducts.length; index += 1) {
      const pid = String(visibleProducts[index]._id);
      if (!positions.has(pid)) {
        positions.set(pid, { blockId: block.blockId, index });
      }
    }
  }

  return positions;
}

async function ensureBlocks() {
  // Blocks are managed manually through the admin/blocks API.
  // No automatic block generation or hardcoded 120-block limit should be used.
  return;
}

async function buildPickingTasksFromOrders() {
  if (buildPickingTasksFromOrders._running) return;
  buildPickingTasksFromOrders._running = true;
  try {
  // 1. Find already assigned order/product pairs so we don't create duplicates.
  const activeTasks = await PickingTask.find(
    { status: { $in: ['pending', 'locked'] } },
    'productId items.orderId blockId positionIndex'
  ).lean();

  const assignedOrderProducts = new Set();
  for (const task of activeTasks) {
    const pid = String(task.productId);
    for (const item of task.items) {
      assignedOrderProducts.add(`${item.orderId}_${pid}`);
    }
  }

  // 2. Take all active orders and build missing picking tasks.
  const orders = await Order.find({ status: { $in: ['new', 'in_progress'] } })
    .populate('items.productId')
    .sort({ createdAt: 1 })
    .lean();

  const buyerIds = orders.length ? [...new Set(orders.map((order) => order.buyerTelegramId))] : [];
  const buyers = buyerIds.length ? await User.find({ telegramId: { $in: buyerIds } }).lean() : [];
  const buyerMap = new Map(buyers.map((buyer) => [buyer.telegramId, buyer]));

  const productGroups = new Map();
  for (const order of orders) {
    const buyer = buyerMap.get(order.buyerTelegramId);
    for (const item of order.items) {
      if (item.packed || item.cancelled || !item.productId) continue;
      if (item.productId.status === 'archived') continue;
      const productId = String(item.productId._id);
      if (assignedOrderProducts.has(`${order._id}_${productId}`)) continue;

      const group = productGroups.get(productId) || {
        productId: item.productId._id,
        items: [],
      };
      group.items.push({
        orderId: order._id,
        shopName: order.buyerSnapshot?.shopName || buyer?.shopName || 'невідомий магазин',
        quantity: item.quantity || 0,
        packed: false,
      });
      productGroups.set(productId, group);
    }
  }

  // Refresh location of existing pending/locked tasks in case products were moved between blocks.
  if (activeTasks.length) {
    const existingPositions = await getShippingBlockPositions(
      activeTasks.map((t) => String(t.productId))
    );
    await Promise.all(
      activeTasks.map(async (t) => {
        const pos = existingPositions.get(String(t.productId));
        if (!pos) return;
        const newBlockId = pos.blockId;
        const newPosIdx = pos.index + 1;
        if (t.blockId === newBlockId && t.positionIndex === newPosIdx) return;
        await PickingTask.updateOne(
          { _id: t._id },
          { $set: { blockId: newBlockId, positionIndex: newPosIdx } }
        );
      })
    );
  }

  if (!productGroups.size) return;

  const positions = await getShippingBlockPositions(Array.from(productGroups.keys()));
  const tasks = [];
  for (const [productId, group] of productGroups.entries()) {
    const position = positions.get(productId);
    tasks.push({
      productId: group.productId,
      // Products from incoming can be ordered before they are placed on shelves.
      // For those we keep a valid picking task with synthetic location (blockId=0).
      blockId: position?.blockId ?? 0,
      positionIndex: position ? position.index + 1 : 0,
      items: group.items,
    });
  }

  tasks.sort((a, b) => a.blockId - b.blockId || a.positionIndex - b.positionIndex);
  if (!tasks.length) return;

  try {
    // ordered:false — if two workers trigger this simultaneously, duplicate key errors
    // from the partial unique index on productId are silently skipped; valid new tasks still insert.
    await PickingTask.insertMany(tasks, { ordered: false });
  } catch (err) {
    if (err?.code !== 11000 && err?.name !== 'BulkWriteError') {
      console.error('[Bot] PickingTask insert error:', err);
    }
  }
  } finally {
    buildPickingTasksFromOrders._running = false;
  }
}

function buildPickTaskCaption(task) {
  const totalQty = task.items.reduce((sum, item) => sum + (item.quantity || 0), 0);
  const productTitle = task.productId?.name || 'Невідомий товар';
  const locationLine = task.blockId > 0
    ? `📍 Блок ${task.blockId}, позиція ${task.positionIndex}`
    : '📍 Надходження (товар ще не розміщений на полиці)';
  return [
    locationLine,
    `📦 Товар: ${productTitle}`,
    `🔢 Загальна кількість: ${totalQty} шт.`,
    '',
    'Натисніть на магазин, щоб позначити товар як спакований.',
  ].join('\n');
}

function buildPickTaskKeyboard(task) {
  const rows = task.items.map((item, index) => [{
    text: `${item.packed ? '✅' : '📦'} ${item.shopName} (${item.quantity || 0} шт)`,
    callback_data: `pick_item:${task._id}:${index}`,
  }] );

  rows.push([
    { text: '⏸ Відкласти', callback_data: `pick_skip:${task._id}` },
  ]);

  rows.push([
    { text: '❌ Товар закінчився', callback_data: `pick_sold_out:${task._id}` },
  ]);

  return { inline_keyboard: rows };
}

async function getUserLockedPickingTasks(chatId) {
  return PickingTask.find({ status: 'locked', lockedBy: String(chatId) })
    .sort({ blockId: 1, positionIndex: 1 })
    .populate('productId')
    .lean();
}

async function releaseStaleOrOrphanLockedTasks() {
  const lockDeadline = new Date(Date.now() - PICK_TASK_LOCK_TIMEOUT_MS);

  // Auto-release tasks that stayed locked too long.
  await PickingTask.updateMany(
    {
      status: 'locked',
      lockedAt: { $lt: lockDeadline },
    },
    {
      $set: { status: 'pending', lockedBy: null, lockedAt: null },
    }
  );

  // Auto-release tasks locked by workers who are not on shift anymore.
  const activeWorkers = await User.find({ role: 'warehouse', isOnShift: true }, 'telegramId').lean();
  const activeTelegramIds = activeWorkers.map((worker) => String(worker.telegramId));

  await PickingTask.updateMany(
    {
      status: 'locked',
      lockedBy: { $nin: activeTelegramIds },
    },
    {
      $set: { status: 'pending', lockedBy: null, lockedAt: null },
    }
  );
}

async function claimPickingTask(chatId, zoneStart, zoneEnd, lastBlock) {
  await releaseStaleOrOrphanLockedTasks();

  const lockUpdate = {
    $set: {
      status: 'locked',
      lockedBy: String(chatId),
      lockedAt: new Date(),
    },
  };

  const claimValidTask = async (query) => {
    while (true) {
      const claimed = await PickingTask.findOneAndUpdate(
        query,
        lockUpdate,
        { sort: { blockId: 1, positionIndex: 1 }, new: true }
      );

      if (!claimed) return null;

      const product = await Product.findById(claimed.productId, 'status').lean();
      if (product && product.status !== 'archived') {
        return PickingTask.findById(claimed._id).populate('productId').lean();
      }

      // Stale task linked to archived/missing product: mark completed and try next.
      await PickingTask.findByIdAndUpdate(claimed._id, {
        $set: { status: 'completed', lockedBy: null, lockedAt: null },
      });
    }
  };

  const taskInZone = await claimValidTask({
    blockId: { $gte: zoneStart, $lte: zoneEnd },
    status: 'pending',
    skippedBy: { $ne: String(chatId) },
  });

  if (taskInZone) {
    return { task: taskInZone, wasSkipped: false };
  }

  const taskOutsideZone = await claimValidTask({
    status: 'pending',
    skippedBy: { $ne: String(chatId) },
  });

  if (taskOutsideZone) {
    return { task: taskOutsideZone, wasSkipped: false };
  }

  // Anti-deadlock fallback: if all workers skipped the same task(s), still force claim
  // so those positions get resolved within the same shift.
  const forcedTaskInZone = await claimValidTask({
    blockId: { $gte: zoneStart, $lte: zoneEnd },
    status: 'pending',
  });

  if (forcedTaskInZone) {
    return { task: forcedTaskInZone, wasSkipped: true };
  }

  const forcedTask = await claimValidTask({
    status: 'pending',
  });
  return forcedTask ? { task: forcedTask, wasSkipped: true } : null;
}

async function getCurrentPickSession(chatId) {
  return getSession(chatId, 'pick', 'current');
}

async function saveCurrentPickSession(chatId, data) {
  return setSession(chatId, 'pick', data, 'current');
}

async function deleteCurrentPickSession(chatId) {
  return deleteSession(chatId, 'pick', 'current');
}

async function getPickTaskById(taskId) {
  return PickingTask.findById(taskId).populate('productId').lean();
}

async function sendPickTaskMessage(chatId, task, pickState, msgId = null) {
  const caption = buildPickTaskCaption(task);
  const replyMarkup = buildPickTaskKeyboard(task);
  const photoUrl = task.productId?.telegramFileId || getPhotoUrl(task.productId?.imageUrls?.[0]);
  const hasPhoto = Boolean(photoUrl);
  const oldHasPhoto = Boolean(pickState?.hasPhoto);

  if (msgId) {
    try {
      if (oldHasPhoto && hasPhoto) {
        // Update photo and caption when both old and new messages are photo-based.
        await bot.editMessageMedia(
          {
            type: 'photo',
            media: photoUrl,
            caption,
          },
          {
            chat_id: chatId,
            message_id: msgId,
            reply_markup: replyMarkup,
          }
        );
        return { messageId: msgId, hasPhoto };
      }

      if (!oldHasPhoto && !hasPhoto) {
        await bot.editMessageText(caption, { chat_id: chatId, message_id: msgId, reply_markup: replyMarkup });
        return { messageId: msgId, hasPhoto };
      }

      // If message type changes between photo and text, remove the old message and send a new one.
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (_) {
      }
    } catch (_) {
      // fallback to sending a new message if editing fails
      try {
        await bot.deleteMessage(chatId, msgId);
      } catch (_) {
      }
    }
  }

  let sent;
  if (hasPhoto) {
    sent = await sendPhotoWithRetry(chatId, photoUrl, { caption, reply_markup: replyMarkup });
  } else {
    sent = await bot.sendMessage(chatId, caption, { reply_markup: replyMarkup });
  }

  return { messageId: String(sent?.message_id), hasPhoto };
}

async function claimAndSendNextPickTask(chatId, zoneStart, zoneEnd, lastBlock, currentSession) {
  await buildPickingTasksFromOrders();
  const result = await claimPickingTask(chatId, zoneStart, zoneEnd, lastBlock);
  if (!result) {
    await bot.sendMessage(chatId, 'Поки що немає вільних завдань для поточної зони. Спробуйте пізніше.');
    return null;
  }
  const { task, wasSkipped } = result;

  const lockedTasks = await getUserLockedPickingTasks(chatId);
  const currentIndex = lockedTasks.findIndex((locked) => String(locked._id) === String(task._id));
  const session = {
    lastBlock,
    currentTaskId: String(task._id),
    taskIds: lockedTasks.map((t) => String(t._id)),
    currentTaskIndex: currentIndex >= 0 ? currentIndex : 0,
  };
  if (currentSession?.messageId) {
    session.messageId = currentSession.messageId;
    session.hasPhoto = currentSession.hasPhoto;
  }

  const sendResult = await sendPickTaskMessage(chatId, task, session, session.messageId);
  session.messageId = sendResult.messageId;
  session.hasPhoto = sendResult.hasPhoto;
  await saveCurrentPickSession(chatId, session);

  if (wasSkipped) {
    await bot.sendMessage(
      chatId,
      '⚠️ Ця позиція була пропущена раніше.\nЗнайдіть товар на складі або натисніть «❌ Закінчився», якщо товару немає.'
    );
  }

  return task;
}

async function openPickWorkflow(chatId, lastBlock) {
  const user = await User.findOne({ telegramId: chatId });
  if (!user || user.role !== 'warehouse') {
    await bot.sendMessage(chatId, 'Вас не знайдено або у вас немає доступу до складу.');
    return null;
  }

  const zoneStart = Number(user.shiftZone?.startBlock || 0);
  const zoneEnd = Number(user.shiftZone?.endBlock || 0);
  if (!zoneStart || !zoneEnd || zoneStart > zoneEnd) {
    await bot.sendMessage(chatId, 'Ваша зона не призначена. Зверніться до менеджера зміни.');
    return null;
  }

  const session = await getCurrentPickSession(chatId);

  // 1. Return worker to existing locked tasks if they have any.
  const lockedTasks = await getUserLockedPickingTasks(chatId);
  if (lockedTasks.length > 0) {
    let taskIndex = 0;
    if (session?.currentTaskId) {
      const idx = lockedTasks.findIndex((t) => String(t._id) === session.currentTaskId);
      if (idx !== -1) taskIndex = idx;
    }
    const task = lockedTasks[taskIndex];

    const newSession = {
      lastBlock: task.blockId,
      currentTaskId: String(task._id),
      taskIds: lockedTasks.map((t) => String(t._id)),
      currentTaskIndex: taskIndex,
      messageId: session?.messageId,
      hasPhoto: session?.hasPhoto,
    };

    const result = await sendPickTaskMessage(chatId, task, newSession, session?.messageId);
    newSession.messageId = result.messageId;
    newSession.hasPhoto = result.hasPhoto;
    await saveCurrentPickSession(chatId, newSession);
    return task;
  }

  // 2. If there are no locked tasks, build/claim a new one.
  const effectiveLastBlock = lastBlock && lastBlock >= zoneStart && lastBlock <= zoneEnd ? lastBlock : zoneStart;
  const task = await claimAndSendNextPickTask(chatId, zoneStart, zoneEnd, effectiveLastBlock, session);
  return task;
}

async function getCurrentLockedTasks(chatId) {
  return getUserLockedPickingTasks(chatId);
}

async function navigatePickTask(chatId, direction) {
  const session = await getCurrentPickSession(chatId);
  const tasks = await getCurrentLockedTasks(chatId);
  if (!tasks.length) {
    if (session) await deleteCurrentPickSession(chatId);
    return null;
  }

  if (!session || !Array.isArray(session.taskIds) || !session.taskIds.length) {
    return null;
  }

  let index = tasks.findIndex((task) => String(task._id) === String(session.currentTaskId));
  if (index === -1) {
    index = 0;
  }

  if (direction === 'next') {
    index = (index + 1) % tasks.length;
  } else {
    index = (index - 1 + tasks.length) % tasks.length;
  }

  const task = tasks[index];
  if (!task) return null;

  session.taskIds = tasks.map((t) => String(t._id));
  session.currentTaskId = String(task._id);
  session.currentTaskIndex = index;
  const result = await sendPickTaskMessage(chatId, task, session, session.messageId);
  session.messageId = result.messageId;
  session.hasPhoto = result.hasPhoto;
  await saveCurrentPickSession(chatId, session);
  return task;
}

async function handlePickTaskItem(chatId, taskId, itemIndex) {
  const task = await PickingTask.findById(taskId);
  if (!task || task.lockedBy !== String(chatId) || task.status !== 'locked') {
    return null;
  }

  const item = task.items[itemIndex];
  if (!item) {
    return null;
  }

  const toggledPacked = !item.packed;
  item.packed = toggledPacked;
  await task.save();

  // Sync the original order item
  const order = await Order.findById(item.orderId);
  if (order) {
    const orderItem = order.items.find(
      (i) => String(i.productId) === String(task.productId)
    );

    if (orderItem) {
      orderItem.packed = toggledPacked;
      const allCancelled = order.items.every((i) => i.cancelled);
      const isFullyProcessed = order.items.every((i) => i.packed || i.cancelled);

      if (allCancelled) {
        order.status = 'cancelled';
      } else if (isFullyProcessed) {
        order.status = 'confirmed';
      } else if (order.items.some((i) => i.packed || i.cancelled)) {
        order.status = 'in_progress';
      } else {
        order.status = 'new';
      }

      await order.save();
    }
  }

  const allPacked = task.items.every((item) => item.packed);
  if (allPacked) {
    task.status = 'completed';
    task.lockedBy = null;
    task.lockedAt = null;
    await task.save();
    return { task: await getPickTaskById(taskId), completed: true, toggledPacked };
  }

  return { task: await getPickTaskById(taskId), completed: false, toggledPacked };
}

async function scanAndUpdateProduct(product, imageBuffer, options = {}) {
  const result = await analyzeProductImage(imageBuffer, options);
  const parsed = result.parsed || {};

  if (parsed.title) {
    product.name = parsed.title;
  }
  if (parsed.brand) {
    product.brand = parsed.brand;
  }
  if (parsed.model) {
    product.model = parsed.model;
  }
  if (parsed.category) {
    product.category = parsed.category;
  }
  if (parsed.barcode) {
    product.barcode = parsed.barcode;
  }
  if (parsed.qrCode) {
    product.qrCode = parsed.qrCode;
  }
  if (parsed.description !== undefined) {
    product.description = parsed.description;
  }
  if (parsed.textOnImage !== undefined) {
    product.textOnImage = parsed.textOnImage;
  }

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
  const user = await User.findOne({ telegramId: chatId });
  if (!user || user.role !== 'warehouse') {
    await bot.sendMessage(chatId, 'Вас не знайдено або у вас немає доступу до складу.');
    return;
  }

  const zoneStart = Number(user.shiftZone?.startBlock || 0);
  const zoneEnd = Number(user.shiftZone?.endBlock || 0);
  if (!zoneStart || !zoneEnd || zoneStart > zoneEnd) {
    await bot.sendMessage(chatId, 'Ваша зона не призначена. Зверніться до менеджера зміни.');
    return;
  }

  // Шукаємо і нові, і ті що "в процесі"
  const orders = await Order.find({ status: { $in: ['new', 'in_progress'] } })
    .populate('items.productId')
    .sort({ createdAt: 1 });
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
      if (item.packed || item.cancelled) continue;
      const product = item.productId;
      if (!product) continue;
      if (product.status === 'archived') continue;
      const pid = String(product._id);
      if (!productMap.has(pid)) {
        productMap.set(pid, { product, entries: [] });
      }

      const entries = productMap.get(pid).entries;
      const snapshotShopName = order.buyerSnapshot?.shopName || buyer?.shopName || 'не вказано';
      const existingEntry = entries.find(
        (e) => e.buyerTelegramId === order.buyerTelegramId && e.shopName === snapshotShopName
      );

      if (existingEntry) {
        existingEntry.quantity += item.quantity;
        if (!existingEntry.orderIds.includes(String(order._id))) {
          existingEntry.orderIds.push(String(order._id));
        }
      } else {
        const buyerName = [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' ') || order.buyerTelegramId;
        const address = [buyer?.shopAddress, buyer?.shopCity].filter(Boolean).join(', ') || 'не вказано';
        entries.push({
          buyerTelegramId: order.buyerTelegramId,
          orderIds: [String(order._id)],
          shopName: snapshotShopName,
          buyerName,
          address,
          quantity: item.quantity,
          packed: false,
        });
      }
    }
  }

  const productIds = Array.from(productMap.keys());
  const blockPositions = await getShippingBlockPositions(productIds);

  const filteredProducts = Array.from(productMap.values()).filter(({ product }) => {
    const position = blockPositions.get(String(product._id));
    if (!position) {
      // Incoming products are not assigned to any block yet but should still be pickable.
      return true;
    }
    return position.blockId >= zoneStart && position.blockId <= zoneEnd;
  });

  if (!filteredProducts.length) {
    await bot.sendMessage(chatId, `У вашій зоні блоків ${zoneStart}–${zoneEnd} поки що нема товарів для пакування.`);
    return;
  }

  const sorted = filteredProducts.sort((a, b) => {
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
      : 'Надходження (ще не на полиці)';
    const hasRemaining = entries.some((entry) => !entry.packed);
    const { caption, reply_markup } = buildCarouselMessage(
      getProductTitle(product),
      position,
      entries[0],
      0,
      entries.length,
      String(product._id),
      hasRemaining
    );

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

async function archiveProductAsSoldOut(chatId, product, carousel, repliedMsgId = null) {
  const { archiveProduct } = require('./services/archiveProduct');

  const { cancelledCount } = await archiveProduct(product, { notifyBuyers: true, bot });

  if (repliedMsgId && carousel) {
    try {
      const doneCaption = `📦 "${getProductTitle(product)}"\n❌ Скасовано замовлень: ${cancelledCount}\nТовар переміщено в архів.`;
      if (carousel.hasPhoto) {
        await bot.editMessageCaption(doneCaption, {
          chat_id: chatId,
          message_id: repliedMsgId,
          reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
        });
      } else {
        await bot.editMessageText(doneCaption, {
          chat_id: chatId,
          message_id: repliedMsgId,
          reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
        });
      }
    } catch (_) {}
  }

  if (carousel) {
    await deleteSession(chatId, 'ship', repliedMsgId);
  }

  await bot.sendMessage(chatId, `📦 "${getProductTitle(product)}" — скасовано замовлень: ${cancelledCount}. Товар в архіві.`);
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



      if (!user) {
        if (isGroupChat) return;
        await bot.sendMessage(chatId, getUnknownUserMessage());
        return;
      }

      // ── Warehouse reply "Закінчився" to archive product ──
      if (user.role === 'warehouse' && msg.reply_to_message && rawText && rawText.trim().toLowerCase() === 'закінчився') {
        const repliedMsgId = String(msg.reply_to_message.message_id);
        const replied = msg.reply_to_message;
        const captionText = replied.caption || replied.text || '';

        let product = null;
        const idMatch = captionText.match(/\[ID:\s*([a-fA-F0-9]{24})\]/i);
        if (idMatch) {
          product = await Product.findById(idMatch[1]);
        }

        const carousel = await getSession(chatId, 'ship', repliedMsgId);
        if (!product && carousel) {
          product = await Product.findById(carousel.productId);
        }

        if (!product) {
          await bot.sendMessage(chatId, '❌ Не вдалося визначити товар з цього повідомлення. Переконайтеся, що ви відповідаєте на актуальне повідомлення з [ID: ...].');
          return;
        }

        if (product.status === 'archived') {
          await bot.sendMessage(chatId, `"${getProductTitle(product)}" вже в архіві.`);
          return;
        }

        const activeOrdersCount = await Order.countDocuments({
          'items.productId': product._id,
          status: { $in: ['new', 'in_progress'] },
        });

        const confirmText = `Увага! Ви впевнені, що товар "${getProductTitle(product)}" закінчився? Це скасує його у ${activeOrdersCount} активних замовленнях і перенесе в архів. Цю дію неможливо скасувати.`;
        const confirmMarkup = buildSoldOutConfirmationMarkup(
          `ps_ok:reply:${product._id}`,
          `ps_no:reply:${product._id}`
        );

        await bot.sendMessage(chatId, confirmText, { reply_markup: confirmMarkup });
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

      if (data.startsWith('ps_ok') || data.startsWith('ps_no')) {
        if (!user || user.role !== 'warehouse') {
          await bot.answerCallbackQuery(query.id, { text: 'Ця дія доступна лише складу.', show_alert: true });
          return;
        }

        const [action, payloadId, actionProductId] = data.split(':');

        if (action === 'ps_ok') {
          const targetId = actionProductId || payloadId;
          const product = targetId ? await Product.findById(targetId) : null;

          if (!product) {
            await bot.answerCallbackQuery(query.id, { text: 'Товар не знайдено.', show_alert: true });
            return;
          }

          if (product.status === 'archived') {
            await bot.answerCallbackQuery(query.id, { text: `"${getProductTitle(product)}" вже в архіві.`, show_alert: true });
            return;
          }

          await archiveProductAsSoldOut(chatId, product, null, msgId);

          try {
            const doneCaption = `❌ Товар "${getProductTitle(product)}" закінчився та переміщено в архів.`;
            if (query.message.photo) {
              await bot.editMessageCaption(doneCaption, {
                chat_id: chatId,
                message_id: msgId,
                reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
              });
            } else {
              await bot.editMessageText(doneCaption, {
                chat_id: chatId,
                message_id: msgId,
                reply_markup: { inline_keyboard: [[{ text: '📦 Архівовано', callback_data: 'noop' }]] },
              });
            }
          } catch (_) {}

          await bot.answerCallbackQuery(query.id, { text: 'Товар позначено як закінчився і заархівовано.', show_alert: false });
          return;
        }

        if (action === 'ps_no') {
          try {
            await bot.editMessageText('❌ Дія скасована. Товар не буде архівовано.', {
              chat_id: chatId,
              message_id: msgId,
              reply_markup: { inline_keyboard: [[{ text: 'OK', callback_data: 'noop' }]] },
            });
          } catch (_) {}
          await bot.answerCallbackQuery(query.id, { text: 'Дія скасована.', show_alert: false });
          return;
        }
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
              shopCity: request.role === 'seller' ? request.shopCity : '',
              deliveryGroupId: request.role === 'seller' ? request.deliveryGroupId || '' : '',
            });
            await user.save();
            if (request.role === 'seller' && request.deliveryGroupId) {
              const deliveryGroup = await DeliveryGroup.findByIdAndUpdate(
                request.deliveryGroupId,
                { $addToSet: { members: request.telegramId } },
                { new: true }
              );
              if (deliveryGroup?.name) {
                await User.findByIdAndUpdate(user._id, { warehouseZone: deliveryGroup.name });
              }
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

      const [action, actionProductId] = data.split(':');
      const carousel = await getSession(chatId, 'ship', msgId);

      const isShipCarouselAction = action === 'sprev' || action === 'snext' || action === 'spack';
      if (isShipCarouselAction) {
        if (!user || user.role !== 'warehouse') {
          await bot.answerCallbackQuery(query.id, { text: 'Ця дія доступна лише складу.', show_alert: true });
          return;
        }

        const zoneStart = Number(user.shiftZone?.startBlock || 0);
        const zoneEnd = Number(user.shiftZone?.endBlock || 0);
        if (!user.isOnShift || !zoneStart || !zoneEnd || zoneStart > zoneEnd) {
          await bot.answerCallbackQuery(query.id, { text: 'Ви не на активній зміні. Оновіть /ship після призначення.', show_alert: true });
          return;
        }
      }

      // ── ◀️ PREV / ▶️ NEXT: navigate carousel ──
      if (action === 'sprev' || action === 'snext') {
        if (!carousel || (actionProductId && String(carousel.productId) !== actionProductId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена. Натисніть /ship знову.', show_alert: true });
          return;
        }

        const total = carousel.entries.length;
        if (action === 'snext') {
          carousel.currentIndex = (carousel.currentIndex + 1) % total;
        } else {
          carousel.currentIndex = (carousel.currentIndex - 1 + total) % total;
        }

        const entry = carousel.entries[carousel.currentIndex];
        const hasRemaining = carousel.entries.some((e) => !e.packed);
        const { caption, reply_markup } = buildCarouselMessage(
          carousel.productName,
          carousel.position,
          entry,
          carousel.currentIndex,
          total,
          carousel.productId,
          hasRemaining
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
      if (action === 'spack') {
        if (!carousel || (actionProductId && String(carousel.productId) !== actionProductId)) {
          await bot.answerCallbackQuery(query.id, { text: 'Сесія не знайдена. Натисніть /ship знову.', show_alert: true });
          return;
        }

        const entry = carousel.entries[carousel.currentIndex];
        const wasPacked = Boolean(entry.packed);
        const nextPacked = !wasPacked;

        const orderIdsToConfirm = entry.orderIds || (entry.orderId ? [entry.orderId] : []);
        let anyUpdated = false;

        for (const oid of orderIdsToConfirm) {
          const order = await Order.findOneAndUpdate(
            {
              _id: oid,
              status: { $in: ['new', 'in_progress', 'confirmed'] },
              items: { $elemMatch: { productId: carousel.productId, packed: wasPacked, cancelled: false } },
            },
            { $set: { 'items.$.packed': nextPacked } },
            { new: true }
          );

          if (!order) continue;
          anyUpdated = true;

          const isFullyProcessed = order.items.every((i) => i.packed || i.cancelled);
          const allCancelled = order.items.every((i) => i.cancelled);
          if (isFullyProcessed) {
            order.status = allCancelled ? 'cancelled' : 'confirmed';
          } else {
            order.status = 'in_progress';
          }
          await order.save();
        }

        if (!anyUpdated) {
          await bot.answerCallbackQuery(query.id, { text: 'Це замовлення вже оброблене або не доступне.', show_alert: false });
          return;
        }

        entry.packed = nextPacked;

        // Sync picking tasks for toggled order items
        const affectedTasks = await PickingTask.find({
          productId: carousel.productId,
          status: { $in: ['pending', 'locked', 'completed'] },
          'items.orderId': { $in: orderIdsToConfirm },
        });

        for (const task of affectedTasks) {
          let taskUpdated = false;
          task.items.forEach((taskItem) => {
            if (orderIdsToConfirm.includes(String(taskItem.orderId))) {
              taskItem.packed = nextPacked;
              taskUpdated = true;
            }
          });

          if (taskUpdated) {
            const allTaskItemsPacked = task.items.every((i) => i.packed);
            if (allTaskItemsPacked) {
              task.status = 'completed';
              task.lockedBy = null;
              task.lockedAt = null;
            } else {
              task.status = 'pending';
              task.lockedBy = null;
              task.lockedAt = null;
            }
            await task.save();
          }
        }

        const allPacked = carousel.entries.every((e) => e.packed);

        // Auto-advance only when marking as packed and there are still unpacked entries
        if (nextPacked && !allPacked) {
          let nextIdx = (carousel.currentIndex + 1) % carousel.entries.length;
          while (carousel.entries[nextIdx].packed && nextIdx !== carousel.currentIndex) {
            nextIdx = (nextIdx + 1) % carousel.entries.length;
          }
          carousel.currentIndex = nextIdx;
        }

        const nextEntry = carousel.entries[carousel.currentIndex];
        const remaining = carousel.entries.filter((e) => !e.packed).length;
        const hasRemaining = carousel.entries.some((e) => !e.packed);
        const { caption, reply_markup } = buildCarouselMessage(
          carousel.productName,
          carousel.position,
          nextEntry,
          carousel.currentIndex,
          carousel.entries.length,
          carousel.productId,
          hasRemaining
        );

        try {
          const statusLine = allPacked
            ? `\n\n✅ Усі ${carousel.entries.length} замовлень для цієї позиції спаковано.`
            : `\n\n⏳ Залишилось: ${remaining}`;
          if (carousel.hasPhoto) {
            await bot.editMessageCaption(`${caption}${statusLine}`, {
              chat_id: chatId, message_id: msgId, reply_markup,
            });
          } else {
            await bot.editMessageText(`${caption}${statusLine}`, {
              chat_id: chatId, message_id: msgId, reply_markup,
            });
          }
        } catch (_) {}

        carousel.allPacked = allPacked;
        await setSession(chatId, 'ship', carousel, msgId);
        if (nextPacked) {
          await bot.answerCallbackQuery(query.id, { text: allPacked ? '✅ Усі замовлення для позиції спаковано' : `✅ Спаковано для ${entry.shopName}`, show_alert: false });
        } else {
          await bot.answerCallbackQuery(query.id, { text: `↩️ Пакування скасовано для ${entry.shopName}`, show_alert: false });
        }
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
  sendMessageWithRetry,
  sendAdminNotification,
  sendRegistrationApprovedMessage,
  getShippingBlockPositions,
  buildPickingTasksFromOrders,
};
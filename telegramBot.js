const TelegramBot = require('node-telegram-bot-api');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');
const crypto = require('crypto');
const { shiftUp: shiftOrderUp } = require('./utils/shiftOrderNumbers');
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const PendingReaction = require('./models/PendingReaction');
const BotSession = require('./models/BotSession');
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

const SHELF_PAGE_SIZE = 5;

// Guard against double-submit of /order (in-memory is fine, non-critical)
const orderInFlight = new Set();

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || (process.env.NODE_ENV === 'production' ? null : `http://localhost:${process.env.PORT || 5000}`);

let bot = null;
let status = {
  connected: false,
  startedAt: null,
  error: null,
};

const roleCommands = {
  seller: [
    '/help - Показати доступні команди',
    '/profile - Мій профіль',
    '/shelf - Переглянути ',
    '/mylist - Переглянути обрані товари',
    '/order - Оформити замовлення з обраних товарів',
  ],
  warehouse: [
    '/help - Показати доступні команди',
    '/profile - Мій профіль',
    '/receive - Прийняти товар на склад',
    '/ship - Переглянути замовлення для відвантаження',
  ],
  admin: [
    '/help - Показати доступні команди',
    '/profile - Мій профіль',
  ],
};

function buildRoleHelp(role) {
  const commands = roleCommands[role] || roleCommands.admin;
  return `Ваша роль: ${role}\n\nДоступні команди:\n${commands.join('\n')}`;
}

const roleBotCommands = {
  seller: [
    { command: '/shelf', description: 'Переглянути товари' },
    { command: '/mylist', description: 'Переглянути обрані товари' },
    { command: '/order', description: 'Оформити замовлення' },
    { command: '/help', description: 'Показати доступні команди' },
    { command: '/profile', description: 'Мій профіль' },
  ],
  warehouse: [
    { command: '/receive', description: 'Прийняти товар на склад' },
    { command: '/ship', description: 'Замовлення для відвантаження' },
    { command: '/help', description: 'Показати доступні команди' },
    { command: '/profile', description: 'Мій профіль' },
  ],
  admin: [
    { command: '/help', description: 'Показати доступні команди' },
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
    lines.push(`Зона складу: ${user.warehouseZone || 'не вказано'}`);
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

async function sendMessageWithRetry(chatId, text, attempts = 3) {
  try {
    return await bot.sendMessage(chatId, text);
  } catch (error) {
    const retryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (attempts > 0 && error?.response?.body?.error_code === 429) {
      const delayMs = (retryAfter || 2) * 1000;
      console.warn(`Telegram 429 on sendMessage, retrying after ${delayMs}ms (${attempts - 1} attempts left)`);
      await delay(delayMs);
      return sendMessageWithRetry(chatId, text, attempts - 1);
    }
    throw error;
  }
}

async function sendPhotoWithRetry(chatId, photo, options = {}, attempts = 3) {
  try {
    return await bot.sendPhoto(chatId, photo, options);
  } catch (error) {
    const retryAfter = Number(error?.response?.body?.parameters?.retry_after || 0);
    if (attempts > 0 && error?.response?.body?.error_code === 429) {
      const delayMs = (retryAfter || 2) * 1000;
      console.warn(`Telegram 429 on sendPhoto, retrying after ${delayMs}ms (${attempts - 1} attempts left)`);
      await delay(delayMs);
      return sendPhotoWithRetry(chatId, photo, options, attempts - 1);
    }
    throw error;
  }
}

async function sendShelfProducts(chatId, page = 0) {
  const products = await Product.find({ status: 'active' }).sort({ orderNumber: 1 }).lean();
  if (!products.length) {
    await bot.sendMessage(chatId, 'Активних товарів на складі поки що немає.');
    return;
  }

  // Delete previous shelf messages first
  const prev = await getSession(chatId, 'shelf');
  if (prev?.messageIds?.length) {
    await deleteShelfMessages(chatId, prev.messageIds);
  }

  const totalPages = Math.ceil(products.length / SHELF_PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageProducts = products.slice(safePage * SHELF_PAGE_SIZE, (safePage + 1) * SHELF_PAGE_SIZE);

  const sentIds = [];

  for (const product of pageProducts) {
    const caption = `📦 #${product.orderNumber} — ${product.name || 'Без назви'}\n💰 ${product.price} zł | 📦 ${product.quantityPerPackage || '?'} шт/уп`;
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
  bottomButtons.push([
    { text: `🛒 Мій список (${await PendingReaction.countDocuments({ sellerTelegramId: chatId })})`, callback_data: 'shelf_mylist' },
    { text: '✅ Оформити', callback_data: 'shelf_order' },
  ]);

  const navMsg = await bot.sendMessage(chatId, `Товари ${safePage * SHELF_PAGE_SIZE + 1}–${safePage * SHELF_PAGE_SIZE + pageProducts.length} з ${products.length}`, {
    reply_markup: { inline_keyboard: bottomButtons },
  });
  sentIds.push(navMsg.message_id);

  await setSession(chatId, 'shelf', {
    page: safePage,
    messageIds: sentIds,
  });
}

async function deleteShelfMessages(chatId, messageIds) {
  for (const msgId of messageIds) {
    try {
      await bot.deleteMessage(chatId, msgId);
    } catch (_) { /* message may already be deleted */ }
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

async function uploadBufferToR2(buffer, ext) {
  const filename = `${crypto.randomUUID()}.${ext}`;
  await r2Client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: `products/${filename}`,
    Body: buffer,
    ContentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
  }));
  return { url: `/api/products/images/${filename}`, name: filename };
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

async function handleReceiveStep(chatId, msg, state) {
  const msgText = msg.text?.trim() || '';

  if (state.step === 'await_photo') {
    if (!msg.photo?.length) {
      await bot.sendMessage(chatId, 'Будь ласка, надішліть фото товару.');
      return;
    }
    state.photoFileId = msg.photo[msg.photo.length - 1].file_id;
    state.step = 'await_price';
    await setSession(chatId, 'receive', state);
    await bot.sendMessage(chatId, 'Введіть ціну товару (zł):')
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
    `📦 Позиція: ${position || 'N/A'}`,
    `🏪 Магазин: ${entry.shopName}`,
    `👤 Покупець: ${entry.buyerName}`,
    `📍 Адреса: ${entry.address}`,
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

  // Sort by orderNumber
  const sorted = Array.from(productMap.values()).sort(
    (a, b) => (a.product.orderNumber ?? 0) - (b.product.orderNumber ?? 0)
  );

  for (const { product, entries } of sorted) {
    const position = product.orderNumber || 'N/A';
    const { caption, reply_markup } = buildCarouselMessage(product.name, position, entries[0], 0, entries.length);

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
          productName: product.name,
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
  }

  await bot.sendMessage(chatId, `📋 Відправлено ${sorted.length} позицій для пакування.\n\nЩоб позначити товар як закінчений — відповідте (reply) на повідомлення з товаром словом "Закінчився".`);
}

async function initBot(token) {
  if (!token) {
    status.error = 'TELEGRAM_BOT_TOKEN not configured';
    console.warn(status.error);
    return;
  }

  try {
    bot = new TelegramBot(token, {
      polling: {
        params: {
          allowed_updates: ['message', 'message_reaction', 'callback_query'],
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
      const rawText = msg.text?.trim() || '';
      const text = rawText.split(' ')[0] || '';
      const user = await User.findOne({ telegramId: chatId });

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

      if (text === '/start') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        // Set per-chat commands based on role
        await setRoleCommands(chatId, user.role);

        await bot.sendMessage(
          chatId,
          `Привіт, ${user.firstName || 'користувачу'}! Ви зайшли як ${user.role}.\n\n${buildRoleHelp(user.role)}`
        );
        return;
      }

      if (text === '/help') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        await bot.sendMessage(chatId, buildRoleHelp(user.role));
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

      if (text === '/orders' || text === '/mylist') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'seller') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише продавцю. Використайте /help, щоб побачити доступні команди.');
          return;
        }

        const pending = await PendingReaction.find({ sellerTelegramId: chatId }).populate('productId');
        if (!pending.length) {
          await bot.sendMessage(chatId, 'У вас поки немає обраних товарів. Поставте реакцію (лайк) на товар, щоб додати.');
          return;
        }

        const lines = pending
          .filter((p) => p.productId)
          .map((p, i) => `${i + 1}. ${p.productId.name} — ${p.productId.price} zł x${p.quantity || 1}`);
        const total = pending.filter((p) => p.productId).reduce((sum, p) => sum + p.productId.price * (p.quantity || 1), 0);

        await bot.sendMessage(chatId, `Ваші обрані товари:\n\n${lines.join('\n')}\n\nРазом: ${total} zł\n\nНадішліть /order щоб оформити замовлення.`);
        return;
      }

      if (text === '/order') {
        if (!user) {
          await bot.sendMessage(chatId, getUnknownUserMessage());
          return;
        }

        if (user.role !== 'seller') {
          await bot.sendMessage(chatId, 'Ця команда доступна лише продавцю.');
          return;
        }

        if (orderInFlight.has(chatId)) {
          await bot.sendMessage(chatId, 'Ваше замовлення вже обробляється, зачекайте...');
          return;
        }
        orderInFlight.add(chatId);
        try {
          const result = await finalizeOrder(chatId);
          await bot.sendMessage(chatId, result);
        } finally {
          orderInFlight.delete(chatId);
        }
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
            product = await Product.findOne({ name: nameMatch[1], status: { $ne: 'archived' } });
          }
        }

        if (!product) {
          await bot.sendMessage(chatId, 'Не вдалося визначити товар з цього повідомлення. Можливо, він вже архівований.');
          return;
        }

        if (product.status === 'archived') {
          await bot.sendMessage(chatId, `"${product.name}" вже в архіві.`);
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
          await bot.sendMessage(order.buyerTelegramId, `⛔ Товар "${product.name}" на складі скінчився. Замовлення для ${buyerName} не буде виконано.`).catch(() => null);
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
          const doneCaption = `📦 "${product.name}"\n❌ Скасовано замовлень: ${cancelledCount}\nТовар переміщено в архів.`;
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
        await bot.sendMessage(chatId, `📦 "${product.name}" — скасовано замовлень: ${cancelledCount}. Товар в архіві.`);
        return;
      }

      if (user.role === 'seller' && msg.reply_to_message && rawText) {
        const repliedMessageId = String(msg.reply_to_message.message_id);
        const numericMessageId = Number(repliedMessageId);
        const product = await Product.findOne({
          telegramMessageIds: {
            $in: [repliedMessageId, Number.isFinite(numericMessageId) ? numericMessageId : repliedMessageId],
          },
        });

        if (product) {
          const likesOnly = rawText.trim() === '👍' || rawText.trim().toLowerCase() === 'like';
          const quantity = likesOnly ? 1 : parseInt(rawText, 10);

          if (!likesOnly && (!Number.isInteger(quantity) || quantity <= 0)) {
            await bot.sendMessage(chatId, 'Будь ласка, відповідайте лише числом більше 0 або лайком (👍).');
            return;
          }

          await PendingReaction.findOneAndUpdate(
            { sellerTelegramId: chatId, messageId: repliedMessageId },
            {
              sellerTelegramId: chatId,
              productId: product._id,
              messageId: repliedMessageId,
              chatId,
              emoji: likesOnly ? '👍' : `x${quantity}`,
              quantity,
            },
            { upsert: true, new: true }
          );

          await bot.sendMessage(chatId, `✅ ${product.name} (${likesOnly ? '1 шт' : quantity + ' шт'}) додано до списку.\nПереглянути: /mylist\nОформити: /order`);
          return;
        }
      }

      await bot.sendMessage(chatId, 'Невідома команда. Використайте /help, щоб побачити доступні команди.');
      } catch (err) {
        console.error('[Bot] Message handler error:', err);
      }
    });

    // Handle emoji reactions (likes) on product messages
    // node-telegram-bot-api@0.67 doesn't natively emit message_reaction,
    // so we intercept raw updates via polling
    let pollingRestartAttempts = 0;
    const MAX_POLLING_RESTARTS = 10;
    bot.on('polling_error', async (err) => {
      console.error('Telegram polling error:', err);
      status.error = err.message || String(err);
      status.connected = false;

      pollingRestartAttempts++;
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

    bot.on('callback_query', async (query) => {
      try {
      const chatId = String(query.message.chat.id);
      const msgId = String(query.message.message_id);
      const data = query.data || '';

      // Handle "noop" for already-processed buttons
      if (data === 'noop') {
        await bot.answerCallbackQuery(query.id);
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

        await bot.answerCallbackQuery(query.id, { text: `✅ ${product.name} — ${quantity} шт`, show_alert: false });
        return;
      }

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

      await bot.answerCallbackQuery(query.id, { text: 'Невідома дія.', show_alert: true });
      } catch (err) {
        console.error('[Bot] Callback query handler error:', err);
        try { await bot.answerCallbackQuery(query.id); } catch (_) {}
      }
    });

    const originalProcessUpdate = bot.processUpdate.bind(bot);
    bot.processUpdate = function (update) {
      if (update.message_reaction) {
        handleReaction(update.message_reaction);
      }
      return originalProcessUpdate(update);
    };

    async function handleReaction(reaction) {
      try {
        const chatId = String(reaction.chat.id);
        const messageId = String(reaction.message_id);
        const userId = String(reaction.user?.id || reaction.actor_chat?.id || '');
        if (!userId) return;

        const newReactions = reaction.new_reaction || [];

        const user = await User.findOne({ telegramId: userId });
        if (!user || user.role !== 'seller') return;

        const product = await Product.findOne({
          telegramMessageIds: { $in: [messageId, Number(messageId)] },
        });
        if (!product) return;

        if (newReactions.length === 0) {
          // Reaction removed — delete pending
          await PendingReaction.findOneAndDelete({ sellerTelegramId: userId, messageId });
          return;
        }

        // Reaction added or changed — upsert pending
        const emoji = newReactions[0]?.emoji || '👍';
        await PendingReaction.findOneAndUpdate(
          { sellerTelegramId: userId, messageId },
          { sellerTelegramId: userId, productId: product._id, messageId, chatId, emoji },
          { upsert: true, new: true }
        );
      } catch (error) {
        console.error('Error handling message_reaction:', error);
      }
    }

    async function finalizeOrder(userId) {
      const user = await User.findOne({ telegramId: userId });
      if (!user) return 'Вас не знайдено в системі.';

      const pending = await PendingReaction.find({ sellerTelegramId: userId }).populate('productId');
      if (!pending.length) return 'У вас немає обраних товарів. Поставте реакцію на товар, щоб додати його до замовлення.';

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

      // Update product reaction stats
      for (const p of pending) {
        if (!p.productId) continue;
        const product = p.productId;
        product.reactions = product.reactions || new Map();
        const currentCount = product.reactions.get(p.emoji) || 0;
        product.reactions.set(p.emoji, currentCount + (p.quantity || 1));
        product.reactionDetails.push({ userId: user.telegramId, reactionType: p.emoji, quantity: p.quantity || 1 });
        await product.save();
      }

      // Clear pending reactions
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
};

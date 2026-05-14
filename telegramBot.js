const TelegramBot = require('node-telegram-bot-api');
const User = require('./models/User');
const BotInteractionLog = require('./models/BotInteractionLog');
const RegistrationRequest = require('./models/RegistrationRequest');
const DeliveryGroup = require('./models/DeliveryGroup');
const Shop = require('./models/Shop');

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
  } catch (e) {
    console.warn('[telegramBot] markUserBotActive failed:', e.message);
  }
}

async function markUserBotBlocked(chatId) {
  try {
    await User.findOneAndUpdate({ telegramId: String(chatId) }, { botBlocked: true });
  } catch (e) {
    console.warn('[telegramBot] markUserBotBlocked failed:', e.message);
  }
}


async function logBotInteraction(telegramId, type, action, label = '', context = {}) {
  try {
    await BotInteractionLog.create({ telegramId: String(telegramId), type, action, label, context });
  } catch (e) {
    console.warn('[telegramBot] logBotInteraction failed:', e.message);
  }
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


const SERVER_BASE_URL = process.env.SERVER_BASE_URL || (process.env.NODE_ENV === 'production' ? null : `http://localhost:${process.env.PORT || 5000}`);
const WEB_APP_URL = process.env.WEB_APP_URL || 'http://localhost:5173/mini-app';
const ALLOWED_TELEGRAM_GROUP_IDS = (process.env.TELEGRAM_ALLOWED_GROUP_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => Number(id));

async function isAuthorizedGroup(chatId) {
  try {
    const { getAllowedGroupIds } = require('./routes/admin');
    const ids = await getAllowedGroupIds();
    if (ids.length) return ids.includes(String(chatId));
  } catch (_) { /* fallback to env */ }
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
    // shopName/shopCity are no longer on User — look up via shopId (cached)
    let shopDisplayName = '';
    if (blockedUser?.shopId) {
      const { getShop } = require('./utils/modelCache');
      const blockedShop = await getShop(blockedUser.shopId);
      if (blockedShop) shopDisplayName = [blockedShop.name, blockedShop.cityId?.name].filter(Boolean).join(', ');
    }
    const shopParts = shopDisplayName ? [shopDisplayName] : [];
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
      const user = await User.findOne({ telegramId: chatId });
      if (user) {
        updateUserBotActivity(chatId).catch(() => {});
      }

      if (isGroupChat && !(await isAuthorizedGroup(chatId))) {
        return;
      }

      if (text === '/start') {
        if (isGroupChat) {
          const groupMessage = (await isAuthorizedGroup(chatId))
            ? 'Бот активовано для цього групового чату.'
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

        await bot.sendMessage(
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

      await bot.sendMessage(chatId, 'Невідома команда. Використайте /miniapp, щоб відкрити додаток.');
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
          } catch (e) {
            console.warn('[Bot] editMessageReplyMarkup (already-processed) failed:', e.message);
          }
          return;
        }

        if (action === 'regreq_approve') {
          const existingUser = await User.findOne({ telegramId: request.telegramId }).lean();
          if (existingUser) {
            await RegistrationRequest.findByIdAndUpdate(requestId, { status: 'rejected' });
            await bot.answerCallbackQuery(query.id, { text: 'Користувач вже зареєстрований', show_alert: true });
          } else {
            // Resolve shop fresh — shopName/shopCity are NOT stored on User anymore,
            // they are always read via shopId → Shop lookup at display time.
            let shopId          = request.shopId || null;
            let deliveryGroupId = request.deliveryGroupId || '';
            let warehouseZone   = '';
            if (shopId) {
              const shop = await Shop.findById(shopId).populate('cityId', 'name').lean();
              if (shop) {
                deliveryGroupId = shop.deliveryGroupId || '';
                if (deliveryGroupId) {
                  const grp = await DeliveryGroup.findById(deliveryGroupId).lean();
                  warehouseZone = grp?.name || '';
                }
              }
            }
            const user = new User({
              telegramId: request.telegramId,
              role: request.role,
              firstName: request.firstName,
              lastName: request.lastName,
              shopId:          request.role === 'seller' ? shopId          : null,
              deliveryGroupId: request.role === 'seller' ? deliveryGroupId : '',
              warehouseZone:   request.role === 'seller' ? warehouseZone   : '',
            });
            await user.save();
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
        } catch (e) {
          console.warn('[Bot] editMessageReplyMarkup (processed) failed:', e.message);
        }
        return;
      }

      console.warn('[Bot] Unknown callback query action:', { data, chatId, msgId });
      await bot.answerCallbackQuery(query.id, { text: 'Невідома дія.', show_alert: true });
      } catch (err) {
        console.error('[Bot] Callback query handler error:', err);
        try { await bot.answerCallbackQuery(query.id); } catch (e) {
          console.warn('[Bot] answerCallbackQuery (after error) failed:', e.message);
        }
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
  sendAdminNotification,
  sendRegistrationApprovedMessage,
};
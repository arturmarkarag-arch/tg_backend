const TelegramBot = require('node-telegram-bot-api');
const User = require('./models/User');
const BotInteractionLog = require('./models/BotInteractionLog');
const RegistrationRequest = require('./models/RegistrationRequest');
const SearchProduct = require('./models/SearchProduct');
const DeliveryGroup = require('./models/DeliveryGroup');
const Shop = require('./models/Shop');
const GroupMember = require('./models/GroupMember');
const { redeemTransferHash } = require('./services/redeemTransferHash');
const { trackMemberFromMessage, handleChatMemberUpdate, setMemberPhoto } = require('./services/groupMemberSync');
const { issueRegistrationToken, peekRegistrationToken } = require('./services/registrationToken');

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

    const user = await User.findOne({ telegramId: chatId }).lean();
    if (!user) {
      return;
    }

    if (newStatus === 'kicked') {
      await handleBotBlocked(chatId);
      await logBotInteraction(chatId, 'system', 'my_chat_member', 'kicked', { payload });
      return;
    }

    if (['member', 'administrator', 'creator'].includes(newStatus)) {
      const wasBlocked = Boolean(user.botBlocked);
      await User.findOneAndUpdate(
        { telegramId: chatId },
        { botBlocked: false, botLastActivityAt: new Date() }
      );
      await logBotInteraction(chatId, 'system', 'my_chat_member', newStatus, { payload });

      if (wasBlocked) {
        const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || chatId;
        const roleLabels = { seller: 'Продавець', warehouse: 'Склад', admin: 'Адмін' };
        const roleLabel = roleLabels[user.role] || user.role || 'Невідома роль';
        const lines = [`✅ Користувач розблокував бота.`, `${roleLabel}: ${name}`, `telegramId: ${chatId}`];
        await sendAdminNotification(lines.join('\n'));
      }
    }
  } catch (error) {
    console.error('Failed to handle my_chat_member update:', error);
  }
}


const SERVER_BASE_URL = process.env.SERVER_BASE_URL || null;
const WEB_APP_URL = process.env.WEB_APP_URL;
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
  mode: null,
};

// ── Update delivery: webhook only ────────────────────────────────────────────
// The bot runs purely on webhook: Telegram pushes updates to us, so there is no
// constant getUpdates long-poll draining traffic in the background. This requires
// a stable public HTTPS host reachable by Telegram — SERVER_BASE_URL (Render in
// prod, the dev tunnel locally). No polling path exists.
const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'chat_member'];

// Deterministic, unguessable path + secret-token derived from the bot token, so
// the Express route can be mounted synchronously (before the async bot init runs)
// and every delivery's X-Telegram-Bot-Api-Secret-Token header can be verified.
function getWebhookConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const h = require('crypto').createHash('sha256').update(token).digest('hex');
  return {
    path: `/telegram/webhook/${h.slice(0, 32)}`,
    secretToken: h.slice(32, 64),
  };
}

// Feed an update delivered to the Express webhook route into the bot's event
// machinery — emits the same events handlers below listen for.
function handleWebhookUpdate(update) {
  if (bot && update) bot.processUpdate(update);
}

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

// Sends a welcome + registration-link message to the group after 10 s.
// Used for both chat_member and new_chat_members join paths.
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// In-flight de-dup: a single join can arrive via BOTH the `new_chat_members`
// service message AND the `chat_member` update, so guard by (group, member)
// to ensure exactly one welcome is scheduled. Key is cleared once the message
// is sent (or fails), so a later re-join still gets a fresh welcome.
const pendingWelcomes = new Set();

// Posts a single welcome + per-person registration link to the group and
// remembers the message id (so it can be deleted once the user registers).
// Skips silently if the user is already registered. Returns true if a message
// was sent. Shared by the auto-schedule path and the manual re-push button.
async function postGroupWelcome(groupChatId, telegramId, from) {
  const nowRegistered = await User.findOne({ telegramId }).lean();
  if (nowRegistered) return false;
  const me = await bot.getMe();
  const botUsername = me?.username;
  if (!botUsername) return false;
  // Per-person invite token bound to THIS member's telegramId. Safe to post
  // in the public group: it only works for its owner (server checks
  // token.telegramId === authenticated telegramId), so another member
  // clicking it cannot register as someone else.
  const regToken = await issueRegistrationToken(telegramId);
  const displayName = escapeHtml([from.first_name, from.last_name].filter(Boolean).join(' ') || telegramId);
  const mention = from.username
    ? `@${from.username}`
    : `<a href="tg://user?id=${telegramId}">${displayName}</a>`;
  const text = [
    `👋 ${mention}, вітаємо в групі!`,
    '',
    'Щоб отримати доступ до системи Замовлень, потрібно зареєструватися в телеграм Боті.',
    '',
    `➡️ <a href="https://t.me/${botUsername}?start=${regToken}">Натисніть тут щоб зареєструватись</a>`,
  ].join('\n');
  const sent = await bot.sendMessage(groupChatId, text, { parse_mode: 'HTML' });
  // Remember the message so we can delete it once the user registers.
  if (sent?.message_id) {
    await GroupMember.updateOne(
      { groupChatId: String(groupChatId), telegramId: String(telegramId) },
      { $set: { welcomeChatId: String(groupChatId), welcomeMessageId: sent.message_id } },
    ).catch((e) => console.warn('[Bot] store welcome message_id failed:', e.message));
  }
  return true;
}

async function scheduleGroupWelcome(groupChatId, telegramId, from) {
  const dedupeKey = `${groupChatId}:${telegramId}`;
  if (pendingWelcomes.has(dedupeKey)) return;
  pendingWelcomes.add(dedupeKey);
  setTimeout(async () => {
    try {
      await postGroupWelcome(groupChatId, telegramId, from);
    } catch (err) {
      console.warn('[Bot] welcome message failed:', err.message);
    } finally {
      pendingWelcomes.delete(dedupeKey);
    }
  }, 10_000);
}

// Manual "re-check + re-push" for the admin Unregistered list. Verifies the
// member is STILL in the group (single getChatMember against this group), then:
//  - not in group  → mark them `left` so the list drops them; no message.
//  - registered     → nothing to push (list will drop them on next refresh).
//  - in group, not registered → delete any stale welcome and post a fresh one.
// Returns a small status object for the UI.
async function recheckAndRepushWelcome(groupChatId, telegramId) {
  if (!bot) return { ok: false, reason: 'bot_unavailable' };
  const gid = String(groupChatId);
  const tid = String(telegramId);

  let member = null;
  try {
    member = await bot.getChatMember(gid, Number(tid));
  } catch (e) {
    console.warn(`[recheck] getChatMember(${gid}, ${tid}) failed:`, e.message);
    return { ok: false, reason: 'check_failed' };
  }

  const inGroup = ['member', 'administrator', 'creator', 'restricted'].includes(member?.status);
  if (!inGroup) {
    // They actually left/were removed — reflect it so the list stops showing them.
    await GroupMember.updateOne({ groupChatId: gid, telegramId: tid }, { $set: { left: true } }).catch(() => {});
    return { ok: true, status: 'left' };
  }

  const registered = await User.findOne({ telegramId: tid }).lean();
  if (registered) return { ok: true, status: 'registered' };

  // Build a fresh `from` from the live membership (best name/username available).
  const u = member?.user || {};
  const from = {
    id: Number(tid),
    first_name: u.first_name || '',
    last_name: u.last_name || '',
    username: u.username || '',
  };

  // Drop the previous welcome (if any) before posting a new one so the group
  // doesn't accumulate duplicate prompts.
  try { await deleteWelcomeFor(tid); } catch (_) { /* best-effort */ }

  try {
    const sent = await postGroupWelcome(gid, tid, from);
    return { ok: true, status: sent ? 'reposted' : 'registered' };
  } catch (e) {
    console.warn(`[recheck] postGroupWelcome(${gid}, ${tid}) failed:`, e.message);
    return { ok: false, reason: 'send_failed' };
  }
}

// Deletes any outstanding group welcome ("register here") messages for a user
// who has just registered. Best-effort: Telegram only allows the bot to delete
// group messages younger than 48h and only with delete-message rights, so any
// failure is swallowed. Clears the stored ids either way.
async function deleteWelcomeFor(telegramId) {
  if (!bot) return;
  let members = [];
  try {
    members = await GroupMember.find({
      telegramId: String(telegramId),
      welcomeMessageId: { $ne: null },
    }).lean();
  } catch (e) {
    console.warn('[Bot] deleteWelcomeFor lookup failed:', e.message);
    return;
  }
  for (const m of members) {
    if (m.welcomeChatId && m.welcomeMessageId) {
      try {
        await bot.deleteMessage(m.welcomeChatId, m.welcomeMessageId);
      } catch (e) {
        // >48h old or no admin rights — not critical.
        console.warn('[Bot] deleteWelcome message failed:', e.message);
      }
    }
    await GroupMember.updateOne(
      { _id: m._id },
      { $set: { welcomeChatId: '', welcomeMessageId: null } },
    ).catch(() => {});
  }
}

// Live membership gate for registration. Returns true only if the user is a
// CURRENT member of at least one allowed group (member/administrator/creator).
// `restricted` (muted/limited) and `left`/`kicked` are rejected. Fail-closed:
// any API error (bot not in the group, network) counts as "not a member".
// Precondition: the bot must be a member (ideally admin) of each allowed group.
async function isUserInAllowedGroup(telegramId) {
  if (!bot || !telegramId) return false;
  let groupIds = [];
  try {
    const { getAllowedGroupIds } = require('./routes/admin');
    groupIds = await getAllowedGroupIds();
  } catch (e) {
    console.warn('[groupGate] getAllowedGroupIds failed:', e.message);
    return false;
  }
  if (!groupIds.length) return false;

  for (const groupId of groupIds) {
    try {
      const member = await bot.getChatMember(groupId, Number(telegramId));
      if (['member', 'administrator', 'creator'].includes(member?.status)) return true;
    } catch (e) {
      // Fail-closed for THIS group; keep checking the rest.
      console.warn(`[groupGate] getChatMember(${groupId}, ${telegramId}) failed:`, e.message);
    }
  }
  return false;
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
    const blockedUser = await User.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { botBlocked: true },
      { new: true }
    ).lean();

    if (!blockedUser) {
      console.log(`[Bot] Bot blocked event ignored for unknown telegramId=${telegramId}`);
      return;
    }

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
    const lines = [`Користувач заблокував бота!`, `${roleLabel}: ${name}`];
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

// Shared seller-transfer redemption: used by BOTH entry points — a pasted code
// and a `/start ZP-...` deep link. Moves the seller (no admin confirmation),
// replies, and live-refreshes any open admin/picking views.
async function handleTransferHashRedeem(chatId, hash) {
  try {
    const result = await redeemTransferHash({ hash, sellerTelegramId: chatId });
    if (result.ok) {
      const shopLabel = [result.shop?.name, result.shop?.cityId?.name].filter(Boolean).join(', ');
      await bot.sendMessage(chatId, `✅ Вас переведено на магазин: ${shopLabel || result.shop?.name || ''}.`);
      try {
        const { getIO } = require('./socket');
        const io = getIO();
        if (result.movedOrder) {
          if (result.prevGroupId) io.to(`picking_group_${result.prevGroupId}`).emit('shop_status_changed', { groupId: result.prevGroupId });
          if (result.newGroupId && result.newGroupId !== result.prevGroupId) {
            io.to(`picking_group_${result.newGroupId}`).emit('shop_status_changed', { groupId: result.newGroupId });
          }
          io.emit('user_order_updated', { buyerTelegramId: chatId });
        }
      } catch (e) { console.warn('[Bot] transfer-hash socket emit failed:', e?.message); }
    } else {
      const msgByReason = {
        not_found:     'Код переведення недійсний або вже використаний.',
        hash_consumed: 'Код переведення недійсний або вже використаний.',
        not_seller:    'Цей код може активувати лише продавець.',
        same_shop:     'Ви вже привʼязані до цього магазину.',
        shop_inactive: 'Магазин для цього коду неактивний. Зверніться до адміністратора.',
      };
      await bot.sendMessage(chatId, msgByReason[result.reason] || 'Не вдалося активувати код переведення.');
    }
  } catch (e) {
    console.error('[Bot] redeemTransferHash failed:', e);
    await bot.sendMessage(chatId, 'Сталася помилка під час переведення. Спробуйте ще раз або зверніться до адміністратора.');
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

  try {
    // Manual mode — updates arrive via the Express webhook route, not getUpdates.
    bot = new TelegramBot(token);
    status.connected = true;
    status.mode = 'webhook';
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

      if (isGroupChat && msg.from) {
        trackMemberFromMessage(chatId, msg.from).catch(() => {});
      }

      // new_chat_members fires in basic groups (not supergroups) when someone joins.
      // Supergroups use chat_member updates handled separately.
      if (isGroupChat && msg.new_chat_members?.length) {
        for (const newMember of msg.new_chat_members) {
          if (newMember.is_bot) continue;
          const memberId = String(newMember.id);
          trackMemberFromMessage(chatId, newMember).catch(() => {});
          const existing = await User.findOne({ telegramId: memberId }).lean();
          if (!existing) scheduleGroupWelcome(chatId, memberId, newMember);
        }
      }

      if (isGroupChat && msg.reply_to_message && rawText && !rawText.startsWith('/')) {
        const replyToId = String(msg.reply_to_message.message_id);
        const request = await SearchProduct.findOne({
          requestTelegramMessageId: replyToId,
          groupChatId: chatId,
        }).lean();

        if (request) {
          const match = rawText.match(/([0-9]+(?:[.,][0-9]+)?)/);
          if (!match) {
            await bot.sendMessage(chatId, 'Не вдалося розпізнати ціну. Введіть число, наприклад 10 або 10.50.', {
              reply_to_message_id: msg.message_id,
            });
            return;
          }

          const price = Number(match[1].replace(',', '.'));
          if (Number.isNaN(price)) {
            await bot.sendMessage(chatId, 'Не вдалося обробити ціну. Введіть валідне число, наприклад 10 або 10.50.', {
              reply_to_message_id: msg.message_id,
            });
            return;
          }

          const adminName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || '';
          await SearchProduct.findByIdAndUpdate(request._id, {
            price,
            adminTelegramId: String(msg.from?.id || ''),
            adminName,
          });

          await bot.sendMessage(chatId, `Ціну ${match[1]} збережено.`, {
            reply_to_message_id: msg.message_id,
          });
          return;
        }
      }

      if (text === '/start') {
        if (isGroupChat) {
          const groupMessage = (await isAuthorizedGroup(chatId))
            ? 'Бот активовано для цього групового чату.'
            : 'Цей груповий чат не підключено. Зверніться до адміністратора для авторизації.';
          await bot.sendMessage(chatId, groupMessage);
          return;
        }

        // Deep-link payload: `/start ZP-...` — a seller opened the transfer
        // link an admin sent them. Telegram only allows [A-Za-z0-9_-] here,
        // which our ZP-<hex> format already satisfies (no decoding needed).
        // We redeem through the SAME path as a pasted code.
        const startPayload = rawText.split(/\s+/)[1] || '';
        const startHashMatch = startPayload.toUpperCase().match(/^ZP-[0-9A-F]{12}$/);
        if (startHashMatch) {
          if (!user) {
            await bot.sendMessage(chatId, getUnknownUserMessage());
            return;
          }
          await handleTransferHashRedeem(chatId, startHashMatch[0]);
          return;
        }

        // NOTE: Google linking is NO LONGER done here. It moved to the secure
        // reverse-direction flow (mini-app initData mints a telegramId-bound
        // token → system browser does Google → /v1/auth/google/link/complete),
        // which closes the old confused-deputy hole where a t.me deep link could
        // glue a stranger's Google onto whoever opened it. See models/GoogleLinkToken.js.

        if (!user) {
          // Registration handshake. The invite is PER-PERSON. The Telegram id here
          // (chatId / ctx.from.id) is authenticated by Telegram — not spoofable.
          let regToken = null;
          const hasTokenInLink = startPayload && startPayload.toLowerCase() !== 'register';

          if (hasTokenInLink) {
            // A personal token was passed in the link → it MUST belong to THIS
            // user, be unused and unexpired. Foreign / expired / used → REJECT.
            // We never re-issue from a link that carried a token, so one person's
            // link can't open the door for anyone else.
            const owned = await peekRegistrationToken(startPayload, chatId);
            if (!owned) {
              await bot.sendMessage(chatId, 'Це посилання для реєстрації недійсне або призначене не для вас. Відкрийте персональне посилання, яке бот надіслав саме вам у робочій групі.');
              return;
            }
            regToken = owned.token;
          } else if (await isUserInAllowedGroup(chatId)) {
            // Plain /start (no token in the link) by a live group member → mint
            // THEIR OWN token, bound to their id, so a member who came without a
            // link can still register as themselves.
            regToken = await issueRegistrationToken(chatId);
          }

          if (!regToken) {
            await bot.sendMessage(chatId, 'Реєстрація доступна лише учасникам робочої групи. Зверніться до адміністратора.');
            return;
          }

          const regUrl = `${WEB_APP_URL}${WEB_APP_URL.includes('?') ? '&' : '?'}regToken=${encodeURIComponent(regToken)}`;
          if (WEB_APP_URL.startsWith('https://')) {
            await bot.sendMessage(chatId, 'Натисніть кнопку, щоб зареєструватися через Mini App.', {
              reply_markup: {
                inline_keyboard: [[{ text: 'Реєстрація в Mini App', web_app: { url: regUrl } }]],
              },
            });
          } else {
            await bot.sendMessage(chatId, `Відкрийте Mini App: ${regUrl}`);
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

      // ── Shop transfer hash redemption (private chat only) ──
      // A seller pastes the one-time code an admin gave them; we move them to
      // the hash's shop with no admin confirmation. We scan the message for a
      // code anywhere in the text (admins often paste it with a note).
      if (!isGroupChat && rawText) {
        const hashMatch = rawText.toUpperCase().match(/ZP-[0-9A-F]{12}/);
        if (hashMatch) {
          if (!user) {
            await bot.sendMessage(chatId, getUnknownUserMessage());
            return;
          }
          await handleTransferHashRedeem(chatId, hashMatch[0]);
          return;
        }
      }

      if (!user) {
        if (isGroupChat) return;
        await bot.sendMessage(chatId, getUnknownUserMessage());
        return;
      }

      const miniAppUrl = getMiniAppUrl(user.role);
      const buttonText = user.role === 'warehouse' ? 'Відкрити склад' : 'Відкрити товари';
      if (WEB_APP_URL.startsWith('https://')) {
        await bot.sendMessage(chatId, 'Натисніть кнопку нижче, щоб відкрити додаток:', {
          reply_markup: {
            inline_keyboard: [[{ text: buttonText, web_app: { url: miniAppUrl } }]],
          },
        });
      } else {
        await bot.sendMessage(chatId, `Відкрийте Mini App: ${miniAppUrl}`);
      }
      } catch (err) {
        console.error('[Bot] Message handler error:', err);
      }
    });

    // ── New member joins an authorized group ──────────────────────────────────
    bot.on('chat_member', async (update) => {
      try {
        const groupChatId = String(update.chat?.id || '');
        if (!groupChatId || !(await isAuthorizedGroup(groupChatId))) return;

        const joined = await handleChatMemberUpdate(update);
        if (!joined) return; // left / kicked / already known / bot

        const { telegramId, from } = joined;

        // Check immediately — if already registered, nothing to do
        const existing = await User.findOne({ telegramId }).lean();
        if (existing) return;

        // Fetch avatar in background (non-blocking)
        bot.getUserProfilePhotos(Number(telegramId), { limit: 1 })
          .then((photos) => {
            const fileId = photos?.photos?.[0]?.[0]?.file_id;
            if (fileId) setMemberPhoto(groupChatId, telegramId, fileId).catch(() => {});
          })
          .catch(() => {});

        scheduleGroupWelcome(groupChatId, telegramId, from);
      } catch (err) {
        console.error('[Bot] chat_member handler error:', err);
      }
    });

    bot.on('error', (err) => {
      console.error('Telegram bot runtime error:', err);
    });

    bot.on('webhook_error', (err) => {
      console.error('Telegram webhook error:', err);
      status.error = err?.message || String(err);
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
            // Same shared creation as the web approve path (resolves shop →
            // group → zone). No session here — the inline-button flow isn't
            // transactional; the existingUser check above guards the common case.
            const { resolveAndCreateUser } = require('./services/createUserFromRequest');
            await resolveAndCreateUser({
              telegramId: request.telegramId,
              role: request.role,
              firstName: request.firstName,
              lastName: request.lastName,
              phoneNumber: request.phoneNumber,
              shopId: request.role === 'seller' ? request.shopId : null,
              deliveryGroupId: request.deliveryGroupId,
            });
            await RegistrationRequest.findByIdAndDelete(requestId);
            deleteWelcomeFor(request.telegramId).catch((e) =>
              console.warn('[Bot] deleteWelcomeFor failed:', e.message));
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

    // Register the webhook AFTER all handlers are attached, so an update
    // delivered the instant it goes live already has listeners. setWebHook
    // replaces any prior URL; secret_token is echoed back in a header the route
    // verifies. Needs SERVER_BASE_URL to be a public HTTPS host Telegram can reach.
    if (!process.env.SERVER_BASE_URL) {
      throw new Error('SERVER_BASE_URL is required for the Telegram webhook');
    }
    const { path, secretToken } = getWebhookConfig();
    const url = `${String(process.env.SERVER_BASE_URL).replace(/\/$/, '')}${path}`;
    await bot.setWebHook(url, { allowed_updates: ALLOWED_UPDATES, secret_token: secretToken });
    console.log('[Bot] webhook registered at', url);

    console.log('Telegram bot started (webhook)');
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
    mode: status.mode || 'webhook',
    startedAt: status.startedAt,
    error: status.error,
    hasToken: Boolean(bot),
  };
}


module.exports = {
  initBot,
  getBotStatus,
  getWebhookConfig,
  handleWebhookUpdate,
  getBot: () => bot,
  sendAdminNotification,
  sendRegistrationApprovedMessage,
  isUserInAllowedGroup,
  deleteWelcomeFor,
  recheckAndRepushWelcome,
};
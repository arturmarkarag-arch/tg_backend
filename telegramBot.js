const TelegramBot = require('node-telegram-bot-api');
const User = require('./models/User');
const BotInteractionLog = require('./models/BotInteractionLog');
const RegistrationRequest = require('./models/RegistrationRequest');
const SearchProduct = require('./models/SearchProduct');
const DeliveryGroup = require('./models/DeliveryGroup');
const Shop = require('./models/Shop');
const GroupMember = require('./models/GroupMember');
const { redeemShopInvite } = require('./services/redeemShopInvite');
const { publishShopAssignmentTransition } = require('./services/shopAssignmentCommand');
const { getSupportAdmins, toPublicSupportAdmins } = require('./utils/telegramSupportAdmins');
const { isRemovedUser, activeUserFilter } = require('./utils/userAccountState');
const { trackMemberFromMessage, handleChatMemberUpdate, setMemberPhoto } = require('./services/groupMemberSync');
const {
  issueRegistrationToken,
  peekRegistrationToken,
  peekShopInvite,
  looksLikeShopCode,
} = require('./services/registrationToken');

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
  }
}

async function markUserBotBlocked(chatId) {
  try {
    await User.findOneAndUpdate({ telegramId: String(chatId) }, { botBlocked: true });
  } catch (e) {
  }
}

async function logBotInteraction(telegramId, type, action, label = '', context = {}) {
  try {
    await BotInteractionLog.create({ telegramId: String(telegramId), type, action, label, context });
  } catch (e) {
  }
}

async function handleMyChatMemberUpdate(update) {
  try {
    const payload = update?.my_chat_member || update || {};
    const chatId = String(payload.chat?.id || payload.chat_id || payload.from?.id || '');
    const newStatus = payload.new_chat_member?.status || payload.new_chat_member_status;
    if (!chatId || !newStatus) return;

    const user = await User.findOne({ telegramId: chatId }).lean();
    if (!user || isRemovedUser(user)) {
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
  }
}

// Sends a welcome + registration-link message to the group after 10 s.
// Used for both chat_member and new_chat_members join paths.
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendNotInAnnouncementsGroupMessage(chatId) {
  let admins = [];
  try {
    admins = toPublicSupportAdmins(await getSupportAdmins());
  } catch (err) {
  }

  const lines = [
    '❗ <b>Вас не знайдено в робочій групі «Оголошення».</b>',
    '',
    'Для доступу до системи ви <b>обов’язково</b> маєте бути учасником цієї групи.',
    'Попросіть менеджера або адміністратора додати вас до «Оголошення».',
  ];

  if (admins.length) {
    lines.push('', '<b>Адміністратори для зв’язку:</b>');
    for (const admin of admins) {
      lines.push(`• <a href="${admin.url}">${escapeHtml(admin.name)}</a>`);
    }
    lines.push('', 'Натисніть на ім’я адміністратора або кнопку нижче — Telegram одразу відкриє чат.');
  } else {
    lines.push('', 'Після додавання поверніться до бота та натисніть /start ще раз.');
  }

  const options = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (admins.length) {
    options.reply_markup = {
      inline_keyboard: admins.map((admin) => ([{
        text: `Написати: ${admin.name}`.slice(0, 64),
        url: admin.url,
      }])),
    };
  }

  return bot.sendMessage(chatId, lines.join('\n'), options);
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
  const nowRegistered = await User.findOne(activeUserFilter({ telegramId })).lean();
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
    ).catch((e) => {});
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
    return { ok: false, reason: 'check_failed' };
  }

  const inGroup = ['member', 'administrator', 'creator', 'restricted'].includes(member?.status);
  if (!inGroup) {
    // They actually left/were removed — reflect it so the list stops showing them.
    await GroupMember.updateOne({ groupChatId: gid, telegramId: tid }, { $set: { left: true } }).catch(() => {});
    return { ok: true, status: 'left' };
  }

  const registered = await User.findOne(activeUserFilter({ telegramId: tid })).lean();
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
    return;
  }
  for (const m of members) {
    if (m.welcomeChatId && m.welcomeMessageId) {
      try {
        await bot.deleteMessage(m.welcomeChatId, m.welcomeMessageId);
      } catch (e) {
        // >48h old or no admin rights — not critical.
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
    return false;
  }
  if (!groupIds.length) return false;

  for (const groupId of groupIds) {
    try {
      const member = await bot.getChatMember(groupId, Number(telegramId));
      if (['member', 'administrator', 'creator'].includes(member?.status)) return true;
    } catch (e) {
      // Fail-closed for THIS group; keep checking the rest.
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
  const { classifyTelegramSendError, retryDelayMs } = require('./utils/telegramDeliveryPolicy');
  const maxAttempts = Math.max(1, Number(attempts) || 1);
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await bot.sendMessage(chatId, text, options);
    } catch (error) {
      lastError = error;
      const classification = classifyTelegramSendError(error);
      if (classification.botBlocked) {
        handleBotBlocked(String(chatId)).catch(() => {});
      }
      if (!classification.retryable || attempt >= maxAttempts || classification.botBlocked) {
        error.deliveryAttempts = attempt;
        error.telegramClassification = classification;
        throw error;
      }
      await delay(retryDelayMs(classification, attempt));
    }
  }
  throw lastError;
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
    const admins = await User.find(activeUserFilter({ role: 'admin' }), 'telegramId').lean();
    const adminIds = admins.map((a) => a.telegramId).filter(Boolean);
    await sendAdminNotification(lines.join('\n'));
  } catch (err) {
  }
}

// ── THE shop link ────────────────────────────────────────────────────────────
// One code per shop, one meaning per PERSON — decided here, on the server, not
// by which button the admin happened to press:
//   • already registered → move them onto the shop (sellers only);
//   • no account yet     → open registration with that shop pre-fixed.
// Used by BOTH entry points: a `/start ZP-...` deep link and a pasted code.
async function handleShopInvite(chatId, code, user) {
  const invite = await peekShopInvite(code);
  if (!invite) {
    await bot.sendMessage(chatId, 'Це посилання недійсне або вже використане. Попросіть адміністратора надіслати нове.');
    return;
  }

  if (user) {
    await handleShopInviteTransfer(chatId, code);
    return;
  }

  // Newcomer branch: same gate as any other registration — live group membership
  // decides, the invite only fixes WHICH shop. Nothing is consumed here; the
  // token is burnt in the transaction that creates the user.
  if (!(await isUserInAllowedGroup(chatId))) {
    await sendNotInAnnouncementsGroupMessage(chatId);
    return;
  }

  // The shop must still be registerable — /register-request refuses an inactive
  // or group-less shop (registration_shop_inactive / _shop_no_group) and the token
  // DICTATES that shop, so handing out the form here only walks the newcomer into
  // a form they cannot submit. Say it now instead.
  const inviteShop = await Shop.findById(invite.shopId).select('isActive deliveryGroupId').lean();
  if (!inviteShop || !inviteShop.isActive || !inviteShop.deliveryGroupId) {
    await bot.sendMessage(chatId, 'Магазин для цього посилання зараз недоступний. Зверніться до адміністратора.');
    return;
  }

  await sendRegistrationButton(chatId, invite.token);
}

// Registered-user half of a shop link: a straight transfer, no admin
// confirmation. Replies and live-refreshes any open admin/picking views.
async function handleShopInviteTransfer(chatId, code) {
  try {
    const result = await redeemShopInvite({ code, sellerTelegramId: chatId });
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
      } catch (e) {}
    } else {
      const msgByReason = {
        not_found:     'Це посилання недійсне або вже використане.',
        code_consumed: 'Це посилання недійсне або вже використане.',
        not_seller:    'Переводити можна лише продавця. Зверніться до адміністратора.',
        same_shop:     'Ви вже привʼязані до цього магазину.',
        shop_inactive: 'Магазин для цього посилання неактивний. Зверніться до адміністратора.',
      };
      await bot.sendMessage(chatId, msgByReason[result.reason] || 'Не вдалося активувати посилання.');
    }
  } catch (e) {
    await bot.sendMessage(chatId, 'Сталася помилка під час переведення. Спробуйте ще раз або зверніться до адміністратора.');
  }
}

// Sends the mini-app registration button for an already-minted token. Shared by
// the plain /start path and the shop-link path so both open the same form.
async function sendRegistrationButton(chatId, regToken) {
  const regUrl = `${WEB_APP_URL}${WEB_APP_URL.includes('?') ? '&' : '?'}regToken=${encodeURIComponent(regToken)}`;
  if (WEB_APP_URL.startsWith('https://')) {
    await bot.sendMessage(
      chatId,
      '✅ Вас знайдено в групі «Оголошення».\n\nНатисніть «Відкрити», щоб пройти реєстрацію.',
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Відкрити', web_app: { url: regUrl } }]],
        },
      },
    );
    return;
  }
  await bot.sendMessage(chatId, `✅ Вас знайдено в групі «Оголошення». Відкрийте реєстрацію: ${regUrl}`);
}

async function sendAdminNotification(text) {
  const admins = await User.find(activeUserFilter({ role: 'admin' }), 'telegramId').lean();
  const adminIds = admins.map((a) => a.telegramId).filter(Boolean);
  for (const adminId of adminIds) {
    try {
      await bot.sendMessage(adminId, text);
    } catch (err) {
    }
  }
}

async function initBot(token) {
  if (!token) {
    status.error = 'TELEGRAM_BOT_TOKEN not configured';
    return;
  }

  if (bot) {
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
      const storedUser = await User.findOne({ telegramId: chatId });
      const user = storedUser && !isRemovedUser(storedUser) ? storedUser : null;
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
          const existing = await User.findOne(activeUserFilter({ telegramId: memberId })).lean();
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

        // Deep-link payload: `/start ZP-...` — someone opened the admin's shop
        // link. ONE link for both cases: the branch (transfer vs. registration)
        // is decided by whether this telegramId already has an account, not by
        // which link was sent. Same path as a pasted code.
        const startPayload = rawText.split(/\s+/)[1] || '';
        if (looksLikeShopCode(startPayload)) {
          await handleShopInvite(chatId, startPayload, user);
          return;
        }

        // NOTE: Google linking is NO LONGER done here. It moved to the secure
        // reverse-direction flow (mini-app initData mints a telegramId-bound
        // token → system browser does Google → /v1/auth/google/link/complete),
        // which closes the old confused-deputy hole where a t.me deep link could
        // glue a stranger's Google onto whoever opened it. See models/GoogleLinkToken.js.

        if (!user) {
          // Registration handshake. Shop links were already handled above, so a
          // token here is the PER-PERSON kind from the group welcome message.
          // The Telegram id (chatId / ctx.from.id) is authenticated by Telegram
          // — not spoofable.
          let regToken = null;
          const hasTokenInLink = startPayload && startPayload.toLowerCase() !== 'register';

          if (hasTokenInLink) {
            // Foreign / expired / used → REJECT. We never re-issue from a link
            // that carried a token, so one person's link can't open the door for
            // anyone else.
            const owned = await peekRegistrationToken(startPayload, chatId);
            if (!owned || !owned.telegramId) {
              await bot.sendMessage(chatId, 'Це посилання для реєстрації недійсне або призначене не для вас. Відкрийте персональне посилання, яке бот надіслав саме вам у робочій групі.');
              return;
            }
            // A token proves who the registration link belongs to, NOT current
            // membership. Someone may leave «Оголошення» after receiving it, so
            // /start still performs the same live gate before offering Open.
            if (!(await isUserInAllowedGroup(chatId))) {
              await sendNotInAnnouncementsGroupMessage(chatId);
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
            await sendNotInAnnouncementsGroupMessage(chatId);
            return;
          }

          await sendRegistrationButton(chatId, regToken);
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
          if (await isUserInAllowedGroup(chatId)) {
            const regToken = await issueRegistrationToken(chatId);
            await sendRegistrationButton(chatId, regToken);
          } else {
            await sendNotInAnnouncementsGroupMessage(chatId);
          }
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

      // ── Shop code pasted into the chat (private chat only) ──
      // Same link, typed instead of tapped. We scan the message for a code
      // anywhere in the text (admins often paste it with a note) and hand it to
      // the same server-side branch as the deep link.
      if (!isGroupChat && rawText) {
        const codeMatch = rawText.toUpperCase().match(/ZP-[0-9A-F]{12}/);
        if (codeMatch) {
          await handleShopInvite(chatId, codeMatch[0], user);
          return;
        }
      }

      if (!user) {
        if (isGroupChat) return;
        if (await isUserInAllowedGroup(chatId)) {
          const regToken = await issueRegistrationToken(chatId);
          await sendRegistrationButton(chatId, regToken);
        } else {
          await sendNotInAnnouncementsGroupMessage(chatId);
        }
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
        const existing = await User.findOne(activeUserFilter({ telegramId })).lean();
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
      }
    });

    bot.on('error', (err) => {
    });

    bot.on('webhook_error', (err) => {
      status.error = err?.message || String(err);
    });

    bot.on('callback_query', async (query) => {
      try {
      const chatId = String(query.message.chat.id);
      const msgId = String(query.message.message_id);
      const data = String(query.data || '').trim();
      const storedCallbackUser = await User.findOne({ telegramId: chatId });
      const user = storedCallbackUser && !isRemovedUser(storedCallbackUser) ? storedCallbackUser : null;
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
        // Inline keyboards can live for days. A removed/former admin must not be
        // able to approve an old request after their application access was closed.
        if (!user || user.role !== 'admin') {
          await bot.answerCallbackQuery(query.id, { text: 'Доступ закрито', show_alert: true });
          return;
        }
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
          }
          return;
        }

        if (action === 'regreq_approve') {
          const existingUser = await User.findOne({ telegramId: request.telegramId }).lean();
          if (existingUser && !isRemovedUser(existingUser)) {
            await RegistrationRequest.findByIdAndUpdate(requestId, { status: 'rejected' });
            await bot.answerCallbackQuery(query.id, { text: 'Користувач вже зареєстрований', show_alert: true });
          } else {
            // Same shared creation as the web approve path (resolves shop →
            // group → zone). No session here — the inline-button flow isn't
            // transactional; the existingUser check above guards the common case.
            const { resolveAndCreateUser } = require('./services/createUserFromRequest');
            const resolution = await resolveAndCreateUser({
              telegramId: request.telegramId,
              role: request.role,
              firstName: request.firstName,
              lastName: request.lastName,
              phoneNumber: request.phoneNumber,
              shopId: request.role === 'seller' ? request.shopId : null,
              deliveryGroupId: request.deliveryGroupId,
            });
            await RegistrationRequest.findByIdAndDelete(requestId);
            if (resolution.assignmentTransition) {
              await publishShopAssignmentTransition(resolution.assignmentTransition);
            }
            deleteWelcomeFor(request.telegramId).catch(() => {});
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
        }
        return;
      }

      await bot.answerCallbackQuery(query.id, { text: 'Невідома дія.', show_alert: true });
      } catch (err) {
        try { await bot.answerCallbackQuery(query.id); } catch (e) {
        }
      }
    });

    bot.on('my_chat_member', async (update) => {
      await handleMyChatMemberUpdate(update).catch((err) => {
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
    // URL навмисно не логуємо: шлях вебхука похідний від токена бота.
  } catch (error) {
    status.error = error.message || String(error);
    status.connected = false;
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
  // Виставлено для сервісів, які самі шлють повідомлення (services/supplementNotify.js):
  // обгортка вже вміє 429-ретрай і позначає користувача, що заблокував бота.
  sendMessageWithRetry,
  markBotBlocked: handleBotBlocked,
  sendAdminNotification,
  sendRegistrationApprovedMessage,
  isUserInAllowedGroup,
  deleteWelcomeFor,
  recheckAndRepushWelcome,
};
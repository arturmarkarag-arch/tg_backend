'use strict';

const GroupMember = require('../models/GroupMember');

function normalizeTelegramUsername(value) {
  const raw = String(value || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{5,32}$/.test(raw) ? raw : '';
}

/**
 * GroupMember is the live Telegram-facing source we already maintain from the
 * announcement/work group. Resolve usernames in one batch so staff-facing API
 * responses can show a working t.me button without relying on tg://user?id=...
 * deep links, which are privacy/client dependent.
 */
async function getTelegramUsernameMap(telegramIds = []) {
  const ids = [...new Set((telegramIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const rows = await GroupMember.find(
    { telegramId: { $in: ids }, username: { $nin: ['', null] } },
    'telegramId username statusCheckedAt updatedAt',
  )
    .sort({ statusCheckedAt: -1, updatedAt: -1 })
    .lean();

  for (const row of rows) {
    const id = String(row.telegramId || '');
    if (!id || map.has(id)) continue;
    const username = normalizeTelegramUsername(row.username);
    if (username) map.set(id, username);
  }
  return map;
}

module.exports = { normalizeTelegramUsername, getTelegramUsernameMap };

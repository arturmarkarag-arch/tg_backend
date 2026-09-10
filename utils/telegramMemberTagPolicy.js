'use strict';

const MAX_TAG_CHARACTERS = 16;

function cleanString(value) {
  return value == null ? '' : String(value);
}

function unicodeCharacters(value) {
  return Array.from(cleanString(value).normalize('NFC'));
}

function formatTelegramMemberTag(shopName) {
  const name = cleanString(shopName).trim();
  if (!name) return '';
  return unicodeCharacters(`#${name}`).slice(0, MAX_TAG_CHARACTERS).join('');
}

function hasEmoji(value) {
  try {
    return /\p{Extended_Pictographic}/u.test(cleanString(value));
  } catch (_) {
    return false;
  }
}

/**
 * Pure Telegram-member policy. ERP state is resolved elsewhere.
 * Restricted users are intentionally outside the initial contract even though
 * Bot API exposes a tag for ChatMemberRestricted: only status=member is managed.
 */
function decideTelegramMemberTagAction({ status, currentTag = '', desiredTag = '' } = {}) {
  const s = cleanString(status);
  const previousTag = cleanString(currentTag);
  const desired = cleanString(desiredTag);

  if (s === 'administrator') return { result: 'skipped_admin', write: false };
  if (s === 'creator') return { result: 'skipped_creator', write: false };
  if (s === 'left' || s === 'kicked') return { result: 'not_in_group', write: false };
  if (s !== 'member') return { result: `skipped_${s || 'unknown'}`, write: false };
  if (previousTag === desired) return { result: 'unchanged', write: false };
  return { result: desired ? 'updated' : 'cleared', write: true };
}

module.exports = {
  MAX_TAG_CHARACTERS,
  formatTelegramMemberTag,
  hasEmoji,
  decideTelegramMemberTagAction,
};

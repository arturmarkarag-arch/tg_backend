'use strict';

const {
  persistedPresence,
  resolveAnnouncementGroupMembership,
} = require('../services/announcementGroupMembership');

describe('announcement work-group membership availability', () => {
  it.each(['member', 'administrator', 'creator', 'restricted'])('%s is present', (telegramStatus) => {
    expect(persistedPresence({ telegramStatus, left: false })).toBe(true);
  });

  it.each(['left', 'kicked', 'not_found'])('%s is a determinate absence', (telegramStatus) => {
    expect(persistedPresence({ telegramStatus, left: true })).toBe(false);
  });

  it('never converts unknown Telegram state into absence', () => {
    expect(persistedPresence({ telegramStatus: 'unknown', left: true })).toBeNull();
  });

  it('accepts membership in any configured work group', () => {
    const rows = [
      { groupChatId: '-1', telegramStatus: 'left', left: true },
      { groupChatId: '-2', telegramStatus: 'member', left: false },
    ];
    expect(resolveAnnouncementGroupMembership(rows, ['-1', '-2'])).toBe(true);
  });

  it('marks unavailable only when every configured group confirms absence', () => {
    const rows = [
      { groupChatId: '-1', telegramStatus: 'left', left: true },
      { groupChatId: '-2', telegramStatus: 'not_found', left: true },
    ];
    expect(resolveAnnouncementGroupMembership(rows, ['-1', '-2'])).toBe(false);
    expect(resolveAnnouncementGroupMembership(rows.slice(0, 1), ['-1', '-2'])).toBeNull();
  });
});

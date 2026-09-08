'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

describe('light read-path efficiency contracts 2026-09-07', () => {
  it('nav badge uses one batched group-member projection instead of full admin views per group', () => {
    const route = read('routes/navBadges.js');
    expect(route).toContain('countUnregisteredPresentMembers(groupIds)');
    expect(route).not.toContain('groupIds.map((id) => getMembersWithStatus(id))');
    expect(route).not.toContain('results.flat()');
  });

  it('unregistered badge projection performs bounded GroupMember + User reads only', () => {
    const source = read('services/groupMemberSync.js');
    const block = sliceBetweenOrThrow(
      source,
      'async function countUnregisteredPresentMembers',
      '/**\n * Full admin view for one Telegram group.',
      { label: 'batched unregistered-member badge projection' },
    );

    expect(block.match(/GroupMember\.find\(/g)?.length || 0).toBe(1);
    expect(block.match(/User\.find\(/g)?.length || 0).toBe(1);
    expect(block).not.toContain('Shop.find(');
    expect(block).not.toContain('RegistrationRequest.find(');
    expect(block).not.toContain('getMembersWithStatus(');
    expect(block).toContain("accountState: { $ne: 'removed' }");
  });

  it('badge preserves persisted-presence semantics including legacy empty status rows', () => {
    const source = read('services/groupMemberSync.js');
    const block = sliceBetweenOrThrow(
      source,
      'async function countUnregisteredPresentMembers',
      '/**\n * Full admin view for one Telegram group.',
      { label: 'batched unregistered-member badge projection' },
    );
    expect(block).toContain('PRESENT_STATUSES.includes(status)');
    expect(block).toContain('!status && member.left === false');
    expect(block).toContain('hiddenAt: null');
    expect(block).toContain('isBot: false');
  });
});

'use strict';

const fs = require('fs');
const path = require('path');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'telegramMemberTagSync.js'), 'utf8');

describe('Telegram member-tag processing revision fence', () => {
  it('keeps the claimed requestedRevision as the finishClaim CAS fence', () => {
    expect(source).toContain('row.processingRevision = Number(row.requestedRevision || 0)');
    expect(source).toContain('const filter = { _id: row._id, requestedRevision: row.processingRevision }');
  });

  it('does not persist processingRevision with a redundant updateOne before per-row isolation', () => {
    const claimLane = sliceBetweenOrThrow(
      source,
      'async function drainDueTelegramMemberTagSync',
      'results.push(await processTelegramMemberTagSync(row))',
      { label: 'telegram member-tag claim lane' },
    );
    expect(claimLane).not.toContain("{ $set: { processingRevision: row.processingRevision } }");
    expect(claimLane).not.toContain('TelegramMemberTagSync.updateOne(');
  });

  it('keeps the per-row failure isolation try/catch', () => {
    expect(source).toContain('Failure-isolated per (telegramId, chatId)');
    expect(source).toContain('try {\n      results.push(await processTelegramMemberTagSync(row));');
  });
});

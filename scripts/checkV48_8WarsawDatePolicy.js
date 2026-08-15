'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const fail = (message) => {
  console.error(`V48.8 Warsaw date policy: FAIL — ${message}`);
  process.exit(1);
};

const dates = read('utils/warsawDateTime.js');
const schedule = read('utils/orderingSchedule.js');
const receipts = read('routes/receipts.js');
const archive = read('routes/archive.js');
const products = read('routes/products.js');
const telegram = read('routes/v1/telegram.js');
const liveE2e = read('scripts/liveOrderPickingE2E.js');

// This server suite is CommonJS with Vitest globals enabled. Requiring Vitest
// from CommonJS test files fails before collection, so keep all server tests on globals.
const testDir = path.join(root, 'tests');
const vitestRequireOffenders = [];
const testStack = [testDir];
while (testStack.length) {
  const current = testStack.pop();
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      testStack.push(full);
      continue;
    }
    if (!entry.name.endsWith('.test.js')) continue;
    const rel = path.relative(root, full).replaceAll('\\', '/');
    const source = fs.readFileSync(full, 'utf8');
    if (/require\(\s*['"]vitest['"]\s*\)/.test(source)) vitestRequireOffenders.push(rel);
  }
}
if (vitestRequireOffenders.length) {
  fail(`CommonJS server tests must use Vitest globals; remove require('vitest') from: ${vitestRequireOffenders.join(', ')}`);
}

for (const rel of ['tests/warsawDateTime.test.js', 'tests/warsawDatePolicy.contract.test.js']) {
  const source = read(rel);
  if (!source.includes("describe('") || !source.includes("it('") || !source.includes('expect(')) {
    fail(`${rel} no longer contains executable Vitest assertions`);
  }
}

if (!schedule.includes("const TIMEZONE = 'Europe/Warsaw'")) fail('ordering schedule is not pinned to Europe/Warsaw');
if (!dates.includes("const { TIMEZONE, warsawWallClockToUTC } = require('./orderingSchedule')")) fail('shared Warsaw date helper does not reuse schedule timezone');
if (!dates.includes('function warsawDateKeyToUtcRange')) fail('Warsaw local-day range helper missing');
if (!dates.includes('endExclusive')) fail('local-day range must use exclusive next midnight for DST safety');

if (!receipts.includes('buildWarsawDateRange({')) fail('receipt date filters do not use Warsaw local-day ranges');
if (receipts.includes('Date.parse(req.query.dateFrom') || receipts.includes('Date.parse(req.query.dateTo')) {
  fail('receipt date filters still parse YYYY-MM-DD as UTC/browser dates');
}
if (!archive.includes('formatWarsawDateKey(p.archivedAt)')) fail('archive grouping is not based on Warsaw calendar dates');
if (/archivedAt[^\n]*toISOString\(\)\.slice\(0,\s*10\)/.test(archive)) fail('archive still groups by UTC date key');

if (!products.includes('formatWarsawDateKey(new Date())')) fail('product catalogue day cache is not Warsaw-scoped');
if (!products.includes('warsawDateKeyToUtcRange(dateFilter)')) fail('product date_filter is not interpreted as a Warsaw day');
if (/dateFilter[^\n]*T00:00:00/.test(products)) fail('product date_filter still constructs a raw UTC midnight');

if (!telegram.includes('formatWarsawDateTime(new Date())')) fail('Telegram registration timestamp is not Warsaw/DD.MM/24h');
if (!liveE2e.includes('addDaysToDateKey(curSession.openDate, -7)')) fail('live E2E still manipulates session date keys through UTC Date serialization');

// User-facing/runtime date formatters outside the shared helper are allowed only
// when they explicitly pin Europe/Warsaw. This catches a future bare toLocaleString().
const runtimeDirs = ['routes', 'services', 'utils'];
const offenders = [];
for (const dirName of runtimeDirs) {
  const dir = path.join(root, dirName);
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const rel = path.relative(root, full).replaceAll('\\', '/');
      const source = fs.readFileSync(full, 'utf8');
      if (/\.toLocale(?:Date|Time)?String\s*\(/.test(source) && !source.includes('Europe/Warsaw') && rel !== 'utils/warsawDateTime.js') {
        offenders.push(rel);
      }
    }
  }
}
if (offenders.length) fail(`unscoped locale date formatting remains in: ${[...new Set(offenders)].join(', ')}`);

console.log('V48.8 Warsaw date policy: PASS');

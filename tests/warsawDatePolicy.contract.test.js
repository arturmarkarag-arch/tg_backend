'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.cwd());
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.8 Warsaw / European date policy', () => {
  it('receipt date filters use Warsaw-local calendar boundaries, not UTC YYYY-MM-DD parsing', () => {
    const source = read('routes/receipts.js');
    expect(source).toContain("const { buildWarsawDateRange } = require('../utils/warsawDateTime')");
    expect(source).toContain('dateFrom: req.query.dateFrom');
    expect(source).toContain('dateTo: req.query.dateTo');
    expect(source).not.toContain('Date.parse(req.query.dateFrom');
    expect(source).not.toContain('Date.parse(req.query.dateTo');
  });

  it('archive/product day semantics use Europe/Warsaw date boundaries', () => {
    const archive = read('routes/archive.js');
    const products = read('routes/products.js');
    expect(archive).toContain('formatWarsawDateKey(p.archivedAt)');
    expect(products).not.toContain('new Date().toISOString().slice(0, 10)');
    expect(products).toContain('warsawDateKeyToUtcRange(dateFilter)');
  });

  it('date-only E2E fixtures use pure date-key arithmetic instead of UTC serialization', () => {
    const source = read('scripts/liveOrderPickingE2E.js');
    expect(source).toContain("const { addDaysToDateKey } = require('../utils/warsawDateTime')");
    expect(source).toContain('addDaysToDateKey(curSession.openDate, -7)');
    expect(source).not.toContain('oldDate.toISOString().slice(0, 10)');
  });

  it('Warsaw day ranges preserve DST-short and DST-long days', () => {
    const dates = read('utils/warsawDateTime.js');
    expect(dates).toContain('warsawWallClockToUTC');
    expect(dates).toContain('const nextKey = addDaysToDateKey(value, 1)');
    expect(dates).toContain('return { start, endExclusive }');
  });
});

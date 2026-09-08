'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'routes/products.js'), 'utf8');
const routeStart = source.indexOf("router.get('/', async");
const firstV1 = source.indexOf('if (isV1) {', routeStart);
const start = source.indexOf('if (isV1) {', firstV1 + 1);
const end = source.indexOf('  const total = await Product.countDocuments(query);', start);
if (start < 0 || end <= start) throw new Error('seller catalogue block not found');
const block = source.slice(start, end);
const checks = [
  ['one Product.aggregate for seller/warehouse v1 list', (block.match(/Product\.aggregate\(/g) || []).length === 1],
  ['count and page share $facet', block.includes('$facet: {') && block.includes("meta: [{ $count: 'total' }]") && block.includes('items: [')],
  ['shelf lookup appears once', (block.match(/from: 'blocks'/g) || []).length === 1],
  ['sort/skip/limit remain inside page facet', block.includes('...sortStages') && block.includes('{ $skip: offset }') && block.includes('{ $limit: limit }')],
  ['API total still comes from Mongo count facet', block.includes('const total = Number(pageResult?.meta?.[0]?.total || 0)')],
];
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} PASS`);
if (failed.length) process.exit(1);

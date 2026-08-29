'use strict';
const fs = require('fs');
const path = require('path');
const { parseDecimalNumber } = require('../utils/decimalNumber');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const checks = [];
const ok = (name, condition) => checks.push([name, Boolean(condition)]);

ok('comma parser 29,99', parseDecimalNumber('29,99') === 29.99);
ok('dot parser 29.99', parseDecimalNumber('29.99') === 29.99);
ok('blank invalid', Number.isNaN(parseDecimalNumber('')));
const products = read('routes/products.js');
ok('warehouse product endpoints normalize decimals', products.includes("require('../utils/decimalNumber')") && products.includes('parseDecimalNumber(price)'));
const shops = read('routes/shopProducts.js');
ok('shop product endpoints normalize decimals', shops.includes("require('../utils/decimalNumber')") && (shops.match(/parseDecimalNumber\(/g) || []).length >= 3);

for (const [name, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
const failed = checks.filter(([, pass]) => !pass);
if (failed.length) process.exit(1);
console.log(`Price decimal server contract: PASS (${checks.length}/${checks.length})`);

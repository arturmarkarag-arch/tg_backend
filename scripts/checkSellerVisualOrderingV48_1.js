'use strict';

const fs = require('fs');
const path = require('path');
const { buildVisualSequence } = require('../services/sellerVisualOrderingAlgo');

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS: ${message}`);
}

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const families = [
  { id: 'plate-a', orderNumber: 1, vector: [1, 0, 0], model: 'm', dim: 3 },
  { id: 'fork-a', orderNumber: 2, vector: [0, 1, 0], model: 'm', dim: 3 },
  { id: 'toy-a', orderNumber: 3, vector: [0, 0, 1], model: 'm', dim: 3 },
  { id: 'plate-b', orderNumber: 4, vector: [0.999, 0.01, 0], model: 'm', dim: 3 },
  { id: 'fork-b', orderNumber: 5, vector: [0.01, 0.999, 0], model: 'm', dim: 3 },
  { id: 'toy-b', orderNumber: 6, vector: [0, 0.01, 0.999], model: 'm', dim: 3 },
];
const one = buildVisualSequence(families).ids;
const two = buildVisualSequence(families).ids;
const adjacent = (a, b) => Math.abs(one.indexOf(a) - one.indexOf(b)) === 1;
assert(adjacent('plate-a', 'plate-b'), 'plate-like products stay adjacent');
assert(adjacent('fork-a', 'fork-b'), 'fork-like products stay adjacent');
assert(adjacent('toy-a', 'toy-b'), 'toy-like products stay adjacent');
assert(JSON.stringify(one) === JSON.stringify(two), 'visual sequence is deterministic');

const missing = buildVisualSequence([
  ...families.slice(0, 2),
  { id: 'legacy-no-vector', orderNumber: 99 },
]).ids;
assert(missing[missing.length - 1] === 'legacy-no-vector', 'missing embedding falls back safely at the stable tail');

const routes = read('routes/products.js');
const service = read('services/sellerVisualOrdering.js');
const algo = read('services/sellerVisualOrderingAlgo.js');
assert(routes.includes("router.get('/catalog'"), 'dedicated seller catalog endpoint exists');
assert(routes.includes("status: 'active'"), 'seller catalog requires active warehouse status');
assert(routes.includes("'_block.0': { $exists: true }"), 'seller catalog requires real Block membership');
assert(routes.includes("orderingEnabled: { $ne: false }"), 'seller catalog preserves ordinary-order gate');
assert(routes.includes('applySellerCycleCutoff(match, context.cutoff)'), 'seller catalog preserves current-cycle cutoff');
assert(service.includes("ProductVector.find("), 'embeddings stay backend-only in ProductVector');
assert(algo.includes('buildGreedyRoute'), 'nearest-neighbour route is implemented');
assert(algo.includes('optimizeTwoOpt'), '2-opt improvement pass is implemented');
assert(!service.includes('Block.'), 'visual-order service never mutates or reads Block business ordering');
assert(!service.includes("require('../models/PickingTask')"), 'visual-order service never imports picking');
assert(!service.includes("require('../models/Order')"), 'visual-order service never imports orders');

console.log('V48.1 seller visual ordering checks complete.');

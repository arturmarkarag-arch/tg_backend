'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function section(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  if (start < 0) return '';
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(message);
    err.code = 'SECURITY_CONTRACT_FAILED';
    throw err;
  }
}

function includesAll(text, needles, label) {
  for (const needle of needles) {
    assert(text.includes(needle), `${label}: missing ${needle}`);
  }
}

function noRegex(text, regex, label) {
  assert(!regex.test(text), `${label}: forbidden pattern ${regex}`);
}

function scanFiles(relPaths, regex) {
  const hits = [];
  for (const rel of relPaths) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (regex.test(text)) hits.push(rel);
  }
  return hits;
}

function runChecks({ quiet = false } = {}) {
  const checks = [];
  const pass = (name) => checks.push(name);

  const app = read('app.js');
  const publicPaths = section(app, 'const publicApiPaths = [', '];\n\nfunction requireAuthForApi');
  includesAll(app, [
    "app.use('/uploads', telegramAuth, requireTelegramRoles(['admin', 'warehouse'])",
    "req.telegramUser?.role !== 'baselinker'",
    "/^\\/api\\/(?:baselinker|allegro|commerce)(?:\\/|$)/",
  ], 'app boundary');
  assert(!publicPaths.includes('search-products'), 'public allowlist must not expose search-products');
  assert(!publicPaths.includes('shop-products'), 'public allowlist must not expose shop-products');
  assert(!publicPaths.includes('delivery-groups'), 'public allowlist must not expose delivery-groups');
  assert(!publicPaths.includes('/api\\/v1\\/auth(?:'), 'public allowlist must not expose broad auth namespace');
  pass('anonymous allowlist + uploads boundary');

  const blocks = read('routes/blocks.js');
  includesAll(blocks, [
    "const staffOnly = requireTelegramRoles(['admin', 'warehouse'])",
    'router.use(staffOnly);',
  ], 'blocks boundary');
  pass('blocks router is warehouse/admin only');

  const products = read('routes/products.js');
  includesAll(products, [
    "router.get('/', staffOnly,",
    "router.get('/check', staffOnly,",
    "router.get('/pending', staffOnly,",
    "router.get('/proxy-image', staffOnly,",
    "router.get('/:id', staffOnly,",
    "router.get('/:id/position', staffOnly,",
    "router.get('/catalog', registeredOnly,",
    "router.get('/new-list', registeredOnly,",
  ], 'products role matrix');
  pass('warehouse Product reads are staff-only; seller catalogue is explicit');

  const searchProducts = read('routes/searchProducts.js');
  includesAll(searchProducts, [
    "router.use(requireTelegramRoles(['seller', 'admin', 'warehouse']))",
    ".select('_id barcode price title caption imageUrl createdAt updatedAt')",
    'const items = rows.map((record) => ({',
  ], 'search-products DTO');
  const searchGet = section(searchProducts, "router.get('/',", "router.post('/resend'");
  for (const field of ['telegramMessageId', 'telegramPhotoFileId', 'groupChatId', 'adminTelegramId', 'adminName', 'requestCaption']) {
    assert(!searchGet.includes(field), `SearchProduct GET leaks ${field}`);
  }
  pass('SearchProduct is authenticated and DTO-projected');

  const shopProducts = read('routes/shopProducts.js');
  includesAll(shopProducts, [
    'router.use(anyRole);',
    'function sellerShopProductDto(item)',
    'function scannerShopProductDto(item)',
    ".select('_id barcode name price quantityPerPackage imageUrl')",
  ], 'shop-products DTO');
  const sellerDto = section(shopProducts, 'function sellerShopProductDto(item)', 'function scannerShopProductDto(item)');
  for (const field of ['createdBy', 'receiptItemId', 'linkedProductId:', 'notes:', 'labelPositions', 'originalImageUrl', 'source:']) {
    assert(!sellerDto.includes(field), `seller ShopProduct DTO leaks ${field}`);
  }
  assert(shopProducts.includes("...(!sellerSearch ? [{ notes: new RegExp(t, 'i') }] : [])"), 'seller search must not match internal notes');
  pass('ShopProduct browse is authenticated and seller DTO is minimized');

  const groups = read('routes/deliveryGroups.js');
  includesAll(groups, [
    "router.get('/summary', telegramAuth, requireTelegramRoles(['admin', 'warehouse'])",
    "router.get('/', telegramAuth, requireTelegramRoles(['admin', 'warehouse'])",
  ], 'delivery-groups boundary');
  pass('operational delivery-groups reads are staff-only');

  const proxy = read('utils/safeImageProxy.js');
  includesAll(proxy, [
    'configuredAllowedHosts',
    'dns.lookup(hostname, { all: true, verbatim: true })',
    'isPrivateAddress',
    'pinnedLookup',
    'maxRedirects: 0',
    'maxContentLength: MAX_IMAGE_BYTES',
    "contentType.startsWith('image/')",
    'lookup: pinnedLookup(host, resolvedAddresses)',
  ], 'safe image proxy');
  pass('image proxy allowlist/private-IP/DNS-pinning/redirect/content-size policy');

  const socket = read('socket.js');
  includesAll(socket, [
    "const { verifySession, isSessionNotRevoked } = require('./utils/jwt')",
    '!isSessionNotRevoked(jwtIat, dbUser)',
    "socket.join(`user_${socket.telegramId}`)",
    "socket.join('staff')",
    "socket.join('app_users')",
    "socket.on('get_locks', () => {",
    "socket.emit('locks_error', { error: 'forbidden' })",
    "socket.to('staff').emit('item_locked'",
    "io.to('staff').emit('block_updated'",
    "io.to('staff').emit('picking_tasks_positions_updated'",
  ], 'socket boundary');
  noRegex(socket, /socket\.broadcast\.emit\(['"]item_locked['"]/, 'socket lock leakage');
  pass('Socket JWT revocation + warehouse lock/topology isolation');

  const socketScope = read('utils/socketScope.js');
  includesAll(socketScope, [
    "io.to('staff').emit(event, payload)",
    'io.to(room).emit(event, payload)',
  ], 'socket user scope');

  const productionEventFiles = [
    'routes/orders.js',
    'routes/shopTransfer.js',
    'routes/supplement.js',
    'services/archiveProduct.js',
    'services/lateOrderReconcile.js',
    'services/pickingService.js',
    'services/shopAssignmentCommand.js',
    'telegramBot.js',
  ];
  const userLeaks = scanFiles(productionEventFiles, /(?:\bio|socket)\s*\.\s*emit\(\s*['"](?:user_order_updated|user_shop_changed)['"]/);
  assert(userLeaks.length === 0, `global user identity socket emit remains in: ${userLeaks.join(', ')}`);
  pass('seller-private identity events use targeted rooms');

  const warehouseEventFiles = [
    'socket.js',
    'routes/blocks.js',
    'routes/products.js',
    'routes/receipts.js',
    'routes/shopProducts.js',
    'routes/archive.js',
    'services/archiveProduct.js',
    'services/pickingService.js',
    'services/receiptRoutingCorrectionCommand.js',
  ];
  const richWarehouseLeaks = scanFiles(
    warehouseEventFiles,
    /\bio\s*\.\s*emit\(\s*['"](?:block_updated|picking_tasks_positions_updated|item_locked|item_unlocked|incoming_updated|picking_queue_changed|picking_task_released|receipt_supplement_batch_changed)['"]/,
  );
  assert(richWarehouseLeaks.length === 0, `global warehouse socket emit remains in: ${richWarehouseLeaks.join(', ')}`);
  pass('warehouse-rich socket events are staff-room scoped');


  const appUserEventFiles = [
    'routes/blocks.js', 'routes/products.js', 'routes/shopProducts.js', 'routes/receipts.js',
    'routes/orders.js', 'routes/supplement.js', 'services/archiveProduct.js',
    'services/supplementOffers.js', 'services/supplementWaveService.js',
    'services/receiptRoutingCorrectionCommand.js', 'services/shopTopologyCommand.js',
    'services/shopAssignmentCommand.js',
  ];
  const providerCrossRoleLeaks = scanFiles(
    appUserEventFiles,
    /(?:\bio|socket)\s*\.\s*emit\(\s*['"](?:catalogue_updated|delivery_groups_updated|product_archived|supplement_[^'"]*)['"]/,
  );
  assert(providerCrossRoleLeaks.length === 0, `app UI event still broadcasts to provider workers in: ${providerCrossRoleLeaks.join(', ')}`);
  pass('seller/staff UI invalidations exclude provider-worker sockets');

  if (!quiet) {
    for (const [index, name] of checks.entries()) console.log(`PASS ${index + 1}/${checks.length} ${name}`);
    console.log(`\nSecurity access matrix 2026-09-12: ${checks.length}/${checks.length} PASS`);
  }
  return checks;
}

if (require.main === module) {
  try {
    runChecks();
  } catch (err) {
    console.error(`FAIL ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { runChecks };

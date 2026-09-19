'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { hasBaseLinkerPickingAccess } = require('../utils/baseLinkerAccess');
const { hasMarketplaceWarehouseAccess } = require('../utils/marketplaceWarehouseAccess');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'audits', 'ENDPOINT-ROLE-MATRIX-2026-09-13.md');
const ROLES = ['anonymous', 'seller', 'warehouse', 'admin'];

function routeModulePath(raw) {
  const normalized = String(raw).replace(/\\/g, '/');
  return normalized.endsWith('.js') ? normalized : `${normalized}.js`;
}

function loadRouterMounts() {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const imports = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/const\s+(?:\{\s*router\s*:\s*([\w$]+)\s*\}|([\w$]+))\s*=\s*require\(['"]\.\/(routes\/[^'"]+)['"]\)/);
    if (match) imports.set(match[1] || match[2], routeModulePath(match[3]));
  }

  const mounts = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/app\.use\(\s*['"](\/api[^'"]*)['"]\s*,(.*)\);/);
    if (!match) continue;
    const [, prefix, middlewareList] = match;
    const inline = middlewareList.match(/require\(['"]\.\/(routes\/[^'"]+)['"]\)/);
    let rel = inline ? routeModulePath(inline[1]) : null;
    if (!rel) {
      const imported = [...imports.entries()].find(([name]) => new RegExp(`\\b${name}\\b`).test(middlewareList));
      rel = imported?.[1] || null;
    }
    if (!rel) throw new Error(`Unresolved API router mount: ${line.trim()}`);
    (mounts[rel] ||= []).push({ prefix, middlewareList });
  }

  const runtimeRouters = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && fs.readFileSync(full, 'utf8').includes('express.Router(')) {
        runtimeRouters.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.join(ROOT, 'routes'));
  const unmounted = runtimeRouters.filter((rel) => !mounts[rel]);
  if (unmounted.length) throw new Error(`Runtime router missing from app.js mount inventory: ${unmounted.join(', ')}`);
  return mounts;
}

const ROUTER_MOUNTS = loadRouterMounts();

function loadAccessPatterns(constName) {
  const source = fs.readFileSync(path.join(ROOT, 'middleware', 'accessBoundary.js'), 'utf8');
  const re = new RegExp(String.raw`const\s+${constName}\s*=\s*Object\.freeze\((\[[\s\S]*?\])\);`);
  const match = source.match(re);
  if (!match) throw new Error(`Cannot locate ${constName} in middleware/accessBoundary.js`);
  const patterns = vm.runInNewContext(match[1], Object.create(null), { timeout: 100 });
  if (!Array.isArray(patterns) || patterns.some((item) => Object.prototype.toString.call(item) !== '[object RegExp]')) {
    throw new Error(`${constName} must remain an array of RegExp values`);
  }
  return patterns;
}

const ANONYMOUS_PATTERNS = loadAccessPatterns('ANONYMOUS_ENTRY_API_PATHS');
const TELEGRAM_PROOF_PATTERNS = loadAccessPatterns('TELEGRAM_PROOF_API_PATHS');
const CONTEXT_PROOF_PATTERNS = loadAccessPatterns('CONTEXT_PROOF_API_PATHS');
const BROWSER_PROOF_PATTERNS = loadAccessPatterns('BROWSER_PROOF_API_PATHS');
const SERVICE_PATTERNS = loadAccessPatterns('SERVICE_TOKEN_API_PATHS');

function matchesAccess(patterns, url) {
  return patterns.some((pattern) => pattern.test(url));
}

function isAnonymousUrl(url) {
  return matchesAccess(ANONYMOUS_PATTERNS, url);
}

function isProofOnlyUrl(url) {
  return matchesAccess(TELEGRAM_PROOF_PATTERNS, url)
    || matchesAccess(CONTEXT_PROOF_PATTERNS, url)
    || matchesAccess(BROWSER_PROOF_PATTERNS, url);
}

function isServiceUrl(url) {
  return matchesAccess(SERVICE_PATTERNS, url);
}

function rolesAcceptedBy(predicate) {
  return ROLES.filter((role) => role !== 'anonymous' && predicate({ role }));
}

const ALIASES = {
  staffOnly: ['warehouse', 'admin'],
  warehouseRoles: ['warehouse', 'admin'],
  sellerOnly: ['seller', 'admin'],
  sellerRoles: ['seller', 'admin'],
  adminOnly: ['admin'],
  registeredOnly: ['seller', 'warehouse', 'admin'],
  anyRole: ['seller', 'warehouse', 'admin'],
  nextTaskRoleGuard: ['warehouse', 'admin'],
  // Resolve custom guard semantics from their exported predicates so this
  // inventory cannot silently drift from the actual implementation again.
  requireMarketplaceWarehouseAccess: rolesAcceptedBy(hasMarketplaceWarehouseAccess),
  requireBaseLinkerPickingAccess: rolesAcceptedBy(hasBaseLinkerPickingAccess),
  requireAgentToken: [],
};

function joinUrl(prefix, routePath) {
  if (routePath === '/') return prefix;
  return `${prefix}${routePath.startsWith('/') ? '' : '/'}${routePath}`.replace(/\/{2,}/g, '/');
}

function routePathFromExpression(expression) {
  const value = expression.trim();
  const quoted = value.match(/^(['"])(.*?)\1$/);
  if (quoted) return quoted[2];
  if (value === 'pickingPrefix') return '/accounts/:accountId/orders/:orderId/picking';
  if (value.startsWith('`${pickingPrefix}')) {
    return value.slice(2, -1).replace('${pickingPrefix}', '/accounts/:accountId/orders/:orderId/picking');
  }
  throw new Error(`Unresolved route path expression: ${value}`);
}

function explicitRoles(declaration) {
  const one = declaration.match(/requireTelegramRole\(\s*['"]([^'"]+)['"]\s*\)/);
  if (one) return [one[1]].filter((role) => ROLES.includes(role));
  const many = declaration.match(/requireTelegramRoles\(\s*\[([^\]]+)\]\s*\)/);
  if (many) {
    return [...many[1].matchAll(/['"]([^'"]+)['"]/g)]
      .map((match) => match[1]).filter((role) => ROLES.includes(role));
  }
  for (const [alias, roles] of Object.entries(ALIASES)) {
    if (new RegExp(`(?:,|\\(|\\.\\.\\.)\\s*${alias}(?:\\s*,|\\s*\\))`).test(declaration)) return roles;
  }
  return null;
}

function intersectRoles(left, right) {
  return left.filter((role) => right.includes(role));
}

function routerWideRoles(lines) {
  let roles = null;
  for (const line of lines) {
    if (!/router\.use\s*\(/.test(line)) continue;
    const boundary = explicitRoles(line);
    if (boundary === null) continue;
    roles = roles === null ? boundary : intersectRoles(roles, boundary);
  }
  return roles;
}

function assertSupportedRouteSyntax(source, owner) {
  const unsupported = source.match(/\b(?:app|router)\.(?:all|head|options|route)\s*\(/);
  if (unsupported) throw new Error(`Unsupported route declaration ${unsupported[0]} in ${owner}`);
}

function sourceNote(rel, endpoint, declaration) {
  const url = endpoint.slice(endpoint.indexOf(' ') + 1);
  if (isAnonymousUrl(url)) return 'explicit auth/check entry; route-specific credential/state/rate limits may still apply';
  if (isProofOnlyUrl(url)) return 'first-party session proof required before route; pre-registration/browser probe path';
  if (rel === 'routes/baseLinkerPrintAgent.js' || isServiceUrl(url)) return 'Print Agent token, not a user role';
  if (rel === 'routes/warehouseTest.js') return 'admin and ENABLE_TEST_API outside production';
  if (rel === 'routes/baseLinker.js' || rel === 'routes/allegro.js' || rel === 'routes/commerce.js') {
    return 'provider-worker boundary; among these four roles only admin passes (baselinker is outside the table)';
  }
  if (rel === 'routes/orders.js') return 'route entry only; ownership/shop/session checks run in handler';
  if (rel === 'routes/shops.js') return 'route entry only; response projection may vary by role';
  if (rel === 'routes/picking.js' && endpoint.endsWith('/session-status')) return 'seller is additionally restricted to own authoritative delivery group';
  return 'route-entry authorization';
}

function collectRouterRoutes() {
  const rows = [];
  for (const [rel, mounts] of Object.entries(ROUTER_MOUNTS)) {
    const full = path.join(ROOT, rel);
    const source = fs.readFileSync(full, 'utf8');
    assertSupportedRouteSyntax(source, rel);
    const lines = source.split(/\r?\n/);
    const routerRoles = routerWideRoles(lines);
    let declarations = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(/router\.(get|post|put|patch|delete)\((.+?),\s*/i);
      if (!match) continue;
      declarations += 1;
      const method = match[1].toUpperCase();
      const routePath = routePathFromExpression(match[2]);
      for (const { prefix, middlewareList } of mounts) {
        const url = joinUrl(prefix, routePath);
        const endpoint = `${method} ${url}`;
        const routeRoles = explicitRoles(line);
        const mountRoles = explicitRoles(middlewareList);
        let roles = isAnonymousUrl(url) ? ROLES : ['seller', 'warehouse', 'admin'];
        if (isServiceUrl(url)) roles = [];
        if (isProofOnlyUrl(url)) roles = ['seller', 'warehouse', 'admin'];
        if (routerRoles !== null) roles = intersectRoles(roles, routerRoles);
        if (mountRoles !== null) roles = intersectRoles(roles, mountRoles);
        if (routeRoles !== null) roles = intersectRoles(roles, routeRoles);
        rows.push({ endpoint, rel, line: index + 1, roles, note: sourceNote(rel, endpoint, line) });
      }
    }
    const syntacticDeclarations = [...source.matchAll(/\brouter\.(?:get|post|put|patch|delete)\s*\(/g)].length;
    if (declarations !== syntacticDeclarations) {
      throw new Error(`Unclassified route declaration in ${rel}: classified ${declarations}/${syntacticDeclarations}`);
    }
  }
  return rows;
}

function collectAppRoutes() {
  const appSource = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assertSupportedRouteSyntax(appSource, 'app.js');
  const source = appSource.split(/\r?\n/);
  const rows = [];
  let declarations = 0;
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    const match = line.match(/app\.(get|post|put|patch|delete)\((.+?),\s*/i);
    if (!match) continue;
    declarations += 1;
    if (match[2].trim() === 'wh.path') continue;
    const method = match[1].toUpperCase();
    const url = routePathFromExpression(match[2]);
    const endpoint = `${method} ${url}`;
    let roles = explicitRoles(line) || ['seller', 'warehouse', 'admin'];
    if (isAnonymousUrl(url)) roles = ROLES;
    if (isServiceUrl(url)) roles = [];
    if (isProofOnlyUrl(url)) roles = ['seller', 'warehouse', 'admin'];
    rows.push({ endpoint, rel: 'app.js', line: index + 1, roles, note: sourceNote('app.js', endpoint, line) });
  }
  rows.push({
    endpoint: 'POST /telegram-webhook/<token-derived-path>', rel: 'app.js', line: 73,
    roles: [], note: 'Telegram secret-token header + token-derived path; machine-authenticated, no app user role',
  });
  const syntacticDeclarations = [...appSource.matchAll(/\bapp\.(?:get|post|put|patch|delete)\s*\(/g)].length;
  if (declarations !== syntacticDeclarations) {
    throw new Error(`Unclassified route declaration in app.js: classified ${declarations}/${syntacticDeclarations}`);
  }
  return rows;
}

function collectStaticSurfaces() {
  return [
    {
      endpoint: 'GET/HEAD /uploads/*', rel: 'app.js', line: 55,
      roles: ['warehouse', 'admin'], note: 'authenticated legacy static uploads',
    },
    {
      endpoint: 'GET/HEAD /warehouse-test/*', rel: 'app.js', line: 111,
      roles: ['admin'], note: 'admin-authenticated static test UI; only mounted outside production with ENABLE_TEST_API=true',
    },
  ];
}

function render(rows) {
  const counts = Object.fromEntries(ROLES.map((role) => [role, rows.filter((row) => row.roles.includes(role)).length]));
  const lines = [
    '# Endpoint × role inventory — 2026-09-13', '',
    'This is a complete inventory of runtime Express route declarations, discovered router mounts, and static surfaces.',
    'A check mark means that the role passes the route-entry auth/role middleware. Resource ownership, shop/group/session',
    'scope, one-time tokens, rate limits, feature flags, and request validation can still deny a request as noted.', '',
    `Routes: **${rows.length}** · anonymous: **${counts.anonymous}** · seller: **${counts.seller}** · warehouse: **${counts.warehouse}** · admin: **${counts.admin}**`, '',
    '| Endpoint | Anonymous | Seller | Warehouse | Admin | Source | Boundary note |',
    '|---|:---:|:---:|:---:|:---:|---|---|',
  ];
  for (const row of rows) {
    const cells = ROLES.map((role) => row.roles.includes(role) ? '✓' : '—');
    lines.push(`| \`${row.endpoint}\` | ${cells.join(' | ')} | \`${row.rel}:${row.line}\` | ${row.note} |`);
  }
  lines.push('', '## Coverage contract', '',
    'Run `npm run test:security:endpoint-matrix`. The check re-scans every `app.METHOD` and `router.METHOD` declaration,',
    'rebuilds this table, and fails if a route, mount, role guard, or source line changes without an explicit review.', '',
    'The conditional warehouse-test router/static UI are included even though production cannot mount them. The Telegram',
    'webhook and Print Agent endpoints are listed, but their non-user credentials are intentionally not treated as user roles.',
    'The separate `baselinker` provider-worker role is deliberately outside this requested four-role table.', '');
  return lines.join('\n');
}

function run({ write = false } = {}) {
  const rows = [...collectAppRoutes(), ...collectRouterRoutes(), ...collectStaticSurfaces()]
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.rel.localeCompare(b.rel));
  const duplicate = rows.find((row, index) => index > 0
    && row.endpoint === rows[index - 1].endpoint && row.rel === rows[index - 1].rel);
  if (duplicate) throw new Error(`Duplicate inventory row: ${duplicate.endpoint} (${duplicate.rel})`);
  const markdown = render(rows);
  if (write) fs.writeFileSync(OUTPUT, markdown, 'utf8');
  else if (!fs.existsSync(OUTPUT) || fs.readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== markdown) {
    throw new Error('Endpoint role inventory is stale; review routes and run with --write');
  }
  console.log(`Endpoint role inventory: ${rows.length}/${rows.length} HTTP surfaces classified`);
  return rows;
}

if (require.main === module) {
  try { run({ write: process.argv.includes('--write') }); }
  catch (error) { console.error(`FAIL ${error.message}`); process.exitCode = 1; }
}

module.exports = { run };

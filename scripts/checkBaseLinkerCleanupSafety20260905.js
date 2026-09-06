'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const shared = read('scripts/_cleanupBaseLinkerDb.js');
const test = read('scripts/cleanupBaseLinkerDb.TEST.js');
const prod = read('scripts/cleanupBaseLinkerDb.PROD.js');

const checks = [];
function check(ok, name) {
  checks.push([Boolean(ok), name]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}

check(test.includes("runCleanup('TEST')"), 'TEST wrapper is fixed to TEST mode');
check(prod.includes("runCleanup('PROD')"), 'PROD wrapper is fixed to PROD mode');
check(shared.includes('TEST_ENV_LOADED is missing'), 'TEST requires TEST_ENV_LOADED');
check(shared.includes('assertEnvUriAllowed(uri)'), 'TEST verifies env URI with liveE2EDbGuard');
check(shared.includes('assertConnectedHostAllowed(connectedHost)'), 'TEST verifies connected host with liveE2EDbGuard');
check(shared.includes('REFUSE PROD cleanup: TEST_ENV_LOADED is present'), 'PROD refuses TEST preload');
check(shared.includes('matches TEST guard suffix'), 'PROD refuses TEST Atlas host');
check(shared.includes("argValue('--confirm-db')"), 'execute requires exact database name');
check(shared.includes('WIPE_BASELINKER_PROD'), 'PROD requires explicit destructive acknowledgement');
check(shared.includes('if (!EXECUTE)'), 'cleanup is dry-run by default');
check(shared.includes('baselinker.queueSettings.v1'), 'queue status settings are wiped');
check(shared.includes('baselinker.orderIndex.v1'), 'minimal order index state is wiped');
check(shared.includes('baselinker.orderCache.v2'), 'retired mirror state is wiped during migration cleanup');
check(shared.includes('baselinker.journal.v1'), 'retired journal state is wiped during migration cleanup');
check(shared.includes('BaseLinkerOrderIndex'), 'minimal order_id index is wiped');
check(shared.includes('BaseLinkerPickingOrder'), 'picking state is wiped');
check(shared.includes('BaseLinkerPrintJob'), 'print jobs are wiped');
check(shared.includes('BaseLinkerPrintAgent'), 'ephemeral print-agent registrations are wiped');
check(shared.includes("'baselinkerordercaches'"), 'retired full-order mirror collection is explicitly wiped');
check(shared.includes("'baselinkerordersnapshots'"), 'retired raw-snapshot collection is explicitly wiped');
check(!shared.includes("require('../models/BaseLinkerOrderCache')"), 'cleanup does not require retired full-order model');
check(!shared.includes("require('../models/BaseLinkerOrderSnapshot')"), 'cleanup does not require retired snapshot model');
check(shared.includes('await model.syncIndexes()'), 'current single-account indexes are synchronized after wipe');
check(shared.includes('verifyEmpty(db)'), 'post-wipe emptiness is verified');
check(String(pkg.scripts['cleanup:baselinker:test'] || '').includes('-r ../dev-use-test-db.js'), 'npm TEST alias uses the standard test DB preload');
check(String(pkg.scripts['cleanup:baselinker:prod'] || '') === 'node scripts/cleanupBaseLinkerDb.PROD.js', 'npm PROD alias cannot preload TEST env');

const failed = checks.filter(([ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) process.exit(1);

'use strict';

const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const serverPaused = argv.includes('--server-paused') || process.env.LIVE_E2E_EXTERNAL_SERVER_PAUSED === '1';
if (!serverPaused) {
  console.error('⛔ V48.18 live release gate requires the deployed TEST server/schedulers to be paused.');
  console.error('   Re-run with --server-paused only after you have actually stopped the external TEST server,');
  console.error('   or set LIVE_E2E_EXTERNAL_SERVER_PAUSED=1 in this one test shell.');
  process.exit(2);
}

const steps = [
  ['preflight-before', 'test:live:e2e:preflight'],
  ['real-server-boot', 'test:live:boot:v48.18'],
  ['schedule-guard', 'test:v35:guard'],
  ['receipt', 'test:live:receipt'],
  ['contracts-full', 'test:live:contracts:full'],
  ['race', 'test:live:race'],
  ['mass', 'test:live:e2e:mass'],
  ['preflight-after', 'test:live:e2e:preflight'],
];

for (const [label, script] of steps) {
  console.log(`\n${'='.repeat(88)}\nV48.18 LIVE GATE: ${label} (${script})\n${'='.repeat(88)}`);
  const isWindows = process.platform === 'win32';
  const result = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', script], {
    stdio: 'inherit',
    env: process.env,
    // Node >= 18.20/20.12 refuses to spawn .cmd without a shell (EINVAL, the
    // CVE-2024-27980 hardening). Script names here are fixed literals, so there
    // is nothing user-controlled to quote/inject.
    shell: isWindows,
  });
  if (result.status !== 0) {
    console.error(`\n❌ V48.18 LIVE GATE stopped at ${label}: exit=${result.status ?? 'unknown'}`);
    process.exit(result.status || 1);
  }
}

console.log('\n✅ V48.18 LIVE RELEASE GATE PASS — every live suite ran sequentially and final preflight is clean.');

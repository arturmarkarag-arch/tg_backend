'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const instrument = read('instrument.js');
const app = read('app.js');
const index = read('index.js');

const checks = [
  ['Sentry error SDK remains initialized', instrument.includes('Sentry.init({') && instrument.includes('beforeSend: scrubServerEvent')],
  ['Express error handler remains mounted', app.includes('Sentry.setupExpressErrorHandler(app);')],
  ['startup failures still go to Sentry', index.includes('Sentry.captureException(error);')],
  ['performance sample rate removed', !instrument.includes('tracesSampleRate') && !instrument.includes('tracesSampler')],
  ['performance env cannot silently re-enable tracing', !instrument.includes('SENTRY_TRACES_SAMPLE_RATE')],
  ['profiling is not enabled', !instrument.includes('profilesSampleRate') && !instrument.includes('profileSessionSampleRate')],
  ['Sentry logs are not enabled', !/enableLogs\s*:\s*true/.test(instrument)],
  ['transactions fail closed if tracing is reintroduced accidentally', instrument.includes('beforeSendTransaction: () => null')],
  ['PII scrubbing remains enabled', instrument.includes('sendDefaultPii: false') && instrument.includes('event.request.data = undefined')],
];

let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} - ${label}`);
  if (!pass) failed += 1;
}
console.log(`Sentry backend errors-only contract 2026-09-12: ${checks.length - failed}/${checks.length} PASS`);
if (failed) process.exitCode = 1;

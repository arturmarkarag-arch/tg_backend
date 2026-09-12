'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const monitor = read('services/egressTrafficMonitor.js');
const app = read('app.js');
const index = read('index.js');
const admin = read('routes/admin.js');
const model = read('models/EgressTrafficSample.js');

function check(condition, message) {
  if (!condition) {
    console.error(`❌ ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${message}`);
  }
}

check(monitor.includes('net.Socket.prototype.connect'), 'transport observer hooks outbound sockets globally');
check(monitor.includes('socket.bytesWritten'), 'long-lived socket bytes are sampled from bytesWritten');
check(monitor.includes('installHttpRequestHook(http') && monitor.includes('installHttpRequestHook(https'), 'HTTP/HTTPS endpoint metadata is automatic');
check(monitor.includes('installFetchHook()'), 'global fetch endpoint metadata is automatic');
check(monitor.includes("split('?')[0]"), 'query strings are removed before persistence');
check(!/authorization|cookie|api[_-]?key|tokenEncrypted/i.test(monitor), 'monitor does not persist auth-specific fields');
check(!/base\s*linker|allegro|gemini|openai|telegram/i.test(monitor), 'monitor has no provider allowlist/registry');
check(index.indexOf('installEgressTrafficMonitor();') < index.indexOf("require('./app')"), 'observer installs before app/services load');
check(index.includes('startEgressTrafficPersistence();'), 'aggregated metrics persistence starts after Mongo connect');
check(app.includes('app.use(egressRequestContextMiddleware);'), 'inbound route context is captured automatically');
check(admin.includes("router.get('/egress-traffic'"), 'admin read endpoint exists');
check(admin.includes("requireTelegramRole('admin')"), 'traffic endpoint stays admin-only');
check(model.includes("expires: 0"), 'metrics have TTL retention');

if (process.exitCode) process.exit(process.exitCode);
console.log('\nEGRESS TRAFFIC MONITOR STATIC GATE: PASS');

'use strict';

/**
 * V48.18 real-process boot smoke.
 *
 * Unlike the ordinary live harness (which requires ../app in-process), this
 * starts the real server/index.js in a CHILD PROCESS against a unique temporary
 * database on the TEST Atlas host. It proves that production boot wiring itself
 * starts server-owned session materialisation and picking maintenance without a
 * Mini App request. The temporary database is dropped in finally.
 *
 * Safe default: preflight only. Execute only through the TEST DB preload:
 *   npm run test:live:boot:v48.18
 */

const crypto = require('crypto');
const http = require('http');
const { spawn } = require('child_process');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const {
  assertEnvUriAllowed,
  assertConnectedHostAllowed,
  maskMongoUri,
} = require('../utils/liveE2EDbGuard');
const { buildOpenClosedTestSchedules } = require('./helpers/perGroupTestSchedule');
const { fetchWithTimeout, sleep } = require('./helpers/liveHarnessSafety');

const EXECUTE = process.argv.includes('--execute');
const SOURCE_URI = String(process.env.MONGODB_URI || '').trim();
if (!SOURCE_URI) {
  console.error('❌ MONGODB_URI не заданий');
  process.exit(2);
}
try { assertEnvUriAllowed(SOURCE_URI); }
catch (err) { console.error(`⛔ ${err.message}`); process.exit(3); }

const RUN_ID = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;

const MULTI_WORKER_REFUSAL_TIMEOUT_MS = 45_000; // require/load budget on slower Windows hosts; still fails true hangs
const DB_NAME = `e2e_boot_${RUN_ID.replace(/-/g, '_')}`;
const MARKER = `__BOOT_E2E__${RUN_ID}`;

function uriWithDatabase(uri, dbName) {
  const match = String(uri).match(/^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/[^?]*)?(\?.*)?$/i);
  if (!match) throw new Error('Cannot safely derive temporary Mongo database URI');
  return `${match[1]}/${encodeURIComponent(dbName)}${match[2] || ''}`;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}


function enginePackets(payload) {
  return String(payload || '').split('\x1e').filter(Boolean);
}

async function socketPollingOpen(baseUrl, token) {
  const openUrl = `${baseUrl}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`;
  const openRes = await fetchWithTimeout(openUrl, {}, { timeoutMs: 3_000, label: 'Socket.IO polling open' });
  const openBody = await openRes.text();
  if (!openRes.ok || !openBody.startsWith('0{')) throw new Error(`Socket.IO polling open failed: status=${openRes.status} body=${openBody.slice(0, 160)}`);
  const handshake = JSON.parse(openBody.slice(1));
  if (!handshake?.sid) throw new Error('Socket.IO polling open returned no sid');
  const pollUrl = `${baseUrl}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(handshake.sid)}`;
  const connectRes = await fetchWithTimeout(pollUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: `40${JSON.stringify({ token })}`,
  }, { timeoutMs: 3_000, label: 'Socket.IO authenticated connect packet' });
  if (!connectRes.ok) throw new Error(`Socket.IO connect POST failed: status=${connectRes.status}`);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const poll = await fetchWithTimeout(`${pollUrl}&t=${Date.now()}`, {}, { timeoutMs: 3_000, label: 'Socket.IO connect ack poll' });
    const body = await poll.text();
    for (const packet of enginePackets(body)) {
      if (packet.startsWith('40')) return { pollUrl, sid: handshake.sid };
      if (packet.startsWith('44')) throw new Error(`Socket.IO authentication rejected: ${packet.slice(2)}`);
    }
  }
  throw new Error('Socket.IO authenticated namespace connect ack not received');
}

async function socketPollingSend(socket, packet, label) {
  const res = await fetchWithTimeout(socket.pollUrl, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: packet,
  }, { timeoutMs: 3_000, label });
  if (!res.ok) throw new Error(`${label} failed: status=${res.status}`);
}

async function socketPollingWaitEvent(socket, eventName, predicate = () => true, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await fetchWithTimeout(`${socket.pollUrl}&t=${Date.now()}`, {}, { timeoutMs: Math.min(3_000, Math.max(250, deadline - Date.now())), label: `Socket.IO wait ${eventName}` });
    const body = await poll.text();
    for (const packet of enginePackets(body)) {
      // Engine.IO ping. Keep the polling transport healthy while waiting.
      if (packet === '2') {
        await socketPollingSend(socket, '3', 'Socket.IO pong');
        continue;
      }
      if (!packet.startsWith('42')) continue;
      let decoded = null;
      try { decoded = JSON.parse(packet.slice(2)); } catch { continue; }
      if (Array.isArray(decoded) && decoded[0] === eventName && predicate(decoded[1])) return decoded[1];
    }
  }
  throw new Error(`Socket.IO event ${eventName} not received within ${timeoutMs}ms`);
}

async function waitUntil(fn, { timeoutMs = 30_000, intervalMs = 200, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) { lastError = err; }
    await sleep(intervalMs);
  }
  throw new Error(`${label} not reached within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function waitChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(timeoutMs).then(() => false),
  ]);
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  if (await waitChildExit(child, 8_000)) return;
  child.kill('SIGKILL');
  await waitChildExit(child, 3_000);
}

async function assertMultiWorkerWithoutRedisRefused({ bootUri, port }) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: require('path').resolve(__dirname, '..'),
    env: {
      ...process.env, MONGODB_URI: bootUri, PORT: String(port), NODE_ENV: 'production',
      WEB_CONCURRENCY: '2', REDIS_URL: '', TELEGRAM_BOT_TOKEN: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '',
      JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = await waitChildExit(child, MULTI_WORKER_REFUSAL_TIMEOUT_MS);
  if (!exited) { await stopChild(child); throw new Error('WEB_CONCURRENCY=2 without Redis did not fail within boot budget'); }
  if (child.exitCode === 0) throw new Error('WEB_CONCURRENCY=2 without Redis booted successfully; expected refusal');
  console.log('✅ real index.js refuses WEB_CONCURRENCY>1 without Redis');
}

async function main() {
  const bootUri = uriWithDatabase(SOURCE_URI, DB_NAME);
  console.log(`V48.18 REAL SERVER BOOT · run=${RUN_ID}`);
  console.log(`TEST host guard: ${maskMongoUri(SOURCE_URI)}`);
  console.log(`Temporary DB: ${DB_NAME}`);
  if (!EXECUTE) {
    console.log('PREFLIGHT ONLY — no temporary DB created. Add --execute via npm script to run real index.js boot smoke.');
    return;
  }

  let child = null;
  let stdout = '';
  let stderr = '';
  const bootMongoose = new mongoose.Mongoose();
  try {
    await bootMongoose.connect(bootUri, {
      serverSelectionTimeoutMS: 15_000,
      socketTimeoutMS: 30_000,
      autoIndex: false,
    });
    assertConnectedHostAllowed(bootMongoose.connection.host);

    const { openSchedule, deliveryDay } = buildOpenClosedTestSchedules(new Date());
    const now = new Date();
    const groupId = new mongoose.Types.ObjectId();
    await bootMongoose.connection.db.collection('deliverygroups').insertOne({
      _id: groupId,
      name: `${MARKER}-GROUP`,
      dayOfWeek: deliveryDay,
      orderingSchedule: openSchedule,
      createdAt: now,
      updatedAt: now,
    });

    const shopId = new mongoose.Types.ObjectId();
    const adminTelegramId = `${MARKER}-ADMIN`;
    await bootMongoose.connection.db.collection('shops').insertOne({
      _id: shopId,
      name: `${MARKER}-SHOP`,
      address: 'BOOT E2E',
      deliveryGroupId: String(groupId),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
    await bootMongoose.connection.db.collection('users').insertOne({
      _id: new mongoose.Types.ObjectId(),
      telegramId: adminTelegramId,
      firstName: 'BOOT',
      lastName: 'E2E',
      role: 'admin',
      shopId,
      botBlocked: false,
      createdAt: now,
      updatedAt: now,
    });

    const staleTaskId = new mongoose.Types.ObjectId();
    await bootMongoose.connection.db.collection('pickingtasks').insertOne({
      _id: staleTaskId,
      productId: new mongoose.Types.ObjectId(),
      deliveryGroupId: String(groupId),
      orderingSessionId: `${MARKER}-STALE-SESSION`,
      blockId: 1,
      positionIndex: 0,
      status: 'locked',
      lockedBy: `${MARKER}-WORKER`,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000),
      items: [],
      createdAt: now,
      updatedAt: now,
    });

    const refusalPort = await reservePort();
    await assertMultiWorkerWithoutRedisRefused({ bootUri, port: refusalPort });

    const port = await reservePort();
    const jwtSecret = crypto.randomBytes(48).toString('hex');
    const env = {
      ...process.env,
      MONGODB_URI: bootUri,
      PORT: String(port),
      NODE_ENV: 'production',
      WEB_CONCURRENCY: '1',
      REDIS_URL: '',
      TELEGRAM_BOT_TOKEN: '',
      OPENAI_API_KEY: '',
      GEMINI_API_KEY: '',
      JWT_SECRET: jwtSecret,
    };

    child = spawn(process.execPath, ['index.js'], {
      cwd: require('path').resolve(__dirname, '..'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); process.stdout.write(`[boot] ${chunk}`); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); process.stderr.write(`[boot:err] ${chunk}`); });

    await waitUntil(async () => {
      if (child.exitCode != null) throw new Error(`server/index.js exited early with ${child.exitCode}: ${stderr || stdout}`);
      try {
        const response = await fetchWithTimeout(`http://127.0.0.1:${port}/api/health`, {}, { timeoutMs: 2_000, label: 'real boot GET /api/health' });
        if (!response.ok) return false;
        const body = await response.json();
        return body?.status === 'ok';
      } catch { return false; }
    }, { timeoutMs: 45_000, intervalMs: 250, label: 'real server health' });

    const socketToken = jwt.sign({ sub: adminTelegramId }, jwtSecret, { expiresIn: '5m' });
    const socket = await socketPollingOpen(`http://127.0.0.1:${port}`, socketToken);
    await socketPollingSend(socket, `42${JSON.stringify(['join_picking_group', String(groupId)])}`, 'Socket.IO join picking group');

    const session = await waitUntil(
      () => bootMongoose.connection.db.collection('orderingsessions').findOne({ groupId: String(groupId) }),
      { timeoutMs: 15_000, label: 'server-owned OrderingSession materialisation' },
    );
    if (!session?._id) throw new Error('OrderingSession was not materialised by real server boot');

    const socketEventPromise = socketPollingWaitEvent(
      socket,
      'shop_status_changed',
      (payload) => String(payload?.groupId || '') === String(groupId),
      6_000,
    );
    const reviewed = await fetchWithTimeout(`http://127.0.0.1:${port}/api/delivery-groups/catalog-reviewed`, {
      method: 'POST',
      headers: { authorization: `Bearer ${socketToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ productCount: 0 }),
    }, { timeoutMs: 5_000, label: 'real boot POST catalog-reviewed socket trigger' });
    if (!reviewed.ok) throw new Error(`Socket trigger route failed: status=${reviewed.status} body=${(await reviewed.text()).slice(0, 160)}`);
    await socketEventPromise;

    const repairedTask = await waitUntil(async () => {
      const row = await bootMongoose.connection.db.collection('pickingtasks').findOne({ _id: staleTaskId });
      return row?.status === 'pending' && row?.lockedBy == null && row?.lockedAt == null ? row : null;
    }, { timeoutMs: 15_000, label: 'server-owned stale picking lock maintenance' });
    if (!repairedTask) throw new Error('Picking maintenance did not release stale lock');

    const [sessionIndexes, taskIndexes] = await Promise.all([
      bootMongoose.connection.db.collection('orderingsessions').indexes(),
      bootMongoose.connection.db.collection('pickingtasks').indexes(),
    ]);
    const sessionUnique = sessionIndexes.some((idx) => idx.unique && idx.key?.groupId === 1 && idx.key?.openDate === 1);
    const taskUnique = taskIndexes.some((idx) => idx.name === 'one_active_task_per_product_group_session' && idx.unique);
    if (!sessionUnique) throw new Error('Real boot did not establish OrderingSession groupId+openDate unique index');
    if (!taskUnique) throw new Error('Real boot did not establish critical PickingTask unique index');

    console.log('✅ real index.js health reached without Mini App traffic');
    console.log('✅ authenticated Socket.IO room receives a real HTTP-triggered group event');
    console.log('✅ ordering scheduler materialised current OrderingSession on server boot');
    console.log('✅ picking maintenance scheduler released stale lock on server boot');
    console.log('✅ critical OrderingSession/PickingTask indexes exist after real boot');
  } finally {
    await stopChild(child).catch(() => {});
    if (bootMongoose.connection.readyState) {
      try { await bootMongoose.connection.dropDatabase(); console.log(`🧹 dropped temporary DB ${DB_NAME}`); }
      catch (err) { console.error(`❌ failed to drop temporary DB ${DB_NAME}: ${err.message}`); process.exitCode = 1; }
      await bootMongoose.disconnect().catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(`💥 V48.18 real server boot failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});

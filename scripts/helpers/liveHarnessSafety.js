'use strict';

const crypto = require('crypto');

const GLOBAL_LOCK_KEY = 'live-e2e.global-lock';
const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_TTL_MS = 45 * 60 * 1000;
const DEFAULT_LOCK_HEARTBEAT_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseIntArg(argv, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const prefix = `--${name}=`;
  const raw = argv.find((arg) => arg.startsWith(prefix));
  if (!raw) return fallback;
  const value = Number(raw.slice(prefix.length));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Invalid --${name}: expected integer ${min}..${max}`);
  }
  return value;
}

function validateScenarioSelection(requestedScenarios, availableNames) {
  if (!requestedScenarios) return;
  if (requestedScenarios.size === 0) throw new Error('--scenario= must name at least one scenario');
  const available = new Set(availableNames);
  const unknown = [...requestedScenarios].filter((name) => !available.has(name));
  if (unknown.length) {
    throw new Error(`Unknown --scenario value(s): ${unknown.join(', ')}. Available: ${[...available].join(', ')}`);
  }
}

async function fetchWithTimeout(url, options = {}, {
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  label = `${options.method || 'GET'} ${url}`,
  parentSignal = null,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();
  const onParentAbort = () => controller.abort(parentSignal.reason || new Error(`${label} aborted by harness watchdog`));
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const message = reason?.message || `${label} aborted`;
      const wrapped = new Error(message);
      wrapped.cause = err;
      wrapped.code = reason?.code || 'LIVE_E2E_HTTP_TIMEOUT';
      throw wrapped;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
  }
}

function createProgressWatchdog({ name, stallMs = 120_000, onStall = null, exitOnStallCode = null } = {}) {
  const controller = new AbortController();
  let lastAt = Date.now();
  let phase = 'init';
  let detail = '';
  let stopped = false;

  const touch = (nextPhase = phase, nextDetail = '') => {
    phase = nextPhase || phase;
    detail = nextDetail || '';
    lastAt = Date.now();
  };

  const intervalMs = Math.min(5_000, Math.max(25, Math.floor(stallMs / 8)));
  const timer = setInterval(() => {
    if (stopped || controller.signal.aborted) return;
    const idleMs = Date.now() - lastAt;
    if (idleMs <= stallMs) return;
    const error = new Error(`${name || 'live harness'} made no progress for ${idleMs}ms (phase=${phase}${detail ? `, detail=${detail}` : ''})`);
    error.code = 'LIVE_E2E_STALLED';
    try { onStall?.({ error, idleMs, phase, detail }); } catch { /* diagnostic callback only */ }
    controller.abort(error);
    if (Number.isInteger(exitOnStallCode)) {
      // A hung DB/socket promise cannot be cancelled reliably from userland. For
      // destructive live harnesses the crash-safe run manifest is the recovery
      // mechanism, so force a deterministic non-zero exit instead of hanging
      // forever with a green-looking partial log.
      const exitTimer = setTimeout(() => process.exit(exitOnStallCode), 100);
      // Keep this timer referenced: it is the escape hatch from a stuck handle.
      void exitTimer;
    }
  }, intervalMs);
  timer.unref?.();

  return {
    signal: controller.signal,
    touch,
    assertHealthy() {
      if (controller.signal.aborted) throw controller.signal.reason || new Error(`${name || 'live harness'} watchdog aborted`);
    },
    snapshot() { return { lastAt, phase, detail, idleMs: Date.now() - lastAt }; },
    stop() { stopped = true; clearInterval(timer); },
  };
}

async function assertNoActiveGlobalHarnessLease({ AppSetting, exceptRunId = null } = {}) {
  if (!AppSetting) throw new Error('Global harness lease preflight requires AppSetting');
  const doc = await AppSetting.findOne({ key: GLOBAL_LOCK_KEY }).lean();
  const value = doc?.value || {};
  const owner = String(value.runId || '');
  const expiresAt = value.expiresAt ? new Date(value.expiresAt).getTime() : 0;
  if (owner && owner !== String(exceptRunId || '') && expiresAt > Date.now()) {
    throw new Error(
      `Another live harness is active: runId=${owner} kind=${value.kind || '?'} pid=${value.pid || '?'} ` +
      `expiresAt=${value.expiresAt || '?'}`
    );
  }
  return { active: false, owner: owner || null, expired: Boolean(owner && expiresAt <= Date.now()) };
}

async function acquireGlobalHarnessLease({
  AppSetting,
  runId,
  kind,
  ttlMs = DEFAULT_LOCK_TTL_MS,
  heartbeatMs = DEFAULT_LOCK_HEARTBEAT_MS,
}) {
  if (!AppSetting || !runId) throw new Error('Global harness lease requires AppSetting and runId');
  const now = new Date();
  const value = {
    runId,
    kind: kind || 'unknown',
    pid: process.pid,
    acquiredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  let acquired = null;
  try {
    acquired = await AppSetting.findOneAndUpdate(
      {
        key: GLOBAL_LOCK_KEY,
        $or: [
          { 'value.expiresAt': { $lte: now } },
          { 'value.runId': runId },
        ],
      },
      { $set: { value } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }

  if (!acquired || String(acquired.value?.runId || '') !== String(runId)) {
    const owner = await AppSetting.findOne({ key: GLOBAL_LOCK_KEY }).lean();
    const o = owner?.value || {};
    throw new Error(
      `Another live harness owns TEST Atlas: runId=${o.runId || '?'} kind=${o.kind || '?'} ` +
      `pid=${o.pid || '?'} expiresAt=${o.expiresAt || '?'}. Do not run destructive live suites in parallel.`,
    );
  }

  const heartbeat = setInterval(async () => {
    const beat = new Date();
    try {
      await AppSetting.updateOne(
        { key: GLOBAL_LOCK_KEY, 'value.runId': runId },
        {
          $set: {
            'value.heartbeatAt': beat.toISOString(),
            'value.expiresAt': new Date(beat.getTime() + ttlMs),
          },
        },
      );
    } catch { /* lease TTL remains the crash backstop */ }
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    key: GLOBAL_LOCK_KEY,
    async release() {
      clearInterval(heartbeat);
      await AppSetting.deleteOne({ key: GLOBAL_LOCK_KEY, 'value.runId': runId });
    },
  };
}

async function releaseGlobalHarnessLeaseIfOwned({ AppSetting, runId }) {
  if (!AppSetting || !runId) return;
  await AppSetting.deleteOne({ key: GLOBAL_LOCK_KEY, 'value.runId': runId });
}

async function waitForStableZero(countFn, {
  timeoutMs = 8_000,
  quietMs = 600,
  intervalMs = 100,
  label = 'cleanup leftovers',
  onNonZero = null,
} = {}) {
  const started = Date.now();
  let zeroSince = null;
  let last = null;
  while (Date.now() - started <= timeoutMs) {
    last = await countFn();
    const total = typeof last === 'number'
      ? last
      : Object.values(last || {}).reduce((sum, n) => sum + Number(n || 0), 0);
    if (total === 0) {
      if (zeroSince == null) zeroSince = Date.now();
      if (Date.now() - zeroSince >= quietMs) return last;
    } else {
      zeroSince = null;
      await onNonZero?.(last);
    }
    await sleep(intervalMs);
  }
  const error = new Error(`${label} did not stay at zero for ${quietMs}ms within ${timeoutMs}ms: ${JSON.stringify(last)}`);
  error.code = 'LIVE_E2E_CLEANUP_NOT_QUIET';
  throw error;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value._bsontype === 'ObjectId' || value.constructor?.name === 'ObjectId') return String(value);
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

async function fingerprintCollections(specs) {
  const output = {};
  for (const spec of specs) {
    const rows = await spec.model.find(spec.filter || {}, spec.projection || '_id updatedAt').sort({ _id: 1 }).lean();
    const normalized = canonical(rows);
    const serialized = JSON.stringify(normalized);
    output[spec.name] = {
      count: rows.length,
      sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    };
  }
  return output;
}

function compareFingerprints(before, after) {
  const names = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  return names
    .filter((name) => before?.[name]?.count !== after?.[name]?.count || before?.[name]?.sha256 !== after?.[name]?.sha256)
    .map((name) => ({ name, before: before?.[name] || null, after: after?.[name] || null }));
}

module.exports = {
  GLOBAL_LOCK_KEY,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_LOCK_TTL_MS,
  DEFAULT_LOCK_HEARTBEAT_MS,
  parseIntArg,
  validateScenarioSelection,
  fetchWithTimeout,
  createProgressWatchdog,
  assertNoActiveGlobalHarnessLease,
  acquireGlobalHarnessLease,
  releaseGlobalHarnessLeaseIfOwned,
  waitForStableZero,
  fingerprintCollections,
  compareFingerprints,
  sleep,
};

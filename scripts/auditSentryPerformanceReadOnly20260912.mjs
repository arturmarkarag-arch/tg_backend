import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

function loadDotEnvFile(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnvFile(path.resolve(serverRoot, '../.env'));

const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = argv.find((v) => v.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function dsnProjectId(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.at(-1) || '';
  } catch {
    return '';
  }
}

function sanitizeLabel(value) {
  let text = String(value ?? '');
  text = text.replace(/([?&](?:token|key|secret|signature|auth|code)=[^&#\s]+)/gi, ':redacted');
  text = text.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot:credential');
  text = text.replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\b/g, ':credential');
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function sanitizeRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row || {})) {
      out[k] = typeof v === 'string' ? sanitizeLabel(v) : v;
    }
    return out;
  });
}

const token = String(
  arg('token')
  || process.env.SENTRY_AUDIT_AUTH_TOKEN
  || process.env.SENTRY_AUTH_TOKEN
  || '',
).trim();
const org = String(arg('org') || process.env.SENTRY_ORG || '').trim();
const project = String(
  arg('project')
  || process.env.SENTRY_PROJECT
  || dsnProjectId(process.env.SENTRY_DSN)
  || '',
).trim();
const statsPeriod = String(arg('period') || process.env.SENTRY_AUDIT_STATS_PERIOD || '24h').trim();
const environment = String(arg('environment') || process.env.SENTRY_ENVIRONMENT || '').trim();

const report = {
  readOnly: true,
  measuredAt: new Date().toISOString(),
  source: 'Sentry Explore API',
  statsPeriod,
  org: org || null,
  project: project || null,
  environment: environment || null,
  notes: [
    'Only GET requests are used.',
    'Auth tokens are never printed.',
    'Rows are sanitized before output.',
    'Sentry tracing is sampled, so counts are observations, not exact total application request counts.',
  ],
  queries: {},
};

if (!token || !org || !project) {
  report.error = 'missing_sentry_api_context';
  report.required = {
    token: 'SENTRY_AUDIT_AUTH_TOKEN (preferred) or SENTRY_AUTH_TOKEN with org:read scope',
    org: 'SENTRY_ORG or --org=<slug>',
    project: 'SENTRY_PROJECT, --project=<slug-or-id>, or SENTRY_DSN containing project id',
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 2;
} else {
  const base = `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/events/`;

  async function query(name, fields, { sort = '', query = '' } = {}) {
    const u = new URL(base);
    u.searchParams.set('dataset', 'spans');
    u.searchParams.set('statsPeriod', statsPeriod);
    u.searchParams.set('project', project);
    u.searchParams.set('per_page', '100');
    if (environment) u.searchParams.append('environment', environment);
    if (query) u.searchParams.set('query', query);
    for (const field of fields) u.searchParams.append('field', field);
    if (sort) u.searchParams.set('sort', sort);

    const started = Date.now();
    try {
      const response = await fetch(u, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 1000) }; }
      if (!response.ok) {
        report.queries[name] = {
          ok: false,
          status: response.status,
          elapsedMs: Date.now() - started,
          error: sanitizeLabel(body?.detail || body?.error || body?.raw || response.statusText),
        };
        return;
      }
      report.queries[name] = {
        ok: true,
        status: response.status,
        elapsedMs: Date.now() - started,
        rows: sanitizeRows(body?.data || []),
        meta: body?.meta || null,
      };
    } catch (error) {
      report.queries[name] = {
        ok: false,
        status: 0,
        elapsedMs: Date.now() - started,
        error: sanitizeLabel(error?.message || error),
      };
    }
  }

  await query('transactionsByVolume', [
    'transaction',
    'count()',
    'avg(span.duration)',
    'p50(span.duration)',
    'p95(span.duration)',
    'p99(span.duration)',
    'failure_rate()',
  ], { sort: '-count()' });

  await query('transactionsByP95', [
    'transaction',
    'count()',
    'avg(span.duration)',
    'p95(span.duration)',
    'p99(span.duration)',
    'failure_rate()',
  ], { sort: '-p95(span.duration)' });

  await query('spanOperations', [
    'span.op',
    'count()',
    'avg(span.duration)',
    'p95(span.duration)',
    'p99(span.duration)',
    'sum(span.duration)',
  ], { sort: '-sum(span.duration)' });

  await query('slowSpanDescriptions', [
    'span.op',
    'span.description',
    'count()',
    'avg(span.duration)',
    'p95(span.duration)',
    'p99(span.duration)',
  ], { sort: '-p95(span.duration)' });

  const okCount = Object.values(report.queries).filter((q) => q.ok).length;
  const instrumentText = fs.readFileSync(path.join(serverRoot, 'instrument.js'), 'utf8');
  report.summary = {
    successfulQueries: okCount,
    failedQueries: Object.keys(report.queries).length - okCount,
    tracingCurrentlyConfiguredInSource: /tracesSampleRate|tracesSampler/.test(instrumentText),
    nextStep: /tracesSampleRate|tracesSampler/.test(instrumentText)
      ? 'Analyze this report before deploying the errors-only Sentry patch.'
      : 'Performance tracing is already disabled in this source tree.',
  };

  console.log(JSON.stringify(report, null, 2));
  if (okCount === 0) process.exitCode = 1;
}

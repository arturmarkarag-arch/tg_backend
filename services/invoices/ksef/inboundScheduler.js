'use strict';

const { runAsSchedulerLeader } = require('../../schedulerLeader');
const { recordOperationalEventBestEffort } = require('./operationalTelemetry');
const { FETCH_TICK_MS } = require('./inboundPolicy');
const { claimInboundSync, processInboundSyncClaim } = require('./inboundSync');
const { claimInboundDocument, processInboundDocumentClaim } = require('./inboundDocuments');
const { claimInboundExport, processInboundExportClaim } = require('./inboundExports');

const TICK_MS = Math.max(90_000, Number(process.env.KSEF_INBOUND_TICK_MS) || FETCH_TICK_MS);
let timer = null;

async function runKsefInboundTick() {
  return runAsSchedulerLeader('ksef-inbound-sync', async () => {
    const result = { metadata: null, export: null, document: null };
    const sync = await claimInboundSync('', new Date());
    if (sync) {
      try { result.metadata = await processInboundSyncClaim(sync); }
      catch (error) { result.metadata = { ok: false, syncId: sync.syncId, error: error?.code || 'ksef_inbound_sync_failed' }; }
    }
    const exportJob = await claimInboundExport('', new Date());
    if (exportJob) {
      try { result.export = await processInboundExportClaim(exportJob); }
      catch (error) { result.export = { ok: false, exportId: exportJob.exportId, error: error?.code || 'ksef_inbound_export_failed' }; }
    }
    const document = await claimInboundDocument('', new Date());
    if (document) result.document = await processInboundDocumentClaim(document);
    return result;
  }, { ttlMs: Math.max(30 * 60_000, 20 * TICK_MS) });
}

function startKsefInboundScheduler() {
  if (timer) return timer;
  if (String(process.env.KSEF_INBOUND_SYNC_ENABLED || 'true').toLowerCase() === 'false') return null;
  const tick = async () => {
    try { await runKsefInboundTick(); }
    catch (error) { console.error('[ksef-inbound-scheduler]', error?.stack || error); recordOperationalEventBestEffort({ kind: 'scheduler_error', severity: 'error', resourceType: 'inbound_scheduler', code: error?.code || 'ksef_inbound_scheduler_failed', message: error?.message || String(error) }); }
  };
  tick();
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  return timer;
}

function isKsefInboundSchedulerStarted() { return Boolean(timer); }

module.exports = { TICK_MS, runKsefInboundTick, startKsefInboundScheduler, isKsefInboundSchedulerStarted };

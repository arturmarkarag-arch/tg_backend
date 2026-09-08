const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const { sliceBetweenOrThrow } = require('./helpers/sourceContract');

describe('BaseLinker production lifecycle contract', () => {
  it('allows production only in configured Intake and keeps Release local', () => {
    const picking = read('services/baseLinkerPicking.js');
    expect(picking).toContain("if (disposition === 'intake') return disposition");
    expect(picking).toContain("appError('baselinker_order_not_in_intake'");
    const release = sliceBetweenOrThrow(
      picking,
      'async function releasePickingOrder',
      'async function markPickingOrderPacked',
      { label: 'releasePickingOrder' },
    );
    expect(release).not.toContain('verifyTrackedPickingOrderUpstream');
    expect(release).not.toContain('requireAccountEnabled');
  });

  it('materializes configured BaseLinker Sent as the terminal local Sent outcome', () => {
    const picking = read('services/baseLinkerPicking.js');
    const index = read('services/baseLinkerOrderIndex.js');
    expect(picking).toContain('upstream_sent_materialized');
    expect(picking).toContain("doc.status = ORDER_STATUS.SENT");
    expect(picking).toContain("doc.workflowStage = WORKFLOW_STAGE.SENT");
    expect(index).toContain("String(doc?.status || '') === 'sent'");
  });

  it('keeps Packed/Sent physical facts immutable when upstream changes', () => {
    const picking = read('services/baseLinkerPicking.js');
    const model = read('models/BaseLinkerPickingOrder.js');
    expect(picking).toContain('hasPhysicalWarehouseSnapshot');
    expect(picking).toContain('upstream_order_changed_after_fulfillment');
    expect(model).toContain('lastUpstreamOrderFingerprint');
    expect(picking).toContain("appError('baselinker_physical_fulfillment_immutable')");
  });

  it('treats Reviewed Cancelled as lifecycle terminal but unresolved review as blocker', () => {
    const lifecycle = read('services/baseLinkerAccountLifecycle.js');
    expect(lifecycle).toContain('{ upstreamReviewRequired: true }');
    expect(lifecycle).toContain("upstreamDisposition: { $ne: 'cancelled' }");
  });

  it('guards disable and queue-status edits with fresh lifecycle truth', () => {
    const lifecycle = read('services/baseLinkerAccountLifecycle.js');
    const queue = read('services/baseLinkerQueueScope.js');
    const admin = read('routes/admin.js');
    expect(lifecycle).toContain('async function refreshBaseLinkerLifecycleTruth');
    expect(lifecycle).toContain("trackedVerifiedAfter: verifiedAfter");
    expect(lifecycle).toContain('trackedReverifyPending');
    expect(lifecycle).toContain('LIFECYCLE_TRACKED_FRESH_MS');
    expect(lifecycle).toContain('LIFECYCLE_TRACKED_VERIFY_MAX');
    expect(lifecycle).toContain('withBaseLinkerAccountLifecycleLock');
    expect(admin).toContain('disableBaseLinkerAccount');
    expect(queue).toContain("assertBaseLinkerAccountLifecycleIdle(id, 'queue')");
    expect(queue).toContain('refreshBaseLinkerLifecycleTruth(id)');
    expect(queue).toContain('withBaseLinkerAccountLifecycleLock');
  });

  it('never purges unresolved upstream problems and retains terminal Sent/Cancelled correctly', () => {
    const retention = read('services/baseLinkerRetention.js');
    expect(retention).toContain("upstreamReviewRequired: { $ne: true }");
    expect(retention).toContain("lastUpstreamChangeAt: { $lt: cutoffDate }");
    const filter = sliceBetweenOrThrow(
      retention,
      'function terminalPickingCandidateFilter',
      'async function purgeVerifiedTerminalPickingForAccount',
      { label: 'terminalPickingCandidateFilter' },
    );
    expect(filter).toContain("status: 'sent'");
    expect(filter).toContain("{ upstreamDisposition: 'cancelled'");
  });

  it('keeps exact reconciliation running for tracked orders after Intake departure', () => {
    const index = read('services/baseLinkerOrderIndex.js');
    expect(index).toContain('async function reconcileTrackedOrderStatuses');
    expect(index).toContain('TRACKED_REVERIFY_LIMIT');
    expect(index).toContain('VISIBLE_TRACKED_REVERIFY_LIMIT');
    expect(index).toContain('reconcileTrackedOrderStatuses(scope, { force: forceReverify, verifiedAfter: trackedVerifiedAfter })');
    expect(index).toContain('forceReverify: force, trackedVerifiedAfter');
    expect(index).toContain('verifiedAfter: trackedVerifiedAfter');
  });

  it('keeps token rotation available and intentionally has no hard delete', () => {
    const admin = read('routes/admin.js');
    expect(admin).toContain("router.post('/baselinker-settings/accounts/:accountId/token'");
    expect(admin).not.toMatch(/router\.delete\(['"]\/baselinker-settings\/accounts/);
  });
});

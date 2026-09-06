const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker picking claim race guard', () => {
  it('uses accountId + exact orderId as the durable DB uniqueness boundary', () => {
    const model = read('models/BaseLinkerPickingOrder.js');
    expect(model).toContain('BaseLinkerPickingOrderSchema.index({ baseLinkerAccountId: 1, orderId: 1 }, { unique: true })');
    expect(model).not.toContain('BaseLinkerPickingOrderSchema.index({ orderId: 1 }, { unique: true })');
    expect(model).not.toContain('claimKey');
    expect(model).not.toContain('memberOrderIds');
    expect(model).not.toContain('groupKey');
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('BaseLinkerPickingOrder.createIndexes()');
    expect(service).toContain('await ensureClaimIndexReady()');
    expect(service).not.toContain('.syncIndexes()');
  });

  it('does not rely on read-then-save ownership checks for an existing order', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('claimAvailabilityFilter');
    expect(service).toContain('BaseLinkerPickingOrder.findOneAndUpdate(');
    expect(service).toContain('baseLinkerAccountId: accountId');
    expect(service).toContain('orderId: requestedId');
    expect(service).toContain('revision: Number(candidate.revision || 0)');
    expect(service).toContain('$inc: { revision: 1 }');
    expect(service).toContain('status: { $nin: TERMINAL_STATUSES }');
  });

  it('makes first-claim races converge through composite account/order uniqueness and duplicate-key retry', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('isDuplicateKeyError');
    expect(service).toContain('withLock(`baselinker-order:${accountId}:${requestedId}`');
    expect(service).toContain('candidate = await BaseLinkerPickingOrder.findOne({ baseLinkerAccountId: accountId, orderId: requestedId })');
    expect(service).toMatch(/if \(!isDuplicateKeyError\(error\)\) throw error/);
    expect(service).not.toContain('claimKeyForGroup');
    expect(service).not.toContain('findClaimCandidates');
  });

  it('allows only unowned, same-owner, stale-owner or explicit admin-force claims', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('{ ownerTelegramId: actor.by }');
    expect(service).toContain("{ ownerTelegramId: '' }");
    expect(service).toContain('lastActivityAt: { $lte: staleBefore }');
    expect(service).toContain("user?.role === 'admin' && force === true");
  });

  it('returns the existing picking_taken conflict to the losing worker', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain("appError('baselinker_picking_taken'");
    expect(service).toContain('ownerName: doc.ownerName ||');
    expect(service).toContain('takeoverAvailableAt');
  });
});

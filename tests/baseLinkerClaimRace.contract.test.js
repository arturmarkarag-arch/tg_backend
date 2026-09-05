const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker picking claim race guard', () => {
  it('uses accountScope + exact orderId as the durable DB uniqueness boundary', () => {
    const model = read('models/BaseLinkerPickingOrder.js');
    expect(model).toContain("BaseLinkerPickingOrderSchema.index({ accountScope: 1, orderId: 1 }, { unique: true })");
    expect(model).not.toContain('claimKey');
    expect(model).not.toContain('memberOrderIds');
    expect(model).not.toContain('groupKey');
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('.syncIndexes()');
    expect(service).toContain('await ensureClaimIndexReady()');
  });

  it('does not rely on read-then-save ownership checks for an existing order', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('claimAvailabilityFilter');
    expect(service).toContain('BaseLinkerPickingOrder.findOneAndUpdate(');
    expect(service).toContain('revision: Number(candidate.revision || 0)');
    expect(service).toContain('$inc: { revision: 1 }');
    expect(service).toContain('status: { $nin: TERMINAL_STATUSES }');
  });

  it('makes first-claim races converge through exact orderId uniqueness and duplicate-key retry', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('isDuplicateKeyError');
    expect(service).toContain('orderId: requestedId');
    expect(service).toMatch(/if \(!isDuplicateKeyError\(error\)\) throw error/);
    expect(service).toContain("candidate = await BaseLinkerPickingOrder.findOne({ orderId: requestedId })");
    expect(service).not.toContain('claimKeyForGroup');
    expect(service).not.toContain('findClaimCandidates');
  });

  it('allows only unowned, same-owner, stale-owner or explicit admin-force claims', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain("{ ownerTelegramId: actor.by }");
    expect(service).toContain("{ ownerTelegramId: '' }");
    expect(service).toContain("lastActivityAt: { $lte: staleBefore }");
    expect(service).toContain("user?.role === 'admin' && force === true");
  });

  it('returns the existing picking_taken conflict to the losing worker', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain("appError('baselinker_picking_taken'");
    expect(service).toContain('ownerName: doc.ownerName ||');
    expect(service).toContain('takeoverAvailableAt');
  });
});

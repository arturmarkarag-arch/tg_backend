const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker picking claim race guard', () => {
  it('has a DB-unique deterministic logical-order claim key', () => {
    const model = read('models/BaseLinkerPickingOrder.js');
    expect(model).toContain("claimKey: { type: String, default: undefined }");
    expect(model).toMatch(/index\(\{ claimKey: 1 \}, \{ unique: true, sparse: true \}\)/);
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('.createIndex({ claimKey: 1 }, { unique: true, sparse: true })');
    expect(service).toContain('await ensureClaimIndexReady()');
  });

  it('does not rely on read-then-save ownership checks', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('claimAvailabilityFilter');
    expect(service).toContain('BaseLinkerPickingOrder.findOneAndUpdate(');
    expect(service).toContain('revision: Number(candidate.revision || 0)');
    expect(service).toContain('$inc: { revision: 1 }');
    expect(service).toContain('status: { $nin: TERMINAL_STATUSES }');
  });

  it('makes first-claim races converge through the unique key and duplicate-key retry', () => {
    const service = read('services/baseLinkerPicking.js');
    expect(service).toContain('isDuplicateKeyError');
    expect(service).toContain('claimKeyForGroup(group.groupKey)');
    expect(service).toMatch(/if \(!isDuplicateKeyError\(error\)\) throw error/);
    expect(service).toContain('candidate = assertSingleClaimCandidate(await findClaimCandidates(group), group)');
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

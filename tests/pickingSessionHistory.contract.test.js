const fs = require('fs');
const path = require('path');

describe('V45 current-session worker task history contract', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('keeps the main shift-board roster small and current-session scoped', () => {
    const route = read('routes/picking.js');
    expect(route).toContain('sessionId = await findCurrentSessionId(dgId, group.orderingSchedule)');
    expect(route).toContain("const sessionScope = sessionId ? { orderingSessionId: sessionId } : { deliveryGroupId: '__no_current_session__' }");
    expect(route).toContain("PickingTask.distinct('items.packedBy'");
    expect(route).not.toContain('let pickingHistory = []');
    expect(route).not.toContain('pickingHistory, unfinished');
  });

  it('loads one worker history lazily in pages of 25 from the current session only', () => {
    const route = read('routes/picking.js');
    expect(route).toContain("router.get('/shift-board/worker-history'");
    expect(route).toContain("const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 25))");
    expect(route).toContain('orderingSessionId: sessionId');
    expect(route).toContain('deliveryGroupId');
    expect(route).toContain("{ completedBy: workerTelegramId }");
    expect(route).toContain("{ status: 'locked', lockedBy: workerTelegramId }");
    expect(route).toContain("{ items: { $elemMatch: { packed: true, packedBy: workerTelegramId } } }");
    expect(route).toContain('.skip(offset)');
    expect(route).toContain('.limit(limit)');
    expect(route).toContain('hasMore: offset + items.length < total');
  });

  it('returns the product thumbnail and worker-specific participation metadata', () => {
    const route = read('routes/picking.js');
    expect(route).toContain("'_id brand model category orderNumber imageUrls localImageUrl'");
    expect(route).toContain('imageUrl: productInfo?.imageUrl || null');
    expect(route).toContain('workerPackedCount: workerPackedItems.length');
    expect(route).toContain('isActiveForWorker');
    expect(route).toContain('completedByWorker');
  });
});

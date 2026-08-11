const fs = require('fs');
const path = require('path');

describe('current-session picking history contract', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('builds history from PickingTask instead of a second audit store', () => {
    const route = read('routes/picking.js');
    expect(route).toContain('let pickingHistory = []');
    expect(route).toContain("{ orderingSessionId: sessionId, deliveryGroupId: dgId }");
    expect(route).toContain('completedByName');
    expect(route).toContain('packedByName');
    expect(route).toContain('blockId: t.blockId');
    expect(route).toContain('positionIndex: t.positionIndex');
  });

  it('is strictly scoped to the current group session so a new session resets the board', () => {
    const route = read('routes/picking.js');
    expect(route).toContain('sessionId = await getOrCreateSessionId(dgId, group.orderingSchedule)');
    expect(route).toContain("const sessionScope = sessionId ? { orderingSessionId: sessionId }");
    expect(route).toContain('orderingSessionId: sessionId, deliveryGroupId: dgId');
    expect(route).not.toContain('PickingSessionEvent');
  });

  it('renders the current-session history in the Shift board', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'routes', 'ShiftBoardPage.jsx'), 'utf8');
    expect(page).toContain('Історія збирання');
    expect(page).toContain('Тільки поточна сесія цієї групи');
    expect(page).toContain('Блок {entry.blockId} · позиція {entry.positionIndex}');
    expect(page).toContain('Завершив: {entry.completedByName}');
  });
});

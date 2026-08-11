'use strict';

const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(SERVER_ROOT, '..', 'client', 'src');
const readServer = (rel) => fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
const readClient = (rel) => fs.readFileSync(path.join(CLIENT_ROOT, rel), 'utf8');

describe('session status UI/server consistency contract', () => {
  it('picking endpoints share one phase + summary implementation', () => {
    const picking = readServer('routes/picking.js');
    expect(picking).toContain("require('../services/sessionPresentation')");
    expect(picking).not.toContain('async function computeSessionPhase');
    expect(picking).not.toContain('async function buildSessionSummary');
  });

  it('delivery-group selector gets the same server-derived phase as the session header', () => {
    const groups = readServer('routes/deliveryGroups.js');
    const selector = readClient('components/miniapp/PickingGroupSelector.jsx');
    expect(groups).toContain('getCurrentGroupPresentation');
    expect(groups).toContain('pickingStatus: presentations[index]?.pickingStatus');
    expect(groups).toContain('phase: presentations[index]?.phase');
    expect(selector).toContain("phase === 'picking'");
    expect(selector).toContain("phase === 'completed'");
    expect(selector).not.toContain('g.hasRelocatedOrders');
  });

  it('completed header renders actual task/order/archive counters, not mismatched field names', () => {
    const header = readClient('components/picking/SessionStatusHeader.jsx');
    expect(header).toContain('processedProductCount');
    expect(header).toContain('archiveRequiredProductCount');
    expect(header).toContain('completedOrderCount');
    expect(header).toContain('Опрацьовано товарів');
    expect(header).toContain('Завершено замовлень');
    expect(header).toContain('Архівовано товарів');
    expect(header).not.toContain('closedOrderCount');
  });

  it('picking group badges are live while the picking UI is visible', () => {
    const page = readClient('routes/MiniAppPage.jsx');
    expect(page).toContain('refetchInterval: needsPickingGroups ? 5000 : false');
    expect(page).toContain('staleTime: needsPickingGroups ? 0 : 5 * 60 * 1000');
  });
  it('session numbering is wired into the real upsert-item path and has a safe backfill', () => {
    const orders = readServer('routes/orders.js');
    const backfill = readServer('scripts/backfillSessionSeq.js');
    expect(orders).toContain('[orders/upsert-item] ensureSessionSeq failed:');
    expect(backfill).toContain("process.argv.includes('--execute')");
    expect(backfill).toContain("arg.startsWith('--env=')");
    expect(backfill).toContain('DRY-RUN');
  });

});

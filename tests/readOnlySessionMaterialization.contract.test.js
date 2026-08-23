'use strict';

const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { indexOrThrow, sliceBetweenOrThrow } = require('./helpers/sourceContract');

describe('read-only session materialization contract', () => {
  it('picking readiness/queue/shift reads do not create OrderingSession documents', () => {
    const picking = read('routes/picking.js');
    expect(picking).toContain('findCurrentSessionId(dgId, group.orderingSchedule)');
    expect(picking).toContain('findCurrentSessionId(String(deliveryGroupId), groupDoc.orderingSchedule)');
    expect(indexOrThrow(picking, "presentationMode === 'upcoming_preflight'")).toBeLessThan(
      indexOrThrow(picking, 'releaseWorkerAndStaleLocks(user.telegramId, deliveryGroupId'),
    );
  });

  it('read-only conflict/product/shop-status views resolve existing exact session identity', () => {
    const orders = read('routes/orders.js');
    const products = read('routes/products.js');
    const currentShopStatus = read('services/readModels/currentSessionShopStatusReadModel.js');
    const shopProducts = read('services/readModels/currentSessionShopProductsReadModel.js');
    const groupSessions = read('services/readModels/deliveryGroupSessionSummaryReadModel.js');

    expect(orders).toContain('const currentSessionId = await findCurrentSessionId(groupId, group.orderingSchedule)');
    expect(orders).toContain('orderingSessionId: sessionId');
    expect(products).toContain('const orderingSessionId = await findCurrentSessionId(String(group._id), group.orderingSchedule)');
    expect(products).toContain('orderingSessionId: String(orderingSessionId)');
    expect(currentShopStatus).toContain('findCurrentSessionId(String(group._id), group.orderingSchedule)');
    expect(shopProducts).toContain('findCurrentSessionId(String(group._id), group.orderingSchedule)');
    expect(groupSessions).toContain('findCurrentSessionId(');
  });

  it('write paths still materialize a session when a real business operation needs identity', () => {
    const groups = read('routes/deliveryGroups.js');
    const orders = read('routes/orders.js');
    expect(groups).toContain("router.post('/catalog-reviewed'");
    expect(groups).toContain('const sessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);');
    expect(orders).toContain('currentSessionId = await getOrCreateSessionId(String(group._id), group.orderingSchedule);');
  });
  it('seller session-status polling is also pure read and cannot materialize an empty session', () => {
    const picking = read('routes/picking.js');
    const body = sliceBetweenOrThrow(picking, "router.get('/session-status'", "router.get('/schedule'", { label: 'session-status route' });
    expect(body).toContain('findCurrentSessionId(String(groupId), group.orderingSchedule)');
    expect(body).not.toContain('getOrCreateSessionId(');
  });

});

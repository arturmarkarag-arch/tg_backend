'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const orders = read('routes/orders.js');
const deliveryGroups = read('routes/deliveryGroups.js');
const sellerOrderingStatus = read('services/readModels/sellerOrderingStatusReadModel.js');
const supplementRoute = read('routes/supplement.js');
const supplementService = read('services/supplementOffers.js');

// ORDERS — stale UI from an older weekly session cannot write into the new one.
assert.match(orders, /clientOrderingSessionId/);
assert.match(orders, /!clientOrderingSessionId \|\| clientOrderingSessionId !== String\(currentSessionId \|\| ''\)/);
assert.match(orders, /error:\s*'ordering_session_changed'/);
assert.match(orders, /mutationLockKey = `order:upsert:/);
assert.match(orders, /withLock\(mutationLockKey/);
assert.match(orders, /orderingSessionId: String\(currentSessionId \|\| ''\)/);

// ordering-status exposes the authoritative session identity to resumed tabs,
// while the GET read model remains incapable of materialising a session.
assert.match(deliveryGroups, /buildSellerOrderingStatusReadModel\(req\.telegramUser\)/);
assert.match(sellerOrderingStatus, /orderingSessionId:\s*sessionId \? String\(sessionId\) : ''/);
assert.match(sellerOrderingStatus, /findCurrentSessionId/);
assert.doesNotMatch(sellerOrderingStatus, /getOrCreateSessionId/);

// SUPPLEMENT PICKING — heartbeat endpoint and one shared offer critical section.
assert.match(supplementRoute, /\/offers\/:offerId\/heartbeat/);
assert.match(supplementRoute, /heartbeatOffer\(req\.params\.offerId, req\.telegramUser\?\.telegramId\)/);
assert.match(supplementRoute, /lockedAt: new Date\(\)/);
assert.doesNotMatch(supplementRoute, /const holder = await SupplementOffer\.findById\(req\.params\.offerId/);

assert.match(supplementService, /async function heartbeatOffer/);
assert.match(supplementService, /return withOfferLock\(offerId/);
assert.match(supplementService, /async function claimOffer[\s\S]*return withOfferLock\(offerId/);
assert.match(supplementService, /async function releaseOffer[\s\S]*return withOfferLock\(offerId/);
assert.match(supplementService, /async function completeOffer[\s\S]*withOfferLock\(offerId/);
assert.match(supplementService, /String\(doc\.lockedBy \|\| ''\) !== String\(actor\.by\)/);
assert.match(supplementService, /heartbeatOffer,/);

console.log('V47.7 server core-flow hardening checks: PASS');

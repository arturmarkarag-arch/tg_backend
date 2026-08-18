'use strict';

/**
 * Executable, dependency-free lifecycle proof for V48.S3.
 *
 * This does not mock Mongo. It proves the canonical state vocabulary and
 * revision identities that every Mongo command imports. DB/transaction/race
 * behavior remains covered by the runtime/live gate when dependencies exist.
 */
const assert = require('assert');
const {
  ITEM_STATUS,
  ITEM_RELATION_STATUS,
  revisionOf,
  nextRevision,
  isActiveItemRevision,
  isSellerEditable,
  isPackable,
  blocksGenericRepublish,
  requestBelongsToCurrentRevision,
  deriveContainerSummary,
} = require('../utils/supplementState');
const { offerSnapshotForRequestRevision } = require('../services/supplementRevisionProjection');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`✅ ${name}`);
}

console.log('V48.S3 SUPPLEMENT REVISION CYCLES — EXECUTABLE POLICY PROOF');
console.log('----------------------------------------------------------------');

check('OPEN is seller-editable, active and not packable', () => {
  const offer = { revision: 1, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN };
  assert.equal(isSellerEditable(offer), true);
  assert.equal(isActiveItemRevision(offer), true);
  assert.equal(isPackable(offer), false);
  assert.equal(blocksGenericRepublish(offer), true);
});

check('FROZEN is packable, active and seller-locked', () => {
  const offer = { revision: 1, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.FROZEN };
  assert.equal(isSellerEditable(offer), false);
  assert.equal(isActiveItemRevision(offer), true);
  assert.equal(isPackable(offer), true);
  assert.equal(blocksGenericRepublish(offer), true);
});

check('an OPEN cancellation is a correctable state and may be cleanly republished', () => {
  const offer = { revision: 7, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.CANCELLED };
  assert.equal(isSellerEditable(offer), false);
  assert.equal(isActiveItemRevision(offer), false);
  assert.equal(isPackable(offer), false);
  assert.equal(blocksGenericRepublish(offer), false);
  assert.equal(nextRevision(offer), 8);
});

check('a cancellation after FROZEN releases the item for a clean publication', () => {
  const offer = {
    revision: 4,
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    status: ITEM_STATUS.CANCELLED,
    frozenAt: new Date(),
  };
  assert.equal(blocksGenericRepublish(offer), false);
});

check('an older FROZEN revision does not override a later explicit cancellation', () => {
  const offer = {
    revision: 5,
    itemStatus: ITEM_RELATION_STATUS.ACTIVE,
    status: ITEM_STATUS.CANCELLED,
    revisionHistory: [{ revision: 4, status: ITEM_STATUS.FROZEN, frozenAt: new Date() }],
  };
  assert.equal(blocksGenericRepublish(offer), false);
});

check('route-withdrawn publication may be republished after canonical routing permits it again', () => {
  const offer = { revision: 9, itemStatus: ITEM_RELATION_STATUS.WITHDRAWN, status: ITEM_STATUS.CANCELLED };
  assert.equal(isActiveItemRevision(offer), false);
  assert.equal(blocksGenericRepublish(offer), false);
  assert.equal(nextRevision(offer), 10);
});

check('COMPLETED remains immutable to generic republish', () => {
  const offer = { revision: 5, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.COMPLETED };
  assert.equal(isActiveItemRevision(offer), false);
  assert.equal(blocksGenericRepublish(offer), true);
});

check('old request revisions never become current after a restart', () => {
  let offer = { revision: 1, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN };
  const old = { revision: 1, status: 'active', quantity: 3 };
  assert.equal(requestBelongsToCurrentRevision(old, offer), true);
  offer = { ...offer, revision: nextRevision(offer), status: ITEM_STATUS.OPEN };
  assert.equal(requestBelongsToCurrentRevision(old, offer), false);
  const fresh = { revision: offer.revision, status: 'active', quantity: 2 };
  assert.equal(requestBelongsToCurrentRevision(fresh, offer), true);
});

check('250 cancel/restart cycles stay monotonic and never resurrect previous results', () => {
  let offer = { revision: 1, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN };
  const history = [];
  for (let cycle = 1; cycle <= 250; cycle += 1) {
    assert.equal(offer.revision, cycle);
    assert.equal(isSellerEditable(offer), true);
    const request = { revision: offer.revision, shopId: 'shop-A', quantity: (cycle % 6) + 1, status: 'active' };
    assert.equal(requestBelongsToCurrentRevision(request, offer), true);

    offer = { ...offer, status: ITEM_STATUS.CANCELLED };
    assert.equal(blocksGenericRepublish(offer), false);
    history.push(request);

    if (cycle < 250) {
      offer = {
        ...offer,
        revision: nextRevision(offer),
        status: ITEM_STATUS.OPEN,
        itemStatus: ITEM_RELATION_STATUS.ACTIVE,
      };
      for (const historical of history) {
        assert.equal(requestBelongsToCurrentRevision(historical, offer), false);
      }
    }
  }
  assert.equal(offer.revision, 250);
  assert.equal(history.length, 250);
});

check('mixed item states share one container without a global lifecycle lock', () => {
  const offers = [
    { itemStatus: 'active', status: 'frozen' },
    { itemStatus: 'active', status: 'open' },
    { itemStatus: 'active', status: 'completed' },
    { itemStatus: 'active', status: 'cancelled' },
  ];
  assert.equal(deriveContainerSummary(offers), ITEM_STATUS.OPEN);
  offers[1].status = ITEM_STATUS.FROZEN;
  assert.equal(deriveContainerSummary(offers), ITEM_STATUS.FROZEN);
  offers[0].status = ITEM_STATUS.COMPLETED;
  offers[1].status = ITEM_STATUS.COMPLETED;
  assert.equal(deriveContainerSummary(offers), ITEM_STATUS.CANCELLED);
});

check('adding a new OPEN item after older items are FROZEN keeps one container summary OPEN', () => {
  const offers = [
    { revision: 3, itemStatus: 'active', status: 'frozen' },
    { revision: 8, itemStatus: 'active', status: 'frozen' },
  ];
  assert.equal(deriveContainerSummary(offers), ITEM_STATUS.FROZEN);
  offers.push({ revision: 1, itemStatus: 'active', status: 'open' });
  assert.equal(deriveContainerSummary(offers), ITEM_STATUS.OPEN);
  assert.equal(isSellerEditable(offers[0]), false);
  assert.equal(isSellerEditable(offers[2]), true);
});

check('cancelling one item does not alter unrelated item lifecycle', () => {
  const cup = { revision: 4, itemStatus: 'active', status: 'open' };
  const plate = { revision: 2, itemStatus: 'active', status: 'frozen' };
  const cancelledCup = { ...cup, status: 'cancelled' };
  assert.equal(plate.status, ITEM_STATUS.FROZEN);
  assert.equal(isPackable(plate), true);
  assert.equal(blocksGenericRepublish(cancelledCup), false);
  assert.equal(deriveContainerSummary([cancelledCup, plate]), ITEM_STATUS.FROZEN);
});

check('historical projection never borrows a later revision snapshot', () => {
  const offer = {
    revision: 3,
    status: ITEM_STATUS.OPEN,
    sourceSnapshot: { title: 'new-title', price: 30 },
    revisionHistory: [
      { revision: 1, status: ITEM_STATUS.CANCELLED, sourceSnapshot: { title: 'old-title', price: 10 } },
      { revision: 2, status: ITEM_STATUS.CANCELLED, sourceSnapshot: { title: 'middle-title', price: 20 } },
    ],
  };
  const historical = offerSnapshotForRequestRevision(offer, { revision: 1, createdAt: new Date(0) });
  assert.equal(historical.revision, 1);
  assert.equal(historical.sourceSnapshot.title, 'old-title');
  assert.equal(historical.sourceSnapshot.price, 10);
  assert.equal(historical.status, ITEM_STATUS.CANCELLED);
  const current = offerSnapshotForRequestRevision(offer, { revision: 3 });
  assert.equal(current.sourceSnapshot.title, 'new-title');
});

check('revision parser never creates zero/negative/NaN current generations', () => {
  for (const value of [undefined, null, 0, -10, NaN, Infinity, 'garbage']) {
    assert.equal(revisionOf(value), 1);
  }
  assert.equal(revisionOf('12'), 12);
});

check('revision counter fails closed at numeric exhaustion instead of wrapping', () => {
  assert.throws(() => nextRevision(Number.MAX_SAFE_INTEGER), /supplement_revision_exhausted/);
});

console.log(`\nV48.S3 REVISION CYCLES: PASS (${passed}/${passed}; 250 sequential restart cycles)`);

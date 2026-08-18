'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('V48.S3 stable supplement container contracts', () => {
  it('uses one group+session container and one item slot with repeatable revisions', () => {
    const wave = read('models/SupplementWave.js');
    const offer = read('models/SupplementOffer.js');
    expect(wave).toContain('containerKey');
    expect(wave).toContain('architectureVersion');
    expect(offer).toContain('{ waveId: 1, receiptItemId: 1 }');
    expect(offer).toContain('revisionHistory');
    expect(offer).toContain('revision: { type: Number');
  });

  it('keys requests by offer + publication revision + Shop', () => {
    expect(read('models/SupplementRequest.js')).toContain('{ offerId: 1, revision: 1, shopId: 1 }');
  });

  it('shares one dependency-free lifecycle vocabulary across models and commands', () => {
    const state = read('utils/supplementState.js');
    expect(state).toContain('const REQUEST_STATUS');
    expect(read('models/SupplementOffer.js')).toContain("require('../utils/supplementState')");
    expect(read('models/SupplementRequest.js')).toContain("require('../utils/supplementState')");
    expect(read('models/SupplementWave.js')).toContain("require('../utils/supplementState')");
  });

  it('restarts pre-freeze cancelled items cleanly without resurrecting old request rows', () => {
    const service = read('services/supplementWaveService.js');
    expect(service).toContain('$push: { revisionHistory: revisionArchiveOf(current, now) }');
    expect(service).toContain('revision: nextRevision(current)');
    expect(service).toContain('sourceSnapshot: sourceSnapshotFromReceiptItem(item)');
  });

  it('blocks active FROZEN work but releases every explicitly cancelled revision', () => {
    const state = read('utils/supplementState.js');
    const receipts = read('routes/receipts.js');
    expect(state).toContain("if (status === ITEM_STATUS.CANCELLED) return false");
    expect(state).toContain('hasCompletedLifecycle(offer)');
    expect(receipts).toContain('existingPublications');
    expect(receipts).toContain('blockedItemIds');
  });

  it('freezes only currently open item revisions', () => {
    const service = read('services/supplementWaveService.js');
    expect(service).toContain('{ waveId: wave._id, itemStatus: ITEM_RELATION_STATUS.ACTIVE, status: ITEM_STATUS.OPEN }');
  });

  it('separates seller CREATE UPDATE DELETE', () => {
    const route = read('routes/supplement.js');
    expect(route).toContain("router.post('/offers/:offerId/requests'");
    expect(route).toContain("router.patch('/requests/:requestId'");
    expect(route).toContain("router.delete('/requests/:requestId'");
  });

  it('keeps route correction separate and transactionally recomputes container state', () => {
    const service = read('services/supplementWaveService.js');
    const correction = read('services/receiptRoutingCorrectionCommand.js');
    expect(service).toContain('cancelOfferRevision');
    expect(service).toContain('recomputeWaveSummaryInSession(waveId, { session, actor, now })');
    expect(correction).toContain('withdrawReceiptItemFromActiveWaves');
  });

  it('lets cancelled modern publication history stop blocking future Receipt metadata edits', () => {
    const sync = read('services/receiptSync.js');
    expect(sync).toContain('activeModernOffers');
    expect(sync).toContain('modernOffers.filter(isActiveItemRevision)');
    expect(sync).toContain('revision: revisionOf(offer)');
  });

  it('scopes current operational request consumers to the exact revision', () => {
    const supplement = read('routes/supplement.js');
    const picking = read('routes/picking.js');
    expect(supplement).toContain('currentRequestsForOffers');
    expect(picking).toContain('requestPairs');
    expect(picking).toContain('revision: revisionOf(offer)');
  });

  it('closes sessions from active exact-session item work, not derived container summary', () => {
    expect(read('utils/sessionStatus.js')).toContain('SupplementOffer.countDocuments');
    expect(read('services/sessionClosure.js')).toContain('SupplementOffer.find');
  });
});

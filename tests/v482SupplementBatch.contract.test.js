const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const receipts = read('routes/receipts.js');
const permissions = read('utils/receiptPermissions.js');
const offers = read('services/supplementOffers.js');
const model = read('models/ReceiptItem.js');

describe('V48.2 supplement batch-group release contract', () => {
  test('current regular supplement items can confirm unassigned and are marked batch v2', () => {
    expect(model).toContain('Version 2 = current flow');
    expect(receipts).toContain('v2 stays target-neutral only while READY');
    expect(permissions).toContain('allowSupplementWithoutGroup: currentBatchSupplement');
    expect(receipts).toContain('routing.supplementDeliveryGroupId ? 1 : 2');
  });

  test('one global publish lock pins one exact group/session and applies an item-global lifecycle fence', () => {
    expect(receipts).toContain("withLock('supplement-batch:publish'");
    expect(receipts).toContain('existingPublications');
    expect(receipts).toContain('blockedItemIds');
    expect(receipts).toContain('readyCount: readyCountForTarget');
  });

  test('modern offers are created only through Wave publication with grouped notification', () => {
    expect(offers).toContain('if (Number(item.supplementBatchVersion || 0) >= 1) continue');
    expect(receipts).toContain('createWaveWithItems({');
    expect(receipts).toContain("notifyWaves([result.wave], 'opened')");
  });
});

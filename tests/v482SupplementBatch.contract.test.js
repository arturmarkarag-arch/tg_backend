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
    expect(model).toContain('unassigned until batch publication');
    expect(permissions).toContain('allowSupplementWithoutGroup: currentBatchSupplement');
    expect(receipts).toContain('routing.supplementDeliveryGroupId ? 1 : 2');
  });

  test('one global publish lock assigns one selected group to the ready unassigned pool', () => {
    expect(receipts).toContain("withLock('supplement-batch:publish'");
    expect(receipts).toContain("'routing.supplementDeliveryGroupId': null");
    expect(receipts).toContain("'routing.supplementDeliveryGroupId': deliveryGroupId");
    expect(receipts).toContain('readyCount');
    expect(receipts).toContain('targets: targets.groups || []');
  });

  test('offers and grouped notification are created only after batch group assignment/publication', () => {
    expect(offers).toContain('if (!routing.supplement || !item.createdProductId || !routing.supplementDeliveryGroupId) continue;');
    expect(receipts).toContain("notifyOffers(notificationOffers, 'opened')");
    expect(receipts).toContain('if (!result.failed)');
  });
});

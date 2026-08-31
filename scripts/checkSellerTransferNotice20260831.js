'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_ROOT = path.resolve(ROOT, '../client');
const read = (base, rel) => fs.readFileSync(path.join(base, rel), 'utf8');

const {
  buildShopTransferNoticeForAssignment,
  buildShopTransferPayload,
} = require('../services/sellerTransferNotice');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const shopA = { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'A' };
const shopB = { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'B' };
const shopC = { _id: 'cccccccccccccccccccccccc', name: 'C' };
const admin = { role: 'admin' };
const warehouse = { role: 'warehouse' };
const seller = { role: 'seller' };

check('admin A -> B creates one current notice', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: shopA, newShop: shopB, actor: admin });
  assert.equal(m.shouldWrite, true);
  assert.equal(m.notice.fromShopName, 'A');
  assert.equal(m.notice.toShopName, 'B');
  assert.ok(m.notice.id);
});

check('warehouse A -> B creates notice as the legacy UX did', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: shopA, newShop: shopB, actor: warehouse });
  assert.equal(m.shouldWrite, true);
  assert.ok(m.notice);
});


check('staff repair actor shape byRole is recognized by notice helper', () => {
  const m = buildShopTransferNoticeForAssignment({
    oldShop: shopA,
    newShop: shopB,
    actor: { byRole: 'admin' },
  });
  assert.equal(m.shouldWrite, true);
  assert.ok(m.notice);
});

check('seller/self move clears prior manager warning instead of creating one', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: shopA, newShop: shopB, actor: seller });
  assert.equal(m.shouldWrite, true);
  assert.equal(m.notice, null);
});

check('initial assignment clears any stale notice and creates no transfer warning', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: null, newShop: shopB, actor: admin });
  assert.equal(m.shouldWrite, true);
  assert.equal(m.notice, null);
});

check('same-shop no-op preserves an already pending notice', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: shopB, newShop: shopB, actor: admin });
  assert.equal(m.shouldWrite, false);
});

check('A -> B -> C naturally replaces notice identity', () => {
  const first = buildShopTransferNoticeForAssignment({ oldShop: shopA, newShop: shopB, actor: admin });
  const second = buildShopTransferNoticeForAssignment({ oldShop: shopB, newShop: shopC, actor: admin });
  assert.notEqual(first.notice.id, second.notice.id);
  assert.equal(second.notice.fromShopName, 'B');
  assert.equal(second.notice.toShopName, 'C');
});

check('read payload is visible only for CURRENT target shop', () => {
  const m = buildShopTransferNoticeForAssignment({ oldShop: shopA, newShop: shopB, actor: admin });
  const visible = buildShopTransferPayload({ shopId: shopB._id, shopTransferNotice: m.notice });
  assert.equal(visible.transferNoteId, m.notice.id);
  assert.match(visible.note, /A/);
  assert.match(visible.note, /B/);

  const stale = buildShopTransferPayload({ shopId: shopC._id, shopTransferNotice: m.notice });
  assert.deepEqual(stale, {});
});

check('history-only Alexander-style fixture can never create a banner', () => {
  const payload = buildShopTransferPayload({
    shopId: shopC._id,
    history: [{ action: 'shop_changed', byRole: 'admin', meta: { fromShop: 'A', toShop: 'B' } }],
  });
  assert.deepEqual(payload, {});
});

check('schema stores only one current notice on User', () => {
  const src = read(ROOT, 'models/User.js');
  assert.match(src, /shopTransferNotice:\s*\{ type: ShopTransferNoticeSchema, default: null \}/);
  assert.ok(!src.includes('SellerNotice'));
});

check('assignment and unassignment own notice lifecycle transactionally', () => {
  const migrate = read(ROOT, 'services/migrateSellerShop.js');
  const unassign = read(ROOT, 'services/unassignSeller.js');
  const softRemove = read(ROOT, 'services/softRemoveUser.js');
  assert.ok(migrate.includes('buildShopTransferNoticeForAssignment({'));
  assert.ok(migrate.includes('userUpdate.shopTransferNotice = noticeMutation.notice'));
  assert.ok(unassign.includes('shopId: null, shopTransferNotice: null'));
  assert.ok(softRemove.includes('shopTransferNotice: null'));
});


check('explicit Order snapshot repair participates in the same notice lifecycle', () => {
  const src = read(ROOT, 'routes/orders.js');
  assert.ok(src.includes("buildShopTransferNoticeForAssignment"));
  assert.ok(src.includes("oldShop: userSourceShop"));
  assert.ok(src.includes("userUpdate.shopTransferNotice = noticeMutation.notice"));
});

check('assignment userPatch cannot overwrite assignment-owned notice/shop fields', () => {
  const src = read(ROOT, 'services/shopAssignmentCommand.js');
  assert.ok(src.includes('assertAssignmentOwnedFieldsAbsent(userPatch)'));
  assert.ok(src.includes("hasOwnProperty.call(userPatch, 'shopTransferNotice')"));
  assert.ok(src.includes("details: 'assignment_owned_field'"));
});

check('ordering read model never scans User.history for active transfer banner', () => {
  const src = read(ROOT, 'services/readModels/sellerOrderingStatusReadModel.js');
  assert.ok(src.includes('buildShopTransferPayload(user)'));
  assert.ok(!src.includes('user?.history'));
  assert.ok(!src.includes('transferEvent'));
});

check('acknowledgement is current-user, compare-by-id and returns current truth', () => {
  const src = read(ROOT, 'routes/deliveryGroups.js');
  assert.ok(src.includes("router.post('/transfer-note/:noteId/acknowledge'"));
  assert.ok(src.includes("'shopTransferNotice.id': noteId"));
  assert.ok(src.includes('const telegramId = String(req.telegramUser.telegramId)'));
  assert.ok(src.includes('telegramId,'));
  assert.ok(src.includes(".select('shopId shopTransferNotice')"));
  assert.ok(src.includes('buildShopTransferPayload(freshUser)'));
});

check('client dismissal is server-backed and localStorage transfer state is gone', () => {
  const api = read(CLIENT_ROOT, 'src/api.js');
  const page = read(CLIENT_ROOT, 'src/routes/MiniAppPage.jsx');
  assert.ok(api.includes('acknowledgeTransferNote'));
  assert.ok(page.includes('await acknowledgeTransferNote(noteId)'));
  assert.ok(!page.includes('miniapp-dismissed-transfer-notes'));
  assert.ok(!page.includes('dismissedTransferNoteIds'));
});

console.log(`SELLER TRANSFER NOTICE 2026-08-31: PASS ${passed}/${passed}`);

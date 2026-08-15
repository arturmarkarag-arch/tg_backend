const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const route  = read('routes/receipts.js');
const sync   = read('services/receiptSync.js');
const errors = read('utils/errors.js');
const detail = read('../client/src/pages/receipts/ReceiptDetailPage.jsx');

describe('проведена накладна редагується далі', () => {
  test('жоден обробник позиції не гейтить дію статусом накладної', () => {
    for (const marker of [
      "router.post('/:id/items'",
      "router.delete('/:id/items/:itemId'",
      "router.post('/:id/items/:itemId/confirm'",
      "router.post('/:id/items/:itemId/unconfirm'",
    ]) {
      const start = route.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const handler = route.slice(start, route.indexOf('}));', start));
      expect(handler).not.toContain("receipt.status !== 'draft'");
    }
    // Коди «накладну проведено — редагувати не можна» більше не існують.
    expect(errors).not.toContain('receipt_completed_locked');
    expect(errors).not.toContain('receipt_completed_no_delete');
  });

  test('правка НІКОЛИ не архівує товар і не скасовує позицій у замовленнях', () => {
    // Згадка в докблоці лишається (вона пояснює межу), а от викликати архівацію
    // чи чіпати позиції замовлень цей модуль не має права взагалі.
    expect(sync).not.toContain("require('./archiveProduct')");
    expect(sync).not.toContain('.cancelled');
    expect(sync).not.toContain('Order.updateOne');
    expect(sync).not.toContain('order.save');
  });

  test('кожна небезпечна дія має власний usage-guard перед відкатом/зміною', () => {
    // Не рахуємо глобальну кількість guard-ів: нове правило безпеки не повинно
    // ламати тест лише тому, що runtime став суворішим. Перевіряємо конкретні
    // переходи стану окремо, щоб зникнення будь-якого потрібного guard-а падало.
    const editStart = route.indexOf("router.patch('/:id/items/:itemId'");
    const routingStart = route.indexOf("router.patch('/:id/items/:itemId/routing'");
    const editHandler = route.slice(editStart, routingStart);
    expect(editHandler).toContain('criticalEditFields');
    expect(editHandler).toContain('describeItemUsage(item, { session: txSession })');
    expect(editHandler).toContain("appError('receipt_item_in_use'");

    const rerouteStart = editHandler.indexOf('const rerouted =');
    const rerouteEnd = editHandler.indexOf('const before = logSnapshot', rerouteStart);
    const rerouteGuard = editHandler.slice(rerouteStart, rerouteEnd);
    expect(rerouteGuard).toContain('describeItemUsage(item, { session: txSession })');
    expect(rerouteGuard).toContain("appError('receipt_item_in_use'");
    expect(rerouteGuard).toContain('rollbackItemArtifacts(item, { session: txSession })');

    const deleteStart = route.indexOf("router.delete('/:id/items/:itemId'");
    const confirmStart = route.indexOf("router.post('/:id/items/:itemId/confirm'");
    const deleteHandler = route.slice(deleteStart, confirmStart);
    expect(deleteHandler).toContain('describeItemUsage(item, { session })');
    expect(deleteHandler).toContain("appError('receipt_item_in_use'");
    expect(deleteHandler).toContain('rollbackItemArtifacts(item, { session })');

    const unconfirmStart = route.indexOf("router.post('/:id/items/:itemId/unconfirm'");
    const unconfirmHandler = route.slice(unconfirmStart);
    expect(unconfirmHandler).toContain('describeItemUsage(item, { session })');
    expect(unconfirmHandler).toContain("appError('receipt_item_in_use'");
    expect(unconfirmHandler).toContain('rollbackItemArtifacts(item, { session })');

    expect(errors).toContain('receipt_item_in_use');
  });

  test('legacy-позиції зберігають старе delta-оновлення кількості', () => {
    expect(sync).toContain('if (Number(item.routingVersion || 0) < 1)');
    expect(sync).toContain('const delta = Number(item.totalQty || 0) - Number(prev.totalQty || 0)');
    expect(sync).toContain('product.quantity = Math.max(0, next)');
  });

  test('відкат прибирає і дзеркало, і вектор, і пропозиції дозамовлення', () => {
    expect(sync).toContain('ShopProduct.deleteOne({ linkedProductId: productId })');
    expect(sync).toContain('ProductVector.deleteMany({ productId })');
    expect(sync).toContain('ProductVector.deleteMany({ shopProductId })');
    expect(sync).toContain('SupplementOffer.deleteMany(');
  });

  test('проведення теж синхронізує дзеркало (ціна не лишається старою)', () => {
    const start = route.indexOf("router.post('/:id/commit'");
    const commit = route.slice(start);
    expect(commit).toContain('await syncMirror(currentProduct, { session })');
  });

  test('у проведеному дозамовленні світлину підмінити не можна', () => {
    expect(route).toContain("appError('receipt_supplement_photo_locked')");
    expect(errors).toContain('receipt_supplement_photo_locked');
    // Заборонена саме підміна оригіналу; перемальовані підписи проходять.
    expect(route).toContain('afterCommit && originalFilename');
  });

  test('клієнт більше не показує проведену накладну як заморожену', () => {
    expect(detail).not.toContain('редагування позицій недоступне');
    expect(detail).not.toContain('readOnly: isCompleted');
    expect(detail).toContain('lockPhotoSwap');
  });
});

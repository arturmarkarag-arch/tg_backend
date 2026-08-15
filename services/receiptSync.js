'use strict';

/**
 * Накладна ↔ мірор-документи.
 *
 * Проведена накладна БІЛЬШЕ НЕ є замороженим документом: позицію можна правити,
 * додавати й видаляти в будь-який день (docs/receipt/readme.md §5). Ціна цього
 * рішення — кожна правка мусить дійти до всіх похідних документів, інакше
 * накладна почне розходитися зі складом і каталогом магазинів.
 *
 * Тут живуть три операції, і лише вони мають право чіпати похідні документи:
 *
 *   describeItemUsage    — чи товар цієї позиції вже «поїхав далі»;
 *   propagateItemEdit    — протягнути правку позиції в товар + дзеркало;
 *   rollbackItemArtifacts— прибрати все, що позиція створила.
 *
 * ГОЛОВНЕ ПРАВИЛО: правка НІЧОГО не скасовує в замовленнях. Скасування позицій у
 * замовленнях — наслідок ЗНИКНЕННЯ товару (archiveProduct), а зникнути товар тут
 * може лише тоді, коли ним ще ніхто не скористався (describeItemUsage порожній).
 * Якщо товар уже в блоці / замовленні / збиранні — видалення й зміна призначення
 * відмовляються з поясненням, а не архівують товар нишком.
 */

const Block             = require('../models/Block');
const Order             = require('../models/Order');
const PickingTask       = require('../models/PickingTask');
const Product           = require('../models/Product');
const ProductVector     = require('../models/ProductVector');
const ShopProduct       = require('../models/ShopProduct');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');

const { syncMirror, upsertShopOwnedFromReceiptItem } = require('../utils/upsertShopProduct');
const { labelPositionsFromPhotoMeta, photoCommentsText } = require('../utils/receiptPhotoMeta');

/** Підписи на фото (позиції ціни/кількості/всіх коментарів) у формі товару. */
function labelPositionsFromMeta(photoMeta) {
  return labelPositionsFromPhotoMeta(photoMeta);
}

/** Поля позиції, від яких залежать похідні документи. Знімається ДО правки. */
function snapshotItem(item) {
  return {
    destination:      item.destination || 'shelf',
    totalQty:         Number(item.totalQty || 0),
    price:            item.price,
    qtyPerPackage:    item.qtyPerPackage,
    photoUrl:         item.photoUrl || '',
    photoName:        item.photoName || '',
    originalPhotoUrl: item.originalPhotoUrl || '',
    photoMeta:        JSON.stringify(labelPositionsFromMeta(item.photoMeta)),
  };
}

/**
 * Чи товар цієї позиції вже живе власним життям.
 *
 * Використовується там, де похідний документ мав би ЗНИКНУТИ: видалення позиції,
 * зняття підтвердження, зміна призначення склад↔магазини. Повертає причини
 * людською мовою — вони йдуть просто в текст помилки, щоб працівник знав, що
 * саме заважає, і куди йти виправляти.
 */
async function describeItemUsage(item, { session = null } = {}) {
  const ses = (q) => (session ? q.session(session) : q);
  const reasons = [];

  if (item.createdProductId) {
    const productId = item.createdProductId;
    const product = await ses(Product.findById(productId, 'status').lean());

    if (product && product.status === 'archived') reasons.push('товар уже в архіві');

    const block = await ses(Block.findOne({ productIds: productId }, 'blockId').lean());
    if (block) reasons.push(`товар стоїть у блоці ${block.blockId}`);

    // Будь-яке замовлення, не лише активне: доставлене замовлення означає, що
    // товар фізично поїхав у магазин, і накладна вже не може його «не привозити».
    const orderCount = await ses(Order.countDocuments({ 'items.productId': productId }));
    if (orderCount > 0) reasons.push(`товар у замовленнях магазинів (${orderCount})`);

    const taskCount = await ses(PickingTask.countDocuments({ productId }));
    if (taskCount > 0) reasons.push('товар уже потрапив у збирання');
  }

  // Publication itself is irreversible from the receipt editor. A deferred batch
  // has already been assigned to a delivery group and will be opened by the
  // scheduler; letting unconfirm/delete clear it would silently move a product
  // between groups. This guard intentionally applies even before an Offer exists.
  if (item.supplementPublishRequestedAt) {
    reasons.push('дозамовлення вже передано на публікацію');
  }

  // An offer means sellers have already been exposed to this product. Zero
  // requests is NOT a reason to roll it back: open/frozen/completed are all
  // downstream business states. Requests are reported additionally for diagnosis.
  const offers = await ses(
    SupplementOffer.find({ receiptItemId: item._id }, '_id status deliveryGroupId').lean(),
  );
  if (offers.length > 0) {
    const statuses = new Set(offers.map((offer) => String(offer.status || '')));
    if (statuses.has('completed')) reasons.push('дозамовлення вже завершено');
    else if (statuses.has('frozen')) reasons.push('дозамовлення вже закрито для нових заявок');
    else reasons.push('дозамовлення вже відкрито для магазинів');

    const requestCount = await ses(
      SupplementRequest.countDocuments({ offerId: { $in: offers.map((o) => o._id) } }),
    );
    if (requestCount > 0) reasons.push(`магазини вже дозамовили цей товар (${requestCount})`);
  }

  return { inUse: reasons.length > 0, reasons };
}

/**
 * Протягнути правку позиції в похідні документи.
 *
 * Позиція — джерело правди для метаданих того, ЩО приїхало, але НЕ для
 * автоматичного залишку нового routing flow. Для routingVersion>=1 totalQty є
 * довідковою кількістю прийомки й не змінює Product.quantity. Лише legacy rows
 * зберігають стару delta-синхронізацію кількості для сумісності.
 *
 * Викликати ЗАВЖДИ всередині транзакції позиції: товар, дзеркало і сама позиція
 * мусять комітитись разом.
 */
async function propagateItemEdit(item, prev, { session = null } = {}) {
  const out = {
    productId: null,
    shopProductId: null,
    quantityDelta: 0,
    quantityClamped: false,
    // Документ, чиє фото змінилось, — його вектор перегенерується ПІСЛЯ коміту.
    reembed: null,
  };

  const nextLabelPositions = labelPositionsFromMeta(item.photoMeta);
  const originalChanged = (item.originalPhotoUrl || '') !== prev.originalPhotoUrl;
  const labeledChanged  = (item.photoUrl || '') !== prev.photoUrl;
  const photoChanged = originalChanged || labeledChanged;
  const labelsChanged = JSON.stringify(nextLabelPositions) !== prev.photoMeta;
  // Вектор рахується з ЧИСТОГО оригіналу. Правка ціни перемальовує підписи й дає
  // новий анотований файл — але зображення те саме, тому переганяти його через
  // Gemini заново нема сенсу. Виняток: у позиції немає чистого оригіналу, тоді
  // джерелом вектора є сам анотований файл.
  const vectorStale = originalChanged || (labeledChanged && !item.originalPhotoUrl);

  if ((item.destination || 'shelf') !== 'shops') {
    // Позиція без товару — ще не підтверджена. Товар створить підтвердження.
    if (!item.createdProductId) return out;
    const q = Product.findById(item.createdProductId);
    const product = await (session ? q.session(session) : q);
    if (!product) return out;

    if (item.price !== prev.price && item.price != null) product.price = item.price;
    if (item.qtyPerPackage !== prev.qtyPerPackage && item.qtyPerPackage) {
      product.quantityPerPackage = item.qtyPerPackage;
    }

    // New receipt routing treats totalQty as reference metadata only. Do not
    // pretend it equals warehouse leftovers (mandatory/supplement may consume an
    // unknown part before the item becomes normally orderable). Legacy rows keep
    // their historical delta-sync behavior.
    if (Number(item.routingVersion || 0) < 1) {
      const delta = Number(item.totalQty || 0) - Number(prev.totalQty || 0);
      if (delta !== 0) {
        const next = Number(product.quantity || 0) + delta;
        product.quantity = Math.max(0, next);
        out.quantityDelta = delta;
        out.quantityClamped = next < 0;
      }
    }

    if (photoChanged) {
      product.imageUrls = [item.photoUrl];
      product.imageNames = [item.photoName];
      product.originalImageUrl = item.originalPhotoUrl || '';
      if (vectorStale) out.reembed = 'warehouse';
    }
    if (photoChanged || labelsChanged) {
      product.labelPositions = nextLabelPositions;
      product.notes = photoCommentsText(item.photoMeta);
    }
    if (item.aiDescription && !product.aiDescription) product.aiDescription = item.aiDescription;

    await product.save({ session });
    // Дзеркало ShopProduct тримається тим самим викликом, що й скрізь у складі:
    // створити якщо немає, потім протягнути спільні поля.
    await syncMirror(product, { session });

    out.productId = String(product._id);
    out.reembedDoc = out.reembed ? product : null;
    return out;
  }

  // Товар магазину: у нього немає складського власника, тому позиція накладної —
  // єдине джерело правди. upsertShopOwnedFromReceiptItem робить повний $set.
  if (!item.createdShopProductId) return out;
  const sp = await upsertShopOwnedFromReceiptItem(
    typeof item.toObject === 'function' ? item.toObject() : item,
    { session },
  );
  if (!sp) return out;
  out.shopProductId = String(sp._id);
  if (vectorStale) {
    out.reembed = 'shop-owned';
    out.reembedDoc = sp;
  }
  return out;
}

/**
 * Прибрати все, що позиція створила: складський товар з дзеркалом і вектором,
 * товар магазину з вектором, пропозиції дозамовлення.
 *
 * Викликати ЛИШЕ після describeItemUsage з порожнім `reasons` — тут навмисно
 * немає жодних перевірок і жодного archiveProduct: це шлях «нічого не встигло
 * статися», а не шлях «товар зникає зі складу».
 */
async function rollbackItemArtifacts(item, { session = null } = {}) {
  const ses = (q) => (session ? q.session(session) : q);
  const removed = { productId: null, shopProductId: null, offerIds: [] };

  const offers = await ses(SupplementOffer.find({ receiptItemId: item._id }, '_id').lean());
  if (offers.length > 0) {
    await ses(SupplementOffer.deleteMany({ _id: { $in: offers.map((o) => o._id) } }));
    removed.offerIds = offers.map((o) => String(o._id));
  }

  if (item.createdProductId) {
    const productId = item.createdProductId;
    // Дзеркало і вектор належать товару, тож ідуть разом з ним. Без видалення
    // вектора в індексі лишався б рядок, що вказує в нікуди.
    await ses(ShopProduct.deleteOne({ linkedProductId: productId }));
    await ses(ProductVector.deleteMany({ productId }));
    await ses(Product.deleteOne({ _id: productId }));
    removed.productId = String(productId);
    item.createdProductId = null;
  }

  if (item.createdShopProductId) {
    const shopProductId = item.createdShopProductId;
    await ses(ProductVector.deleteMany({ shopProductId }));
    // linkedProductId: null — ніколи не чіпаємо складське дзеркало цією гілкою.
    await ses(ShopProduct.deleteOne({ _id: shopProductId, linkedProductId: null }));
    removed.shopProductId = String(shopProductId);
    item.createdShopProductId = null;
  }

  item.stockApplied = false;
  return removed;
}

/** Хвиля дозамовлення цієї накладної ще приймає заявки? */
async function hasOpenSupplementWave(receiptId, { session = null } = {}) {
  const q = SupplementOffer.exists({ receiptId, status: 'open' });
  return !!(await (session ? q.session(session) : q));
}

/**
 * Чи конкретна позиція вже показана продавцям у дозамовленні.
 * Open і frozen обидва блокують підміну оригінального фото: продавці вже
 * бачили саме цей товар, а frozen ще й може бути в процесі збирання.
 */
async function hasActiveSupplementItemWave(receiptItemId, { session = null } = {}) {
  const q = SupplementOffer.exists({
    receiptItemId,
    status: { $in: SupplementOffer.ACTIVE_STATUSES },
  });
  return !!(await (session ? q.session(session) : q));
}

module.exports = {
  labelPositionsFromMeta,
  snapshotItem,
  describeItemUsage,
  propagateItemEdit,
  rollbackItemArtifacts,
  hasOpenSupplementWave,
  hasActiveSupplementItemWave,
};

'use strict';

/**
 * Ядро «Дозамовлення» (Zlotoweczka_Dozamovlennia_Povna_spetsyfikatsiia_2026-08-05.md).
 *
 * Тут живе вся логіка, спільна для роутів, планувальника і гардів:
 *   • ідемпотентне створення пропозицій після проведення накладної (§4, §21);
 *   • ЄДИНЕ джерело істини про те, чи пропозиція ще open (§21 — дедлайн
 *     перевіряється в кожній операції, а не тільки планувальником);
 *   • заморозка / авто-завершення / завершення складом;
 *   • фізичне місце товару для картки (§9).
 *
 * ЦІЛЬОВА ГРУПА СЮДИ НЕ НАЛЕЖИТЬ. Її обирає людина в модалці проведення, і вона
 * зафіксована на самій накладній (Receipt.targetDeliveryGroupId). Перевірка
 * вибору живе у services/supplementTargets.js.
 *
 * ХВИЛЯ НЕ ЗНАЄ ПРО OrderingSession (рішення власника 05.08.2026, друга ітерація).
 * Ні тут, ні деінде дозамовлення не створює, не оживляє і не блокує звичайну
 * сесію збирання: у нього власний цикл open → frozen → completed, прив'язаний
 * лише до групи. Див. довгий коментар у models/SupplementOffer.js.
 *
 * Свідомо ВІДСУТНЄ у першій версії (рішення власника 05.08.2026):
 *   • адміністративне скасування пропозиції (§16) і cleanup спакованих коробок;
 *   • OOS / часткове виконання / архівування з віртуального блока (§14).
 * TODO на майбутнє (§24): облік залишку та резервування, розподіл при нестачі.
 */

const mongoose = require('mongoose');

const Block             = require('../models/Block');
const Product           = require('../models/Product');
const ReceiptItem       = require('../models/ReceiptItem');
const SupplementOffer   = require('../models/SupplementOffer');
const SupplementRequest = require('../models/SupplementRequest');

const Receipt = require('../models/Receipt');

const { withLock } = require('../utils/lock');
const { getProductTitle } = require('./archiveProduct');
const { getIO } = require('../socket');

// ─── Статус ──────────────────────────────────────────────────────────────────

/**
 * Реальний статус пропозиції ЗАРАЗ.
 *
 * Планувальник переводить open → frozen раз на кілька секунд, тому між моментом
 * closesAt і його тіком у базі ще лежить 'open'. Якби продавець і склад читали
 * сирий status, у цьому вікні продавець ще міг би змінити заявку, а склад уже
 * бачив би кнопку «Спакував» — два різні стани одночасно (§22, тест 8).
 * Усі перевірки йдуть через цю функцію, тож рішення завжди приймає СЕРВЕРНИЙ
 * час, а не те, чи встиг спрацювати таймер.
 */
function effectiveOfferStatus(offer, now = new Date()) {
  if (!offer) return null;
  if (offer.status !== 'open') return offer.status;
  return new Date(offer.closesAt).getTime() <= now.getTime() ? 'frozen' : 'open';
}

/** Пропозиція ще приймає зміни від продавців? */
function isOfferOpenForSellers(offer, now = new Date()) {
  return effectiveOfferStatus(offer, now) === 'open';
}

// Одне визначення «активної» пропозиції для сервісу, роутів і гарда завершення
// сесії — живе на моделі (див. models/SupplementOffer.js).
const ACTIVE_STATUSES = SupplementOffer.ACTIVE_STATUSES;

// ─── Створення після проведення накладної (§4) ───────────────────────────────

/**
 * Створює пропозиції для ВСІХ позицій накладної типу 'supplement'.
 *
 * Ціль хвилі не вгадується: група зафіксована на самій накладній у момент
 * проведення (див. services/supplementTargets.resolveSupplementTarget). Тому тут
 * немає жодної евристики — лише «взяти те, що обрала людина».
 *
 * ІДЕМПОТЕНТНО (§21, §22 тест 2): унікальний індекс {receiptItemId, deliveryGroupId}
 * означає, що повторний виклик (ретрай звірятеля, друге натискання «Провести»)
 * не вставить нічого нового — дублікати ловляться як E11000 і пропускаються.
 * Тому цей крок безпечно винесений ПІСЛЯ транзакції проведення: він не може
 * лишитися «напіввиконаним» у сенсі, що щось доведеться відкочувати.
 *
 * КРИТИЧНЕ ПРАВИЛО: позиція з destination='shops' пропозицію не створює. У
 * накладній-дозамовленні таких бути не може (роут це забороняє), але перевірка
 * дублюється тут, бо роут — не єдиний шлях у базу.
 *
 * @returns {Promise<{created: Array, complete: boolean}>} щойно СТВОРЕНІ пропозиції.
 */
async function createOffersForReceipt(receiptId) {
  const receipt = await Receipt.findById(
    receiptId,
    'type targetDeliveryGroupId supplementOpenedAt supplementClosesAt receiptNumber',
  ).lean();
  if (!receipt) return { created: [], complete: true };

  // Звичайна накладна не має жодного стосунку до дозамовлень — і не має лишати
  // по собі маркера, за який чіплятиметься звірятель.
  if (receipt.type !== 'supplement') {
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: null } });
    return { created: [], complete: true };
  }

  // Ціль мусить бути зафіксована проведенням. Якщо її немає — це не «нічого не
  // сталося», а зламана накладна: мовчки лишити її 'pending' означало б, що
  // звірятель довіку ходитиме по ній щотіка.
  if (!receipt.targetDeliveryGroupId) {
    console.error('[supplement] накладна', receipt.receiptNumber, '— тип supplement без цільової групи; пропозиції не створюються');
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'ready' } });
    return { created: [], complete: true };
  }

  const items = await ReceiptItem.find(
    { receiptId },
    '_id destination createdProductId existingProductId name',
  ).lean();

  const eligible = items.filter(
    (i) => (i.destination || 'shelf') !== 'shops' && (i.createdProductId || i.existingProductId),
  );
  if (!eligible.length) {
    await Receipt.updateOne({ _id: receiptId }, { $set: { supplementStatus: 'ready' } });
    return { created: [], complete: true };
  }

  // Дві позиції накладної можуть вказувати на ОДИН існуючий товар (склад
  // прийняв його двома палетами / двома рядками). Пропозиція ж — про товар, а
  // не про рядок накладної, тож беремо кожен productId один раз. Інакше магазин
  // побачив би дві однакові картки й міг замовити до 6 у кожній.
  const byProduct = new Map();
  for (const item of eligible) {
    const productId = String(item.createdProductId || item.existingProductId);
    if (!byProduct.has(productId)) byProduct.set(productId, item);
  }

  // Дедлайн і момент відкриття зафіксовані проведенням і живуть на накладній.
  // Саме тому довідновлення напівстворених хвиль не роздає групам різні дедлайни
  // і не подовжує вікно кожним ретраєм — на відміну від старої схеми, де
  // closesAt рахувався від «зараз» на кожному виклику.
  const openedAt = receipt.supplementOpenedAt ? new Date(receipt.supplementOpenedAt) : new Date();
  const closesAt = new Date(receipt.supplementClosesAt);

  const deliveryGroupId = String(receipt.targetDeliveryGroupId);

  const docs = [];
  for (const [productId, item] of byProduct) {
    docs.push({
      receiptId,
      receiptItemId: item._id,
      productId,
      deliveryGroupId,
      openedAt,
      closesAt,
      status: 'open',
    });
  }

  // Вставляємо по одному, а не insertMany({ordered:false}): документів одиниці
  // (по одному на товар), зате видно ТОЧНО, що створилось, що впало дублікатом,
  // а що не вдалося. Саме зі списку створених іде Telegram-розсилка.
  //
  // ВАЖЛИВО: збій на одному документі НЕ перериває решту і НЕ кидає помилку
  // назовні. Накладна вже проведена (транзакція закомічена), відкотити її не
  // можна, а зупинитися посередині означало б: частина товарів хвилі видима,
  // частина ні, і ніхто ніколи не дізнається. Тому доробляємо все, що можемо,
  // а недороблене лишаємо позначеним для звірятеля (див. reconcilePendingReceipts).
  const created = [];
  let duplicates = 0;
  let failed = 0;
  for (const doc of docs) {
    try {
      created.push(await SupplementOffer.create(doc));
    } catch (err) {
      if (err?.code === 11000) { duplicates += 1; continue; }
      failed += 1;
      console.error('[supplement] не вдалося створити пропозицію', doc.productId, '→', doc.deliveryGroupId, ':', err?.message);
    }
  }
  if (duplicates) {
    console.log(`[supplement] накладна ${String(receiptId)}: ${duplicates} пропозицій уже існували — пропущено`);
  }

  // Раніше тут був цілий блок «оживити сесію, яка завершилась під час відкриття
  // хвилі» (transitionPickingStatus з allowReopen). Він більше не потрібен: хвиля
  // до сесії не прив'язана, тому завершена сесія їй не заважає, а її власний
  // цикл open → frozen → completed доводить роботу до кінця сам.
  const complete = failed === 0;
  await Receipt.updateOne(
    { _id: receiptId },
    { $set: { supplementStatus: complete ? 'ready' : 'pending' } },
  );
  if (!complete) {
    console.error(`[supplement] накладна ${String(receiptId)}: ${failed} пропозицій НЕ створено — позначено на повтор`);
  }

  return { created, complete };
}

/**
 * Звірятель напівстворених хвиль.
 *
 * Накладна проводиться в транзакції, а пропозиції створюються після неї — тож
 * падіння Mongo, мережі чи процесу в цьому проміжку лишає накладну проведеною
 * без (частини) пропозицій. Повторно провести її вже неможливо: вона completed.
 * Цей прохід — єдине, що реально доводить справу до кінця.
 *
 * Викликається планувальником на кожному тіку. Дешевий: індекс по
 * supplementStatus, у нормі знаходить нуль документів.
 *
 * ВАЖЛИВО про дедлайн: повтор бере closesAt із самої накладної, тобто той, що
 * був зафіксований при проведенні. Хвиля не подовжується від того, що її
 * довелося довідновлювати — інакше кожен ретрай зсував би дедлайн уперед, і
 * повідомлення «закриється о 12:48» розходилося б із реальністю.
 * Наслідок, який варто пам'ятати: якщо процес пролежав довше за вікно, хвиля
 * відкриється вже простроченою і планувальник заморозить її наступним тіком.
 */
async function reconcilePendingReceipts() {
  const stuck = await Receipt.find({ supplementStatus: 'pending' }, '_id receiptNumber').limit(20).lean();
  if (!stuck.length) return 0;

  let repaired = 0;
  for (const receipt of stuck) {
    try {
      const { created, complete } = await createOffersForReceipt(receipt._id);
      if (created.length) {
        // Розсилка йде тим самим шляхом, що й у звичайному відкритті.
        const { notifyOffers } = require('./supplementNotify');
        notifyOffers(created, 'opened').catch((e) =>
          console.error('[supplement] розсилка після довідновлення впала:', e?.message));
        for (const offer of created) {
          emit('supplement_opened', {
            offerId: String(offer._id),
            deliveryGroupId: String(offer.deliveryGroupId),
            closesAt: offer.closesAt,
          });
        }
      }
      if (complete) repaired += 1;
      console.log(`[supplement] довідновлено накладну ${receipt.receiptNumber}: +${created.length} пропозицій`);
    } catch (err) {
      console.error('[supplement] довідновлення накладної', receipt.receiptNumber, 'впало:', err?.message);
    }
  }
  return repaired;
}

// ─── Фізичне місце товару (§9) ───────────────────────────────────────────────

/**
 * Де товар лежить ЗАРАЗ: у звичайному блоці чи ще в «Надходженнях».
 * Віртуальний блок описує ТИП роботи, а не адресу, тому картка має показувати
 * справжнє місце і оновлювати його, коли склад розкладає товар по полицях.
 *
 * @returns {Promise<Map<string, {blockId:number, positionIndex:number}|null>>}
 */
async function resolveProductLocations(productIds = []) {
  const ids = [...new Set(productIds.map(String))].filter(Boolean);
  const out = new Map(ids.map((id) => [id, null]));
  if (!ids.length) return out;

  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!objectIds.length) return out;

  const blocks = await Block.find({ productIds: { $in: objectIds } }, 'blockId productIds').lean();
  for (const block of blocks) {
    (block.productIds || []).forEach((pid, index) => {
      const key = String(pid);
      if (!out.has(key)) return;
      // positionIndex — 1-based, як у PickingTask (services/taskBuilder.js).
      out.set(key, { blockId: block.blockId, positionIndex: index + 1 });
    });
  }
  return out;
}

function formatLocation(location) {
  if (!location) return 'Надходження';
  return `Блок ${location.blockId}, позиція ${location.positionIndex}`;
}

// ─── Збірка відповіді API ────────────────────────────────────────────────────

function productView(product) {
  if (!product) return { productId: null, title: 'Товар недоступний', imageUrl: null, price: 0 };
  return {
    productId: String(product._id),
    title: getProductTitle(product),
    imageUrl: (Array.isArray(product.imageUrls) && product.imageUrls[0]) || product.localImageUrl || null,
    price: Number(product.price || 0),
    aiDescription: product.aiDescription || '',
  };
}

/**
 * Картка пропозиції для складу: товар + фізичне місце + повний список магазинів.
 * `requests` уже відсортовані викликачем за номером коробки.
 */
function offerViewForWarehouse(offer, { product, requests = [], location = null, boxNumberFor = () => null, now = new Date() }) {
  const status = effectiveOfferStatus(offer, now);
  const rows = requests.map((r) => ({
    requestId: String(r._id),
    shopId: String(r.shopId),
    shopName: r.shopName || '',
    // null — номер коробки ще НЕ призначено. Клієнт мусить показати це як
    // «немає номера» і не давати пакувати цей рядок. Вигадувати номер з позиції
    // в списку не можна: працівник поклав би товар у коробку 3, а магазину за
    // хвилину дісталася б коробка 27.
    shopNumber: boxNumberFor(r),
    quantity: r.quantity,
    packed: !!r.packed,
    packedByName: r.packedByName || '',
    packedAt: r.packedAt || null,
  }));
  rows.sort((a, b) => (a.shopNumber ?? Infinity) - (b.shopNumber ?? Infinity)
    || String(a.shopName).localeCompare(String(b.shopName), 'uk'));

  return {
    offerId: String(offer._id),
    status,
    openedAt: offer.openedAt,
    closesAt: offer.closesAt,
    deliveryGroupId: String(offer.deliveryGroupId),
    product: productView(product),
    location: location ? { ...location, label: formatLocation(location) } : { blockId: null, positionIndex: null, label: formatLocation(null) },
    shops: rows,
    totalQty: rows.reduce((s, r) => s + Number(r.quantity || 0), 0),
    packedCount: rows.filter((r) => r.packed).length,
    // Хто тримає пропозицію в руках. Клієнт вирішує за цим, показати картку в
    // роботі чи «зайнято колегою».
    lockedBy: offer.lockedBy ? String(offer.lockedBy) : null,
    lockedAt: offer.lockedAt || null,
    // Сервер сам каже, чи можна завершувати — клієнт не має відтворювати правило.
    canComplete: status === 'frozen' && rows.length > 0 && rows.every((r) => r.packed),
  };
}

// ─── Переходи статусів ───────────────────────────────────────────────────────

function emit(event, payload) {
  try {
    const io = getIO();
    if (io) io.emit(event, payload);
  } catch { /* сокет може бути вимкнений у тестах */ }
}

// ─── Серіалізація операцій над однією пропозицією ────────────────────────────

/**
 * ВСІ зміни, що стосуються однієї пропозиції, проходять через цей замок:
 * створення/зміна/скасування заявки продавцем, галочка складу, заморозка,
 * авто-завершення і «Спакував».
 *
 * Без нього кожна пара з них — гонка, і всі вони закінчуються фізичною
 * розбіжністю, а не просто дивним записом у базі:
 *
 *   • продавець читає packed=false → склад ставить packed=true і кладе 2 шт →
 *     запит продавця зберігає quantity=6. У коробці 2, у системі 6.
 *   • те саме з видаленням: заявка зникає, товар уже лежить у коробці.
 *   • запит, що почався за 50 мс до дедлайну, дописує заявку в пропозицію, яку
 *     планувальник уже заморозив і закрив як порожню — заявка є, картки немає,
 *     склад її ніколи не побачить.
 *   • склад перевірив «усі спаковані» → колега зняв галочку → перший завершує
 *     пропозицію з одним необробленим магазином.
 *
 * Redis робить замок наскрізним для всіх воркерів; без Redis він вироджується
 * в мьютекс процесу — що коректно, бо index.js відмовляється стартувати з
 * WEB_CONCURRENCY>1 без REDIS_URL.
 */
function withOfferLock(offerId, fn) {
  return withLock(`supplement:${String(offerId)}`, fn, { ttlMs: 10_000, waitMs: 5_000 });
}

// Скільки пропозиція може «висіти» за складником, який пішов і не закрив картку.
// Той самий поріг, що й для перехоплення звичайної задачі (pickingService).
const LOCK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Взяти пропозицію в роботу. Одна пропозиція — один складник (див. коментар у
 * моделі про подвійне пакування).
 *
 * Ідемпотентно для власника: повторне відкриття картки тим самим працівником
 * лише оновлює lockedAt (heartbeat). Прострочений чужий замок перехоплюється
 * автоматично — інакше людина, яка пішла додому з відкритою карткою, заблокувала
 * б товар до кінця зміни.
 *
 * @returns {{ ok: boolean, offer?: object, lockedBy?: string }}
 */
async function claimOffer(offerId, telegramId, now = new Date()) {
  const me = String(telegramId || '');
  const staleBefore = new Date(now.getTime() - LOCK_TIMEOUT_MS);

  const claimed = await SupplementOffer.findOneAndUpdate(
    {
      _id: offerId,
      status: { $in: ACTIVE_STATUSES },
      $or: [
        { lockedBy: null },
        { lockedBy: me },
        { lockedAt: { $lt: staleBefore } },
      ],
    },
    { $set: { lockedBy: me, lockedAt: now } },
    { new: true },
  );
  if (claimed) return { ok: true, offer: claimed };

  const existing = await SupplementOffer.findById(offerId, 'lockedBy status').lean();
  if (!existing) return { ok: false, reason: 'supplement_offer_not_found' };
  if (existing.status === 'completed') return { ok: false, reason: 'supplement_closed' };
  return { ok: false, reason: 'supplement_locked_by_other', lockedBy: String(existing.lockedBy || '') };
}

/** Відпустити пропозицію (закрили картку). Тільки власник — чужий замок не чіпаємо. */
async function releaseOffer(offerId, telegramId) {
  await SupplementOffer.updateOne(
    { _id: offerId, lockedBy: String(telegramId || '') },
    { $set: { lockedBy: null, lockedAt: null } },
  );
}

/**
 * Заморозити всі пропозиції, дедлайн яких минув. CAS-фільтр status:'open'
 * гарантує, що два воркери не заморозять одну пропозицію двічі.
 * @returns {Promise<Array>} щойно заморожені пропозиції.
 */
async function freezeDueOffers(now = new Date()) {
  const due = await SupplementOffer.find(
    { status: 'open', closesAt: { $lte: now } },
    '_id deliveryGroupId productId closesAt notifiedTypes',
  ).lean();

  const frozen = [];
  for (const o of due) {
    // Під замком: інакше заморозка може стати між перевіркою дедлайну і
    // вставкою заявки в запиті продавця, який почався до closesAt — і заявка
    // осіла б у вже замороженій (а то й закритій) пропозиції.
    const updated = await withOfferLock(o._id, () => SupplementOffer.findOneAndUpdate(
      { _id: o._id, status: 'open' },
      { $set: { status: 'frozen', frozenAt: now } },
      { new: true },
    ));
    if (updated) frozen.push(updated);
  }

  for (const o of frozen) {
    emit('supplement_frozen', {
      offerId: String(o._id),
      deliveryGroupId: String(o.deliveryGroupId),
    });
  }
  return frozen;
}

/**
 * Пропозиція, яку ніхто не замовив, після дедлайну закривається сама і зникає з
 * віртуального блока — складу нема чого робити (§7, §22 тест 10).
 * @returns {Promise<number>} скільки закрито.
 */
async function autoCompleteEmptyOffers(now = new Date()) {
  const frozen = await SupplementOffer.find(
    { status: 'frozen' },
    '_id deliveryGroupId',
  ).lean();

  let closed = 0;
  for (const o of frozen) {
    // Перевірка «заявок немає» і закриття мусять бути однією операцією: запит
    // продавця, що стартував до дедлайну, міг саме зараз дописувати заявку.
    // Без замка ми закрили б пропозицію, а заявка лишилась би всередині
    // завершеної — магазин її бачить, склад ніколи не побачить.
    const updated = await withOfferLock(o._id, async () => {
      if (await SupplementRequest.exists({ offerId: o._id })) return null;
      return SupplementOffer.findOneAndUpdate(
        { _id: o._id, status: 'frozen' },
        { $set: { status: 'completed', completedAt: now, lockedBy: null, lockedAt: null } },
        { new: true },
      );
    });
    if (!updated) continue;
    closed += 1;
    emit('supplement_completed', {
      offerId: String(o._id),
      deliveryGroupId: String(o.deliveryGroupId),
      reason: 'empty',
    });
  }
  return closed;
}

/**
 * «Спакував» — фінальне закриття пропозиції складом.
 *
 * Усі умови перевіряються СЕРВЕРОМ (§21):
 *   • пропозиція існує і ще не completed;
 *   • ефективний статус = frozen (до дедлайну завершувати не можна, §18);
 *   • кожна заявка магазину позначена packed.
 *
 * @throws {Error} з .code: supplement_offer_not_found | supplement_not_frozen |
 *                          supplement_not_all_packed | supplement_no_requests
 */
async function completeOffer(offerId, actor = {}, now = new Date()) {
  // Увесь блок «перевірити → закрити» під замком. Інакше між читанням заявок і
  // записом статусу колега встигав би зняти галочку (пропозиція закрилася б із
  // необробленим магазином), а запит продавця з-перед дедлайну — дописати нову
  // заявку всередину вже завершеної пропозиції.
  const offer = await withOfferLock(offerId, async () => {
    const doc = await SupplementOffer.findById(offerId);
    if (!doc) throw Object.assign(new Error('offer not found'), { code: 'supplement_offer_not_found' });
    if (doc.status === 'completed') return doc; // ідемпотентно

    if (effectiveOfferStatus(doc, now) !== 'frozen') {
      throw Object.assign(new Error('offer not frozen'), { code: 'supplement_not_frozen' });
    }

    const requests = await SupplementRequest.find({ offerId: doc._id }, 'packed').lean();
    if (!requests.length) throw Object.assign(new Error('no requests'), { code: 'supplement_no_requests' });
    if (requests.some((r) => !r.packed)) {
      throw Object.assign(new Error('not all packed'), { code: 'supplement_not_all_packed' });
    }

    // Статус ще міг бути 'open' (дедлайн минув, планувальник не встиг) — обидва
    // варіанти допустимі, бо ефективний статус уже перевірено. Замок знімаємо
    // разом із закриттям: тримати завершену пропозицію «в руках» немає сенсу.
    return SupplementOffer.findOneAndUpdate(
      { _id: doc._id, status: { $ne: 'completed' } },
      {
        $set: {
          status: 'completed',
          completedAt: now,
          frozenAt: doc.frozenAt || now,
          completedBy: String(actor.by || ''),
          completedByName: String(actor.byName || ''),
          lockedBy: null,
          lockedAt: null,
        },
      },
      { new: true },
    ) || doc;
  });

  emit('supplement_completed', {
    offerId: String(offer._id),
    deliveryGroupId: String(offer.deliveryGroupId),
    reason: 'packed',
  });

  return offer;
}

// ─── Лічильники / вибірки ────────────────────────────────────────────────────

/**
 * Скільки хвиль групи ще в роботі — лічильник плитки віртуального блока
 * (routes/picking.js). Best-effort: підрахунок не має ламати екран збирання.
 */
async function countActiveOffersForGroup(deliveryGroupId) {
  if (!deliveryGroupId) return 0;
  try {
    return await SupplementOffer.countDocuments({
      deliveryGroupId: String(deliveryGroupId),
      status: { $in: ACTIVE_STATUSES },
    });
  } catch (err) {
    console.warn('[supplement] підрахунок дозамовлень не вдався:', err?.message);
    return 0;
  }
}

/**
 * Активні пропозиції групи — вміст віртуального блока (§8).
 *
 * Раніше вибірка додатково фільтрувалась по orderingSessionId, «щоб зависла
 * frozen-пропозиція минулого циклу не домішалась до сьогоднішніх». Тепер такого
 * стану не буває в принципі: заморожена хвиля без заявок закривається сама, а з
 * заявками — після того, як склад їх спакував. Отже все, що тут є, і є роботою.
 */
async function findActiveOffersForGroup(deliveryGroupId) {
  if (!deliveryGroupId) return [];
  return SupplementOffer.find({
    deliveryGroupId: String(deliveryGroupId),
    status: { $in: ACTIVE_STATUSES },
  }).sort({ closesAt: 1, createdAt: 1 }).lean();
}

/** Товари пропозицій одним запитом (картки і каталог продавця). */
async function loadProductsFor(offers = []) {
  const ids = [...new Set(offers.map((o) => String(o.productId)))];
  if (!ids.length) return new Map();
  const products = await Product.find(
    { _id: { $in: ids } },
    '_id name brand model category warehouse orderNumber price imageUrls localImageUrl aiDescription',
  ).lean();
  return new Map(products.map((p) => [String(p._id), p]));
}

module.exports = {
  ACTIVE_STATUSES,
  LOCK_TIMEOUT_MS,
  effectiveOfferStatus,
  isOfferOpenForSellers,
  createOffersForReceipt,
  reconcilePendingReceipts,
  resolveProductLocations,
  formatLocation,
  productView,
  offerViewForWarehouse,
  withOfferLock,
  claimOffer,
  releaseOffer,
  freezeDueOffers,
  autoCompleteEmptyOffers,
  completeOffer,
  countActiveOffersForGroup,
  findActiveOffersForGroup,
  loadProductsFor,
};

'use strict';

const mongoose = require('mongoose');

/**
 * «Дозамовлення» — a supplementary-order OFFER of ONE product to ONE delivery
 * group whose normal ordering window has already closed.
 *
 * Спека (Zlotoweczka_Dozamovlennia, §19) називає цю сутність `LateOrderOffer`.
 * Тут вона `SupplementOffer` СВІДОМО: у проєкті вже є services/lateOrderReconcile.js,
 * і там «late order» означає зовсім інше — звичайне замовлення, що приїхало ПІСЛЯ
 * старту збирання і чіпляється до відкритої PickingTask. Дві різні речі з одним
 * іменем гарантовано переплутали б. Сокет-події теж `supplement_*`.
 *
 * Життєвий цикл (§7), СПРОЩЕНИЙ проти спеки за рішенням власника (05.08.2026):
 *
 *   open ──(closesAt минув)──► frozen ──(усі заявки спаковані)──► completed
 *                                  └──(заявок немає)────────────► completed
 *
 * `cancelled` НЕ реалізовано: адміністративного скасування (§16) у першій версії
 * немає — склад просто відмічає магазини і закриває пропозицію. Так само немає
 * OOS / часткового виконання (§14, §24).
 *
 * TODO (свідомо відкладено, §14/§24): облік залишку (available/reserved), розподіл
 * при нестачі, OOS/часткове виконання, адміністративне скасування з cleanup.
 *
 * ІНВАРІАНТ: frozen визначає СЕРВЕР за closesAt, ніколи не таймер браузера (§18).
 * Планувальник (services/supplementScheduler.js) переводить статус, але кожна
 * операція додатково звіряється з closesAt — див. effectiveOfferStatus() у
 * services/supplementOffers.js, щоб 15-секундне вікно між дедлайном і тіком
 * планувальника не давало двох різних відповідей.
 */
const SupplementOfferSchema = new mongoose.Schema(
  {
    // Звідки приїхав товар — накладна і конкретна її позиція з галочкою.
    receiptId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Receipt', required: true },
    receiptItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReceiptItem', required: true },
    // Складський Product, створений/оновлений проведенням накладної. Товар живе
    // звичайним життям (Надходження → полиця) незалежно від цієї пропозиції (§9).
    productId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },

    // Пропозиція ЗАВЖДИ прив'язана і до групи, і до конкретної сесії доставки:
    // в один день можуть збиратися кілька груп, тому дати/дня тижня замало (§5).
    deliveryGroupId:   { type: String, required: true },
    orderingSessionId: { type: String, required: true },

    openedAt: { type: Date, default: Date.now },
    // Дедлайн ФІКСУЄТЬСЯ тут при створенні. Зміна глобального налаштування
    // тривалості НЕ рухає дедлайн уже відкритих пропозицій (§6).
    closesAt: { type: Date, required: true },

    status: { type: String, enum: ['open', 'frozen', 'completed'], default: 'open' },
    frozenAt:    { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // ── Хто зараз пакує цю пропозицію ────────────────────────────────────────
    // Спершу віртуальний блок був задуманий БЕЗ блокування («хай пакують
    // паралельно»). Це давало тихе подвійне пакування: двоє відкривають той
    // самий товар, обидва бачать «Магазин №12 — 4 шт, не спаковано», обидва
    // кладуть по 4 і обидва тиснуть галочку. У базі один packed=true — вона
    // навіть не помічає дубля, а в коробці 8 штук замість 4.
    //
    // Тому — та сама модель, що й у звичайному збиранні: одна пропозиція
    // одночасно в руках одного складника. Знімається при закритті картки, за
    // таймаутом (LOCK_TIMEOUT_MS) або перехопленням.
    lockedBy: { type: String, default: null },
    lockedAt: { type: Date,   default: null },
    // Хто натиснув «Спакував» (порожньо для авто-завершення пропозиції без заявок).
    completedBy:     { type: String, default: null },
    completedByName: { type: String, default: '' },

    // Ідемпотентність Telegram-розсилки (§21, тест 18): рестарт сервера або
    // повторний тік планувальника не має дублювати повідомлення. Замість окремої
    // колекції NotificationLog (§19) — множина вже надісланих типів на самій
    // пропозиції; кожен запис ставиться атомарним $addToSet із фільтром «ще немає».
    // Значення: 'opened' | 'mid' | 'soon' | 'frozen'.
    notifiedTypes: { type: [String], default: [] },
  },
  { timestamps: true },
);

// «Ще не доведена до кінця» — те, що бачить склад у віртуальному блоці (§8) і
// що блокує завершення сесії (§17). Живе на моделі, щоб гард у
// utils/sessionStatus.js не мусив тягнути весь сервіс і плодити цикл require.
SupplementOfferSchema.statics.ACTIVE_STATUSES = ['open', 'frozen'];

// Ідемпотентне створення (§21): одна позиція накладної → максимум одна пропозиція
// на групу. Повторне проведення накладної не створює другу.
SupplementOfferSchema.index({ receiptItemId: 1, deliveryGroupId: 1 }, { unique: true });

// ОДИН ТОВАР — ОДНА ЖИВА КАРТКА в групі. Ключ вище цього не гарантує: у накладній
// цілком законно бувають ДВІ позиції на той самий існуючий товар (у commit навіть
// є окремий захист від подвійного нарахування залишку). Без цього індексу магазин
// побачив би «Печиво XYZ» двома картками і замовив би до 6 у кожній, а склад —
// дві задачі на один товар. Другу вставку ловимо як E11000 і пропускаємо.
// Обмеження свідоме: поки перша хвиля цього товару не закрита, друга накладна не
// відкриє на нього нову пропозицію — залишок просто доллється в той самий Product.
SupplementOfferSchema.index(
  { productId: 1, deliveryGroupId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['open', 'frozen'] } } },
);
// Віртуальний блок складу: «активні пропозиції цієї групи».
SupplementOfferSchema.index({ deliveryGroupId: 1, status: 1 });
// Гард завершення сесії (§17): «чи лишились активні пропозиції цієї сесії».
SupplementOfferSchema.index({ orderingSessionId: 1, status: 1 });
// Планувальник заморозки: «відкриті, дедлайн яких минув».
SupplementOfferSchema.index({ status: 1, closesAt: 1 });

module.exports = mongoose.model('SupplementOffer', SupplementOfferSchema);

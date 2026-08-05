'use strict';

const mongoose = require('mongoose');

const SupplementRequestHistorySchema = new mongoose.Schema(
  {
    at:     { type: Date, default: Date.now },
    by:     { type: String, default: '' },
    byName: { type: String, default: '' },
    byRole: { type: String, default: '' },
    action: { type: String, required: true }, // created | quantity_changed | cancelled | packed | unpacked
    meta:   { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

/**
 * Одна заявка ОДНОГО магазину на одну пропозицію дозамовлення.
 * Спека (§19) називає це `LateOrderRequest` — див. пояснення перейменування
 * у models/SupplementOffer.js.
 *
 * ВЛАСНИК ЗАЯВКИ — МАГАЗИН, не продавець (§10, §18). Якщо в магазині кілька
 * продавців, вони бачать і редагують ОДНУ кількість; хто саме створив/останнім
 * змінив — лише аудит (createdBy/updatedBy). Унікальний індекс {offerId, shopId}
 * робить це інваріантом на рівні БД, а не домовленістю: подвійний тап або два
 * продавці одночасно не створять дубль (§21).
 *
 * ОКРЕМИЙ ДОКУМЕНТ НА МАГАЗИН (а не масив у пропозиції) — свідомо (§12, §19):
 * список змінюється в реальному часі, поки склад паралельно ставить галочки.
 * Один спільний масив означав би, що автозбереження галочок перезапише щойно
 * додану заявку. Тут кожен рядок пишеться атомарно і незалежно.
 *
 * `packed` — ЖОРСТКЕ БЛОКУВАННЯ (рішення власника 05.08.2026, замість §13):
 * щойно склад позначив магазин спакованим, продавець більше не може змінити чи
 * скасувати заявку — навіть поки пропозиція ще open. Це прибирає цілий клас
 * розбіжностей «у коробці 2, у системі 6» без службових рядків і звірок.
 * Знята галочка повертає заявку в редагований стан.
 */
const SupplementRequestSchema = new mongoose.Schema(
  {
    offerId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementOffer', required: true },
    shopId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true },
    // Знімок назви магазину — щоб картка складу і «Мої замовлення» не робили
    // populate на кожен рядок. Живе ім'я все одно перекриває його при показі.
    shopName: { type: String, default: '' },
    // Денормалізований ключ пропозиції: дозволяє вибрати «усі заявки моєї групи»
    // одним запитом, без $lookup. Сесії тут немає — хвиля до неї не прив'язана
    // (див. models/SupplementOffer.js).
    deliveryGroupId: { type: String, default: '' },

    // 1..6 — та сама межа, що й у звичайному каталозі (§10).
    quantity: { type: Number, required: true, min: 1, max: 6 },

    packed:       { type: Boolean, default: false },
    packedBy:     { type: String, default: '' },
    packedByName: { type: String, default: '' },
    packedAt:     { type: Date,   default: null },

    createdBy:     { type: String, default: '' },
    createdByName: { type: String, default: '' },
    updatedBy:     { type: String, default: '' },
    updatedByName: { type: String, default: '' },

    // Аудит (§19 LateOrderAudit) — обмежений масив на самому рядку замість
    // окремої колекції: заявка живе години, змін одиниці, окрема колекція з TTL
    // була б чистою вагою для БД.
    history: { type: [SupplementRequestHistorySchema], default: [] },
  },
  { timestamps: true },
);

// ОДНА заявка на (пропозиція, магазин) — інваріант §21.
SupplementRequestSchema.index({ offerId: 1, shopId: 1 }, { unique: true });
// Нумерація коробок на старті збирання: «які магазини групи вже дозамовили».
SupplementRequestSchema.index({ deliveryGroupId: 1, shopId: 1 });
// «Мої замовлення» продавця.
SupplementRequestSchema.index({ shopId: 1, createdAt: -1 });

module.exports = mongoose.model('SupplementRequest', SupplementRequestSchema);

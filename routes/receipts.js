const express = require('express');
const mongoose = require('mongoose');
const Busboy = require('busboy');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const { requireTelegramRoles } = require('../middleware/telegramAuth');
const Receipt = require('../models/Receipt');
const ReceiptItem = require('../models/ReceiptItem');
const Product = require('../models/Product');
const ShopProduct = require('../models/ShopProduct');
const ProductVector = require('../models/ProductVector');
const SupplementOffer = require('../models/SupplementOffer');
const SupplementWave = require('../models/SupplementWave');
const Block = require('../models/Block');
const ReceiptItemLog = require('../models/ReceiptItemLog');
const DeliveryGroup = require('../models/DeliveryGroup');
const Counter = require('../models/Counter');
const { getIO } = require('../socket');
const { upsertShopOwnedFromReceiptItem, syncMirror } = require('../utils/upsertShopProduct');
const { embedShopProductAsync } = require('../utils/shopProductEmbedding');
const { embedProductAsync } = require('../utils/productEmbedding');
const { getGeminiStatus } = require('../geminiClient');
const { describeImageUrl } = require('../utils/productDescribe');
const { appError, asyncHandler } = require('../utils/errors');
const { withLock } = require('../utils/lock');
const { withProductOrderNumberLock } = require('../services/productOrderNumber');
const {
  RECEIPT_ITEM_SUPPLEMENT_STATE,
  blocksGenericRepublish,
  deriveReceiptItemSupplementState,
  findActiveReceiptItemSupplementOffer,
  hasCompletedLifecycle,
  isTerminalReceiptItemSupplementState,
} = require('../utils/supplementState');
const { normalizeReceiptPhotoMeta, photoCommentsText } = require('../utils/receiptPhotoMeta');
const { buildWarsawDateRange } = require('../utils/warsawDateTime');
const {
  blankRouting,
  normalizeReceiptItemRouting,
  legacyDestinationForRouting,
  needsWarehouseProduct,
  needsStandaloneShopProduct,
  validateReceiptItemRouting,
  isNormalOrderingEnabled,
} = require('../utils/receiptRouting');
const {
  assertCanEditItem,
  assertCanDeleteItem,
  assertCanConfirmItem,
  assertItemReadyForRouting,
  assertItemReadyToConfirm,
} = require('../utils/receiptPermissions');
// Проведена накладна редагується так само, як відкрита; весь контракт
// «правка позиції → товар, дзеркало, вектор, дозамовлення» живе в одному місці.
const {
  labelPositionsFromMeta,
  snapshotItem,
  describeItemUsage,
  propagateItemEdit,
  rollbackItemArtifacts,
  hasOpenSupplementWave,
} = require('../services/receiptSync');

const staffOnly = requireTelegramRoles(['admin', 'warehouse']);
const RECEIPT_GALLERY_FIELDS = '_id receiptId photoUrl originalPhotoUrl totalQty destination routingVersion routing price qtyPerPackage status createdBy editRevision routingRevision supplementBatchVersion supplementPublishRequestedAt telegramNewProduct.status telegramNewProduct.appliedHash telegramNewProduct.desiredHash telegramNewProduct.lastDecision telegramNewProduct.lastDecisionHash telegramNewProduct.lastDecisionAt telegramNewProduct.sentAt telegramNewProduct.editedAt telegramNewProduct.requestedAt telegramNewProduct.lastError telegramNewProduct.possibleDuplicate';

async function supplementGroupNamesByWaveForOffers(offers = []) {
  const waveIds = [...new Set(offers
    .map((offer) => String(offer?.waveId || ''))
    .filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!waveIds.length) return new Map();
  const waves = await SupplementWave.find(
    { _id: { $in: waveIds } },
    '_id deliveryGroupId',
  ).lean();
  const groupIds = [...new Set(waves
    .map((wave) => String(wave.deliveryGroupId || ''))
    .filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!groupIds.length) return new Map();
  const groups = await DeliveryGroup.find({ _id: { $in: groupIds } }, '_id name').lean();
  const groupNameById = new Map(groups.map((group) => [String(group._id), group.name || '']));
  return new Map(waves.map((wave) => [
    String(wave._id),
    groupNameById.get(String(wave.deliveryGroupId || '')) || '',
  ]));
}

const FIELD_LABELS = {
  totalQty: 'Приїхало',
  destination: 'Куди',
  price: 'Ціна',
  qtyPerPackage: 'В упаковці',
  qtyPerShop: 'На магазин',
  photoUrl: 'Фото',
};

const {
  ensureReceiptItemProduct,
  convertReceiptShopOwnedToWarehouseMirror,
} = require('../services/receiptRoutingArtifacts');

function getActor(req) {
  const u = req.telegramUser || {};
  return {
    telegramId: String(u.telegramId || ''),
    firstName: u.firstName || '',
    lastName: u.lastName || '',
  };
}

const s3Client = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

(async () => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }));
  } catch (err) {
  }
})();

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const fields = {};
    const files = [];

    busboy.on('field', (name, val) => { fields[name] = val; });
    busboy.on('file', (name, stream, info) => {
      const allowed = /^image\/(jpeg|png|webp|gif)$/i;
      if (!allowed.test(info.mimeType)) {
        stream.resume();
        return;
      }

      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        if (stream.truncated) {
          return reject(new Error('File size limit exceeded'));
        }
        files.push({ field: name, buffer: Buffer.concat(chunks), originalname: info.filename, mimetype: info.mimeType });
      });
    });

    busboy.on('close', () => resolve({ fields, files }));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

/** Build the public URL for an uploaded object in the given folder. */
function r2Url(folder, filename) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${folder}/${filename}`;
}

// Sanitize a client-supplied R2 filename (the photo/original are uploaded direct
// to R2 by the browser; only the filename comes back). Rejects path traversal.
function safeUploadName(v) {
  const s = String(v || '').trim();
  return /^[a-zA-Z0-9._-]+\.(jpg|jpeg|png|webp)$/i.test(s) ? s : '';
}

/** Parses a form-field string to a safe non-negative integer. Returns fallback on NaN/negative/missing. */
function parseIntField(val, fallback = 0) {
  const n = Math.trunc(Number(val));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseOptionalPositiveInt(val, fieldName = 'totalQty') {
  if (val === undefined) return undefined;
  if (val === null || String(val).trim() === '') return null;
  const normalized = typeof val === 'string' ? val.trim().replace(',', '.') : val;
  const n = Number(normalized);
  if (!Number.isInteger(n) || n < 1) throw appError('validation_failed', { field: fieldName });
  return n;
}


/**
 * Parses a form-field string to a finite number (price, qtyPerPackage).
 * Returns null if the field is absent or empty; throws validation_failed if
 * the value is present but not a finite number (NaN, Infinity, text).
 */
function parseNumberField(val, fieldName) {
  if (val === undefined || val === null || val === '') return null;
  const normalized = typeof val === 'string' ? val.trim().replace(',', '.') : val;
  const n = Number(normalized);
  if (!Number.isFinite(n)) throw appError('validation_failed', { field: fieldName });
  return n;
}

/** Parses a JSON array field. Returns [] when absent, string[] on success, null on bad JSON. */
function safeParseArray(val) {
  if (!val) return [];
  try {
    const arr = JSON.parse(val);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/** Parses a JSON object field. Returns null when absent, object on success, undefined on bad JSON. */
function safeParseObject(val) {
  if (val === undefined || val === '' || val === null) return null;
  try {
    const obj = JSON.parse(val);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : undefined;
  } catch {
    return undefined;
  }
}

const router = express.Router();

router.get('/', staffOnly, asyncHandler(async (req, res) => {
  const statusFilter = req.query.status;
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));

  const query = {};
  if (statusFilter) query.status = statusFilter;

  // UI dates are Warsaw calendar days. Do not let Date.parse() interpret
  // YYYY-MM-DD as UTC midnight: around local midnight that leaks receipts into
  // the adjacent day. The helper also handles 23/25-hour DST days correctly.
  const createdAt = buildWarsawDateRange({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });
  if (Object.keys(createdAt).length) query.createdAt = createdAt;

  // Free-text search by receipt number (escaped, case-insensitive).
  const q = String(req.query.q || '').trim();
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.receiptNumber = { $regex: escaped, $options: 'i' };
  }

  const SORTS = {
    date_desc: { createdAt: -1 },
    date_asc: { createdAt: 1 },
    number_desc: { receiptNumber: -1 },
    number_asc: { receiptNumber: 1 },
  };
  const sortSpec = SORTS[req.query.sort] || SORTS.date_desc;

  const [total, receipts] = await Promise.all([
    Receipt.countDocuments(query),
    Receipt.find(query)
      .sort(sortSpec)
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

  // Batch count items (one aggregate instead of N queries)
  const receiptIds = receipts.map((r) => r._id);
  const counts = await ReceiptItem.aggregate([
    { $match: { receiptId: { $in: receiptIds } } },
    { $group: { _id: '$receiptId', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [String(c._id), c.count]));
  const receiptsWithCounts = receipts.map((r) => ({ ...r, itemsCount: countMap.get(String(r._id)) || 0 }));

  res.json({
    receipts: receiptsWithCounts,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

// Read-only photo feed for the Receipts page. The full-photo view intentionally
// exposes only the small amount of context needed under the image and for the
// inline preparation: clean-original fallback, received quantity, normalized
// route inputs, preparation readiness/status and batch-publication state.
router.get('/items-gallery', staffOnly, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const query = { photoUrl: { $exists: true, $nin: ['', null] } };

  // Same Warsaw calendar semantics as the receipt list; filter by the
  // parent Receipt.createdAt, not by when an individual photo row was edited.
  const receiptCreatedAt = buildWarsawDateRange({
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  });

  if (Object.keys(receiptCreatedAt).length) {
    const receiptIds = await Receipt.distinct('_id', { createdAt: receiptCreatedAt });
    if (receiptIds.length === 0) {
      return res.json({ items: [], total: 0, page, pageSize, pageCount: 1 });
    }
    query.receiptId = { $in: receiptIds };
  }

  const [total, rows] = await Promise.all([
    ReceiptItem.countDocuments(query),
    ReceiptItem.find(query, RECEIPT_GALLERY_FIELDS)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);

  // Legacy supplement rows encoded their route on Receipt.type instead of the
  // item. Return that tiny compatibility hint so the client can label old photos
  // correctly without fetching N receipts.
  const receiptIds = [...new Set(rows.map((row) => String(row.receiptId || '')).filter(Boolean))];
  const receipts = receiptIds.length
    ? await Receipt.find(
        { _id: { $in: receiptIds } },
        '_id type status targetDeliveryGroupId',
      ).lean()
    : [];
  const rowIds = rows.map((row) => row._id);
  const supplementOffers = rowIds.length
    ? await SupplementOffer.find(
        { receiptItemId: { $in: rowIds }, waveId: { $ne: null } },
        'receiptItemId waveId status itemStatus openedAt frozenAt completedAt revisionHistory',
      ).lean()
    : [];
  const supplementGroupNameByWaveId = await supplementGroupNamesByWaveForOffers(supplementOffers);
  const offersByItemId = new Map();
  for (const offer of supplementOffers) {
    const itemId = String(offer.receiptItemId || '');
    offersByItemId.set(itemId, [...(offersByItemId.get(itemId) || []), offer]);
  }
  const receiptById = new Map(receipts.map((receipt) => [String(receipt._id), receipt]));
  const items = rows.map((row) => {
    const receipt = receiptById.get(String(row.receiptId || ''));
    const routing = normalizeReceiptItemRouting(row, receipt);
    const supplementState = deriveReceiptItemSupplementState({
      offers: offersByItemId.get(String(row._id)) || [],
      routingSupplement: routing.supplement,
      receiptCompleted: receipt?.status === 'completed',
    });
    const itemSupplementOffers = offersByItemId.get(String(row._id)) || [];
    const activeSupplementOffer = findActiveReceiptItemSupplementOffer(
      itemSupplementOffers,
      supplementState,
    );
    const displaySupplementOffer = activeSupplementOffer || itemSupplementOffers
      .filter(hasCompletedLifecycle)
      .sort((a, b) => new Date(b?.completedAt || b?.frozenAt || b?.openedAt || 0).getTime()
        - new Date(a?.completedAt || a?.frozenAt || a?.openedAt || 0).getTime())[0] || null;
    return {
      ...row,
      receiptType: receipt?.type || 'regular',
      receiptStatus: receipt?.status || 'draft',
      receiptTargetDeliveryGroupId: receipt?.targetDeliveryGroupId || null,
      supplementState,
      supplementGroupName: supplementGroupNameByWaveId.get(String(displaySupplementOffer?.waveId || '')) || '',
      telegramNewProduct: {
        ...(row.telegramNewProduct || {}),
        status: String(row.telegramNewProduct?.status || '') === 'expired'
          ? (Number(row.telegramNewProduct?.messageId) > 0 ? 'sent' : 'not_sent')
          : String(row.telegramNewProduct?.status || 'not_sent'),
      },
    };
  });

  res.json({
    items,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  });
}));

// Deep-link from a warehouse tile to receiving. Product._id is the navigation
// handle, but receiving exists only when a real ReceiptItem link exists. Products
// created outside receiving must keep the tile action disabled and may not create
// a synthetic/photo-only row inside the invoices screen.
router.get('/product-context/:productId', staffOnly, asyncHandler(async (req, res) => {
  const { productId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(productId)) throw appError('product_not_found');

  const product = await Product.findById(
    productId,
    '_id receiptItemId',
  ).lean();
  if (!product) throw appError('product_not_found');

  let item = product.receiptItemId
    ? await ReceiptItem.findById(product.receiptItemId, RECEIPT_GALLERY_FIELDS).lean()
    : null;
  if (!item) {
    item = await ReceiptItem.findOne(
      { createdProductId: product._id },
      RECEIPT_GALLERY_FIELDS,
    ).sort({ createdAt: -1 }).lean();
  }

  if (!item) throw appError('receipt_item_not_found');

  const receipt = await Receipt.findById(
    item.receiptId,
    '_id type targetDeliveryGroupId',
  ).lean();
  if (!receipt) throw appError('receipt_not_found');

  return res.json({
    productId: String(product._id),
    item: {
      ...item,
      receiptType: receipt.type || 'regular',
      receiptTargetDeliveryGroupId: receipt.targetDeliveryGroupId || null,
    },
  });
}));


// ── SUPPLEMENT GROUP-SESSION PUBLICATION ───────────────────────────────────
// Preparing/confirming a supplement product never sends Telegram by itself.
// V48.2 current rows are deliberately UNASSIGNED: workers mark all needed items
// as supplement first, then choose one delivery group. The command adds ready
// items to that group+session's single stable supplement container.
// Legacy V47.16 rows that already carry a group remain publishable.
router.get('/supplement-batches/pending', staffOnly, asyncHandler(async (_req, res) => {
  const rows = await ReceiptItem.find({
    status: 'confirmed',
    routingVersion: { $gte: 1 },
    'routing.supplement': true,
    supplementBatchVersion: { $gte: 1 },
  }, '_id receiptId routing.supplementDeliveryGroupId supplementBatchVersion supplementPublishRequestedAt').lean();

  const { describeSupplementTargets } = require('../services/supplementTargets');
  const targets = await describeSupplementTargets();
  if (!rows.length) {
    return res.json({ readyCount: 0, groups: [], targets: targets.groups || [], serverTime: targets.serverTime || new Date().toISOString() });
  }

  // Only a completed receiving document may enter a seller Wave. Supplement
  // lifecycle is item-global, not target-local: one ReceiptItem can have only one
  // OPEN/FROZEN publication, and after FROZEN/COMPLETED it never returns to the
  // generic ready pool. An OPEN publication cancelled as a correction is the only
  // state that may become ready again (possibly for another group).
  const receiptIds = [...new Set(rows.map((row) => String(row.receiptId)))];
  const completed = await Receipt.find(
    { _id: { $in: receiptIds }, status: 'completed' },
    '_id',
  ).lean();
  const completedIds = new Set(completed.map((receipt) => String(receipt._id)));
  const publishable = rows.filter((row) => completedIds.has(String(row.receiptId)));
  const itemIds = publishable.map((row) => row._id);

  const currentPublications = itemIds.length
    ? await SupplementOffer.find({
      receiptItemId: { $in: itemIds },
      waveId: { $ne: null },
    }, 'receiptItemId orderingSessionId status itemStatus revision frozenAt completedAt revisionHistory').lean()
    : [];
  const blocksRepublish = (row) => blocksGenericRepublish(row);
  const blockedItemIds = new Set(
    currentPublications.filter(blocksRepublish).map((row) => String(row.receiptItemId)),
  );
  const eligibleForTarget = (row, target) => {
    if (blockedItemIds.has(String(row._id))) return false;
    if (Number(row.supplementBatchVersion || 0) >= 2) return true;
    return String(row.routing?.supplementDeliveryGroupId || '') === String(target.deliveryGroupId || '');
  };

  const targetsWithCounts = (targets.groups || []).map((target) => {
    const readyCountForTarget = target.selectable && target.orderingSessionId
      ? publishable.filter((row) => eligibleForTarget(row, target)).length
      : 0;
    return { ...target, readyCount: readyCountForTarget };
  });

  // Compatibility only: batch-v1 rows that stored a group directly remain visible
  // until that group's exact current session contains the child item.
  const byTargetGroup = new Map(targetsWithCounts.map((target) => [String(target.deliveryGroupId), target]));
  const legacyCounts = new Map();
  for (const row of publishable) {
    if (Number(row.supplementBatchVersion || 0) !== 1) continue;
    const gid = String(row.routing?.supplementDeliveryGroupId || '').trim();
    const target = byTargetGroup.get(gid);
    if (!gid || !target?.orderingSessionId) continue;
    if (!eligibleForTarget(row, target)) continue;
    legacyCounts.set(gid, (legacyCounts.get(gid) || 0) + 1);
  }
  const groups = [...legacyCounts.entries()].map(([deliveryGroupId, count]) => {
    const target = byTargetGroup.get(deliveryGroupId) || {};
    return {
      deliveryGroupId,
      count,
      name: target.name || target.title || 'Група доставки',
      state: target.state || null,
      title: target.title || '',
      details: target.details || [],
      note: target.note || '',
      orderingSessionId: target.orderingSessionId || null,
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'uk'));

  const readyCount = targetsWithCounts.reduce((max, target) => Math.max(max, Number(target.readyCount || 0)), 0);
  res.json({
    readyCount,
    groups,
    targets: targetsWithCounts,
    serverTime: targets.serverTime || new Date().toISOString(),
  });
}));

router.post('/supplement-batches/:deliveryGroupId/publish', staffOnly, asyncHandler(async (req, res) => {
  const deliveryGroupId = String(req.params.deliveryGroupId || '').trim();
  if (!deliveryGroupId) throw appError('supplement_target_required');
  const expectedOrderingSessionId = String(req.body?.orderingSessionId || '').trim() || null;
  const actor = {
    by: String(req.telegramUser?.telegramId || ''),
    byName: [req.telegramUser?.firstName, req.telegramUser?.lastName].filter(Boolean).join(' '),
  };

  // Two different targets must not race over the same target-neutral ready pool. Once the
  // exact delivery cycle is resolved, publication also shares the session lifecycle
  // lock with completion so the Wave cannot appear concurrently with completed.
  const result = await withLock('supplement-batch:publish', async () => {
    const { resolveSupplementTarget } = require('../services/supplementTargets');
    const firstTarget = await resolveSupplementTarget(deliveryGroupId, { expectedOrderingSessionId });
    const { withSessionLifecycleLock } = require('../utils/sessionLifecycleLock');

    return withSessionLifecycleLock(firstTarget.orderingSessionId, async () => {
      const target = await resolveSupplementTarget(deliveryGroupId, {
        expectedOrderingSessionId: firstTarget.orderingSessionId,
      });

      const mongoSession = await mongoose.connection.startSession();
      let outcome = { selected: 0, offers: [], wave: null, target };
      try {
        await mongoSession.withTransaction(async () => {
          // Re-check the exact session inside the transaction as well. The external
          // lifecycle lock serialises this with maybeCompleteSession; this read makes
          // the invariant explicit in the transaction snapshot.
          const OrderingSession = require('../models/OrderingSession');
          const sessionDoc = await OrderingSession.findOne({
            _id: target.orderingSessionId,
            groupId: deliveryGroupId,
          }).session(mongoSession).lean();
          if (!sessionDoc) throw appError('supplement_target_session_changed', { group: target.groupName });
          if (sessionDoc.pickingStatus === 'completed') {
            const { hasReopenableSupplementCancellation } = require('../services/supplementTargets');
            const reopenable = await hasReopenableSupplementCancellation(target.orderingSessionId, { session: mongoSession });
            if (!reopenable) throw appError('supplement_target_session_completed', { group: target.groupName });
          }

          const candidates = await ReceiptItem.find({
            status: 'confirmed',
            routingVersion: { $gte: 1 },
            'routing.supplement': true,
            supplementBatchVersion: { $gte: 1 },
            $or: [
              // v2 stays target-neutral only while READY. The item-global fence
              // below prevents simultaneous targets and makes FROZEN/COMPLETED
              // terminal for future supplement publication.
              { supplementBatchVersion: { $gte: 2 } },
              // v1 compatibility remains pinned to its old per-item group.
              { supplementBatchVersion: 1, 'routing.supplementDeliveryGroupId': deliveryGroupId },
            ],
          }).session(mongoSession);
          if (!candidates.length) return;

          const receiptIds = [...new Set(candidates.map((row) => String(row.receiptId)))];
          const completed = await Receipt.find(
            { _id: { $in: receiptIds }, status: 'completed' },
            '_id',
          ).session(mongoSession).lean();
          const completedIds = new Set(completed.map((receipt) => String(receipt._id)));
          const publishable = candidates.filter((row) => completedIds.has(String(row.receiptId)));
          if (!publishable.length) return;

          const now = new Date();
          const ids = publishable.map((row) => row._id);

          // Item-global lifecycle is the publication fence. The old target-local
          // check allowed the same ReceiptItem to appear in several groups. Now an
          // Active OPEN/FROZEN work anywhere blocks a duplicate and COMPLETED is
          // final. Any CANCELLED revision is eligible for a clean re-target.
          const existingPublications = await SupplementOffer.find({
            receiptItemId: { $in: ids },
            waveId: { $ne: null },
          }, 'receiptItemId orderingSessionId status itemStatus revision frozenAt completedAt revisionHistory').session(mongoSession).lean();
          const blockedItemIds = new Set(
            existingPublications.filter(blocksGenericRepublish).map((row) => String(row.receiptItemId)),
          );
          const selectedRows = publishable.filter((row) => {
            return !blockedItemIds.has(String(row._id));
          });
          if (!selectedRows.length) return;

          // Archive is a physical fact, not a routing toggle. A ReceiptItem may
          // retain routing.supplement for history after its warehouse Product was
          // archived, but that archived Product can never be republished as a new
          // supplement revision.
          const selectedProductIds = selectedRows
            .map((row) => row.createdProductId)
            .filter(Boolean);
          if (selectedProductIds.length) {
            const archivedProduct = await Product.findOne({
              _id: { $in: selectedProductIds },
              status: 'archived',
            }, '_id').session(mongoSession).lean();
            if (archivedProduct) {
              throw appError('receipt_item_in_use', { reasons: 'товар уже в архіві — фізично видавати його більше не можна' });
            }
          }

          // A cancellation may have made this exact CURRENT delivery
          // session terminal. A real new publication is allowed to reopen only
          // that same current session, and only because persisted cancelled
          // supplement state proves why it closed.
          // Historical sessions are impossible here: resolveSupplementTarget already
          // pinned findCurrentSessionId and the lifecycle lock fences cycle rollover.
          if (sessionDoc.pickingStatus === 'completed') {
            const { transitionPickingStatus } = require('../utils/sessionStatus');
            const reopened = await transitionPickingStatus(
              target.orderingSessionId,
              'in_progress',
              { actor, meta: { reason: 'supplement_republished_after_cancel' }, allowReopen: true },
              mongoSession,
            );
            if (!reopened) throw appError('supplement_target_session_changed', { group: target.groupName });
            target.state = 'picking';
            target.reopenCompleted = false;
          }

          const selectedIds = selectedRows.map((row) => row._id);
          await ReceiptItem.updateMany(
            { _id: { $in: selectedIds }, supplementPublishRequestedAt: null },
            { $set: { supplementPublishRequestedAt: now } },
            { session: mongoSession },
          );

          const { createWaveWithItems } = require('../services/supplementWaveService');
          const created = await createWaveWithItems({
            deliveryGroupId,
            orderingSessionId: target.orderingSessionId,
            receiptItems: selectedRows,
            actor,
            now,
            session: mongoSession,
          });

          const involvedReceiptIds = [...new Set(selectedRows.map((row) => String(row.receiptId)))];
          await Receipt.updateMany(
            { _id: { $in: involvedReceiptIds } },
            { $set: { supplementStatus: 'ready' } },
            { session: mongoSession },
          );

          outcome = {
            selected: created.changedOffers.length,
            offers: created.changedOffers.map((doc) => doc.toObject ? doc.toObject() : doc),
            wave: created.wave?.toObject ? created.wave.toObject() : created.wave,
            target,
          };
        });
      } finally {
        await mongoSession.endSession();
      }
      return outcome;
    });
  }, { ttlMs: 30_000, waitMs: 10_000 });

  if (result.wave) {
    const waveId = String(result.wave._id);
    try {
      const wavePayload = {
        waveId,
        deliveryGroupId,
        orderingSessionId: result.target.orderingSessionId,
        itemCount: result.selected,
        status: 'open',
      };
      getIO()?.emit('supplement_wave_opened', wavePayload);
      getIO()?.emit('supplement_wave_changed', wavePayload);
      // Compatibility event lets old open clients refresh their lists during rollout.
      getIO()?.emit('supplement_opened', { waveId, deliveryGroupId });
    } catch (_) {}
    await require('../services/supplementNotify').notifyWaves([result.wave], 'opened').catch(() => {});
  }

  try { getIO()?.emit('receipt_supplement_batch_changed', { deliveryGroupId }); } catch (_) {}

  res.json({
    selectedCount: result.selected || 0,
    openedCount: result.selected || 0,
    waveId: result.wave?._id ? String(result.wave._id) : null,
    orderingSessionId: result.target?.orderingSessionId || null,
    deferred: false,
    repairPending: false,
  });
}));

router.get('/:id', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id).lean();
  if (!receipt) throw appError('receipt_not_found');
  res.json(receipt);
}));

router.delete('/:id', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.status !== 'draft') throw appError('receipt_only_draft_delete');

  const itemCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
  if (itemCount > 0) throw appError('receipt_only_empty_delete');

  await receipt.deleteOne();
  res.json({ message: 'Receipt deleted' });
}));

async function getNextReceiptNumber() {
  const counter = await Counter.findOneAndUpdate(
    { name: 'receiptNumber' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  );
  return `REC-${String(counter.seq).padStart(4, '0')}`;
}

const RECEIPT_TYPES = ['regular', 'supplement'];

async function bulkIntakeResponse(receipt) {
  const items = await ReceiptItem.find({ receiptId: receipt._id })
    .sort({ intakeIndex: 1, createdAt: 1, _id: 1 })
    .lean();
  return { receipt, items, createdCount: items.length };
}

// Modern receiving command. One multi-file selection becomes one technical,
// already-completed Receipt and N draft ReceiptItems. Workers operate on the
// photo cards; the Receipt exists only as a durable audit/container boundary.
// `batchId` makes an unknown HTTP result safe to retry without duplicate rows.
router.post('/bulk-intake', staffOnly, asyncHandler(async (req, res) => {
  const batchId = String(req.body?.batchId || '').trim();
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(batchId)) throw appError('receipt_bulk_batch_invalid');

  const incoming = Array.isArray(req.body?.items) ? req.body.items : [];
  if (incoming.length === 0) throw appError('receipt_bulk_empty');
  if (incoming.length > 100) throw appError('receipt_bulk_too_large');

  const seenClientIds = new Set();
  const items = incoming.map((row, index) => {
    const photoFilename = safeUploadName(row?.photoFilename);
    const originalFilename = safeUploadName(row?.originalFilename || row?.photoFilename);
    const clientItemId = String(row?.clientItemId || '').trim();
    if (!photoFilename || !originalFilename) throw appError('receipt_photo_required');
    if (!/^[a-zA-Z0-9_-]{4,128}$/.test(clientItemId) || seenClientIds.has(clientItemId)) {
      throw appError('validation_failed', { field: 'clientItemId' });
    }
    seenClientIds.add(clientItemId);
    return { photoFilename, originalFilename, clientItemId, intakeIndex: index };
  });

  const existing = await Receipt.findOne({ intakeBatchId: batchId }).lean();
  if (existing) return res.json(await bulkIntakeResponse(existing));

  const receiptNumber = await getNextReceiptNumber();
  const now = new Date();
  const session = await mongoose.connection.startSession();
  let receiptDoc = null;
  let createdDocs = [];
  try {
    await session.withTransaction(async () => {
      createdDocs = [];
      const already = await Receipt.findOne({ intakeBatchId: batchId }).session(session);
      if (already) {
        receiptDoc = already;
        createdDocs = await ReceiptItem.find({ receiptId: already._id })
          .sort({ intakeIndex: 1, createdAt: 1, _id: 1 })
          .session(session);
        return;
      }

      const [receipt] = await Receipt.create([{
        receiptNumber,
        status: 'completed',
        completedAt: now,
        type: 'regular',
        createdBy: String(req.user.telegramId),
        intakeMode: 'bulk',
        intakeBatchId: batchId,
      }], { session });
      receiptDoc = receipt;

      const docs = items.map((row) => ({
        receiptId: receipt._id,
        createdBy: String(req.user.telegramId),
        status: 'draft',
        destination: 'shelf',
        routingVersion: 1,
        routing: blankRouting(),
        photoUrl: r2Url('products', row.photoFilename),
        photoName: row.photoFilename,
        originalPhotoUrl: r2Url('originals', row.originalFilename),
        totalQty: null,
        price: null,
        qtyPerPackage: null,
        intakeClientItemId: row.clientItemId,
        intakeIndex: row.intakeIndex,
      }));
      createdDocs = await ReceiptItem.insertMany(docs, { session });
    });
  } catch (err) {
    // Two retries with the same batchId may race. The unique batch index elects
    // one winner; the loser returns that durable result instead of surfacing a
    // fake failure or creating another Receipt.
    if (err?.code === 11000 && (err?.keyPattern?.intakeBatchId || err?.keyValue?.intakeBatchId)) {
      const winner = await Receipt.findOne({ intakeBatchId: batchId }).lean();
      if (winner) return res.json(await bulkIntakeResponse(winner));
    }
    throw err;
  } finally {
    session.endSession();
  }

  const receipt = receiptDoc?.toObject ? receiptDoc.toObject() : receiptDoc;
  const created = createdDocs.map((doc) => (doc?.toObject ? doc.toObject() : doc));

  // Audit is deliberately post-commit: Mongo may rerun transaction callbacks.
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemName: receipt.receiptNumber,
    action: 'receipt_create',
    actor: getActor(req),
    meta: { intakeMode: 'bulk', batchId, itemsCount: created.length },
  }).catch(() => {});
  if (created.length) {
    ReceiptItemLog.insertMany(created.map((item) => ({
      receiptId: receipt._id,
      itemId: item._id,
      itemName: item.name || '',
      action: 'create',
      actor: getActor(req),
      meta: { intakeMode: 'bulk', batchId },
    })), { ordered: false }).catch(() => {});
  }

  const io = getIO();
  if (io) {
    for (const item of created) io.to(`receipt_${String(receipt._id)}`).emit('receipt_item_added', item);
  }

  res.status(201).json({ receipt, items: created, createdCount: created.length });
}));

router.post('/', staffOnly, asyncHandler(async (req, res) => {
  // LEGACY compatibility: current UI always posts type='regular' and chooses
  // supplement per item after receiving. We still accept the old whole-receipt
  // type so cached clients and historical workflows do not break during rollout.
  const type = String(req.body?.type || 'regular');
  if (!RECEIPT_TYPES.includes(type)) throw appError('receipt_type_invalid');

  const receiptNumber = await getNextReceiptNumber();
  const receipt = new Receipt({
    receiptNumber,
    status: 'draft',
    type,
    createdBy: req.user.telegramId,
  });
  try {
    await receipt.save();
  } catch (err) {
    if (err.code === 11000) throw appError('receipt_number_exists');
    throw err;
  }
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemName: receipt.receiptNumber,
    action: 'receipt_create',
    actor: getActor(req),
  }).catch((e) => {});
  res.status(201).json(receipt);
}));

/**
 * PATCH /:id — LEGACY зміна типу накладної.
 *
 * Поточний UI цей endpoint не використовує: всі нові накладні regular, а
 * дозамовлення вибирається на ReceiptItem.routing. Залишено лише для старих
 * клієнтів; працює тільки для порожньої draft-накладної.
 */
router.patch('/:id', staffOnly, asyncHandler(async (req, res) => {
  const type = String(req.body?.type || '');
  if (!RECEIPT_TYPES.includes(type)) throw appError('receipt_type_invalid');

  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.status !== 'draft') throw appError('receipt_already_completed');
  if (receipt.type === type) return res.json(receipt);

  const itemCount = await ReceiptItem.countDocuments({ receiptId: receipt._id });
  if (itemCount > 0) throw appError('receipt_type_locked');

  const from = receipt.type;
  receipt.type = type;
  await receipt.save();

  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemName: receipt.receiptNumber,
    action: 'receipt_type_change',
    actor: getActor(req),
    changes: [{ field: 'type', label: 'Тип накладної', from, to: type }],
  }).catch((e) => {});

  res.json(receipt);
}));

/**
 * Додавання позиції — дозволене і в проведену накладну.
 *
 * Нова позиція завжди починається як 'draft': сам факт того, що накладну колись
 * провели, не підписує рядок, якого тоді не існувало. Товар з'явиться при
 * підтвердженні, тим самим шляхом, що й у відкритій накладній.
 *
 * Виняток — накладна-дозамовлення з уже закритим прийомом заявок: нову позицію
 * не буде кому показати, а відкривати нею хвилю заново неправильно.
 */
router.post('/:id/items', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');
  if (receipt.type === 'supplement' && receipt.status === 'completed'
      && !(await hasOpenSupplementWave(receipt._id))) {
    throw appError('receipt_supplement_wave_closed');
  }

  if (!req.is('multipart/form-data')) throw appError('receipt_multipart_required');

  const parsed = await parseMultipart(req);
  // Main photo + clean original are uploaded straight to R2 by the browser; only
  // their sanitized filenames arrive here.
  const photoFilename    = safeUploadName(parsed.fields.photoFilename);
  const originalFilename = safeUploadName(parsed.fields.originalFilename);
  const photoMeta = safeParseObject(parsed.fields.photoMeta) || null;
  // Legacy direct-to-shops fields from pre-routing clients. Current UI does not
  // send them; keep parsing only for backward compatibility.
  const deliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
  if (deliveryGroupIds === null) throw appError('receipt_invalid_delivery_groups');
  if (deliveryGroupIds.length > 0) {
    const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: deliveryGroupIds } });
    if (existingCount !== deliveryGroupIds.length) throw appError('receipt_delivery_groups_missing');
  }
  const qtyPerShop = parseIntField(parsed.fields.qtyPerShop);

  if (!photoFilename) throw appError('receipt_photo_required');

  // Modern staged intake may start from the photo alone. `null` means the
  // physical received quantity has not been entered yet. Legacy whole-receipt
  // supplement rows still require it because their stock contract depends on it.
  const parsedTotalQty = parseOptionalPositiveInt(parsed.fields.totalQty);
  const totalQty = parsedTotalQty === undefined ? null : parsedTotalQty;
  if (receipt.type === 'supplement' && !(Number.isInteger(Number(totalQty)) && Number(totalQty) >= 1)) {
    throw appError('receipt_qty_invalid');
  }

  // Current Stage 1 UI never sends these. We still parse them so a cached legacy
  // client can create an already-prepared row, but a legacy destination must NOT
  // bypass the new Stage 2 gate.
  const initialPrice = parseNumberField(parsed.fields.price, 'price');
  const initialQtyPerPackage = parseNumberField(parsed.fields.qtyPerPackage, 'qtyPerPackage');

  // Receiving and routing are separate. New regular items are intentionally
  // saved without a route. Legacy clients that still send destination are only
  // allowed to normalize it when the same payload already satisfies Stage 2.
  let routing = blankRouting();
  if (receipt.type === 'supplement') {
    routing = { ...routing, warehouse: true, supplement: true };
  } else if (parsed.fields.destination !== undefined) {
    const legacyDestination = String(parsed.fields.destination || 'shelf');
    if (!['shelf', 'shops'].includes(legacyDestination)) throw appError('receipt_destination_required');
    assertItemReadyForRouting({
      photoUrl: r2Url('products', photoFilename),
      totalQty,
      routingVersion: 1,
      price: initialPrice,
      qtyPerPackage: initialQtyPerPackage,
    });
    routing = legacyDestination === 'shops'
      ? { ...routing, mandatory: true }
      : { ...routing, warehouse: true };
  }
  const destination = legacyDestinationForRouting(routing);

  let photoUrl = r2Url('products', photoFilename);
  let photoName = photoFilename;
  let originalPhotoUrl = '';
  if (originalFilename) {
    originalPhotoUrl = r2Url('originals', originalFilename);
  }

  const receiptItem = new ReceiptItem({
    receiptId: receipt._id,
    createdBy: String(req.user.telegramId),
    status: 'draft',
    destination,
    routingVersion: receipt.type === 'supplement' ? 0 : 1,
    routing,
    photoUrl,
    photoName,
    originalPhotoUrl,
    photoMeta: normalizeReceiptPhotoMeta(photoMeta) || undefined,
    totalQty,
    deliveryGroupIds: Array.isArray(deliveryGroupIds) ? deliveryGroupIds : [],
    qtyPerShop,
    price: initialPrice,
    qtyPerPackage: initialQtyPerPackage,
  });

  // Save item AND re-check that the receipt still exists in the SAME transaction,
  // so a concurrently deleted receipt can't leave an orphan item behind. Статус
  // тут більше не гейт: позиція, додана під час проведення, просто лишається
  // непідтвердженою в уже проведеній накладній — це підтримуваний стан.
  const addItemSession = await mongoose.connection.startSession();
  try {
    await addItemSession.withTransaction(async () => {
      const liveReceipt = await Receipt.findById(req.params.id, '_id status').session(addItemSession);
      if (!liveReceipt) throw appError('receipt_not_found');
      await receiptItem.save({ session: addItemSession });
    });
  } catch (txErr) {
    throw txErr;
  } finally {
    addItemSession.endSession();
  }

  // Log: who added this item
  ReceiptItemLog.create({
    receiptId: receipt._id,
    itemId: receiptItem._id,
    itemName: receiptItem.name,
    action: 'create',
    actor: getActor(req),
  }).catch((e) => {});

  const io = getIO();
  if (io) {
    io.to(`receipt_${receipt._id.toString()}`).emit('receipt_item_added', receiptItem);
  }

  res.status(201).json(receiptItem);
}));

router.get('/:id/items', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id);
  if (!receipt) throw appError('receipt_not_found');

  const items = await ReceiptItem.find({ receiptId: receipt._id }).sort({ createdAt: -1 }).lean();

  const supplementOffers = items.length
    ? await SupplementOffer.find(
        { receiptItemId: { $in: items.map((item) => item._id) }, waveId: { $ne: null } },
        'receiptItemId waveId status itemStatus openedAt frozenAt completedAt revisionHistory',
      ).lean()
    : [];
  const supplementGroupNameByWaveId = await supplementGroupNamesByWaveForOffers(supplementOffers);
  const supplementOffersByItemId = new Map();
  for (const offer of supplementOffers) {
    const itemId = String(offer.receiptItemId || '');
    supplementOffersByItemId.set(itemId, [
      ...(supplementOffersByItemId.get(itemId) || []),
      offer,
    ]);
  }

  // Enrich each item with currentLocation (block + product status) and productCurrentQty
  const productIds = items.map((i) => i.createdProductId).filter(Boolean);
  let productMap = {};
  let blockMap = {};

  if (productIds.length > 0) {
    const [products, blocks] = await Promise.all([
      Product.find({ _id: { $in: productIds } }, 'quantity status').lean(),
      Block.find({ productIds: { $in: productIds } }, 'blockId productIds').lean(),
    ]);
    productMap = Object.fromEntries(products.map((p) => [String(p._id), p]));
    for (const block of blocks) {
      block.productIds.forEach((pid, index) => {
        blockMap[String(pid)] = { blockId: block.blockId, position: index + 1 };
      });
    }
  }

  const enrichedItems = items.map((item) => {
    const productId = item.createdProductId;
    const product = productId ? productMap[String(productId)] : null;
    const location = productId ? (blockMap[String(productId)] ?? null) : null;
    const blockId = location?.blockId ?? null;
    const routing = normalizeReceiptItemRouting(item, receipt);
    const itemSupplementOffers = supplementOffersByItemId.get(String(item._id)) || [];
    const supplementState = deriveReceiptItemSupplementState({
      offers: itemSupplementOffers,
      routingSupplement: routing.supplement,
      receiptCompleted: receipt.status === 'completed',
    });
    const activeSupplementOffer = findActiveReceiptItemSupplementOffer(
      itemSupplementOffers,
      supplementState,
    );
    const displaySupplementOffer = activeSupplementOffer || itemSupplementOffers
      .filter(hasCompletedLifecycle)
      .sort((a, b) => new Date(b?.completedAt || b?.frozenAt || b?.openedAt || 0).getTime()
        - new Date(a?.completedAt || a?.frozenAt || a?.openedAt || 0).getTime())[0] || null;
    return {
      ...item,
      currentLocation: { blockId, position: location?.position ?? null, status: product?.status ?? null },
      productCurrentQty: product?.quantity ?? null,
      supplementState,
      supplementGroupName: supplementGroupNameByWaveId.get(String(displaySupplementOffer?.waveId || '')) || '',
      telegramNewProduct: {
        ...(item.telegramNewProduct || {}),
        status: String(item.telegramNewProduct?.status || '') === 'expired'
          ? (Number(item.telegramNewProduct?.messageId) > 0 ? 'sent' : 'not_sent')
          : String(item.telegramNewProduct?.status || 'not_sent'),
      },
    };
  });

  res.json(enrichedItems);
}));

/** Поля позиції, які показуються в журналі накладної. */
function logSnapshot(item) {
  return {
    totalQty: item.totalQty,
    destination: item.destination,
    price: item.price,
    qtyPerPackage: item.qtyPerPackage,
    qtyPerShop: item.qtyPerShop,
    photoUrl: item.photoUrl,
  };
}

// ОНОВЛЕННЯ ПОЗИЦІЇ (PATCH)
/**
 * Правка позиції дозволена В БУДЬ-ЯКИЙ ДЕНЬ, зокрема в проведеній накладній.
 *
 * Накладна — не заморожений папірець, а жива згадка про те, що приїхало: помилку
 * в ціні чи кількості помічають і назавтра. Тому статус накладної тут більше не
 * гейт; гейтом лишається лише те, чи товар уже поїхав далі (див. нижче зміну
 * призначення) та права з receiptPermissions.
 *
 * Кожна правка ОДРАЗУ протягується в похідні документи (propagateItemEdit):
 * складський товар + його дзеркало ShopProduct, або товар магазину. Для нового
 * routing flow totalQty лишається довідковою кількістю прийомки й НЕ змінює
 * складський залишок; delta-sync кількості працює лише для legacy-позицій.
 * Замовлення не чіпаються: у них своя зафіксована ціна.
 */
router.patch('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  if (!req.is('multipart/form-data')) {
    throw appError('validation_failed', { field: 'multipart/form-data is required' });
  }

  // Validate existence BEFORE consuming the body.
  const receipt = await Receipt.findById(req.params.id).lean();
  if (!receipt) throw appError('receipt_not_found');
  if (!(await ReceiptItem.exists({ _id: req.params.itemId, receiptId: req.params.id }))) {
    throw appError('receipt_item_not_found');
  }

  const parsed = await parseMultipart(req);

  let expectedEditRevision = null;
  if (parsed.fields.expectedEditRevision !== undefined) {
    expectedEditRevision = parseIntField(parsed.fields.expectedEditRevision, -1);
    if (!Number.isInteger(expectedEditRevision) || expectedEditRevision < 0) {
      throw appError('validation_failed', { field: 'expectedEditRevision' });
    }
  }

  // ── Розбір payload. `undefined` = поле не надсилали → лишається як є ───────
  let nextDestination;
  if (parsed.fields.destination !== undefined) {
    nextDestination = String(parsed.fields.destination);
    if (!['shelf', 'shops'].includes(nextDestination)) {
      throw appError('receipt_destination_required');
    }
    // LEGACY whole-receipt supplement contract was shelf-only. New regular
    // receipts route supplement per item through the dedicated /routing endpoint.
    if (receipt.type === 'supplement' && nextDestination !== 'shelf') {
      throw appError('receipt_supplement_shelf_only');
    }
  }

  let nextTotalQty;
  if (parsed.fields.totalQty !== undefined) {
    nextTotalQty = parseOptionalPositiveInt(parsed.fields.totalQty);
  }

  let nextDeliveryGroupIds;
  if (parsed.fields.deliveryGroupIds !== undefined) {
    nextDeliveryGroupIds = safeParseArray(parsed.fields.deliveryGroupIds);
    if (nextDeliveryGroupIds === null) {
      throw appError('validation_failed', { field: 'deliveryGroupIds' });
    }
    if (nextDeliveryGroupIds.length > 0) {
      const existingCount = await DeliveryGroup.countDocuments({ _id: { $in: nextDeliveryGroupIds } });
      if (existingCount !== nextDeliveryGroupIds.length) {
        throw appError('validation_failed', { field: 'deliveryGroupIds' });
      }
    }
  }

  let nextQtyPerShop;
  if (parsed.fields.qtyPerShop !== undefined) {
    nextQtyPerShop = parseIntField(parsed.fields.qtyPerShop, -1);
    if (!Number.isInteger(nextQtyPerShop) || nextQtyPerShop < 0) {
      throw appError('validation_failed', { field: 'qtyPerShop' });
    }
  }

  let nextPrice;
  if (parsed.fields.price !== undefined) nextPrice = parseNumberField(parsed.fields.price, 'price');
  let nextQtyPerPackage;
  if (parsed.fields.qtyPerPackage !== undefined) {
    nextQtyPerPackage = parseNumberField(parsed.fields.qtyPerPackage, 'qtyPerPackage');
  }

  let normalizedPhotoMeta = null;
  if (parsed.fields.photoMeta !== undefined) {
    const rawPhotoMeta = safeParseObject(parsed.fields.photoMeta);
    if (rawPhotoMeta === undefined) throw appError('validation_failed', { field: 'photoMeta' });
    if (rawPhotoMeta && typeof rawPhotoMeta === 'object') {
      normalizedPhotoMeta = normalizeReceiptPhotoMeta(rawPhotoMeta);
    }
  }

  const photoFilename = safeUploadName(parsed.fields.photoFilename);
  const originalFilename = safeUploadName(parsed.fields.originalFilename);

  const arraysEqual = (a = [], b = []) =>
    a.length === b.length && a.every((v, i) => String(v) === String(b[i]));

  let outcome = null;
  const txSession = await mongoose.connection.startSession();
  try {
    await txSession.withTransaction(async () => {
      outcome = null; // withTransaction може перезапустити колбек — скидаємо результат

      // Позицію перечитуємо ВСЕРЕДИНІ транзакції: різниця кількості рахується
      // від актуального значення, тож дві паралельні правки не загублять одна одну
      // (конфлікт запису → повторна спроба з новим читанням).
      const item = await ReceiptItem.findOne(
        { _id: req.params.itemId, receiptId: req.params.id },
      ).session(txSession);
      if (!item) throw appError('receipt_item_not_found');
      const liveReceipt = await Receipt.findById(req.params.id, '_id status type').session(txSession).lean();
      if (!liveReceipt) throw appError('receipt_not_found');
      const afterCommit = liveReceipt.status === 'completed';

      // V48.S3.1: metadata of the SAME ReceiptItem may be corrected while
      // supplement work is OPEN/FROZEN. Identity/routing is unchanged, so current
      // requests stay intact and the active SupplementOffer snapshot is updated in
      // the same transaction by propagateItemEdit(). Legacy whole-receipt supplement
      // rows keep their historical contract because they do not have revisioned
      // snapshots.
      if (afterCommit && originalFilename && liveReceipt.type === 'supplement') {
        throw appError('receipt_supplement_photo_locked');
      }

      // New routing rows change business direction ONLY through the dedicated
      // /routing endpoint. A cached legacy client may still include destination in
      // a generic edit payload; ignore that field instead of silently destroying
      // a valid combined route (mandatory+warehouse / supplement+warehouse).
      const destination = Number(item.routingVersion || 0) >= 1
        ? (item.destination || 'shelf')
        : (nextDestination ?? (item.destination || 'shelf'));
      const totalQty = nextTotalQty !== undefined ? nextTotalQty : item.totalQty;
      if (Number(item.routingVersion || 0) < 1 && !(Number.isInteger(Number(totalQty)) && Number(totalQty) >= 1)) {
        throw appError('receipt_qty_invalid');
      }
      const deliveryGroupIds = nextDeliveryGroupIds ?? (item.deliveryGroupIds || []);
      const qtyPerShop = nextQtyPerShop ?? (item.qtyPerShop || 0);

      const changedFields = [];
      if (nextPrice !== undefined && nextPrice !== item.price) changedFields.push('price');
      if (nextQtyPerPackage !== undefined && nextQtyPerPackage !== item.qtyPerPackage) {
        changedFields.push('qtyPerPackage');
      }
      if (destination !== (item.destination || 'shelf')) changedFields.push('destination');
      if (totalQty !== item.totalQty) changedFields.push('totalQty');
      if (nextDeliveryGroupIds !== undefined
          && !arraysEqual(deliveryGroupIds, item.deliveryGroupIds || [])) changedFields.push('deliveryGroupIds');
      if (nextQtyPerShop !== undefined && qtyPerShop !== (item.qtyPerShop || 0)) changedFields.push('qtyPerShop');
      if (photoFilename) changedFields.push('photoUrl');
      if (normalizedPhotoMeta) changedFields.push('photoMeta');
      if (originalFilename) changedFields.push('originalPhotoUrl');

      assertCanEditItem(req.user, item, changedFields);

      // Modern clients pin the revision they actually edited. If another worker
      // committed receiving/commercial data meanwhile, reject instead of silently
      // overwriting their newer values. Legacy clients without the token remain
      // readable during rollout, but every current client sends it.
      if (changedFields.length > 0 && expectedEditRevision !== null
          && Number(item.editRevision || 0) !== expectedEditRevision) {
        throw appError('receipt_item_stale', { currentRevision: Number(item.editRevision || 0) });
      }

      // Once a product has entered an operational flow, the receipt must not be
      // used as a back door to change what sellers/warehouse are working with.
      // Cosmetic overlay/comment edits remain allowed because they do not change
      // product identity or commercial terms. totalQty is receiving metadata for
      // routingVersion>=1 and is intentionally not treated as live stock.
      const criticalEditFields = new Set([
        // Metadata corrections (price/package/photo) do NOT cancel or block
        // modern supplement work. Business direction changes remain guarded.
        'destination',
        'deliveryGroupIds',
        'qtyPerShop',
      ]);
      if (item.status === 'confirmed' && changedFields.some((field) => criticalEditFields.has(field))) {
        const usage = await describeItemUsage(item, { session: txSession, mode: 'edit' });
        if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
      }

      // ── Зміна призначення вже створеної позиції ─────────────────────────────
      // Складський товар і товар магазину — РІЗНІ сутності, а не прапорець на
      // одній. Перемкнути призначення можна, лише поки створеним товаром ще
      // ніхто не скористався: тоді старий товар прибирається начисто, позиція
      // повертається в 'draft', і повторне підтвердження створює новий у
      // правильному місці. Якщо товар уже в блоці/замовленні/збиранні — відмова
      // з поясненням; нишком архівувати його (і скасовувати позиції в
      // замовленнях магазинів) правка накладної не має права.
      const statusBefore = item.status;
      const rerouted = destination !== (item.destination || 'shelf')
        && !!(item.createdProductId || item.createdShopProductId);
      if (rerouted) {
        const usage = await describeItemUsage(item, { session: txSession });
        if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
        await rollbackItemArtifacts(item, { session: txSession });
        item.status = 'draft';
      }

      const before = logSnapshot(item);
      const prev = snapshotItem(item);

      item.totalQty = totalQty;
      item.destination = destination;
      item.deliveryGroupIds = deliveryGroupIds;
      item.qtyPerShop = qtyPerShop;
      if (nextPrice !== undefined) item.price = nextPrice;
      if (nextQtyPerPackage !== undefined) item.qtyPerPackage = nextQtyPerPackage;
      if (normalizedPhotoMeta) item.photoMeta = normalizedPhotoMeta;
      if (originalFilename) item.originalPhotoUrl = r2Url('originals', originalFilename);
      if (photoFilename) {
        item.photoUrl = r2Url('products', photoFilename);
        item.photoName = photoFilename;
      }
      if (changedFields.length > 0) item.editRevision = Number(item.editRevision || 0) + 1;

      // A confirmed row is already a published system item. Draft rows may keep
      // price/package empty while receiving, but once confirmed we never allow an
      // edit to break the publication invariant.
      if (item.status === 'confirmed') {
        assertItemReadyToConfirm(item, liveReceipt);
      } else {
        const liveRouting = normalizeReceiptItemRouting(item, liveReceipt);
        const hasRoute = liveRouting.warehouse || liveRouting.mandatory || liveRouting.supplement;
        if (hasRoute && (nextPrice !== undefined || nextQtyPerPackage !== undefined)) {
          assertItemReadyForRouting(item);
        }
      }

      await item.save({ session: txSession });

      // Товар, дзеркало і вектор оновлюються в ТІЙ САМІЙ транзакції, що й позиція:
      // накладна не може розійтися зі складом навіть на мить.
      const propagation = await propagateItemEdit(item, prev, { session: txSession });

      outcome = { item, before, after: logSnapshot(item), propagation, rerouted, statusBefore, afterCommit };
    });
  } finally {
    txSession.endSession();
  }

  const { item, before, after, propagation, rerouted, statusBefore, afterCommit } = outcome;

  const logChanges = Object.keys(before)
    .filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''))
    .map((field) => ({
      field,
      label: FIELD_LABELS[field] || field,
      from: before[field],
      to: after[field],
    }));
  if (rerouted && statusBefore !== item.status) {
    logChanges.push({ field: 'status', label: 'Статус', from: statusBefore, to: item.status });
  }
  if (logChanges.length > 0) {
    ReceiptItemLog.create({
      receiptId: req.params.id,
      itemId: item._id,
      itemName: item.name,
      action: 'update',
      actor: getActor(req),
      changes: logChanges,
      // Скільки саме додалося/відняли на складі — головне питання при розборі
      // «чому залишок такий»; сам by-value залишок у логу позиції не видно.
      meta: {
        afterCommit,
        ...(propagation.quantityDelta ? { stockDelta: propagation.quantityDelta } : {}),
        ...(propagation.quantityClamped ? { stockClampedToZero: true } : {}),
        ...(propagation.productId ? { productId: propagation.productId } : {}),
        ...(propagation.shopProductId ? { shopProductId: propagation.shopProductId } : {}),
      },
    }).catch((e) => {});
  }

  // Нове фото → старий вектор бреше. Перегенерація ПІСЛЯ коміту (Gemini повільний
  // і не має тримати транзакцію), force — бо рядок вектора вже існує.
  if (propagation.reembed === 'warehouse') {
    embedProductAsync(propagation.reembedDoc, 'receipt-item-edit', { force: true });
  } else if (propagation.reembed === 'shop-owned') {
    embedShopProductAsync(propagation.reembedDoc, 'receipt-item-edit', { force: true });
  }

  const io = getIO();
  if (io) {
    io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', item);
    // Правка проведеної накладної міняє живий товар — дошки складу мають це побачити.
    if (propagation.productId || propagation.shopProductId) io.emit('incoming_updated');
    for (const change of propagation.supplementChanges || []) {
      io.emit('supplement_wave_changed', {
        ...change,
        receiptItemId: String(item._id),
        action: 'metadata_updated',
      });
    }
  }

  res.json(item);
}));

// ── TELEGRAM «НОВІ ТОВАРИ» ────────────────────────────────────────────────
// Publication is a side effect of an already-saved receipt item. Route/preparation
// persistence never waits for Telegram and never rolls back because Telegram is
// unavailable. The POST only records the worker's decision + durable desired
// payload; the shared Telegram scheduler performs the Bot API call in background.
router.get('/:id/items/:itemId/telegram-new-product', staffOnly, asyncHandler(async (req, res) => {
  const { getPublicationState } = require('../services/receiptNewProductTelegram');
  const state = await getPublicationState(req.params.id, req.params.itemId);
  if (!state) throw appError('receipt_item_not_found');
  res.json(state);
}));

router.post('/:id/items/:itemId/telegram-new-product', staffOnly, asyncHandler(async (req, res) => {
  const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).lean();
  if (!item) throw appError('receipt_item_not_found');
  assertCanConfirmItem(req.user, item);
  if (item.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');

  const { recordDecision } = require('../services/receiptNewProductTelegram');
  try {
    const state = await recordDecision({
      receiptId: req.params.id,
      itemId: req.params.itemId,
      decision: String(req.body?.decision || ''),
      actorId: String(req.telegramUser?.telegramId || ''),
      forceUnknownRetry: req.body?.forceUnknownRetry === true,
    });
    if (!state) throw appError('receipt_item_not_found');
    res.json(state);
  } catch (err) {
    const code = String(err?.message || '');
    if (code === 'telegram_new_products_group_not_configured') throw appError(code);
    if (code === 'telegram_new_products_original_photo_missing') throw appError(code);
    if (code === 'telegram_new_products_decision_invalid') throw appError(code);
    if (code === 'telegram_new_products_delivery_unknown') throw appError(code);
    throw err;
  }
}));

// ВИДАЛЕННЯ ПОЗИЦІЇ (DELETE)
/**
 * Видалити рядок можна і з проведеної накладної — але лише поки товар, який він
 * створив, нікуди не поїхав. Товар у блоці, в замовленні магазину чи в збиранні
 * не зникає через правку паперу: тоді приходить 409 зі списком причин, а забрати
 * товар зі складу можна свідомою архівацією на сторінці Складу.
 */
router.delete('/:id/items/:itemId', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let deletedItem = null;
    let removedArtifacts = null;

    await session.withTransaction(async () => {
      removedArtifacts = null; // withTransaction може перезапустити колбек
      const receipt = await Receipt.findById(req.params.id, '_id status').session(session);
      if (!receipt) throw appError('receipt_not_found');

      const item = await ReceiptItem.findOne(
        { _id: req.params.itemId, receiptId: req.params.id },
      ).session(session);
      if (!item) throw appError('receipt_item_not_found');

      // Delete policy stays narrower than edit policy: original receiver/admin for drafts; confirmed rows
      // is admin-only. Checked inside the txn so a concurrent confirm cannot slip
      // between the check and the delete.
      assertCanDeleteItem(req.user, item);

      // Publication markers/offers are usage too, even if an inconsistent row has
      // already lost its product back-reference. Never skip the usage gate based
      // only on createdProductId/createdShopProductId.
      const usage = await describeItemUsage(item, { session });
      if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
      if (item.createdProductId || item.createdShopProductId) {
        removedArtifacts = await rollbackItemArtifacts(item, { session });
      }

      await item.deleteOne({ session });
      deletedItem = item;
    });

    // Аудит-лог видалення позиції — обов'язковий слід для розслідувань
    // (раніше DELETE не писав у ReceiptItemLog взагалі).
    ReceiptItemLog.create({
      receiptId: req.params.id,
      itemId: deletedItem._id,
      itemName: deletedItem.name || '',
      action: 'delete',
      actor: getActor(req),
      changes: [
        { field: 'totalQty', label: FIELD_LABELS.totalQty, from: deletedItem.totalQty, to: null },
        { field: 'price', label: FIELD_LABELS.price, from: deletedItem.price, to: null },
      ],
      // Що саме зникло разом з рядком — інакше «куди подівся товар» не відновити.
      meta: removedArtifacts || {},
    }).catch((e) => {});

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_deleted', req.params.itemId);
      if (removedArtifacts) io.emit('incoming_updated');
    }

    res.json({ message: 'Позицію видалено' });
  } finally {
    session.endSession();
  }
}));

// ── ROUTING AFTER RECEIVING + COMMERCIAL PREPARATION ───────────────────────
// Stage 1 saves the photo; received quantity is optional reference metadata in
// modern rows. Stage 2 requires price + package quantity. Only then may Stage 3 choose routing on the item card. Draft rows are
// freely routable. Confirmed primary routes are immutable EXCEPT the explicit
// additive `add-warehouse-remainder` operation below (false -> true warehouse only).

// Photo-feed batch routing deliberately spans receipts. Draft rows only record
// the intended route and stay unconfirmed. Confirmed rows go through the same
// compensating correction command as the single-item editor so existing product,
// shop and supplement artifacts remain consistent.
router.patch('/items/routing-batch', staffOnly, asyncHandler(async (req, res) => {
  const itemIds = [...new Set((Array.isArray(req.body?.itemIds) ? req.body.itemIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (itemIds.length === 0) throw appError('receipt_routing_batch_empty');
  if (itemIds.length > 100) throw appError('receipt_routing_batch_too_large');
  if (itemIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
    throw appError('validation_failed', { field: 'itemIds' });
  }

  const expectedRoutingRevisions = req.body?.expectedRoutingRevisions
    && typeof req.body.expectedRoutingRevisions === 'object'
    && !Array.isArray(req.body.expectedRoutingRevisions)
      ? req.body.expectedRoutingRevisions
      : {};
  for (const [itemId, raw] of Object.entries(expectedRoutingRevisions)) {
    const value = Number(raw);
    if (!itemIds.includes(String(itemId)) || !Number.isInteger(value) || value < 0) {
      throw appError('validation_failed', { field: 'expectedRoutingRevisions' });
    }
  }

  const body = req.body?.routing || {};
  const routing = {
    warehouse: body.warehouse === true,
    mandatory: body.mandatory === true,
    supplement: body.supplement === true,
    mayNotReachAllShops: body.mayNotReachAllShops === true,
    supplementDeliveryGroupId: null,
  };
  const check = validateReceiptItemRouting(routing, {
    allowEmpty: false,
    allowSupplementWithoutGroup: true,
  });
  if (!check.ok) {
    if (check.reason === 'route_required') throw appError('receipt_route_required');
    if (check.reason === 'mandatory_and_supplement') throw appError('receipt_route_conflict');
    if (check.reason === 'may_not_reach_without_mandatory') throw appError('receipt_route_warning_requires_mandatory');
    if (check.reason === 'may_not_reach_with_warehouse') throw appError('receipt_route_warning_with_warehouse');
  }

  const items = await ReceiptItem.find({ _id: { $in: itemIds } }).lean();
  if (items.length !== itemIds.length) throw appError('receipt_item_not_found');
  for (const item of items) {
    if (item.status === 'confirmed') assertCanConfirmItem(req.user, item);
    else {
      assertCanEditItem(req.user, item, ['routing']);
      // Batch routing must obey exactly the same Stage-2 readiness contract as
      // the single-item route endpoint. It may never be a back door around
      // price/package preparation.
      assertItemReadyForRouting(item);
    }
    const expected = expectedRoutingRevisions[String(item._id)];
    if (expected !== undefined && Number(item.routingRevision || 0) !== Number(expected)) {
      throw appError('receipt_route_stale', { currentRevision: Number(item.routingRevision || 0) });
    }
  }

  const receiptIds = [...new Set(items.map((item) => String(item.receiptId || '')).filter(Boolean))];
  const receipts = await Receipt.find({ _id: { $in: receiptIds } }, '_id type status').lean();
  const receiptById = new Map(receipts.map((receipt) => [String(receipt._id), receipt]));
  if (receipts.length !== receiptIds.length) throw appError('receipt_not_found');
  if (receipts.some((receipt) => receipt.type === 'supplement')) {
    throw appError('receipt_routing_batch_regular_only');
  }

  const updatedItems = [];
  const failures = [];
  let processableItems = items;

  // Do not let a stale/older client mark a physically spent lifecycle as a new
  // supplement. The same derivation powers the gallery's grey button and badge.
  if (routing.supplement) {
    const publications = await SupplementOffer.find(
      { receiptItemId: { $in: items.map((item) => item._id) }, waveId: { $ne: null } },
      'receiptItemId status itemStatus frozenAt completedAt revisionHistory',
    ).lean();
    const offersByItemId = new Map();
    for (const offer of publications) {
      const itemId = String(offer.receiptItemId || '');
      offersByItemId.set(itemId, [...(offersByItemId.get(itemId) || []), offer]);
    }
    processableItems = items.filter((item) => {
      const receipt = receiptById.get(String(item.receiptId || ''));
      const state = deriveReceiptItemSupplementState({
        offers: offersByItemId.get(String(item._id)) || [],
        routingSupplement: normalizeReceiptItemRouting(item, receipt).supplement,
        receiptCompleted: receipt?.status === 'completed',
      });
      if (!isTerminalReceiptItemSupplementState(state)) return true;
      failures.push({
        itemId: String(item._id),
        error: 'receipt_supplement_already_completed',
        message: 'Дозамовлення цього товару вже виконано',
      });
      return false;
    });
  }

  const draftItems = processableItems.filter((item) => item.status !== 'confirmed');
  const confirmedItems = processableItems.filter((item) => item.status === 'confirmed');

  // Business guards are preflighted for the whole selection BEFORE the first
  // write. A dumb/stale client therefore cannot change 19 rows and discover on
  // row 20 that one Product is on a shelf or its Supplement is still OPEN.
  if (confirmedItems.length) {
    const { preflightReceiptItemRoutingCorrection } = require('../services/receiptRoutingCorrectionCommand');
    for (const item of confirmedItems) {
      try {
        await preflightReceiptItemRoutingCorrection({
          receiptId: item.receiptId,
          itemId: item._id,
          nextRouting: routing,
          expectedRoutingRevision: expectedRoutingRevisions[String(item._id)] ?? null,
        });
      } catch (err) {
        failures.push({
          itemId: String(item._id),
          error: err?.code || 'internal_error',
          message: err?.expose ? err.message : 'Не вдалося змінити маршрут товару',
        });
      }
    }
  }

  if (failures.length) {
    const short = failures.slice(0, 5).map((row) => row.message).filter(Boolean).join(' · ');
    const more = failures.length > 5 ? ` · ще ${failures.length - 5}` : '';
    throw appError('receipt_routing_batch_blocked', { reasons: `${short}${more}` });
  }

  if (draftItems.length) {
    const draftIds = draftItems.map((item) => item._id);
    const session = await mongoose.connection.startSession();
    let draftUpdatedItems = [];
    try {
      await session.withTransaction(async () => {
        for (const draftItem of draftItems) {
          const expected = expectedRoutingRevisions[String(draftItem._id)];
          const result = await ReceiptItem.updateOne(
            {
              _id: draftItem._id,
              status: 'draft',
              ...(expected === undefined
                ? {}
                : Number(expected) === 0
                  ? { $or: [{ routingRevision: 0 }, { routingRevision: { $exists: false } }] }
                  : { routingRevision: Number(expected) }),
            },
            {
              $set: {
                routingVersion: 1,
                routing,
                destination: legacyDestinationForRouting(routing),
                supplementBatchVersion: routing.supplement ? 2 : 0,
                supplementPublishRequestedAt: null,
              },
              $inc: { routingRevision: 1 },
            },
            { session },
          );
          if (Number(result.matchedCount ?? result.n ?? 0) !== 1) {
            const live = await ReceiptItem.findById(draftItem._id, 'status routingRevision').session(session).lean();
            if (live?.status === 'draft' && expected !== undefined
                && Number(live.routingRevision || 0) !== Number(expected)) {
              throw appError('receipt_route_stale', { currentRevision: Number(live.routingRevision || 0) });
            }
            throw appError('receipt_routing_batch_draft_only');
          }
        }

        const logs = draftItems.map((item) => ({
          receiptId: item.receiptId,
          itemId: item._id,
          itemName: item.name,
          action: 'routing_change',
          actor: getActor(req),
          changes: [{
            field: 'routing',
            label: 'Маршрут (пакетно)',
            from: normalizeReceiptItemRouting(item, receiptById.get(String(item.receiptId))),
            to: routing,
          }],
        }));
        await ReceiptItemLog.insertMany(logs, { session });
        draftUpdatedItems = await ReceiptItem.find({ _id: { $in: draftIds } }).session(session).lean();
      });
    } finally {
      session.endSession();
    }
    updatedItems.push(...draftUpdatedItems);

    const io = getIO();
    if (io) {
      for (const item of draftUpdatedItems) {
        io.to(`receipt_${item.receiptId}`).emit('receipt_item_updated', item);
      }
    }
  }

  if (confirmedItems.length) {
    const { correctReceiptItemRouting: correctConfirmedRouting } = require('../services/receiptRoutingCorrectionCommand');
    for (const item of confirmedItems) {
      const result = await correctConfirmedRouting({
        receiptId: item.receiptId,
        itemId: item._id,
        nextRouting: routing,
        actor: {
          by: String(req.telegramUser?.telegramId || ''),
          byName: [req.telegramUser?.firstName, req.telegramUser?.lastName].filter(Boolean).join(' '),
          byRole: req.telegramUser?.role || 'warehouse',
        },
        reason: 'routing_corrected_batch',
        expectedRoutingRevision: expectedRoutingRevisions[String(item._id)] ?? null,
      });
      if (result?.item) updatedItems.push(result.item);
    }
  }

  res.json({
    selectedCount: itemIds.length,
    updatedCount: updatedItems.length,
    failedCount: failures.length,
    items: updatedItems,
    failures,
  });
}));

router.patch('/:id/items/:itemId/routing', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id).lean();
  if (!receipt) throw appError('receipt_not_found');

  // First read is for authorization/readiness only. The actual write below is a single atomic
  // status=draft CAS, so it cannot race a confirm into "artifacts from route A,
  // flags from route B".
  const authItem = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).lean();
  if (!authItem) throw appError('receipt_item_not_found');
  assertCanEditItem(req.user, authItem, ['routing']);
  // Stage 2 is mandatory: no routing until price + package quantity are ready.
  assertItemReadyForRouting(authItem);

  const body = req.body || {};
  const expectedRoutingRevision = body.expectedRoutingRevision == null
    ? null
    : Number(body.expectedRoutingRevision);
  if (expectedRoutingRevision !== null
      && (!Number.isInteger(expectedRoutingRevision) || expectedRoutingRevision < 0)) {
    throw appError('validation_failed', { field: 'expectedRoutingRevision' });
  }
  const routing = {
    warehouse: body.warehouse === true,
    mandatory: body.mandatory === true,
    supplement: body.supplement === true,
    mayNotReachAllShops: body.mayNotReachAllShops === true,
    supplementDeliveryGroupId: body.supplementDeliveryGroupId
      ? String(body.supplementDeliveryGroupId)
      : null,
  };

  // Current draft UX only marks «Дозамовлення» on the item. The delivery group
  // is intentionally chosen later, once, for the whole batch. Older cached
  // clients may still send a per-item group and remain backward-compatible.
  const check = validateReceiptItemRouting(routing, {
    allowEmpty: true,
    allowSupplementWithoutGroup: true,
  });
  if (!check.ok) {
    if (check.reason === 'mandatory_and_supplement') throw appError('receipt_route_conflict');
    if (check.reason === 'may_not_reach_without_mandatory') throw appError('receipt_route_warning_requires_mandatory');
    if (check.reason === 'may_not_reach_with_warehouse') throw appError('receipt_route_warning_with_warehouse');
  }

  if (routing.supplement && routing.supplementDeliveryGroupId) {
    const { resolveSupplementTarget } = require('../services/supplementTargets');
    const resolved = await resolveSupplementTarget(routing.supplementDeliveryGroupId);
    routing.supplementDeliveryGroupId = resolved.deliveryGroupId;
  } else if (!routing.supplement) {
    routing.supplementDeliveryGroupId = null;
  }
  if (!routing.mandatory) routing.mayNotReachAllShops = false;

  const currentRouting = normalizeReceiptItemRouting(authItem, receipt);
  if (routing.supplement && !currentRouting.supplement) {
    const offers = await SupplementOffer.find(
      { receiptItemId: authItem._id, waveId: { $ne: null } },
      'status itemStatus frozenAt completedAt revisionHistory',
    ).lean();
    const supplementState = deriveReceiptItemSupplementState({
      offers,
      routingSupplement: currentRouting.supplement,
      receiptCompleted: receipt.status === 'completed',
    });
    if (supplementState === RECEIPT_ITEM_SUPPLEMENT_STATE.COMPLETED) {
      throw appError('receipt_supplement_already_completed');
    }
  }

  // Return the real pre-image from the atomic write. Besides making the audit log
  // exact under two simultaneous toggles, the predicate makes confirm vs routing
  // mutually exclusive AND closes the tiny readiness race between the read above
  // and this write. Stage 2 cannot disappear underneath a concurrent route click.
  const previousItem = await ReceiptItem.findOneAndUpdate(
    {
      _id: req.params.itemId,
      receiptId: req.params.id,
      status: 'draft',
      photoUrl: { $nin: ['', null] },
      ...(Number(authItem.routingVersion || 0) >= 1 ? {} : { totalQty: { $gte: 1 } }),
      price: { $gt: 0 },
      qtyPerPackage: { $gte: 1 },
      ...(expectedRoutingRevision === null
        ? {}
        : expectedRoutingRevision === 0
          ? { $or: [{ routingRevision: 0 }, { routingRevision: { $exists: false } }] }
          : { routingRevision: expectedRoutingRevision }),
    },
    {
      $set: {
        routingVersion: 1,
        routing,
        destination: legacyDestinationForRouting(routing),
        // Supplement routes are batch-managed. Current UI deliberately leaves
        // the delivery group empty here; it is chosen once when the whole batch
        // is published. A cached older client that still supplied a group remains
        // readable as batch v1; unassigned current rows are batch v2.
        supplementBatchVersion: routing.supplement
          ? (routing.supplementDeliveryGroupId ? 1 : 2)
          : 0,
        supplementPublishRequestedAt: null,
      },
      $inc: { routingRevision: 1 },
    },
    { new: false },
  );
  if (!previousItem) {
    const currentItem = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).lean();
    if (!currentItem) throw appError('receipt_item_not_found');
    if (currentItem.status === 'draft') assertItemReadyForRouting(currentItem);
    if (currentItem.status === 'draft'
        && expectedRoutingRevision !== null
        && Number(currentItem.routingRevision || 0) !== expectedRoutingRevision) {
      throw appError('receipt_route_stale', { currentRevision: Number(currentItem.routingRevision || 0) });
    }
    throw appError('receipt_route_locked');
  }

  const item = await ReceiptItem.findById(req.params.itemId);
  const prev = normalizeReceiptItemRouting(previousItem, receipt);

  ReceiptItemLog.create({
    receiptId: item.receiptId,
    itemId: item._id,
    itemName: item.name,
    action: 'routing_change',
    actor: getActor(req),
    changes: [{ field: 'routing', label: 'Маршрут', from: prev, to: routing }],
  }).catch(() => {});

  const out = item.toObject();
  out.routing = normalizeReceiptItemRouting(out, receipt);
  try { getIO()?.to(`receipt_${req.params.id}`).emit('receipt_item_updated', out); } catch (_) {}
  res.json(out);
}));

// ── COMPENSATING ROUTE CORRECTION AFTER PUBLICATION ─────────────────────────
// Published/confirmed cards are edited through ONE domain command rather than
// unconfirm/delete/recreate. Physical facts and history survive; unfinished work
// is compensated using the same archive/OOS/session primitives as the rest of the
// system.
router.patch('/:id/items/:itemId/routing-correction', staffOnly, asyncHandler(async (req, res) => {
  const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).lean();
  if (!item) throw appError('receipt_item_not_found');
  assertCanConfirmItem(req.user, item);

  const body = req.body || {};
  const expectedRoutingRevision = body.expectedRoutingRevision == null ? null : Number(body.expectedRoutingRevision);
  if (expectedRoutingRevision !== null
      && (!Number.isInteger(expectedRoutingRevision) || expectedRoutingRevision < 0)) {
    throw appError('validation_failed', { field: 'expectedRoutingRevision' });
  }
  const { correctReceiptItemRouting } = require('../services/receiptRoutingCorrectionCommand');
  const result = await correctReceiptItemRouting({
    receiptId: req.params.id,
    itemId: req.params.itemId,
    nextRouting: {
      warehouse: body.warehouse === true,
      mandatory: body.mandatory === true,
      supplement: body.supplement === true,
      mayNotReachAllShops: body.mayNotReachAllShops === true,
    },
    actor: {
      by: String(req.telegramUser?.telegramId || ''),
      byName: [req.telegramUser?.firstName, req.telegramUser?.lastName].filter(Boolean).join(' '),
      byRole: req.telegramUser?.role || 'warehouse',
    },
    reason: String(body.reason || 'routing_corrected'),
    expectedRoutingRevision,
  });
  res.json(result.item);
}));

// ── ADD REMAINDER TO WAREHOUSE AFTER PRIMARY ROUTE ─────────────────────────
// A real-world correction, NOT a reroute: mandatory/supplement may be decided and
// executed first, then workers discover there is stock left. The only permitted
// post-confirm mutation is false -> true for routing.warehouse. Primary-route
// artifacts stay intact; supplement offers/requests/notifications are untouched.
router.post('/:id/items/:itemId/add-warehouse-remainder', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  let updatedItem = null;
  let productForEmbedding = null;
  let productId = null;
  let didPromote = false;

  try {
    await withProductOrderNumberLock(() => session.withTransaction(async () => {
      const receipt = await Receipt.findById(req.params.id).session(session);
      const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).session(session);
      if (!receipt) throw appError('receipt_not_found');
      if (!item) throw appError('receipt_item_not_found');

      assertCanConfirmItem(req.user, item);
      if (item.status !== 'confirmed') throw appError('receipt_item_not_confirmed_yet');
      if (receipt.type === 'supplement' || Number(item.routingVersion || 0) < 1) {
        throw appError('receipt_remainder_not_supported_legacy');
      }

      const before = normalizeReceiptItemRouting(item, receipt);

      // Idempotent double tap/retry: once warehouse=true, return the same state and
      // perform zero artifact/notification work.
      if (before.warehouse) {
        updatedItem = item.toObject();
        updatedItem.routing = before;
        productId = item.createdProductId ? String(item.createdProductId) : null;
        return;
      }

      // "Remainder" only makes sense after one of the two primary non-warehouse
      // decisions. A warehouse-only item was already warehouse from the start.
      if (!before.mandatory && !before.supplement) {
        throw appError('receipt_remainder_route_invalid');
      }

      const nextRouting = {
        ...before,
        warehouse: true,
        // The old warning means "mandatory stock may be insufficient". Once the
        // worker explicitly says a remainder exists for warehouse, that warning is
        // contradictory and must be cleared.
        mayNotReachAllShops: false,
      };
      const check = validateReceiptItemRouting(nextRouting);
      if (!check.ok) throw appError('receipt_remainder_route_invalid');

      item.routingVersion = 1;
      item.routing = nextRouting;
      item.destination = legacyDestinationForRouting(nextRouting);
      await item.save({ session });

      // A supplement-only row deliberately owns NO warehouse Product. Turning on
      // warehouse routing creates/reuses the real Product here; mandatory-only is
      // promoted through the same canonical artifact service.
      const product = await ensureReceiptItemProduct(item, session, receipt);
      if (!product) throw appError('receipt_remainder_product_failed');

      await convertReceiptShopOwnedToWarehouseMirror(item, product, session);
      productForEmbedding = product;
      productId = String(product._id);

      didPromote = true;
      updatedItem = item.toObject();
      updatedItem.routing = nextRouting;
      updatedItem.currentLocation = { blockId: null, position: null, status: product.status ?? null };
      updatedItem.productCurrentQty = product.quantity ?? null;
    }));

    if (didPromote && productForEmbedding) embedProductAsync(productForEmbedding, 'receipt-remainder-to-warehouse');

    if (didPromote && updatedItem) {
      ReceiptItemLog.create({
        receiptId: updatedItem.receiptId,
        itemId: updatedItem._id,
        itemName: updatedItem.name,
        action: 'routing_change',
        actor: getActor(req),
        changes: [{
          field: 'routing.warehouse',
          label: 'Залишок на склад',
          from: false,
          to: true,
        }],
        meta: { additive: true, primaryRoutePreserved: true },
      }).catch(() => {});
    }

    const io = getIO();
    if (didPromote && io && updatedItem) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', updatedItem);
      io.emit('incoming_updated');
      if (productId) io.emit('catalogue_updated', { action: 'add', productId });
    }

    res.json(updatedItem);
  } finally {
    session.endSession();
  }
}));

// ── CONFIRM / UNCONFIRM A SINGLE ITEM ─────────────────────────────────────
// Any warehouse/admin worker may sign it off. `createdBy` is audit provenance only. A receipt
// can only be committed once every non-deleted item is confirmed.
//
// Підтвердження працює і в проведеній накладній: рядок, доданий після
// проведення, стає товаром тим самим шляхом, що й будь-який інший.
router.post('/:id/items/:itemId/confirm', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let confirmedItem = null;
    let receiptDoc = null;
    // ShopProducts that need (re)embedding — scheduled AFTER commit so we never
    // embed a doc that could still roll back. Reset on every transaction attempt.
    let embedTargets = [];
    await withProductOrderNumberLock(() => session.withTransaction(async () => {
      embedTargets = [];
      const receipt = await Receipt.findById(req.params.id).session(session);
      const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).session(session);
      if (!item) throw appError('receipt_item_not_found');
      if (!receipt) throw appError('receipt_not_found');
      receiptDoc = receipt;

      assertCanConfirmItem(req.user, item);
      const expectedEditRevision = req.body?.expectedEditRevision == null ? null : Number(req.body.expectedEditRevision);
      const expectedRoutingRevision = req.body?.expectedRoutingRevision == null ? null : Number(req.body.expectedRoutingRevision);
      if (expectedEditRevision !== null
          && (!Number.isInteger(expectedEditRevision) || expectedEditRevision < 0)) {
        throw appError('validation_failed', { field: 'expectedEditRevision' });
      }
      if (expectedRoutingRevision !== null
          && (!Number.isInteger(expectedRoutingRevision) || expectedRoutingRevision < 0)) {
        throw appError('validation_failed', { field: 'expectedRoutingRevision' });
      }
      if (expectedEditRevision !== null && Number(item.editRevision || 0) !== expectedEditRevision) {
        throw appError('receipt_item_stale', { currentRevision: Number(item.editRevision || 0) });
      }
      if (expectedRoutingRevision !== null && Number(item.routingRevision || 0) !== expectedRoutingRevision) {
        throw appError('receipt_route_stale', { currentRevision: Number(item.routingRevision || 0) });
      }
      assertItemReadyToConfirm(item, receipt);

      // A cached v1 item may already carry an explicit group before batch publication.
      // Revalidate that group against the CURRENT delivery-cycle OrderingSession.
      // Ordinary ordering may still be open; that is a valid supplement target.
      const currentRouting = normalizeReceiptItemRouting(item, receipt);
      if (receipt.status === 'completed'
          && receipt.type !== 'supplement'
          && currentRouting.supplement
          && currentRouting.supplementDeliveryGroupId) {
        // Compatibility for v1 rows that already carry a group. V48.2 rows are
        // intentionally unassigned until batch publication, so there is nothing
        // group-specific to validate at per-item confirm time.
        const { resolveSupplementTarget } = require('../services/supplementTargets');
        await resolveSupplementTarget(currentRouting.supplementDeliveryGroupId);
      }

      if (item.status !== 'confirmed') {
        // Any current per-item supplement confirmed after V47.16 joins the batch
        // workflow even if its draft route was saved by a cached V47.15 client.
        // Existing already-confirmed historical rows remain untouched.
        if (receipt.type !== 'supplement'
            && Number(item.routingVersion || 0) >= 1
            && currentRouting.supplement) {
          item.supplementBatchVersion = currentRouting.supplementDeliveryGroupId ? 1 : 2;
          item.supplementPublishRequestedAt = null;
        }
        item.status = 'confirmed';
        await item.save({ session });
      }

      const product = await ensureReceiptItemProduct(item, session, receipt);

      // Shop-catalog routing by destination — now INSIDE the stock transaction so
      // a warehouse Product can NEVER commit without its ShopProduct mirror, and a
      // shop-owned entry's back-link (createdShopProductId) is persisted atomically.
      // Previously these ran fire-and-forget after the txn: a crash/error there left
      // a confirmed Product with no mirror that nothing retried (re-confirm is
      // blocked once confirmed). Embeddings are deferred to after commit.
      if (product) {
        // shelf item → ShopProduct MIRROR of the warehouse product (linkedProductId set).
        // syncMirror CREATES the mirror if missing then PUSHES the warehouse's current
        // shared values, so a re-receipt into a product that already has a mirror can't
        // leave its price/qtyPerPackage/photo/description stale. In-transaction (session)
        // so a warehouse Product can never commit without its mirror.
        await syncMirror(product, { session });
        // Warehouse OWNS the Gemini vector (its ProductVector row); embed once
        // post-commit. embedProduct is idempotent — it skips when the row already
        // exists (re-receipt), so no gate is needed here. The mirror references this
        // same row at search time, so there is nothing separate to embed for it.
        if (product.originalImageUrl || product.imageUrls?.[0]) {
          embedTargets.push(['warehouse', product, 'receipt-confirm-warehouse']);
        }
      } else if (needsStandaloneShopProduct(normalizeReceiptItemRouting(item, receipt))) {
        // Mandatory-only / Supplement-only item → shop-OWNED ShopProduct
        // (visible in Shop Products/New Products, no warehouse Product/stock).
        const sp = await upsertShopOwnedFromReceiptItem(item.toObject(), { session });
        if (sp && String(sp._id) !== String(item.createdShopProductId || '')) {
          item.createdShopProductId = sp._id;
          await item.save({ session });
        }
        if (sp && (sp.imageUrl || sp.originalImageUrl)) embedTargets.push(['shop-owned', sp, 'shop-owned-upsert']);
      }

      confirmedItem = item.toObject();
      confirmedItem.currentLocation = {
        blockId: null,
        position: null,
        status: product?.status ?? null,
      };
      confirmedItem.productCurrentQty = product?.quantity ?? null;
    }));
    // Audit log AFTER commit (not inside the callback): withTransaction re-runs the
    // callback on a WriteConflict, so an in-callback create would write one log row
    // per attempt — and a row even if the transaction ultimately aborted.
    ReceiptItemLog.create({
      receiptId: confirmedItem.receiptId,
      itemId: confirmedItem._id,
      itemName: confirmedItem.name,
      action: 'confirm',
      actor: getActor(req),
      changes: [{ field: 'status', label: 'Статус', from: 'draft', to: 'confirmed' }],
    }).catch((e) => {});
    // Docs are now durable — schedule background Gemini embedding into ProductVector.
    // Warehouse products embed by productId; shop-owned items by shopProductId. Mirrors
    // are never embedded (they reference the warehouse row).
    for (const [kind, doc, reason] of embedTargets) {
      if (kind === 'warehouse') embedProductAsync(doc, reason);
      else                      embedShopProductAsync(doc, reason); // shop-owned
    }

    // Позиція, додана в УЖЕ проведену накладну-дозамовлення, має потрапити в ту
    // саму хвилю — інакше товар мовчки осів би на складі, а магазини його не
    // побачили. Створення ідемпотентне (унікальний {receiptItemId, deliveryGroupId}),
    // тому наздоганяє рівно нову позицію. Якщо прийом заявок уже закрито, нічого
    // не робимо: заново відкривати хвилю правкою накладної не можна.
    if (receiptDoc?.status === 'completed') {
      try {
        const { createOffersForReceipt } = require('../services/supplementOffers');
        const { created } = await createOffersForReceipt(receiptDoc._id);
        if (created.length) {
          for (const offer of created) {
            try {
              getIO()?.emit('supplement_opened', {
                offerId: String(offer._id),
                deliveryGroupId: String(offer.deliveryGroupId),
              });
            } catch (_) { /* сокет не критичний */ }
          }
          require('../services/supplementNotify').notifyOffers(created, 'opened').catch(() => {});
        }
      } catch (err) {
        // Товар уже на складі — це головне; звірятель supplementScheduler добʼє.
      }
    }

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_confirmed', confirmedItem);
      io.emit('incoming_updated');
      if (Number(confirmedItem?.supplementBatchVersion || 0) >= 1) {
        io.emit('receipt_supplement_batch_changed', {
          deliveryGroupId: confirmedItem?.routing?.supplementDeliveryGroupId || null,
        });
      }
    }
    res.json(confirmedItem);
  } finally {
    session.endSession();
  }
}));

/**
 * Зняти підтвердження — це ВІДКАТ позиції: створений нею товар (з дзеркалом,
 * вектором і пропозиціями дозамовлення) зникає, і рядок знову можна правити чи
 * видалити. Працює і в проведеній накладній.
 *
 * Єдина умова — товаром ще ніхто не скористався. Раніше товар у блоці просто
 * тихо лишався жити без підтвердженої позиції; тепер це явна відмова з
 * причиною, бо «зняв підтвердження, а товар усе одно на полиці» — саме той
 * мовчазний розрив між накладною і складом, який ця сторінка має виключати.
 */
router.post('/:id/items/:itemId/unconfirm', staffOnly, asyncHandler(async (req, res) => {
  const session = await mongoose.connection.startSession();
  try {
    let updatedItem = null;
    let didUnconfirm = false;
    let removedArtifacts = null;
    await session.withTransaction(async () => {
      didUnconfirm = false; // reset per attempt (withTransaction may re-run this)
      removedArtifacts = null;
      const receipt = await Receipt.findById(req.params.id, '_id status').session(session);
      const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id }).session(session);
      if (!item) throw appError('receipt_item_not_found');
      if (!receipt) throw appError('receipt_not_found');

      assertCanConfirmItem(req.user, item);

      if (item.status === 'confirmed') {
        const usage = await describeItemUsage(item, { session });
        if (usage.inUse) throw appError('receipt_item_in_use', { reasons: usage.reasons.join('; ') });
        if (item.createdProductId || item.createdShopProductId) {
          removedArtifacts = await rollbackItemArtifacts(item, { session });
        }

        item.status = 'draft';
        // Re-confirming must never silently reopen/re-notify a previously
        // published supplement. Once confirmation is removed, the item returns
        // to the batch-ready state and needs an explicit batch publication again.
        if (Number(item.supplementBatchVersion || 0) >= 1) {
          item.supplementPublishRequestedAt = null;
        }
        await item.save({ session });
        didUnconfirm = true;
      }

      updatedItem = item.toObject();
    });

    // Audit log AFTER commit — see the confirm handler note (avoid per-retry / phantom rows).
    if (didUnconfirm && updatedItem) {
      ReceiptItemLog.create({
        receiptId: updatedItem.receiptId,
        itemId: updatedItem._id,
        itemName: updatedItem.name,
        action: 'confirm',
        actor: getActor(req),
        changes: [{ field: 'status', label: 'Статус', from: 'confirmed', to: 'draft' }],
        meta: removedArtifacts || {},
      }).catch((e) => {});
    }

    const io = getIO();
    if (io) {
      io.to(`receipt_${req.params.id}`).emit('receipt_item_confirmed', updatedItem);
      io.emit('incoming_updated');
      if (Number(updatedItem?.supplementBatchVersion || 0) >= 1) {
        io.emit('receipt_supplement_batch_changed', {
          deliveryGroupId: updatedItem?.routing?.supplementDeliveryGroupId || null,
        });
      }
    }

    res.json(updatedItem);
  } finally {
    session.endSession();
  }
}));

/**
 * GET /:id/supplement-targets — інформаційний стан груп доставки.
 *
 * Legacy whole-receipt supplement still uses this in its commit modal. Current
 * regular receipts pick the group per item. The displayed state is informative,
 * while the current per-item WRITE path independently enforces the actual business
 * gate: an offer never opens in parallel with ordinary ordering. Preparation may
 * be saved earlier and the scheduler opens it after the ordinary window closes.
 */
router.get('/:id/supplement-targets', staffOnly, asyncHandler(async (req, res) => {
  const receipt = await Receipt.findById(req.params.id, 'type status').lean();
  if (!receipt) throw appError('receipt_not_found');

  const { describeSupplementTargets } = require('../services/supplementTargets');
  res.json(await describeSupplementTargets());
}));

router.post('/:id/commit', staffOnly, asyncHandler(async (req, res) => {
  // Cheap pre-flight (avoids opening a session for the obviously-bad case).
  const receiptCheck = await Receipt.findById(req.params.id).lean();
  if (!receiptCheck) throw appError('receipt_not_found');
  if (receiptCheck.status === 'completed') throw appError('receipt_already_completed');

  // Current regular receipts are receiving documents only. A routingVersion>=1
  // row was created by the staged flow: Stage 1 (photo + received quantity) is
  // enough to close the receipt itself. Commercial preparation, routing and
  // publication remain on ReceiptItem and may happen later from the full-photo
  // preparation feed. This keeps the receiving document independent from the
  // product lifecycle while preserving the old commit path for legacy receipts.
  if (receiptCheck.type === 'regular') {
    const receivingItems = await ReceiptItem.find(
      { receiptId: receiptCheck._id },
      '_id photoUrl routingVersion',
    ).lean();

    const currentReceivingFlow = receivingItems.length > 0
      && receivingItems.every((item) => Number(item.routingVersion || 0) >= 1);

    if (currentReceivingFlow) {
      const incomplete = receivingItems.find((item) => !item.photoUrl);
      if (incomplete) {
        throw appError('receipt_item_incomplete', { fields: 'фото' });
      }

      const receipt = await Receipt.findOneAndUpdate(
        { _id: receiptCheck._id, status: 'draft' },
        { $set: { status: 'completed', completedAt: new Date() } },
        { new: true },
      ).lean();
      if (!receipt) throw appError('receipt_already_completed');

      ReceiptItemLog.create({
        receiptId: receipt._id,
        itemName: receipt.receiptNumber,
        action: 'receipt_complete',
        actor: getActor(req),
      }).catch(() => {});

      // Some items may already have been prepared/routed/confirmed before the
      // receiving document was closed. If any of those are supplement items,
      // completion is the moment their offers are allowed to open. Unprepared
      // rows are simply ignored and can be completed later from the photo feed.
      let supplementOffersCount = 0;
      try {
        const { createOffersForReceipt } = require('../services/supplementOffers');
        const { created: offers } = await createOffersForReceipt(receipt._id);
        supplementOffersCount = offers.length;
        if (offers.length) {
          for (const offer of offers) {
            try {
              getIO()?.emit('supplement_opened', {
                offerId: String(offer._id),
                deliveryGroupId: String(offer.deliveryGroupId),
              });
            } catch (_) {}
          }
          require('../services/supplementNotify').notifyOffers(offers, 'opened').catch(() => {});
        }
      } catch (_) {
        // Receipt completion is receiving-only and must not be rolled back by a
        // non-critical supplement notification/reconciliation failure.
      }

      // Items confirmed before receiving completion become visible in the batch
      // panel at this exact moment. Wake every open staff client immediately
      // instead of waiting for the 20s query fallback.
      try { getIO()?.emit('receipt_supplement_batch_changed', { receiptId: String(receipt._id) }); } catch (_) {}

      return res.json({ receipt, createdProductsCount: 0, supplementOffersCount });
    }
  }

  // ── Legacy whole-receipt supplement target ────────────────────────────────
  // Kept only for old Receipt.type='supplement' rows. Even legacy publication
  // must target the CURRENT non-terminal delivery-cycle OrderingSession.
  let supplementTarget = null;
  if (receiptCheck.type === 'supplement') {
    const { resolveSupplementTarget } = require('../services/supplementTargets');
    supplementTarget = await resolveSupplementTarget(req.body?.targetDeliveryGroupId);
    supplementTarget.openedAt = new Date();
  } else {
    // Current per-item supplements may be prepared while ordinary ordering is
    // open. Cached older clients may already have stored a group on the item, so
    // revalidate those explicit targets against the current delivery session.
    const supplementRows = await ReceiptItem.find(
      { receiptId: receiptCheck._id, routingVersion: { $gte: 1 }, 'routing.supplement': true },
      'routing.supplementDeliveryGroupId',
    ).lean();
    if (supplementRows.length) {
      const { resolveSupplementTarget } = require('../services/supplementTargets');
      const groupIds = [...new Set(supplementRows
        .map((row) => row.routing?.supplementDeliveryGroupId)
        .filter(Boolean)
        .map(String))];
      for (const groupId of groupIds) {
        await resolveSupplementTarget(groupId);
      }
    }
  }

  const session = await mongoose.connection.startSession();
  await withProductOrderNumberLock(async () => {
    session.startTransaction();

    try {
    // Atomic CAS: draft → completed. Виконуємо ПЕРШИМ кроком транзакції, щоб
    // паралельний PATCH/DELETE item (який теж перевіряє status='draft' у своїй
    // транзакції) гарантовано побачив новий статус і відмовив запит, а не
    // переписав/видалив позицію вже після нашої перевірки.
    const receipt = await Receipt.findOneAndUpdate(
      { _id: req.params.id, status: 'draft' },
      {
        $set: {
          status: 'completed',
          completedAt: new Date(),
          // Ціль хвилі стає частиною самого акту проведення: або накладна
          // проведена І має групу, або не проведена зовсім. Записати її окремим
          // апдейтом після коміту означало б вікно, у якому накладна вже
          // completed, а кому вона адресована — невідомо.
          ...(supplementTarget ? {
            targetDeliveryGroupId: supplementTarget.deliveryGroupId,
            supplementOpenedAt:    supplementTarget.openedAt,
            supplementClosesAt:    null,
            supplementStatus:      'pending',
          } : {}),
        },
      },
      { new: true, session },
    );
    if (!receipt) {
      // Do NOT abort/end here — the outer catch owns rollback. Aborting twice
      // on an already-ended session throws a secondary error that masks this
      // one. Just throw; the catch aborts the still-open transaction cleanly.
      throw appError('receipt_already_completed');
    }

    // Re-load items INSIDE the transaction — таким чином усі зміни, які
    // могли пройти між pre-check і CAS, вже або встигли (і ми бачимо актуальний
    // стан), або заблоковані статус-CAS-ом у власних транзакціях.
    const items = await ReceiptItem.find({ receiptId: receipt._id }).session(session);
    if (!items.length) throw appError('receipt_no_items');

    // Multi-worker gate: every item must be confirmed before commit; any warehouse/admin may confirm.
    const pendingConfirm = items.filter((item) => item.status !== 'confirmed').length;
    if (pendingConfirm > 0) {
      throw appError('receipt_items_not_all_confirmed', { pending: pendingConfirm });
    }

    // Re-validate the full publication contract at commit time as well. This is
    // deliberately redundant with /confirm: V37 briefly allowed confirmations
    // without price/package, and a confirmed row can also be edited later. A
    // receipt must never complete while any item lacks price or package quantity.
    for (const item of items) {
      assertItemReadyToConfirm(item, receipt);
    }

    // Mandatory distribution is a separate/manual warehouse workflow. Commit
    // creates the catalog artifact but MUST NOT auto-allocate shops or infer a
    // remaining warehouse quantity from totalQty.

    const createdProducts = [];

    // Pre-determine how many warehouse Products still need a fallback create.
    // Normally confirm already created the Product; this keeps commit robust and
    // idempotent without any pre-existing-product matching path.
    const shelfItems = items.filter((i) => needsWarehouseProduct(normalizeReceiptItemRouting(i, receipt)));
    const createdIdSet = new Set(
      shelfItems.map((i) => i.createdProductId).filter(Boolean).map(String),
    );
    let resolvedCreatedCount = 0;
    if (createdIdSet.size > 0) {
      resolvedCreatedCount = await Product.countDocuments({
        _id: { $in: [...createdIdSet] },
      }).session(session);
    }
    const newProductCount = shelfItems.length - resolvedCreatedCount;
    if (newProductCount > 0) {
      await Product.updateMany(
        { orderNumber: { $gte: 1 } },
        { $inc: { orderNumber: newProductCount } },
        { session },
      );
    }
    let nextOrderNumber = 1;

    for (const item of items) {
      const routing = normalizeReceiptItemRouting(item, receipt);
      // Only explicit warehouse routing creates/updates warehouse stock.
      // Mandatory-only and supplement-only items already own their non-warehouse
      // publication artifacts and must not materialise a fake Product here.
      if (!needsWarehouseProduct(routing)) continue;

      let currentProduct = null;
      const stockAlreadyApplied = !!item.stockApplied;

      if (item.createdProductId) {
        currentProduct = await Product.findById(item.createdProductId).session(session);
        if (currentProduct) {
          if (item.price !== null) currentProduct.price = item.price;
          if (item.qtyPerPackage) currentProduct.quantityPerPackage = item.qtyPerPackage;
          if (!stockAlreadyApplied) currentProduct.quantity = Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty;
          currentProduct.orderingEnabled = isNormalOrderingEnabled(routing);
          currentProduct.mandatoryDistribution = !!routing.mandatory;
          currentProduct.mayNotReachAllShops = !!routing.mayNotReachAllShops;
          currentProduct.receiptItemId = item._id;
          await currentProduct.save({ session });
          // Проведення дописує в товар ціну/упаковку — отже, дзеркало теж мусить
          // їх побачити. Без цього правка ціни між підтвердженням і проведенням
          // лишала «Товари Магазинів» зі старою ціною назавжди.
          await syncMirror(currentProduct, { session });
          if (!stockAlreadyApplied) {
            item.stockApplied = true;
            await item.save({ session });
          }
        }
      }

      if (!currentProduct) {
        currentProduct = new Product({
          orderNumber: nextOrderNumber++,
          price: item.price ?? 0,
          quantity: Number(item.routingVersion || 0) >= 1 ? 0 : item.totalQty,
          warehouse: '',
          category: '',
          name: item.name || '',
          brand: item.name || '',
          model: '',
          status: 'pending',
          source: 'receipt',
          shelvedAt: new Date(),
          orderingEnabled: isNormalOrderingEnabled(routing),
          mandatoryDistribution: !!routing.mandatory,
          mayNotReachAllShops: !!routing.mayNotReachAllShops,
          receiptItemId: item._id,
          imageUrls: [item.photoUrl],
          imageNames: [item.photoName],
          originalImageUrl: item.originalPhotoUrl || '',
          quantityPerPackage: item.qtyPerPackage || 0,
          aiDescription: item.aiDescription || '',
        });

        await currentProduct.save({ session });
        // Той самий інваріант, що й у підтвердженні: складський товар не існує
        // без свого дзеркала в «Товарах Магазинів».
        await syncMirror(currentProduct, { session });
        item.createdProductId = currentProduct._id;
        item.stockApplied = true;
        await item.save({ session });
      }

      createdProducts.push(currentProduct);
    }

    await session.commitTransaction();
    session.endSession();

    ReceiptItemLog.create({
      receiptId: receipt._id,
      itemName: receipt.receiptNumber,
      action: 'receipt_complete',
      actor: getActor(req),
    }).catch((e) => {});

    // Notify warehouse board that new products are available in the incoming strip
    try { getIO().emit('incoming_updated'); } catch (_) {}

    // ── Дозамовлення після durable commit ───────────────────────────────────
    // Legacy Receipt.type='supplement' лишається однією receipt-level хвилею.
    // Current regular rows are publication-managed: unassigned rows stay silent
    // until a worker chooses a group; all ready items join that group+session container.
    // Grouped V47.16 rows remain readable/publishable during rollout.
    //
    // Поза транзакцією свідомо: створення ідемпотентне через container+item identity
    // і current item revision, тому повторний виклик нічого не
    // задублює, а збій розсилки не має відкочувати вже проведену накладну.
    // Відповідь клієнту чекає на створення пропозицій (щоб «Проведено» і
    // «дозамовлення відкрито» не розповзалися в часі), а Telegram — ні.
    let supplementOffersCount = 0;
    try {
      const { createOffersForReceipt } = require('../services/supplementOffers');
      // Works for BOTH legacy supplement receipts and new per-item supplement
      // routing in an ordinary receipt. Creation is idempotent by the exact group+session container and item slot.
      const { created: offers } = await createOffersForReceipt(receipt._id);
      supplementOffersCount = offers.length;
      if (offers.length) {
        for (const offer of offers) {
          try {
            getIO()?.emit('supplement_opened', {
              offerId: String(offer._id),
              deliveryGroupId: String(offer.deliveryGroupId),
            });
          } catch (_) { /* socket is non-critical */ }
        }
        require('../services/supplementNotify')
          .notifyOffers(offers, 'opened')
          .catch(() => {});
      }
    } catch (err) {
      // Receipt completion is durable even if supplement notification/opening
      // needs the reconciler to retry later.
    }

    res.json({
      receipt,
      createdProductsCount: createdProducts.length,
      supplementOffersCount,
      // Клієнт показує це в тості: для якої групи і до котрої години відкрито
      // хвилю. Без цього «Проведено» нічого не каже про головне — кому.
      supplementTarget: supplementTarget ? {
        deliveryGroupId: supplementTarget.deliveryGroupId,
      } : null,
    });
  } catch (err) {
    // Guard both: after a FAILED commitTransaction (e.g. a concurrent-commit
    // WriteConflict) the transaction is already terminal, so an unguarded
    // abortTransaction() throws a SECONDARY error that masks the real one and
    // crashes the handler to 500. Swallow teardown errors so the real cause below wins.
    try { await session.abortTransaction(); } catch { /* already terminal */ }
    try { session.endSession(); } catch { /* idempotent */ }
    // AppError instances are already user-facing; rethrow so the central handler
    // turns them into proper JSON. Anything else becomes a generic commit failure.
    if (err && err.name === 'AppError') throw err;
    if (err && err.name === 'CastError') throw err; // bad :id → global 400, not 500
    // Concurrent double-commit (двічі натиснули «Провести»): the other request won
    // the draft→completed CAS and our transaction hit a transient WriteConflict.
    // Surface a clean 409 (already completed), not a 500.
    const fresh = await Receipt.findById(req.params.id).lean();
    if (fresh && fresh.status === 'completed') throw appError('receipt_already_completed');
    throw appError('receipt_commit_failed');
    }
  });
}));

// ── POST /:id/items/:itemId/describe — generate + cache the item description ──
// On-demand during receiving. Plain-language Ukrainian explainer from the item
// photo, cached on the ReceiptItem; copied into the warehouse Product /
// ShopProduct when this item is confirmed. Pressing again regenerates.
router.post('/:id/items/:itemId/describe', staffOnly, asyncHandler(async (req, res) => {
  const item = await ReceiptItem.findOne({ _id: req.params.itemId, receiptId: req.params.id });
  if (!item) throw appError('receipt_item_not_found');

  const url = item.originalPhotoUrl || item.photoUrl || '';
  if (!url) return res.status(400).json({ error: 'photo_required', message: 'У позиції немає фото' });

  if (!getGeminiStatus().connected) {
    return res.status(503).json({ error: 'describe_not_configured', message: 'Опис недоступний: не підключено Gemini' });
  }

  try {
    const { text, name } = await describeImageUrl(url);
    if (!text) return res.status(502).json({ error: 'empty_description', message: 'Не вдалося згенерувати опис' });
    item.aiDescription = text;
    // Fill the name ONLY when the user left it blank — never clobber a manually
    // typed name with the model's guess.
    if (name && !String(item.name || '').trim()) item.name = name;
    await item.save();
    const io = getIO();
    if (io) io.to(`receipt_${req.params.id}`).emit('receipt_item_updated', item.toObject());
    res.json({ _id: item._id, aiDescription: item.aiDescription, name: item.name });
  } catch (err) {
    return res.status(502).json({ error: 'describe_api_error', message: err.message });
  }
}));

// ── HISTORY / AUDIT LOG ────────────────────────────────────────────────────

// GET all logs for a receipt (lazy — only called when user explicitly opens history)
router.get('/:id/logs', staffOnly, asyncHandler(async (req, res) => {
  const logs = await ReceiptItemLog.find({ receiptId: req.params.id })
    .sort({ createdAt: -1 })
    .lean();
  res.json(logs);
}));

// POST a move_to_block action from the frontend (addToBlock lives in blocks route, not here)
router.post('/:id/items/:itemId/log', staffOnly, asyncHandler(async (req, res) => {
  const { action, blockId, itemName } = req.body || {};
  if (!action) throw appError('receipt_log_action_required');

  await ReceiptItemLog.create({
    receiptId: req.params.id,
    itemId: req.params.itemId,
    itemName: itemName || '',
    action,
    actor: getActor(req),
    meta: blockId ? { blockId } : {},
  });
  res.json({ ok: true });
}));

module.exports = router;

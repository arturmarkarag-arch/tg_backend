'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const CommerceStockReservation = require('../../models/CommerceStockReservation');
const CommerceStockReservationState = require('../../models/CommerceStockReservationState');
const CommerceProduct = require('../../models/CommerceProduct');
const ChannelListing = require('../../models/ChannelListing');
const AllegroOrderIndex = require('../../models/AllegroOrderIndex');
const BaseLinkerOrderIndex = require('../../models/BaseLinkerOrderIndex');
const BaseLinkerPickingOrder = require('../../models/BaseLinkerPickingOrder');
const { withLock } = require('../../utils/lock');

const LEDGER_KEY = 'marketplace';
const STOCK_STATES = Object.freeze(['reserved', 'consumed', 'unknown']);

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function quantity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.floor(n)) : 0;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function dateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function canonicalLineKey({ canonicalProvider, auctionId, sourceLineId, sku, ean, name }) {
  if (canonicalProvider === 'allegro' && auctionId) return `offer:${auctionId}`;
  if (sourceLineId) return `line:${sourceLineId}`;
  if (auctionId) return `auction:${auctionId}`;
  const identity = [sku, ean, name].map((value) => text(value, 300).toLowerCase()).join('|');
  return `identity:${hash(identity).slice(0, 32)}`;
}

function reservationKey(canonicalOrderKey, lineKey) {
  return hash(`${canonicalOrderKey}|${lineKey}`);
}

function baseLinkerCanonical({ accountId, orderId, sourceType, externalOrderId }) {
  const type = text(sourceType, 80).toLowerCase();
  const external = text(externalOrderId, 180);
  if (type === 'allegro' && external) {
    return {
      canonicalProvider: 'allegro',
      canonicalOrderId: external,
      canonicalOrderKey: `allegro:${external}`,
      sourcePriority: 70,
    };
  }
  const oid = text(orderId, 180);
  const aid = text(accountId, 100);
  return {
    canonicalProvider: 'baselinker',
    canonicalOrderId: oid,
    canonicalOrderKey: `baselinker:${aid}:${oid}`,
    sourcePriority: 80,
  };
}

function lineSnapshot(base, item, state, observedAt) {
  const auctionId = text(item?.auction_id ?? item?.auctionId, 180);
  const sourceLineId = text(item?.order_product_id ?? item?.orderProductId ?? item?.lineKey, 180);
  const sku = text(item?.sku, 240);
  const ean = text(item?.ean, 120).replace(/\s+/g, '');
  const name = text(item?.name, 600);
  const qty = quantity(item?.quantity ?? item?.requestedQty);
  if (!qty) return null;
  const lineKey = canonicalLineKey({
    canonicalProvider: base.canonicalProvider,
    auctionId,
    sourceLineId,
    sku,
    ean,
    name,
  });
  return {
    ...base,
    canonicalLineKey: lineKey,
    reservationKey: reservationKey(base.canonicalOrderKey, lineKey),
    sourceLineId,
    auctionId,
    sku,
    ean,
    nameSnapshot: name,
    quantity: qty,
    state,
    upstreamDisposition: state === 'consumed' ? 'sent' : 'active',
    countsAgainstStock: true,
    sourceObservedAt: observedAt,
  };
}

function snapshotsFromAllegroRow(row, state) {
  const orderId = text(row?.checkoutFormId, 180);
  if (!orderId) return [];
  const base = {
    canonicalProvider: 'allegro',
    canonicalOrderId: orderId,
    canonicalOrderKey: `allegro:${orderId}`,
    sourceProvider: 'allegro',
    sourceAccountId: text(row?.accountId, 100),
    sourceOrderId: orderId,
    sourceType: 'allegro',
    sourceExternalOrderId: orderId,
    sourcePriority: 100,
  };
  const observedAt = dateOrNull(row?.upstreamUpdatedAt || row?.lastEventOccurredAt || row?.seenAt || row?.updatedAt) || new Date();
  return (Array.isArray(row?.preview?.products) ? row.preview.products : [])
    .map((item) => lineSnapshot(base, item, state, observedAt))
    .filter(Boolean);
}

function snapshotsFromBaseLinkerIndex(row) {
  const preview = row?.preview || {};
  const accountId = text(row?.baseLinkerAccountId, 100);
  const orderId = text(row?.orderId || preview?.order_id, 180);
  if (!accountId || !orderId) return [];
  const sourceType = text(preview?.order_source || row?.sourceType, 80).toLowerCase();
  const externalOrderId = text(preview?.external_order_id, 180);
  const canonical = baseLinkerCanonical({ accountId, orderId, sourceType, externalOrderId });
  const base = {
    ...canonical,
    sourceProvider: 'baselinker',
    sourceAccountId: accountId,
    sourceOrderId: orderId,
    sourceType,
    sourceExternalOrderId: externalOrderId,
  };
  const observedAt = dateOrNull(row?.seenAt || row?.updatedAt) || new Date();
  return (Array.isArray(preview?.products) ? preview.products : [])
    .map((item) => lineSnapshot(base, item, 'reserved', observedAt))
    .filter(Boolean);
}

function snapshotsFromBaseLinkerSent(row) {
  const accountId = text(row?.baseLinkerAccountId, 100);
  const orderId = text(row?.orderId, 180);
  if (!accountId || !orderId) return [];
  const sourceType = text(row?.sourceType, 80).toLowerCase();
  const externalOrderId = text(row?.sourceExternalOrderId, 180);
  const canonical = baseLinkerCanonical({ accountId, orderId, sourceType, externalOrderId });
  const base = {
    ...canonical,
    sourceProvider: 'baselinker',
    sourceAccountId: accountId,
    sourceOrderId: orderId,
    sourceType,
    sourceExternalOrderId: externalOrderId,
  };
  const observedAt = dateOrNull(row?.sentAt || row?.updatedAt) || new Date();
  return (Array.isArray(row?.items) ? row.items : [])
    .map((item) => lineSnapshot(base, item, 'consumed', observedAt))
    .filter(Boolean);
}

function mergeSnapshot(target, incoming) {
  const current = target.get(incoming.reservationKey);
  if (!current) {
    target.set(incoming.reservationKey, incoming);
    return;
  }
  // Direct marketplace data outranks an aggregator bridge for the same canonical
  // order line. Quantity disagreements are held at the larger value (fail-closed)
  // so a stale duplicate can cause undersell, never oversell.
  const winner = incoming.sourcePriority > current.sourcePriority ? incoming : current;
  target.set(incoming.reservationKey, {
    ...winner,
    quantity: Math.max(quantity(current.quantity), quantity(incoming.quantity)),
    sourceObservedAt: [dateOrNull(current.sourceObservedAt), dateOrNull(incoming.sourceObservedAt)]
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || new Date(),
  });
}

async function loadDesiredSnapshots(startedAt) {
  const [allegroRows, baseLinkerRows, recentBaseLinkerSent] = await Promise.all([
    AllegroOrderIndex.find({
      fulfillmentProviderId: 'SELLER',
      $or: [
        { upstreamStage: { $in: ['processing', 'deferred'] } },
        { upstreamStage: 'sent', orderSortDate: { $gte: startedAt } },
      ],
    }).select('accountId checkoutFormId upstreamStage upstreamUpdatedAt lastEventOccurredAt seenAt orderSortDate preview updatedAt').lean(),
    BaseLinkerOrderIndex.find({}).select('baseLinkerAccountId orderId sourceType seenAt preview updatedAt').lean(),
    BaseLinkerPickingOrder.find({
      $or: [{ workflowStage: 'sent' }, { status: 'sent' }, { upstreamDisposition: 'sent' }],
      sentAt: { $gte: startedAt },
    }).select('baseLinkerAccountId orderId sourceType sourceExternalOrderId sentAt items updatedAt').lean(),
  ]);

  const map = new Map();
  for (const row of allegroRows) {
    const state = String(row?.upstreamStage || '') === 'sent' ? 'consumed' : 'reserved';
    for (const snapshot of snapshotsFromAllegroRow(row, state)) mergeSnapshot(map, snapshot);
  }
  for (const row of baseLinkerRows) {
    for (const snapshot of snapshotsFromBaseLinkerIndex(row)) mergeSnapshot(map, snapshot);
  }
  for (const row of recentBaseLinkerSent) {
    for (const snapshot of snapshotsFromBaseLinkerSent(row)) mergeSnapshot(map, snapshot);
  }
  return [...map.values()];
}

async function resolveSnapshots(snapshots) {
  const auctionIds = [...new Set(snapshots.filter((row) => row.canonicalProvider === 'allegro').map((row) => row.auctionId).filter(Boolean))];
  const skuKeys = [...new Set(snapshots.map((row) => text(row.sku, 240).toLocaleUpperCase('en-US')).filter(Boolean))];
  const eanKeys = [...new Set(snapshots.map((row) => text(row.ean, 120).replace(/\s+/g, '')).filter(Boolean))];

  const [listings, products] = await Promise.all([
    auctionIds.length
      ? ChannelListing.find({ provider: 'allegro', externalId: { $in: auctionIds } })
        .select('_id commerceProductId accountId externalId')
        .lean()
      : [],
    (skuKeys.length || eanKeys.length)
      ? CommerceProduct.find({
        $or: [
          ...(skuKeys.length ? [{ skuKey: { $in: skuKeys } }] : []),
          ...(eanKeys.length ? [{ eanKey: { $in: eanKeys } }] : []),
        ],
      }).select('_id sku ean +skuKey +eanKey').lean()
      : [],
  ]);

  const listingByOffer = new Map();
  for (const listing of listings) {
    const key = text(listing.externalId, 180);
    if (!listingByOffer.has(key)) listingByOffer.set(key, []);
    listingByOffer.get(key).push(listing);
  }
  const bySku = new Map();
  const byEan = new Map();
  for (const product of products) {
    const skuKey = text(product.skuKey || product.sku, 240).toLocaleUpperCase('en-US');
    const eanKey = text(product.eanKey || product.ean, 120).replace(/\s+/g, '');
    if (skuKey) bySku.set(skuKey, product);
    if (eanKey) {
      if (!byEan.has(eanKey)) byEan.set(eanKey, []);
      byEan.get(eanKey).push(product);
    }
  }

  return snapshots.map((snapshot) => {
    if (snapshot.canonicalProvider === 'allegro' && snapshot.auctionId) {
      let candidates = listingByOffer.get(snapshot.auctionId) || [];
      if (snapshot.sourceProvider === 'allegro' && snapshot.sourceAccountId) {
        const exactAccount = candidates.filter((row) => text(row.accountId, 100) === snapshot.sourceAccountId);
        if (exactAccount.length) candidates = exactAccount;
      }
      if (candidates.length === 1) {
        return {
          ...snapshot,
          commerceProductId: candidates[0].commerceProductId,
          channelListingId: candidates[0]._id,
          matchState: 'resolved',
          matchStrategy: 'listing_offer_id',
          issueCode: '',
          issueMessage: '',
        };
      }
      if (candidates.length > 1) {
        return {
          ...snapshot,
          commerceProductId: null,
          channelListingId: null,
          matchState: 'ambiguous',
          matchStrategy: 'ambiguous',
          issueCode: 'reservation_offer_mapping_ambiguous',
          issueMessage: 'Один marketplace offer відповідає кільком ChannelListing. Reservation не можна безпечно прив’язати до CommerceProduct.',
        };
      }
    }

    const skuKey = text(snapshot.sku, 240).toLocaleUpperCase('en-US');
    if (skuKey && bySku.has(skuKey)) {
      return {
        ...snapshot,
        commerceProductId: bySku.get(skuKey)._id,
        channelListingId: null,
        matchState: 'resolved',
        matchStrategy: 'sku',
        issueCode: '',
        issueMessage: '',
      };
    }

    const eanKey = text(snapshot.ean, 120).replace(/\s+/g, '');
    const eanMatches = eanKey ? (byEan.get(eanKey) || []) : [];
    if (eanMatches.length === 1) {
      return {
        ...snapshot,
        commerceProductId: eanMatches[0]._id,
        channelListingId: null,
        matchState: 'resolved',
        matchStrategy: 'ean',
        issueCode: '',
        issueMessage: '',
      };
    }
    if (eanMatches.length > 1) {
      return {
        ...snapshot,
        commerceProductId: null,
        channelListingId: null,
        matchState: 'ambiguous',
        matchStrategy: 'ambiguous',
        issueCode: 'reservation_ean_mapping_ambiguous',
        issueMessage: 'EAN відповідає кільком CommerceProduct. Reservation залишено fail-closed до ручного виправлення каталогу.',
      };
    }

    return {
      ...snapshot,
      commerceProductId: null,
      channelListingId: null,
      matchState: 'unresolved',
      matchStrategy: 'unresolved',
      issueCode: 'reservation_product_unresolved',
      issueMessage: 'Не вдалося однозначно зіставити marketplace order line з CommerceProduct за offerId/SKU/EAN.',
    };
  });
}

async function terminalStateMaps(rows) {
  const allegroIds = [...new Set(rows.filter((row) => row.canonicalProvider === 'allegro').map((row) => row.canonicalOrderId).filter(Boolean))];
  const baseLinkerKeys = rows
    .filter((row) => row.sourceProvider === 'baselinker')
    .map((row) => ({ accountId: text(row.sourceAccountId, 100), orderId: text(row.sourceOrderId, 180) }))
    .filter((row) => row.accountId && row.orderId);

  const [allegroRows, baseLinkerPicking] = await Promise.all([
    allegroIds.length
      ? AllegroOrderIndex.find({ checkoutFormId: { $in: allegroIds } }).select('checkoutFormId upstreamStage').lean()
      : [],
    baseLinkerKeys.length
      ? BaseLinkerPickingOrder.find({
        $or: baseLinkerKeys.map((row) => ({ baseLinkerAccountId: row.accountId, orderId: row.orderId })),
      }).select('baseLinkerAccountId orderId workflowStage status upstreamDisposition sentAt').lean()
      : [],
  ]);

  const allegro = new Map(allegroRows.map((row) => [text(row.checkoutFormId, 180), text(row.upstreamStage, 40).toLowerCase()]));
  const baseLinker = new Map(baseLinkerPicking.map((row) => [`${text(row.baseLinkerAccountId, 100)}:${text(row.orderId, 180)}`, row]));
  return { allegro, baseLinker };
}

function transitionForMissing(row, maps) {
  if (row.canonicalProvider === 'allegro') {
    const stage = maps.allegro.get(text(row.canonicalOrderId, 180));
    if (stage === 'sent') return { state: 'consumed', countsAgainstStock: true, disposition: 'sent', issueCode: '', issueMessage: '' };
    if (stage === 'cancelled') return { state: 'released', countsAgainstStock: false, disposition: 'cancelled', issueCode: '', issueMessage: '' };
    if (['processing', 'deferred'].includes(stage)) {
      return {
        state: 'unknown', countsAgainstStock: true, disposition: stage,
        issueCode: 'reservation_line_missing_from_active_order',
        issueMessage: 'Order лишається активним, але ця line більше не присутня в локальній проєкції. Одиниці продовжують утримуватися fail-closed.',
      };
    }
  }

  if (row.sourceProvider === 'baselinker') {
    const doc = maps.baseLinker.get(`${text(row.sourceAccountId, 100)}:${text(row.sourceOrderId, 180)}`);
    const disposition = text(doc?.upstreamDisposition, 40).toLowerCase();
    const workflow = text(doc?.workflowStage, 40).toLowerCase();
    const status = text(doc?.status, 40).toLowerCase();
    if (disposition === 'cancelled') return { state: 'released', countsAgainstStock: false, disposition: 'cancelled', issueCode: '', issueMessage: '' };
    if (disposition === 'sent' || workflow === 'sent' || status === 'sent') return { state: 'consumed', countsAgainstStock: true, disposition: 'sent', issueCode: '', issueMessage: '' };
  }

  return {
    state: 'unknown', countsAgainstStock: true, disposition: 'unverified',
    issueCode: 'reservation_source_disappeared_unverified',
    issueMessage: 'Order line зникла з активної локальної черги без підтвердженого cancel/sent. Reservation утримується fail-closed до reconciliation.',
  };
}

async function summarizeLedger(stateDoc) {
  const groups = await CommerceStockReservation.aggregate([
    {
      $group: {
        _id: { state: '$state', matchState: '$matchState' },
        rows: { $sum: 1 },
        units: { $sum: '$quantity' },
      },
    },
  ]);
  const summary = {
    startedAt: stateDoc.startedAt,
    lastRefreshAt: stateDoc.lastRefreshAt,
    rows: 0,
    heldRows: 0,
    heldUnits: 0,
    reservedUnits: 0,
    consumedUnits: 0,
    unknownUnits: 0,
    releasedUnits: 0,
    unresolvedHeldRows: 0,
    ambiguousHeldRows: 0,
    mappingCoverageReady: true,
    inventoryConsumptionReady: false,
    writeReady: false,
  };
  for (const group of groups) {
    const state = text(group?._id?.state, 40);
    const matchState = text(group?._id?.matchState, 40);
    const rows = Number(group?.rows || 0);
    const units = Number(group?.units || 0);
    summary.rows += rows;
    if (STOCK_STATES.includes(state)) {
      summary.heldRows += rows;
      summary.heldUnits += units;
      if (matchState === 'unresolved') summary.unresolvedHeldRows += rows;
      if (matchState === 'ambiguous') summary.ambiguousHeldRows += rows;
    }
    if (state === 'reserved') summary.reservedUnits += units;
    if (state === 'consumed') summary.consumedUnits += units;
    if (state === 'unknown') summary.unknownUnits += units;
    if (state === 'released') summary.releasedUnits += units;
  }
  summary.mappingCoverageReady = summary.unresolvedHeldRows === 0 && summary.ambiguousHeldRows === 0;
  return summary;
}

async function refreshCommerceStockReservations() {
  return withLock('commerce:stock-reservations:refresh', async () => {
    const now = new Date();
    const stateDoc = await CommerceStockReservationState.findOneAndUpdate(
      { key: LEDGER_KEY },
      { $setOnInsert: { key: LEDGER_KEY, startedAt: now } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    const refreshId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    try {
      const snapshots = await resolveSnapshots(await loadDesiredSnapshots(stateDoc.startedAt));
      if (snapshots.length) {
        await CommerceStockReservation.bulkWrite(snapshots.map((row) => ({
          updateOne: {
            filter: { reservationKey: row.reservationKey },
            update: {
              $set: {
                sourceKind: 'marketplace_order',
                canonicalProvider: row.canonicalProvider,
                canonicalOrderId: row.canonicalOrderId,
                canonicalOrderKey: row.canonicalOrderKey,
                canonicalLineKey: row.canonicalLineKey,
                sourceProvider: row.sourceProvider,
                sourceAccountId: row.sourceAccountId,
                sourceOrderId: row.sourceOrderId,
                sourceLineId: row.sourceLineId,
                sourceType: row.sourceType || '',
                sourceExternalOrderId: row.sourceExternalOrderId || '',
                sourcePriority: Number(row.sourcePriority || 0),
                auctionId: row.auctionId || '',
                sku: row.sku || '',
                ean: row.ean || '',
                nameSnapshot: row.nameSnapshot || '',
                commerceProductId: row.commerceProductId || null,
                channelListingId: row.channelListingId || null,
                matchState: row.matchState,
                matchStrategy: row.matchStrategy,
                state: row.state,
                quantity: quantity(row.quantity),
                countsAgainstStock: true,
                upstreamDisposition: row.upstreamDisposition || '',
                issueCode: row.issueCode || '',
                issueMessage: row.issueMessage || '',
                sourceObservedAt: row.sourceObservedAt || now,
                consumedAt: row.state === 'consumed' ? (row.sourceObservedAt || now) : null,
                releasedAt: null,
                lastSeenAt: now,
                lastRefreshId: refreshId,
              },
              $setOnInsert: { firstReservedAt: now },
            },
            upsert: true,
          },
        })), { ordered: false });
      }

      const missing = await CommerceStockReservation.find({
        sourceKind: 'marketplace_order',
        state: { $in: ['reserved', 'unknown'] },
        lastRefreshId: { $ne: refreshId },
      }).lean();
      if (missing.length) {
        const maps = await terminalStateMaps(missing);
        const ops = missing.map((row) => {
          const transition = transitionForMissing(row, maps);
          return {
            updateOne: {
              filter: { _id: row._id, state: { $in: ['reserved', 'unknown'] }, lastRefreshId: { $ne: refreshId } },
              update: { $set: {
                state: transition.state,
                countsAgainstStock: transition.countsAgainstStock,
                upstreamDisposition: transition.disposition,
                issueCode: transition.issueCode,
                issueMessage: transition.issueMessage,
                consumedAt: transition.state === 'consumed' ? (row.consumedAt || now) : null,
                releasedAt: transition.state === 'released' ? now : null,
                lastRefreshId: refreshId,
              } },
            },
          };
        });
        await CommerceStockReservation.bulkWrite(ops, { ordered: false });
      }

      stateDoc.lastRefreshAt = now;
      stateDoc.lastRefreshId = refreshId;
      stateDoc.lastError = '';
      const summary = await summarizeLedger(stateDoc);
      stateDoc.lastSummary = summary;
      await stateDoc.save();
      return { ...summary, refreshId, ledgerReady: true };
    } catch (error) {
      stateDoc.lastRefreshAt = now;
      stateDoc.lastRefreshId = refreshId;
      stateDoc.lastError = text(error?.code || error?.message || 'commerce_stock_reservation_refresh_failed', 500);
      await stateDoc.save().catch(() => {});
      throw error;
    }
  }, { ttlMs: 30_000, waitMs: 8_000 });
}

async function getReservationTotals(productIds = []) {
  const ids = [...new Set(productIds.map((value) => String(value || '')).filter((value) => mongoose.isValidObjectId(value)))]
    .map((value) => new mongoose.Types.ObjectId(value));
  const [groups, unresolvedHeld] = await Promise.all([
    ids.length
      ? CommerceStockReservation.aggregate([
        { $match: { commerceProductId: { $in: ids }, countsAgainstStock: true, state: { $in: STOCK_STATES } } },
        { $group: { _id: { productId: '$commerceProductId', state: '$state' }, units: { $sum: '$quantity' }, rows: { $sum: 1 } } },
      ])
      : [],
    CommerceStockReservation.countDocuments({
      countsAgainstStock: true,
      state: { $in: STOCK_STATES },
      matchState: { $in: ['unresolved', 'ambiguous'] },
    }),
  ]);
  const map = new Map();
  for (const group of groups) {
    const productId = String(group?._id?.productId || '');
    if (!map.has(productId)) map.set(productId, { reserved: 0, consumed: 0, unknown: 0, held: 0, rows: 0 });
    const target = map.get(productId);
    const state = text(group?._id?.state, 40);
    const units = quantity(group?.units);
    if (state === 'reserved') target.reserved += units;
    if (state === 'consumed') target.consumed += units;
    if (state === 'unknown') target.unknown += units;
    target.held += units;
    target.rows += Number(group?.rows || 0);
  }
  return { byProductId: map, unresolvedHeldRows: Number(unresolvedHeld || 0) };
}

module.exports = {
  STOCK_STATES,
  refreshCommerceStockReservations,
  getReservationTotals,
  reservationKey,
  baseLinkerCanonical,
};

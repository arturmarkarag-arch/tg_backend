'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const CommerceStockReservation = require('../../models/CommerceStockReservation');
const CommerceStockReservationState = require('../../models/CommerceStockReservationState');
const CommerceProduct = require('../../models/CommerceProduct');
const ChannelListing = require('../../models/ChannelListing');
const { withLock } = require('../../utils/lock');
const { listProviderAdapters } = require('./providers/registry');
const {
  text,
  quantity,
  dateOrNull,
  reservationKey,
} = require('./providers/reservationProjection');

const LEDGER_KEY = 'marketplace';
const STOCK_STATES = Object.freeze(['reserved', 'consumed', 'unknown']);

function mergeSnapshot(target, incoming) {
  const current = target.get(incoming.reservationKey);
  if (!current) {
    target.set(incoming.reservationKey, incoming);
    return;
  }
  // A provider adapter declares sourcePriority. Direct source data can therefore
  // outrank aggregator bridges without Commerce Core knowing provider names.
  // Quantity disagreements keep the larger hold (fail-closed: undersell, never oversell).
  const winner = incoming.sourcePriority > current.sourcePriority ? incoming : current;
  target.set(incoming.reservationKey, {
    ...winner,
    quantity: Math.max(quantity(current.quantity), quantity(incoming.quantity)),
    sourceObservedAt: [dateOrNull(current.sourceObservedAt), dateOrNull(incoming.sourceObservedAt)]
      .filter(Boolean)
      .sort((a, b) => b.getTime() - a.getTime())[0] || new Date(),
  });
}

function reservationAdapters() {
  return listProviderAdapters().filter((adapter) => adapter?.reservationProjection);
}

async function loadDesiredSnapshots(startedAt) {
  const batches = await Promise.all(reservationAdapters()
    .filter((adapter) => typeof adapter.reservationProjection?.loadDesiredSnapshots === 'function')
    .map((adapter) => adapter.reservationProjection.loadDesiredSnapshots({ startedAt })));
  const map = new Map();
  for (const batch of batches) {
    for (const snapshot of Array.isArray(batch) ? batch : []) mergeSnapshot(map, snapshot);
  }
  return [...map.values()];
}

async function resolveSnapshots(snapshots) {
  const listingIdsByProvider = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot.matchByListingExternalId || !snapshot.canonicalProvider || !snapshot.auctionId) continue;
    if (!listingIdsByProvider.has(snapshot.canonicalProvider)) listingIdsByProvider.set(snapshot.canonicalProvider, new Set());
    listingIdsByProvider.get(snapshot.canonicalProvider).add(snapshot.auctionId);
  }
  const listingFilters = [...listingIdsByProvider.entries()].map(([provider, ids]) => ({
    provider,
    externalId: { $in: [...ids] },
  }));
  const skuKeys = [...new Set(snapshots.map((row) => text(row.sku, 240).toLocaleUpperCase('en-US')).filter(Boolean))];
  const eanKeys = [...new Set(snapshots.map((row) => text(row.ean, 120).replace(/\s+/g, '')).filter(Boolean))];

  const [listings, products] = await Promise.all([
    listingFilters.length
      ? ChannelListing.find({ $or: listingFilters }).select('_id commerceProductId provider accountId externalId').lean()
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

  const listingsByExternalId = new Map();
  for (const listing of listings) {
    const key = `${text(listing.provider, 80)}:${text(listing.externalId, 180)}`;
    if (!listingsByExternalId.has(key)) listingsByExternalId.set(key, []);
    listingsByExternalId.get(key).push(listing);
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
    if (snapshot.matchByListingExternalId && snapshot.canonicalProvider && snapshot.auctionId) {
      const key = `${snapshot.canonicalProvider}:${snapshot.auctionId}`;
      let candidates = listingsByExternalId.get(key) || [];
      if (snapshot.sourceProvider === snapshot.canonicalProvider && snapshot.sourceAccountId) {
        const exactAccount = candidates.filter((row) => text(row.accountId, 100) === snapshot.sourceAccountId);
        if (exactAccount.length) candidates = exactAccount;
      }
      if (candidates.length === 1) {
        return {
          ...snapshot,
          commerceProductId: candidates[0].commerceProductId,
          channelListingId: candidates[0]._id,
          matchState: 'resolved',
          matchStrategy: 'listing_external_id',
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
          issueCode: 'reservation_listing_mapping_ambiguous',
          issueMessage: 'Один provider listing відповідає кільком ChannelListing. Reservation не можна безпечно прив’язати до CommerceProduct.',
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
      issueMessage: 'Не вдалося однозначно зіставити provider order line з CommerceProduct за listing/SKU/EAN.',
    };
  });
}

async function terminalStateMaps(rows) {
  const canonical = new Map();
  const source = new Map();
  await Promise.all(reservationAdapters().map(async (adapter) => {
    const projection = adapter.reservationProjection || {};
    if (typeof projection.loadCanonicalReservationStates === 'function') {
      const relevant = rows.filter((row) => row.canonicalProvider === adapter.id);
      if (relevant.length) canonical.set(adapter.id, await projection.loadCanonicalReservationStates(relevant));
    }
    if (typeof projection.loadSourceReservationStates === 'function') {
      const relevant = rows.filter((row) => row.sourceProvider === adapter.id);
      if (relevant.length) source.set(adapter.id, await projection.loadSourceReservationStates(relevant));
    }
  }));
  return { canonical, source };
}

function transitionForMissing(row, maps) {
  const canonicalState = text(
    maps.canonical.get(text(row.canonicalProvider, 80))?.get(text(row.canonicalOrderId, 180)),
    40,
  ).toLowerCase();
  if (canonicalState === 'sent') return { state: 'consumed', countsAgainstStock: true, disposition: 'sent', issueCode: '', issueMessage: '' };
  if (canonicalState === 'cancelled') return { state: 'released', countsAgainstStock: false, disposition: 'cancelled', issueCode: '', issueMessage: '' };
  if (['processing', 'deferred', 'active'].includes(canonicalState)) {
    return {
      state: 'unknown', countsAgainstStock: true, disposition: canonicalState,
      issueCode: 'reservation_line_missing_from_active_order',
      issueMessage: 'Order лишається активним, але ця line більше не присутня в provider projection. Одиниці продовжують утримуватися fail-closed.',
    };
  }

  const sourceKey = `${text(row.sourceAccountId, 100)}:${text(row.sourceOrderId, 180)}`;
  const sourceState = text(maps.source.get(text(row.sourceProvider, 80))?.get(sourceKey), 40).toLowerCase();
  if (sourceState === 'cancelled') return { state: 'released', countsAgainstStock: false, disposition: 'cancelled', issueCode: '', issueMessage: '' };
  if (sourceState === 'sent') return { state: 'consumed', countsAgainstStock: true, disposition: 'sent', issueCode: '', issueMessage: '' };

  return {
    state: 'unknown', countsAgainstStock: true, disposition: 'unverified',
    issueCode: 'reservation_source_disappeared_unverified',
    issueMessage: 'Order line зникла з активної provider projection без підтвердженого cancel/sent. Reservation утримується fail-closed до reconciliation.',
  };
}

async function summarizeLedger(stateDoc) {
  const groups = await CommerceStockReservation.aggregate([
    {
      $group: {
        _id: { state: '$state', matchState: '$matchState', countsAgainstStock: '$countsAgainstStock' },
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
    const countsAgainstStock = group?._id?.countsAgainstStock === true;
    summary.rows += rows;
    if (STOCK_STATES.includes(state) && countsAgainstStock) {
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
};

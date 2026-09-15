'use strict';

const crypto = require('crypto');

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

function canonicalLineKey({ preferListingIdentity = false, listingId, sourceLineId, sku, ean, name }) {
  if (preferListingIdentity && listingId) return `offer:${listingId}`;
  if (sourceLineId) return `line:${sourceLineId}`;
  if (listingId) return `auction:${listingId}`;
  const identity = [sku, ean, name].map((value) => text(value, 300).toLowerCase()).join('|');
  return `identity:${hash(identity).slice(0, 32)}`;
}

function reservationKey(canonicalOrderKey, lineKey) {
  return hash(`${canonicalOrderKey}|${lineKey}`);
}

function lineSnapshot(base, item, state, observedAt, { preferListingIdentity = false, matchByListingExternalId = false } = {}) {
  const listingId = text(item?.auction_id ?? item?.auctionId, 180);
  const sourceLineId = text(item?.order_product_id ?? item?.orderProductId ?? item?.lineKey, 180);
  const sku = text(item?.sku, 240);
  const ean = text(item?.ean, 120).replace(/\s+/g, '');
  const name = text(item?.name, 600);
  const qty = quantity(item?.quantity ?? item?.requestedQty);
  if (!qty) return null;
  const lineKey = canonicalLineKey({
    preferListingIdentity,
    listingId,
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
    auctionId: listingId,
    matchByListingExternalId: matchByListingExternalId === true,
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

module.exports = {
  text,
  quantity,
  hash,
  dateOrNull,
  canonicalLineKey,
  reservationKey,
  lineSnapshot,
};

'use strict';

/**
 * Canonical read projection for one SupplementRequest's publication revision.
 *
 * SupplementOffer stores the current item slot plus immutable revision snapshots.
 * Historical readers MUST resolve through this helper; otherwise a cancelled /
 * packed old request could render the photo/price/status of a later re-publication.
 */
const { ITEM_STATUS, revisionOf } = require('../utils/supplementState');

function offerSnapshotForRequestRevision(offer, request) {
  if (!offer) return null;
  const revision = revisionOf(request);
  const currentRevision = revisionOf(offer);
  if (revision === currentRevision) return offer;

  const archived = (offer.revisionHistory || []).find((row) => revisionOf(row) === revision);
  if (!archived) {
    // Fail closed on identity: never pretend a historical request belongs to the
    // current revision. Preserve stable relation fields, but mark the missing
    // publication snapshot explicitly so callers can avoid false current truth.
    return {
      ...offer,
      revision,
      status: ITEM_STATUS.CANCELLED,
      sourceSnapshot: {},
      openedAt: request?.createdAt || null,
      frozenAt: null,
      completedAt: null,
      cancelledAt: null,
      cancelReason: 'revision_snapshot_missing',
      revisionSnapshotMissing: true,
    };
  }

  return {
    ...offer,
    revision,
    status: archived.status,
    sourceSnapshot: archived.sourceSnapshot || {},
    openedAt: archived.openedAt || request?.createdAt || null,
    frozenAt: archived.frozenAt || null,
    completedAt: archived.completedAt || null,
    cancelledAt: archived.cancelledAt || null,
    cancelReason: archived.cancelReason || '',
    revisionSnapshotMissing: false,
  };
}

module.exports = { offerSnapshotForRequestRevision };

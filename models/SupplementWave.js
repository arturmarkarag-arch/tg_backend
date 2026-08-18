'use strict';

const mongoose = require('mongoose');
const { ITEM_STATUS, ACTIVE_ITEM_STATUSES, TERMINAL_ITEM_STATUSES } = require('../utils/supplementState');

/**
 * Supplement container for ONE DeliveryGroup + ONE exact OrderingSession.
 *
 * V48.S3+: the Wave is a stable container, NOT a one-shot batch. Individual
 * SupplementOffer rows own the lifecycle of each item publication/revision.
 * The container may therefore move between summary states many times while the
 * exact delivery session is alive (new items can be added after older items were
 * frozen/completed/cancelled).
 *
 * Legacy V48.S2 fields are preserved for rollout/history compatibility.
 */
const SupplementWaveSchema = new mongoose.Schema(
  {
    deliveryGroupId: { type: String, required: true },
    orderingSessionId: { type: String, required: true },

    // 3 = stable group+session container with item-level lifecycle/revisions.
    architectureVersion: { type: Number, default: 3 },
    containerKey: { type: String, default: null },
    mergedIntoWaveId: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplementWave', default: null },

    // Derived operational summary for compatibility/UI. It is NOT the seller
    // edit lock in V48.S3; SupplementOffer.status is authoritative per item.
    status: {
      type: String,
      enum: Object.values(ITEM_STATUS),
      default: ITEM_STATUS.OPEN,
      required: true,
    },

    openedAt: { type: Date, default: Date.now },
    openedBy: { type: String, default: '' },
    openedByName: { type: String, default: '' },

    frozenAt: { type: Date, default: null },
    frozenBy: { type: String, default: '' },
    frozenByName: { type: String, default: '' },

    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: '' },
    completedByName: { type: String, default: '' },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: '' },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },

    // Every successful item-publication command increments activityRevision.
    // Notification claims are revision-based, so a container can be reopened
    // 100+ times without a one-shot `notifiedTypes` lifetime lock.
    activityRevision: { type: Number, default: 0 },
    openedNotifiedRevision: { type: Number, default: 0 },
    frozenNotifiedRevision: { type: Number, default: 0 },
    cancelledNotifiedRevision: { type: Number, default: 0 },
    lastReminderRevision: { type: Number, default: 0 },
    lastReminderAt: { type: Date, default: null },

    // Legacy V48.S2 notification/idempotency fields.
    notifiedTypes: { type: [String], default: [] },
    publicationKey: { type: String, default: null },
  },
  { timestamps: true },
);

// Legacy helper constants remain for compatibility readers only. New operational
// code must inspect current SupplementOffer statuses for exact-session work.
SupplementWaveSchema.statics.ACTIVE_STATUSES = [...ACTIVE_ITEM_STATUSES];
SupplementWaveSchema.statics.TERMINAL_STATUSES = [...TERMINAL_ITEM_STATUSES];
SupplementWaveSchema.statics.ARCHITECTURE_VERSION = 3;

SupplementWaveSchema.index(
  { containerKey: 1 },
  { unique: true, partialFilterExpression: { containerKey: { $type: 'string' } } },
);
SupplementWaveSchema.index(
  { publicationKey: 1 },
  { unique: true, partialFilterExpression: { publicationKey: { $type: 'string' } } },
);
SupplementWaveSchema.index({ orderingSessionId: 1, status: 1 });
SupplementWaveSchema.index({ deliveryGroupId: 1, orderingSessionId: 1 });

module.exports = mongoose.model('SupplementWave', SupplementWaveSchema);

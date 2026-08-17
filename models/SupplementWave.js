'use strict';

const mongoose = require('mongoose');

/**
 * V48.S2 aggregate root for one supplement publication.
 *
 * One Wave = one explicit publication to ONE DeliveryGroup in ONE OrderingSession.
 * Items/offers and shop requests are children of this lifecycle; current Shop
 * topology must never migrate a Wave to another delivery cycle.
 */
const SupplementWaveSchema = new mongoose.Schema(
  {
    deliveryGroupId: { type: String, required: true },
    orderingSessionId: { type: String, required: true },

    status: {
      type: String,
      enum: ['open', 'frozen', 'completed', 'cancelled'],
      default: 'open',
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

    // Idempotent lifecycle notifications belong to the Wave, never to every item.
    notifiedTypes: { type: [String], default: [] },
    lastReminderAt: { type: Date, default: null },

    // Stable idempotency key for a publish command. It is intentionally opaque to
    // UI and derived from target session + selected receipt item ids.
    publicationKey: { type: String, required: true },
  },
  { timestamps: true },
);

SupplementWaveSchema.statics.ACTIVE_STATUSES = ['open', 'frozen'];
SupplementWaveSchema.statics.TERMINAL_STATUSES = ['completed', 'cancelled'];

SupplementWaveSchema.index({ publicationKey: 1 }, { unique: true });
SupplementWaveSchema.index({ orderingSessionId: 1, status: 1 });
SupplementWaveSchema.index({ deliveryGroupId: 1, orderingSessionId: 1, status: 1 });

module.exports = mongoose.model('SupplementWave', SupplementWaveSchema);

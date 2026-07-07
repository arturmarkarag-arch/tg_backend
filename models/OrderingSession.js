'use strict';

const mongoose = require('mongoose');
const { PICKING_STATUSES, EVENT_TYPES } = require('../utils/sessionVocab');

// Timeline of things that HAPPENED to the session (verbs), kept separate from
// pickingStatus (the single current STATE). The two axes never conflict: a
// session can be `in_progress` AND have a `rescheduled` event — events accumulate,
// status holds exactly one value. The enum lives in utils/sessionVocab so the
// schema, state-machine and UI labels share a single source of truth.
const SessionEventSchema = new mongoose.Schema(
  {
    at:     { type: Date, default: Date.now },
    type:   { type: String, enum: EVENT_TYPES, required: true },
    by:     { type: String, default: '' },
    byName: { type: String, default: '' },
    meta:   { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const OrderingSessionSchema = new mongoose.Schema(
  {
    groupId:  { type: String, required: true },
    // Human-facing sequential number, PER delivery group, assigned the moment the
    // FIRST order of the session is placed (see utils/sessionSeq.ensureSessionSeq).
    // null until then, so empty weeks (nobody ordered) never consume a number and
    // the sequence the operator sees stays gap-free ("Сесія №12"). Sourced from the
    // atomic Counter collection under name `session-seq:<groupId>`.
    seq: { type: Number, default: null },
    // "YYYY-MM-DD" in Warsaw timezone — the calendar date the window opens on.
    // Using the date (not the exact timestamp) means a time change by the admin
    // (e.g. 16:00 → 15:00) does NOT produce a new session document, so all orders
    // placed before the schedule change stay associated with the same session.
    openDate: { type: String, required: true },
    openAt:   { type: Date },

    // ── Picking lifecycle (single current state) ──────────────────────────────
    // pending      — session exists, picking not yet confirmed by warehouse
    // confirmed    — warehouse pressed "Розпочати збирання"; tasks built (or empty)
    // in_progress  — at least one task of THIS session has been completed
    // completed    — every task of THIS session is done (всі товари зібрані)
    //
    // This replaces both DeliveryGroup.pickingConfirmedAt (group-level flag) and
    // the old `updatedAt >= sessionOpenAt` completed-count heuristic. Because the
    // session id already encapsulates the open date, the state cannot be captured
    // by a previous cycle when the admin changes the delivery day/hours.
    pickingStatus:      { type: String, enum: PICKING_STATUSES, default: 'pending' },
    pickingConfirmedAt: { type: Date, default: null },
    pickingStartedAt:   { type: Date, default: null },
    pickingCompletedAt: { type: Date, default: null },

    events: { type: [SessionEventSchema], default: [] },

    // Box numbers for packing. Each SHOP (by shopId) in this session gets one
    // stable sequential number so warehouse staff can label boxes with a digit
    // instead of a shop name. Numbered alphabetically by shop name and FROZEN
    // once at picking start (the set of shops is fixed by then — ordering window
    // ⊕ picking are mutually exclusive in time). Two sellers of the same shop
    // share one number. Scoped to this session only (restarts at 1 each session,
    // independent per group). See utils/shopNumbering.js. Empty until frozen.
    shopNumbers: {
      type: [new mongoose.Schema({
        shopId:   { type: String, required: true },
        shopName: { type: String, default: '' },
        number:   { type: Number, required: true },
      }, { _id: false })],
      default: undefined,
    },
  },
  { timestamps: true },
);

OrderingSessionSchema.index({ groupId: 1, openDate: 1 }, { unique: true });

module.exports = mongoose.model('OrderingSession', OrderingSessionSchema);

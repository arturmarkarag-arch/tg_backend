'use strict';

const mongoose = require('mongoose');
const CommerceInventoryItem = require('../../models/CommerceInventoryItem');
const CommerceInventoryMovement = require('../../models/CommerceInventoryMovement');
const CommerceStockReservation = require('../../models/CommerceStockReservation');
const { withLock } = require('../../utils/lock');

const MOVEMENT_TYPE = 'marketplace_order_consumption';
const MAX_PER_PASS = 500;

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function qty(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(0, Math.floor(n)) : 0;
}

function movementKeyForReservation(reservationKey) {
  return `consume:${text(reservationKey, 128)}`;
}

async function applyOneConsumedReservation(reservationId) {
  const session = await mongoose.connection.startSession();
  let outcome = { state: 'skipped' };
  try {
    await session.withTransaction(async () => {
      const reservation = await CommerceStockReservation.findOne({
        _id: reservationId,
        state: 'consumed',
        matchState: 'resolved',
        commerceProductId: { $ne: null },
      }).session(session);
      if (!reservation) {
        outcome = { state: 'skipped' };
        return;
      }

      const targetQuantity = qty(reservation.quantity);
      const movementKey = movementKeyForReservation(reservation.reservationKey);
      let movement = await CommerceInventoryMovement.findOne({ movementKey }).session(session);
      const alreadyApplied = qty(movement?.appliedQuantity);

      if (alreadyApplied === targetQuantity && movement?.state === 'applied') {
        if (reservation.countsAgainstStock !== false) {
          reservation.countsAgainstStock = false;
          reservation.issueCode = '';
          reservation.issueMessage = '';
          await reservation.save({ session });
        }
        outcome = { state: 'applied', quantity: targetQuantity, delta: 0 };
        return;
      }

      const inventory = await CommerceInventoryItem.findOne({ commerceProductId: reservation.commerceProductId }).session(session);
      if (!inventory) {
        await CommerceInventoryMovement.findOneAndUpdate(
          { movementKey },
          {
            $set: {
              commerceProductId: reservation.commerceProductId,
              commerceInventoryItemId: null,
              type: MOVEMENT_TYPE,
              sourceReservationKey: reservation.reservationKey,
              canonicalProvider: reservation.canonicalProvider || '',
              canonicalOrderId: reservation.canonicalOrderId || '',
              targetQuantity,
              appliedQuantity: alreadyApplied,
              state: 'blocked',
              issueCode: 'commerce_inventory_missing',
              issueMessage: 'Для CommerceProduct немає окремого CommerceInventoryItem; списання online-order не виконано.',
            },
          },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        );
        reservation.countsAgainstStock = true;
        reservation.issueCode = 'commerce_inventory_missing';
        reservation.issueMessage = 'Shipped order утримується fail-closed: online inventory item відсутній.';
        await reservation.save({ session });
        outcome = { state: 'blocked', issueCode: 'commerce_inventory_missing' };
        return;
      }

      const delta = targetQuantity - alreadyApplied;
      const before = Math.max(0, Math.floor(Number(inventory.onHand || 0)));
      if (delta < 0) {
        // Never auto-restock an already shipped order because an upstream line
        // later shrank. Returns/corrections need an explicit inbound movement.
        await CommerceInventoryMovement.findOneAndUpdate(
          { movementKey },
          { $set: {
            commerceProductId: reservation.commerceProductId,
            commerceInventoryItemId: inventory._id,
            type: MOVEMENT_TYPE,
            sourceReservationKey: reservation.reservationKey,
            canonicalProvider: reservation.canonicalProvider || '',
            canonicalOrderId: reservation.canonicalOrderId || '',
            targetQuantity,
            appliedQuantity: alreadyApplied,
            state: 'blocked',
            issueCode: 'commerce_inventory_consumption_quantity_regressed',
            issueMessage: `Shipped quantity зменшилась з ${alreadyApplied} до ${targetQuantity}. Автоматичне повернення stock заборонене; потрібен явний inbound adjustment.`,
            beforeOnHand: before,
            afterOnHand: before,
          } },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        );
        // The already-applied consumption remains the stock truth; do not double
        // hold the same units via reservation while the discrepancy is reviewed.
        reservation.countsAgainstStock = false;
        reservation.issueCode = 'commerce_inventory_consumption_quantity_regressed';
        reservation.issueMessage = 'Shipped quantity стала меншою після списання; stock автоматично не повертаємо.';
        await reservation.save({ session });
        outcome = { state: 'blocked', issueCode: 'commerce_inventory_consumption_quantity_regressed' };
        return;
      }
      if (delta > 0 && before < delta) {
        await CommerceInventoryMovement.findOneAndUpdate(
          { movementKey },
          {
            $set: {
              commerceProductId: reservation.commerceProductId,
              commerceInventoryItemId: inventory._id,
              type: MOVEMENT_TYPE,
              sourceReservationKey: reservation.reservationKey,
              canonicalProvider: reservation.canonicalProvider || '',
              canonicalOrderId: reservation.canonicalOrderId || '',
              targetQuantity,
              appliedQuantity: alreadyApplied,
              state: 'blocked',
              issueCode: 'commerce_inventory_insufficient_for_consumption',
              issueMessage: `Online inventory onHand=${before}, але для shipped order треба додатково списати ${delta}.`,
              beforeOnHand: before,
              afterOnHand: before,
            },
          },
          { upsert: true, new: true, session, setDefaultsOnInsert: true },
        );
        reservation.countsAgainstStock = true;
        reservation.issueCode = 'commerce_inventory_insufficient_for_consumption';
        reservation.issueMessage = 'Shipped order утримується fail-closed: online onHand недостатній для exactly-once списання.';
        await reservation.save({ session });
        outcome = { state: 'blocked', issueCode: 'commerce_inventory_insufficient_for_consumption', requiredDelta: delta, onHand: before };
        return;
      }

      const after = delta >= 0 ? before - delta : before + Math.abs(delta);
      if (delta !== 0) {
        inventory.onHand = after;
        await inventory.save({ session });
      }

      movement = await CommerceInventoryMovement.findOneAndUpdate(
        { movementKey },
        {
          $set: {
            commerceProductId: reservation.commerceProductId,
            commerceInventoryItemId: inventory._id,
            type: MOVEMENT_TYPE,
            sourceReservationKey: reservation.reservationKey,
            canonicalProvider: reservation.canonicalProvider || '',
            canonicalOrderId: reservation.canonicalOrderId || '',
            targetQuantity,
            appliedQuantity: targetQuantity,
            state: 'applied',
            issueCode: '',
            issueMessage: '',
            beforeOnHand: before,
            afterOnHand: after,
            appliedAt: new Date(),
          },
        },
        { upsert: true, new: true, session, setDefaultsOnInsert: true },
      );

      reservation.countsAgainstStock = false;
      reservation.issueCode = '';
      reservation.issueMessage = '';
      await reservation.save({ session });
      outcome = { state: 'applied', quantity: targetQuantity, delta, beforeOnHand: before, afterOnHand: after, movementId: String(movement._id) };
    });
    return outcome;
  } finally {
    await session.endSession();
  }
}

async function summarizeConsumptionMovements() {
  const [movementGroups, heldConsumed] = await Promise.all([
    CommerceInventoryMovement.aggregate([
      { $match: { type: MOVEMENT_TYPE } },
      { $group: { _id: '$state', rows: { $sum: 1 }, targetUnits: { $sum: '$targetQuantity' }, appliedUnits: { $sum: '$appliedQuantity' } } },
    ]),
    CommerceStockReservation.countDocuments({ state: 'consumed', countsAgainstStock: true }),
  ]);
  const summary = { appliedRows: 0, appliedUnits: 0, blockedRows: 0, heldConsumedRows: Number(heldConsumed || 0), ready: false };
  for (const row of movementGroups) {
    if (row._id === 'applied') {
      summary.appliedRows += Number(row.rows || 0);
      summary.appliedUnits += Number(row.appliedUnits || 0);
    }
    if (row._id === 'blocked') summary.blockedRows += Number(row.rows || 0);
  }
  summary.ready = summary.blockedRows === 0 && summary.heldConsumedRows === 0;
  return summary;
}

async function reconcileConsumedReservations() {
  return withLock('commerce:inventory:consumption', async () => {
    const rows = await CommerceStockReservation.find({
      state: 'consumed',
      matchState: 'resolved',
      commerceProductId: { $ne: null },
    }).select('_id').sort({ consumedAt: 1, _id: 1 }).limit(MAX_PER_PASS).lean();

    let applied = 0;
    let blocked = 0;
    for (const row of rows) {
      const result = await applyOneConsumedReservation(row._id);
      if (result.state === 'applied') applied += 1;
      if (result.state === 'blocked') blocked += 1;
    }
    const summary = await summarizeConsumptionMovements();
    return { ...summary, processed: rows.length, appliedThisPass: applied, blockedThisPass: blocked };
  }, { ttlMs: 60_000, waitMs: 10_000 });
}

module.exports = {
  MOVEMENT_TYPE,
  movementKeyForReservation,
  reconcileConsumedReservations,
  summarizeConsumptionMovements,
};

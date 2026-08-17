/**
 * scrubBlockProductIds
 *
 * Scans all blocks (or a specific set) and removes productIds that no longer
 * exist OR are archived. The actual Block.productIds write is owned by the
 * canonical transaction-aware membership primitive; this utility is only a
 * maintenance orchestrator.
 */

const Block = require('../models/Block');
const { pruneInvalidBlockProductIds } = require('../services/blockMembershipPrimitives');
const { refreshPickingTaskPositions } = require('../services/taskBuilder');

async function scrubBlockProductIds({ blockIdFilter = {} } = {}) {
  const blocks = await Block.find(
    { ...blockIdFilter, productIds: { $exists: true, $not: { $size: 0 } } },
    'blockId',
  ).lean();

  let scanned = 0;
  let fixed = 0;
  let removed = 0;

  for (const block of blocks) {
    scanned += 1;
    const result = await pruneInvalidBlockProductIds({
      blockId: block.blockId,
      removeArchived: true,
    });
    if (!result.changed) continue;
    fixed += 1;
    removed += result.removedCount;
  }

  // Maintenance can shift physical positions just like an explicit removal.
  // Keep PickingTask.positionIndex derived from the repaired Block truth.
  if (fixed > 0) {
    try { await refreshPickingTaskPositions(); } catch (_) { /* maintenance remains best-effort */ }
  }

  return { scanned, fixed, removed };
}

module.exports = { scrubBlockProductIds };

'use strict';

/**
 * RETIRED by V48.S2.
 *
 * Older MVP code briefly treated supplements as group-only and this script could
 * delete orderingSessionId from supplement data. V48.S2 restores exact delivery-
 * cycle ownership: SupplementWave.orderingSessionId is mandatory and new child
 * rows mirror it for compatibility/read efficiency.
 *
 * This filename is intentionally kept as a SAFE TOMBSTONE so an old runbook or
 * shell history cannot execute the former destructive migration after upgrade.
 */
console.error(
  'dropSupplementSessionField.js is retired by V48.S2: supplement session ownership is canonical. Nothing was changed.',
);
process.exitCode = 2;

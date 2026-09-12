'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const receipts = read('routes/receipts.js');
const sync = read('services/receiptSync.js');
const permissions = read('utils/receiptPermissions.js');

const deletePermissionStart = permissions.indexOf('function assertCanDeleteItem');
const deletePermissionEnd = permissions.indexOf('function assertCanConfirmItem');
const deletePermission = deletePermissionStart >= 0 && deletePermissionEnd > deletePermissionStart
  ? permissions.slice(deletePermissionStart, deletePermissionEnd)
  : '';

const checks = [
  ['admin + warehouse share delete permission', deletePermission.includes("if (!isReceiptStaff(user)) throw appError('forbidden')") && !deletePermission.includes('isOwnerOrAdmin') && !deletePermission.includes("item.status === 'confirmed'")],
  ['delete-specific lifecycle helper exists', sync.includes('async function describeItemDeleteUsage')],
  ['unrouted state is explicitly allowed', sync.includes("allowedState: usage.inUse ? null : 'unrouted'")],
  ['routed non-archived state is blocked', sync.includes("товар уже має маршрут і переданий у роботу")],
  ['archived state is explicitly allowed', sync.includes("allowedState: reasons.length ? null : 'archived'")],
  ['archived branch wins even if historical route is empty', sync.indexOf('if (archivedProduct)') < sync.indexOf('if (!hasRoute)')],
  ['archived delete checks block membership', sync.includes("Block.findOne({ productIds: productId }, 'blockId')")],
  ['archived delete checks active orders', sync.includes("status: { $in: ['new', 'in_progress'] }")],
  ['archived delete checks active picking', sync.includes("status: { $in: ['pending', 'locked'] }")],
  ['archived delete checks active supplement work', sync.includes('ACTIVE_ITEM_STATUSES') && sync.includes('REQUEST_STATUS.ACTIVE')],
  ['route uses delete-specific lifecycle', receipts.includes('describeItemDeleteUsage(item, receipt, { session })')],
  ['archived Product/history is preserved', receipts.includes('archivedProductPreserved: usage.productId') && receipts.includes('!usage.preserveArchivedProduct')],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}`);
  if (!ok) failed += 1;
}
if (failed) process.exit(1);
console.log(`Receipt delete lifecycle 2026-09-12: ${checks.length}/${checks.length} PASS`);

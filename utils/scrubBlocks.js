/**
 * scrubBlockProductIds
 *
 * Scans all blocks (or a specific set) and removes any productIds that no
 * longer exist in the Product collection OR have status 'archived'.
 *
 * When to call:
 *  - After any batch Product.deleteMany (test cleanup, etc.)
 *  - Once on server startup (catches leftovers from crashed/partial runs)
 *  - Explicitly from admin endpoints when needed
 *
 * Returns a summary: { scanned, fixed, removed }
 */

const Block = require('../models/Block');
const Product = require('../models/Product');

async function scrubBlockProductIds({ blockIdFilter = {} } = {}) {
  const blocks = await Block.find(
    { ...blockIdFilter, productIds: { $exists: true, $not: { $size: 0 } } },
    'blockId productIds version',
  ).lean();

  let scanned = 0;
  let fixed = 0;
  let removed = 0;

  for (const block of blocks) {
    scanned++;
    const rawIds = block.productIds || [];
    if (!rawIds.length) continue;

    const existingDocs = await Product.find(
      { _id: { $in: rawIds }, status: { $ne: 'archived' } },
      '_id',
    ).lean();
    const existingSet = new Set(existingDocs.map((p) => String(p._id)));

    const danglingIds = rawIds.filter((id) => !existingSet.has(String(id)));
    if (!danglingIds.length) continue;

    await Block.updateOne(
      { blockId: block.blockId },
      { $pull: { productIds: { $in: danglingIds } }, $inc: { version: 1 } },
    );

    fixed++;
    removed += danglingIds.length;
  }

  return { scanned, fixed, removed };
}

module.exports = { scrubBlockProductIds };

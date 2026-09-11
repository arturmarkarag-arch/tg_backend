'use strict';

// Targets, not guarantees: provider downtime/rate limits remain visible as lag.
const ORDER_RECHECK_MS = 60_000;
const ORDER_RECHECK_BATCH = 10;
const IMAGE_FRESH_MS = 6 * 60 * 60_000;
const IMAGE_MISSING_MS = 30 * 60_000;
const IMAGE_ERROR_MS = 60_000;
const IMAGE_BATCH = 12;

async function mapSettledLimit(values, limit, worker) {
  const items = Array.from(values);
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: 'fulfilled', value: await worker(items[i], i) }; }
      catch (reason) { results[i] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

module.exports = { ORDER_RECHECK_MS, ORDER_RECHECK_BATCH, IMAGE_FRESH_MS, IMAGE_MISSING_MS, IMAGE_ERROR_MS, IMAGE_BATCH, mapSettledLimit };

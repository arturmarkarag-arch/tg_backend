'use strict';

function syncErrorDetails(error) {
  const details = error?.args || {};
  return {
    code: error?.code || 'baselinker_sync_failed',
    upstreamMethod: details.upstreamMethod || null,
    upstreamCode: details.upstreamCode || null,
    upstreamMessage: details.upstreamMessage || error?.message || null,
    upstreamStatus: details.upstreamStatus || null,
    at: new Date().toISOString(),
  };
}

function retryDelayMs(error, failures = 1) {
  const details = error?.args || {};
  const deterministic = (details.upstreamCode && !['ERROR_REQUEST_LIMIT', 'ERROR_RATE_LIMIT', 'ERROR_INTERNAL'].includes(details.upstreamCode))
    || (details.upstreamStatus >= 400 && details.upstreamStatus < 500 && ![408, 429].includes(details.upstreamStatus))
    || ['baselinker_cursor_invalid', 'baselinker_order_cache_bootstrap_truncated'].includes(error?.code);
  return deterministic ? 15 * 60_000 : Math.min(15 * 60_000, 30_000 * (2 ** Math.min(5, Math.max(0, failures - 1))));
}

module.exports = { syncErrorDetails, retryDelayMs };

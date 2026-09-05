'use strict';

const NAVIGATION_USER_FIELDS = '_id role shopId miniAppState.updatedAt cartState.navigationSessionId cartState.lastViewedProductId cartState.currentIndex cartState.updatedAt';

// The database keeps only a stable product ID, an index fallback and its session
// fence. Page size is a view concern; quantities belong exclusively to Order.
function normalizeCartState(state) {
  return {
    navigationSessionId: String(state?.navigationSessionId || ''),
    lastViewedProductId: String(state?.lastViewedProductId || ''),
    currentIndex: Number.isInteger(state?.currentIndex) && state.currentIndex >= 0 ? state.currentIndex : 0,
    updatedAt: state?.updatedAt || null,
  };
}

function normalizeMiniAppState(state) {
  return { updatedAt: state?.updatedAt || null };
}

module.exports = { NAVIGATION_USER_FIELDS, normalizeCartState, normalizeMiniAppState };

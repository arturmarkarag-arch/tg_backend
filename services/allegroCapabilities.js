'use strict';

const ALLEGRO_SCOPE = Object.freeze({
  PROFILE_READ: 'allegro:api:profile:read',
  ORDERS_READ: 'allegro:api:orders:read',
  ORDERS_WRITE: 'allegro:api:orders:write',
  SHIPMENTS_READ: 'allegro:api:shipments:read',
  SHIPMENTS_WRITE: 'allegro:api:shipments:write',
});

const ORDER_INGEST_REQUIRED_SCOPES = Object.freeze([
  ALLEGRO_SCOPE.ORDERS_READ,
]);

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeScopes(scopes) {
  return [...new Set((Array.isArray(scopes) ? scopes : [])
    .map((value) => clean(value, 200))
    .filter(Boolean))];
}

function capabilityMatrix(scopes) {
  const normalized = normalizeScopes(scopes);
  const set = new Set(normalized);
  const scopesKnown = normalized.length > 0;
  const capabilities = {
    profileRead: set.has(ALLEGRO_SCOPE.PROFILE_READ),
    ordersRead: set.has(ALLEGRO_SCOPE.ORDERS_READ),
    ordersWrite: set.has(ALLEGRO_SCOPE.ORDERS_WRITE),
    shipmentsRead: set.has(ALLEGRO_SCOPE.SHIPMENTS_READ),
    shipmentsWrite: set.has(ALLEGRO_SCOPE.SHIPMENTS_WRITE),
  };
  const missingOrderIngestScopes = ORDER_INGEST_REQUIRED_SCOPES.filter((scope) => !set.has(scope));
  return {
    scopesKnown,
    scopeCount: normalized.length,
    capabilities,
    missingOrderIngestScopes,
    orderIngestReady: scopesKnown ? missingOrderIngestScopes.length === 0 : null,
  };
}

module.exports = {
  ALLEGRO_SCOPE,
  ORDER_INGEST_REQUIRED_SCOPES,
  normalizeScopes,
  capabilityMatrix,
};

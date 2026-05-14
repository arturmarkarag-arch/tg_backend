'use strict';

const store = new Map();

function get(key) {
  return store.get(key) ?? null;
}

function set(key, value) {
  store.set(key, value);
}

function invalidate(key) {
  store.delete(key);
}

function invalidateAll() {
  store.clear();
}

// Cache keys
const KEYS = {
  ORDERING_SCHEDULE: 'ordering_schedule',
  CITIES: 'cities',
  DELIVERY_GROUPS: 'delivery_groups',
};

module.exports = { get, set, invalidate, invalidateAll, KEYS };

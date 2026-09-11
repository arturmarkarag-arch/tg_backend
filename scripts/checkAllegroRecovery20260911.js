'use strict';

// Execute the real adapters with isolated dependencies: no DB or live API writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load(file, dependencies, extra = '') {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + extra, {
    module, exports: module.exports, Buffer, process, URL, AbortController, setTimeout, clearTimeout,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id === 'crypto') return require('node:crypto');
      throw new Error(`Unexpected dependency: ${id}`);
    },
  }, { filename: file });
  return module.exports;
}

async function main() {
  const binding = { commandId: 'existing-command', status: 'pending', save: async () => {} };
  const calls = [];
  const picking = { ownerTelegramId: '123', status: 'ready' };
  let commandStatus = 'IN_PROGRESS';
  const shipments = load('services/allegroShipments.js', {
    '../models/AllegroShipmentBinding': { findOne: async () => binding },
    '../models/AllegroPickingOrder': { findOne: async () => picking },
    './allegroAccounts': { getAllegroAccount: async () => ({}) },
    './allegroCapabilities': { capabilityMatrix: () => ({ scopesKnown: false }) },
    './allegroHttpClient': { allegroRequest: async (_id, options) => {
      calls.push(options);
      if (options.stage === 'shipment_order_revalidate') return { payload: { id: 'order', lineItems: [{ id: 'changed-line', quantity: 2 }] } };
      if (options.stage === 'shipment_create_status') return { payload: { status: commandStatus, errors: [{ message: 'Invalid package' }] } };
      throw new Error(`Unexpected upstream call: ${options.stage}`);
    } },
    '../utils/errors': { appError: (code) => new Error(code) },
    '../utils/lock': { withLock: async (_key, fn) => fn() },
    '../domain/warehousePickingState': { ORDER_STATUS: { READY: 'ready', READY_WITH_ISSUE: 'ready_with_issue' } },
    './allegroPicking': { classifyUpstream: () => 'active', reconcileAllegroPickingFromUpstream: async () => { picking.upstreamReviewRequired = true; } },
  });
  for (let i = 0; i < 2; i += 1) {
    const result = await shipments.prepareShipment('account', 'order', { user: { telegramId: '123' } });
    assert.equal(result.pending, true);
    assert.equal(result.ready, false);
    assert.equal(result.binding.commandId, 'existing-command');
  }
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(calls.filter((call) => call.stage === 'shipment_create_status').length, 1, 'second request must respect the persisted retry deadline');
  commandStatus = 'ERROR';
  binding.nextCommandCheckAt = null;
  await assert.rejects(shipments.prepareShipment('account', 'order', { user: { telegramId: '123' } }), /allegro_shipment_create_failed/);
  console.log('PASS repeated pending shipment checks never submit another creation command; terminal failure is surfaced');
  binding.commandId = ''; binding.status = 'idle';
  await assert.rejects(shipments.prepareShipment('account', 'order', { user: { telegramId: '123' } }), /allegro_upstream_review_required/);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0);
  console.log('PASS fresh upstream item changes block creating a shipment from stale picking readiness');

  const http = load('services/allegroHttpClient.js', {
    './allegroRuntimePolicy': {}, '../models/AllegroAccount': {}, '../models/AllegroApiErrorLog': {},
    '../utils/errors': {}, '../utils/redis': {}, './allegroOAuth': {},
  }, '\nmodule.exports.readPayload = readPayload;');
  const failure = new Error('body stream interrupted');
  await assert.rejects(http.readPayload({ status: 200, text: async () => { throw failure; } }), (error) => error === failure);
  assert.equal(await http.readPayload({ status: 204 }), null);
  assert.equal((await http.readPayload({ status: 200, text: async () => '{"id":"order"}' })).id, 'order');
  console.log('PASS interrupted response body propagates as failure; valid JSON and 204 still work');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

const fs = require('fs');
const path = require('path');
const {
  buildSourceItems,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
  baseLinkerFulfilmentGroupKey,
  mergeOrderGroup,
} = require('../services/baseLinkerPicking');
const { t } = require('../utils/errors');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('BaseLinker local picking workflow', () => {
  it('builds stable line keys and preserves duplicate lines deterministically', () => {
    const items = buildSourceItems({
      products: [
        { order_product_id: 10, product_id: 1, quantity: 2, name: 'A' },
        { order_product_id: 10, product_id: 1, quantity: 2, name: 'A' },
        { product_id: 7, variant_id: 3, sku: 'SKU', quantity: 1, name: 'B' },
      ],
    });
    expect(items.map((item) => item.lineKey)).toEqual([
      'op:10',
      'op:10#2',
      'src:7:3:SKU:::B',
    ]);
    expect(items[0].requestedQty).toBe(2);
  });

  it('keeps all upstream BaseLinker methods read-only while local Mongo workflow may mutate', () => {
    const picking = read('services/baseLinkerPicking.js');
    const router = read('routes/baseLinker.js');
    expect(picking).toContain('fetchBaseLinkerOrders');
    expect(`${picking}\n${router}`).not.toMatch(/callBaseLinker\(['\"](?:create|set|delete|add|remove)/i);
    expect(router).toContain('mutate ONLY our MongoDB picking state');
  });

  it('requires a revision for item/release/pack/sent corrections and keeps admin-only reopen', () => {
    const router = read('routes/baseLinker.js');
    expect(router).toContain('expectedRevision');
    expect(router).toContain("router.post('/picking/orders/:orderId/reopen', requireTelegramRole('admin')");
  });

  it('authorizes only admins or the dedicated baselinker role server-side', () => {
    const access = read('utils/baseLinkerAccess.js');
    expect(access).toContain("user.role === 'admin'");
    expect(access).toContain("user.role === 'baselinker'");
    expect(access).not.toContain('permissions?.baseLinkerPicking');
  });

  it('persists BaseLinker socket capability during auth instead of leaking dbUser outside its scope', () => {
    const socket = read('socket.js');
    expect(socket).toContain('socket.baseLinkerPickingAccess = hasBaseLinkerPickingAccess(dbUser)');
    const connectionHandler = socket.split("io.on('connection', (socket) => {")[1] || '';
    expect(connectionHandler).not.toContain('hasBaseLinkerPickingAccess(dbUser)');
    expect(connectionHandler).toContain('socket.baseLinkerPickingAccess');
  });

  it('does not hide work behind a second BaseLinker eligible-status configuration', () => {
    const router = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(`${router}\n${picking}`).not.toContain('assertOrderEligibleForPicking');
    expect(router).not.toContain('/picking/settings');
    expect(picking).not.toContain('eligibleStatusIds');
  });

  it('treats a shortage as handled work and becomes ready for explicit partial packing only after every line is handled', () => {
    const items = [
      { state: 'picked', requestedQty: 2, pickedQty: 2 },
      { state: 'shortage', requestedQty: 3, pickedQty: 1 },
    ];
    expect(progressFor(items)).toEqual({
      totalLines: 2,
      handledLines: 2,
      pickedLines: 1,
      problemLines: 1,
      totalQty: 5,
      pickedQty: 3,
      missingQty: 2,
    });
    expect(packingReadiness(items)).toMatchObject({
      allHandled: true,
      allPicked: false,
      hasIssues: true,
      pendingLines: 0,
      missingQty: 2,
    });
    expect(deriveWorkingStatus(items, true)).toBe('ready_to_pack_with_issue');
  });

  it('keeps a problem in progress while another line is still pending', () => {
    const items = [
      { state: 'shortage', requestedQty: 3, pickedQty: 1 },
      { state: 'pending', requestedQty: 2, pickedQty: 0 },
    ];
    expect(packingReadiness(items).pendingLines).toBe(1);
    expect(deriveWorkingStatus(items, true)).toBe('problem');
  });

  it('requires an explicit allowIssues acknowledgement to pack a handled problem order', () => {
    const router = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(router).toContain('allowIssues: req.body?.allowIssues === true');
    expect(picking).toContain("appError('baselinker_picking_issue_confirmation_required'");
    expect(picking).toContain("appError('baselinker_picking_items_unhandled'");
    expect(picking).toContain("'order_packed_with_issues'");
    expect(picking).toContain('packedSummary');
  });

  it('exact claim/pack re-reads include unconfirmed orders instead of producing a fake not-found', () => {
    const picking = read('services/baseLinkerPicking.js');
    expect(picking).toMatch(/orderId:\s*id,[\s\S]{0,200}includeUnconfirmed:\s*true,[\s\S]{0,100}maxPages:\s*1/);
    expect(picking).toContain("appError('baselinker_order_not_returned'");
  });

  it('keeps BaseLinker upstream method/code/message in operator-facing errors', () => {
    const client = read('services/baseLinkerClient.js');
    expect(client).toContain("appError('baselinker_network_error'");
    expect(client).toContain("appError('baselinker_http_error'");
    expect(client).toContain("appError('baselinker_invalid_response'");
    expect(client).toContain("appError('baselinker_api_error'");
    expect(client).toContain('upstreamCode');
    expect(client).toContain('upstreamMessage');
    expect(t('baselinker_api_error', {
      upstreamMethod: 'getOrders',
      upstreamCode: 'ERROR_TEST',
      upstreamMessage: 'Test message',
    })).toContain('ERROR_TEST');
    expect(t('baselinker_api_error', {
      upstreamMethod: 'getOrders',
      upstreamCode: 'ERROR_TEST',
      upstreamMessage: 'Test message',
    })).toContain('Test message');
  });
  it('groups split BaseLinker records only when source + external order identity match', () => {
    const a = { order_id: 101, order_source: 'shop', order_source_id: 5, external_order_id: 'ABC', products: [{ order_product_id: 1, quantity: 1 }] };
    const b = { order_id: 102, order_source: 'shop', order_source_id: 5, external_order_id: 'ABC', products: [{ order_product_id: 2, quantity: 2 }] };
    const c = { order_id: 103, order_source: 'shop', order_source_id: 6, external_order_id: 'ABC', products: [{ order_product_id: 3, quantity: 1 }] };
    expect(baseLinkerFulfilmentGroupKey(a)).toBe(baseLinkerFulfilmentGroupKey(b));
    expect(baseLinkerFulfilmentGroupKey(a)).not.toBe(baseLinkerFulfilmentGroupKey(c));

    const merged = mergeOrderGroup([a, b], 101);
    expect(merged._member_order_ids).toEqual(['101', '102']);
    expect(merged.products).toHaveLength(2);
    expect(merged.products[1]._source_order_id).toBe('102');
    expect(buildSourceItems(merged).map((item) => item.lineKey)).toEqual(['op:1', 'bl:102:op:2']);
  });

  it('claim route sends all BaseLinker member order ids to the server-side group validator', () => {
    const router = read('routes/baseLinker.js');
    expect(router).toContain('memberOrderIds: Array.isArray(req.body?.memberOrderIds)');
    expect(read('models/BaseLinkerPickingOrder.js')).toContain('memberOrderIds');
    expect(read('services/baseLinkerPicking.js')).toContain('fetchExactOrderGroup');
    expect(read('services/baseLinkerPicking.js')).toContain('baselinker_picking_group_mismatch');
  });


  it('centralizes picking statuses and preserves completion when ownership is released', () => {
    const domain = read('domain/baseLinkerPickingState.js');
    const model = read('models/BaseLinkerPickingOrder.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(domain).toContain('function deriveWorkingStatus');
    expect(domain).toContain("if (allPicked(items)) return ORDER_STATUS.READY");
    expect(domain).toContain("return ORDER_STATUS.READY_WITH_ISSUE");
    expect(model).toContain('PERSISTED_ORDER_STATUSES');
    expect(model).toContain('PERSISTED_ITEM_STATES');
    expect(picking).toContain("require('../domain/baseLinkerPickingState')");
  });

  it('does not allow removed damaged/other reasons to be written by current clients', () => {
    const domain = read('domain/baseLinkerPickingState.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(domain).toContain("const CURRENT_ISSUE_STATES = Object.freeze(['shortage', 'not_found'])");
    expect(domain).toContain("const LEGACY_ISSUE_STATES = Object.freeze(['damaged', 'other'])");
    expect(picking).toContain('WRITABLE_ITEM_STATES.has(nextState)');
  });

});

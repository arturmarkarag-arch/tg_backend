const fs = require('fs');
const path = require('path');
const {
  buildSourceItems,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
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

  it('allows exactly one BaseLinker write path: exact order_id status transition to Sent', () => {
    const picking = read('services/baseLinkerPicking.js');
    const commands = read('services/baseLinkerOrderCommands.js');
    const router = read('routes/baseLinker.js');
    expect(picking).toContain('setBaseLinkerOrderStatus');
    expect(commands).toContain("callBaseLinker('setOrderStatus'");
    expect(commands).toContain('order_id: id');
    expect(commands).toContain('status_id: status');
    expect(router).toContain('sole upstream mutation is "Sent"');
    expect(`${picking}
${commands}
${router}`).not.toMatch(/callBaseLinker\(['"](?:addOrder|deleteOrder|setOrderFields|setOrderPayment)/i);
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

  it('never allows packing while any problem remains unresolved', () => {
    const router = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(router).not.toContain('allowIssues');
    expect(picking).not.toContain('allowIssues');
    expect(picking).toContain("appError('baselinker_picking_items_unhandled'");
    expect(picking).toContain("appError('baselinker_picking_has_unresolved_issues'");
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
  it('keeps each exact BaseLinker order_id as the only fulfilment boundary', () => {
    const source = read('services/baseLinkerPicking.js');
    const model = read('models/BaseLinkerPickingOrder.js');
    const router = read('routes/baseLinker.js');

    const first = buildSourceItems({
      order_id: 101,
      products: [{ order_product_id: 1, product_id: 10, name: 'A', quantity: 3 }],
    });
    const second = buildSourceItems({
      order_id: 102,
      products: [{ order_product_id: 2, product_id: 10, name: 'A', quantity: 4 }],
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].sourceOrderId).toBe('101');
    expect(second[0].sourceOrderId).toBe('102');
    expect(first[0].requestedQty).toBe(3);
    expect(second[0].requestedQty).toBe(4);

    expect(model).toContain("BaseLinkerPickingOrderSchema.index({ accountScope: 1, orderId: 1 }, { unique: true })");
    expect(model).not.toContain('memberOrderIds');
    expect(model).not.toContain('groupKey');
    expect(source).not.toContain('mergeOrderGroup');
    expect(source).not.toContain('fetchExactOrderGroup');
    expect(source).not.toContain('claimKeyForGroup');
    expect(router).not.toContain('memberOrderIds');
  });

  it('claim route accepts only the exact BaseLinker order id from the URL', () => {
    const router = read('routes/baseLinker.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(router).toContain('orderId: req.params.orderId');
    expect(router).not.toContain('memberOrderIds');
    expect(picking).toContain('async function fetchExactOrder(orderId)');
    expect(picking).toContain('const order = await fetchExactOrder(requestedId)');
    expect(picking).toContain('withLock(scopedLockKey(`baselinker-order:${requestedId}`');
    expect(picking).not.toContain('baselinker_picking_group_mismatch');
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

  it('separates operational shelf from ownership so claiming Deferred cannot make the card disappear', () => {
    const domain = read('domain/baseLinkerPickingState.js');
    const model = read('models/BaseLinkerPickingOrder.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(domain).toContain('WORKFLOW_STAGE');
    expect(domain).toContain('function workflowStageFor');
    expect(model).toContain('workflowStage');
    expect(picking).toContain('const preservedWorkflowStage = workflowStageFor(doc)');
    expect(picking).toContain('draft.workflowStage = preservedWorkflowStage');
    expect(picking).toContain('doc.workflowStage = WORKFLOW_STAGE.DEFERRED');
    expect(picking).toContain('doc.workflowStage = WORKFLOW_STAGE.PACKED');
    expect(picking).toContain('workflowStage: workflowStageFor(plain)');
  });

  it('does not allow removed damaged/other reasons to be written by current clients', () => {
    const domain = read('domain/baseLinkerPickingState.js');
    const picking = read('services/baseLinkerPicking.js');
    expect(domain).toContain("const CURRENT_ISSUE_STATES = Object.freeze(['shortage', 'not_found'])");
    expect(domain).toContain("const LEGACY_ISSUE_STATES = Object.freeze(['damaged', 'other'])");
    expect(picking).toContain('WRITABLE_ITEM_STATES.has(nextState)');
  });

});

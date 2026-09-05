const ORDER_STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  PROBLEM: 'problem',
  READY: 'ready_to_pack',
  READY_WITH_ISSUE: 'ready_to_pack_with_issue',
  PACKED: 'packed',
  SENT: 'sent',
});

const WORKFLOW_STAGE = Object.freeze({
  PROCESSING: 'processing',
  DEFERRED: 'deferred',
  PACKED: 'packed',
  SENT: 'sent',
});

const PERSISTED_WORKFLOW_STAGES = Object.freeze(Object.values(WORKFLOW_STAGE));

const PERSISTED_ORDER_STATUSES = Object.freeze(Object.values(ORDER_STATUS));
const WORKING_STATUSES = Object.freeze([
  ORDER_STATUS.IN_PROGRESS,
  ORDER_STATUS.PROBLEM,
  ORDER_STATUS.READY,
  ORDER_STATUS.READY_WITH_ISSUE,
]);
const TERMINAL_STATUSES = Object.freeze([ORDER_STATUS.PACKED, ORDER_STATUS.SENT]);

const CURRENT_ISSUE_STATES = Object.freeze(['shortage', 'not_found']);
const LEGACY_ISSUE_STATES = Object.freeze(['damaged', 'other']);
const ISSUE_STATES = new Set([...CURRENT_ISSUE_STATES, ...LEGACY_ISSUE_STATES]);
const WRITABLE_ITEM_STATES = new Set(['pending', 'picked', ...CURRENT_ISSUE_STATES]);
const PERSISTED_ITEM_STATES = Object.freeze(['pending', 'picked', ...CURRENT_ISSUE_STATES, ...LEGACY_ISSUE_STATES]);

function hasIssues(items = []) {
  return items.some((item) => ISSUE_STATES.has(String(item?.state || '')));
}

function allPicked(items = []) {
  return items.length > 0 && items.every((item) => (
    item?.state === 'picked' && Number(item?.pickedQty || 0) >= Number(item?.requestedQty || 0)
  ));
}

function allHandled(items = []) {
  return items.length > 0 && items.every((item) => String(item?.state || 'pending') !== 'pending');
}

function progressFor(items = []) {
  const totalLines = items.length;
  const pickedLines = items.filter((item) => item?.state === 'picked').length;
  const handledLines = items.filter((item) => String(item?.state || 'pending') !== 'pending').length;
  const problemLines = items.filter((item) => ISSUE_STATES.has(String(item?.state || ''))).length;
  const totalQty = items.reduce((sum, item) => sum + Number(item?.requestedQty || 0), 0);
  const pickedQty = items.reduce((sum, item) => sum + Math.min(Number(item?.requestedQty || 0), Number(item?.pickedQty || 0)), 0);
  const missingQty = Math.max(0, totalQty - pickedQty);
  return { totalLines, handledLines, pickedLines, problemLines, totalQty, pickedQty, missingQty };
}

function packingReadiness(items = []) {
  const progress = progressFor(items);
  return {
    ...progress,
    allHandled: allHandled(items),
    allPicked: allPicked(items),
    hasIssues: hasIssues(items),
    pendingLines: Math.max(0, progress.totalLines - progress.handledLines),
  };
}

function deriveWorkingStatus(items = [], hasOwner = false) {
  // Completion is a business state, ownership is not. Releasing a fully handled
  // order must never throw it back into "paused"/"problem" and make it look unfinished.
  if (allPicked(items)) return ORDER_STATUS.READY;
  if (hasIssues(items) && allHandled(items)) return ORDER_STATUS.READY_WITH_ISSUE;
  if (hasIssues(items)) return ORDER_STATUS.PROBLEM;
  return hasOwner ? ORDER_STATUS.IN_PROGRESS : ORDER_STATUS.PAUSED;
}

function legacyWorkflowStageForStatus(status) {
  const value = String(status || '');
  if (value === ORDER_STATUS.SENT) return WORKFLOW_STAGE.SENT;
  if (value === ORDER_STATUS.PACKED) return WORKFLOW_STAGE.PACKED;
  if ([ORDER_STATUS.PAUSED, ORDER_STATUS.PROBLEM, ORDER_STATUS.READY_WITH_ISSUE].includes(value)) {
    return WORKFLOW_STAGE.DEFERRED;
  }
  return WORKFLOW_STAGE.PROCESSING;
}

function workflowStageFor(state = {}) {
  const explicit = String(state?.workflowStage || '');
  if (PERSISTED_WORKFLOW_STAGES.includes(explicit)) return explicit;
  return legacyWorkflowStageForStatus(state?.status);
}

function workflowStageAfterWorkingStatus(previousStage, status) {
  const current = PERSISTED_WORKFLOW_STAGES.includes(String(previousStage || ''))
    ? String(previousStage)
    : legacyWorkflowStageForStatus(status);
  if ([ORDER_STATUS.PROBLEM, ORDER_STATUS.READY_WITH_ISSUE].includes(String(status || ''))) {
    return WORKFLOW_STAGE.DEFERRED;
  }
  if (current === WORKFLOW_STAGE.DEFERRED) return WORKFLOW_STAGE.DEFERRED;
  return WORKFLOW_STAGE.PROCESSING;
}

module.exports = {
  ORDER_STATUS,
  WORKFLOW_STAGE,
  PERSISTED_ORDER_STATUSES,
  PERSISTED_WORKFLOW_STAGES,
  WORKING_STATUSES,
  TERMINAL_STATUSES,
  CURRENT_ISSUE_STATES,
  LEGACY_ISSUE_STATES,
  ISSUE_STATES,
  WRITABLE_ITEM_STATES,
  PERSISTED_ITEM_STATES,
  hasIssues,
  allPicked,
  allHandled,
  progressFor,
  packingReadiness,
  deriveWorkingStatus,
  legacyWorkflowStageForStatus,
  workflowStageFor,
  workflowStageAfterWorkingStatus,
};

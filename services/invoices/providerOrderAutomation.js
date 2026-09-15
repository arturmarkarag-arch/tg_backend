'use strict';

const InvoiceSourceAutomationState = require('../../models/InvoiceSourceAutomationState');
const { getProviderAdapter, providerSupports } = require('../commerce/providers/registry');
const { CAPABILITIES } = require('../commerce/providers/contract');
const { createInvoiceFromSource } = require('./invoiceCreationService');
const { refreshInvoiceDraftFromSource } = require('./invoiceService');
const { resolveProviderAccountLegalEntity } = require('./providerAccountBinding');
const { areInvoiceKsefWritesBlocked } = require('./invoiceKsefWriteState');
const { formatWarsawDateKey } = require('../../utils/warsawDateTime');

const SYSTEM_ACTOR = Object.freeze({ id: 'system:invoice-source', name: 'Invoice source automation', role: 'system' });
const BLOCKED_RETRY_MS = Math.max(60_000, Number(process.env.INVOICE_SOURCE_BLOCKED_RETRY_MS) || 15 * 60_000);
const ERROR_RETRY_MS = Math.max(60_000, Number(process.env.INVOICE_SOURCE_ERROR_RETRY_MS) || 5 * 60_000);

function text(value, max = 180) { return String(value ?? '').trim().slice(0, max); }
function blockerList(error) {
  return [...new Set((Array.isArray(error?.args?.blockers) ? error.args.blockers : []).map((value) => text(value, 160)).filter(Boolean))];
}

async function saveState(identity, patch) {
  try {
    return await InvoiceSourceAutomationState.findOneAndUpdate(
      identity,
      { $set: { ...patch, attemptedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return InvoiceSourceAutomationState.findOneAndUpdate(
      identity,
      { $set: { ...patch, attemptedAt: new Date() } },
      { new: true },
    ).lean();
  }
}

async function runProviderOrderInvoiceAutomation(providerId, { accountId = '', orders = [] } = {}) {
  if (areInvoiceKsefWritesBlocked()) return { skipped: true, reason: 'invoice_ksef_read_only', observed: 0, created: 0, blocked: 0 };
  const provider = getProviderAdapter(providerId, { requireLive: true });
  if (!providerSupports(provider, CAPABILITIES.INVOICE_SOURCE) || !provider.invoiceSource) {
    return { skipped: true, reason: 'invoice_source_unsupported', observed: 0, created: 0, blocked: 0 };
  }

  const normalizedAccountId = text(accountId, 120);
  const observed = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const source = provider.invoiceSource.fromOrder({ accountId: normalizedAccountId, order }) || {};
    if (source.requested !== true) continue;
    const orderId = text(source.sourceRef?.orderId || source.sourceRef?.entityId || source.sourceRef?.id, 180);
    if (!normalizedAccountId || !orderId) continue;
    observed.push({
      orderId,
      revision: text(source.revision, 128),
      sourceRef: source.sourceRef || { accountId: normalizedAccountId, orderId },
      context: source.context || {},
    });
  }
  if (!observed.length) return { skipped: false, observed: 0, created: 0, blocked: 0, unchanged: 0, errors: 0 };

  const existing = await InvoiceSourceAutomationState.find({
    provider: provider.id,
    accountId: normalizedAccountId,
    orderId: { $in: observed.map((row) => row.orderId) },
  }).lean();
  const byOrder = new Map(existing.map((row) => [String(row.orderId), row]));
  const nowMs = Date.now();
  const pending = observed.filter((row) => {
    const state = byOrder.get(row.orderId);
    if (!state) return true;
    if (state.status === 'finalized_source_changed') return false;
    if (state.status === 'draft_created' && state.revision === row.revision) return false;
    const retryAt = state.nextRetryAt ? new Date(state.nextRetryAt).getTime() : 0;
    if (state.revision === row.revision && retryAt > nowMs) return false;
    return true;
  });
  if (!pending.length) return { skipped: false, observed: observed.length, created: 0, blocked: 0, unchanged: observed.length, errors: 0 };

  const binding = await resolveProviderAccountLegalEntity({ provider: provider.id, accountId: normalizedAccountId });
  if (!binding.entity) {
    await Promise.all(pending.map((row) => saveState(
      { provider: provider.id, accountId: normalizedAccountId, orderId: row.orderId },
      {
        sourceAdapterId: provider.invoiceSource.adapterId,
        revision: row.revision,
        status: 'unbound',
        legalEntityId: null,
        invoiceId: null,
        blockers: [binding.reason || 'legal_entity_binding_required'],
        lastErrorCode: '',
        observedAt: new Date(),
        nextRetryAt: new Date(Date.now() + BLOCKED_RETRY_MS),
      },
    )));
    return { skipped: false, observed: observed.length, created: 0, blocked: pending.length, unchanged: observed.length - pending.length, errors: 0 };
  }

  let created = 0;
  let blocked = 0;
  let errors = 0;
  for (const row of pending) {
    const identity = { provider: provider.id, accountId: normalizedAccountId, orderId: row.orderId };
    try {
      const previous = byOrder.get(row.orderId) || null;
      let result;
      if (previous?.invoiceId) {
        const invoice = await refreshInvoiceDraftFromSource(String(previous.invoiceId), SYSTEM_ACTOR, row.context);
        result = { invoice, blockers: [] };
      } else {
        result = await createInvoiceFromSource({
          sourceAdapter: provider.invoiceSource.adapterId,
          sourceRef: row.sourceRef,
          input: { issueDate: formatWarsawDateKey(new Date()), requireInvoiceRequested: true },
          legalEntityId: String(binding.entity._id),
          context: row.context,
        }, SYSTEM_ACTOR);
      }
      await saveState(identity, {
        sourceAdapterId: provider.invoiceSource.adapterId,
        revision: row.revision,
        status: 'draft_created',
        legalEntityId: binding.entity._id,
        invoiceId: result.invoice?._id || previous?.invoiceId || null,
        blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 50) : [],
        lastErrorCode: '',
        observedAt: new Date(),
        nextRetryAt: null,
      });
      created += previous?.invoiceId ? 0 : 1;
    } catch (error) {
      const previous = byOrder.get(row.orderId) || null;
      if (error?.code === 'invoice_finalized_immutable' && previous?.invoiceId) {
        await saveState(identity, {
          sourceAdapterId: provider.invoiceSource.adapterId,
          revision: row.revision,
          status: 'finalized_source_changed',
          legalEntityId: binding.entity._id,
          invoiceId: previous.invoiceId,
          blockers: ['invoice_finalized_source_changed'],
          lastErrorCode: 'invoice_finalized_immutable',
          observedAt: new Date(),
          nextRetryAt: null,
        });
        blocked += 1;
        continue;
      }
      const sourceBlockers = blockerList(error);
      if (error?.code === 'invoice_source_contract_invalid' || sourceBlockers.length) {
        await saveState(identity, {
          sourceAdapterId: provider.invoiceSource.adapterId,
          revision: row.revision,
          status: 'blocked',
          legalEntityId: binding.entity._id,
          invoiceId: null,
          blockers: sourceBlockers.length ? sourceBlockers : [text(error?.code || 'invoice_source_contract_invalid', 160)],
          lastErrorCode: text(error?.code, 160),
          observedAt: new Date(),
          nextRetryAt: new Date(Date.now() + BLOCKED_RETRY_MS),
        });
        blocked += 1;
      } else {
        await saveState(identity, {
          sourceAdapterId: provider.invoiceSource.adapterId,
          revision: row.revision,
          status: 'error',
          legalEntityId: binding.entity._id,
          invoiceId: null,
          blockers: [],
          lastErrorCode: text(error?.code || error?.message || 'invoice_source_automation_failed', 160),
          observedAt: new Date(),
          nextRetryAt: new Date(Date.now() + ERROR_RETRY_MS),
        });
        errors += 1;
        console.error('[invoice-source-automation]', provider.id, normalizedAccountId, row.orderId, error?.stack || error);
      }
    }
  }
  return { skipped: false, observed: observed.length, created, blocked, unchanged: observed.length - pending.length, errors };
}

module.exports = { runProviderOrderInvoiceAutomation };

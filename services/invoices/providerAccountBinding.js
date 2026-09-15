'use strict';

const LegalEntity = require('../../models/LegalEntity');
const CommerceProviderAccountBinding = require('../../models/CommerceProviderAccountBinding');

function text(value, max = 160) { return String(value ?? '').trim().slice(0, max); }

async function resolveProviderAccountLegalEntity({ provider = '', accountId = '' } = {}) {
  const normalizedProvider = text(provider, 60).toLowerCase();
  const normalizedAccountId = text(accountId, 120);
  if (!normalizedProvider || !normalizedAccountId) return { entity: null, binding: null, reason: 'provider_account_identity_missing' };

  const existing = await CommerceProviderAccountBinding.findOne({ provider: normalizedProvider, accountId: normalizedAccountId }).lean();
  if (existing) {
    const entity = await LegalEntity.findOne({ _id: existing.legalEntityId, isActive: true }).lean();
    return entity
      ? { entity, binding: existing, reason: '' }
      : { entity: null, binding: existing, reason: 'legal_entity_binding_invalid' };
  }

  const active = await LegalEntity.find({ isActive: true }).sort({ isDefault: -1, _id: 1 }).limit(2).lean();
  if (active.length !== 1) {
    return { entity: null, binding: null, reason: active.length ? 'legal_entity_binding_required' : 'legal_entity_required' };
  }

  const entity = active[0];
  let binding;
  try {
    binding = await CommerceProviderAccountBinding.findOneAndUpdate(
      { provider: normalizedProvider, accountId: normalizedAccountId },
      { $setOnInsert: { legalEntityId: entity._id, source: 'auto_single_entity' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    binding = await CommerceProviderAccountBinding.findOne({ provider: normalizedProvider, accountId: normalizedAccountId }).lean();
  }
  const boundEntity = binding && String(binding.legalEntityId) !== String(entity._id)
    ? await LegalEntity.findOne({ _id: binding.legalEntityId, isActive: true }).lean()
    : entity;
  return boundEntity
    ? { entity: boundEntity, binding, reason: '' }
    : { entity: null, binding, reason: 'legal_entity_binding_invalid' };
}

module.exports = { resolveProviderAccountLegalEntity };

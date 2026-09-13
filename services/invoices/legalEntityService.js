'use strict';

const mongoose = require('mongoose');
const LegalEntity = require('../../models/LegalEntity');
const { appError } = require('../../utils/errors');
const { withLock } = require('../../utils/lock');
const { isValidPolishNip, normalizeTaxId } = require('./taxId');

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeBankAccount(value) {
  return text(value, 80).replace(/\s+/g, '');
}

function normalizeLegalEntityInput(raw = {}, { partial = false } = {}) {
  const out = {};
  const set = (key, value) => { if (!partial || Object.prototype.hasOwnProperty.call(raw, key)) out[key] = value; };

  set('name', text(raw.name, 300));
  set('shortName', text(raw.shortName, 160));
  set('countryCode', text(raw.countryCode || (partial ? '' : 'PL'), 2).toUpperCase());
  set('taxIdType', text(raw.taxIdType || (partial ? '' : 'nip'), 40).toLowerCase());

  const countryCode = out.countryCode || text(raw.countryCode, 2).toUpperCase();
  const taxIdType = out.taxIdType || text(raw.taxIdType, 40).toLowerCase();
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'taxId')) {
    out.taxId = normalizeTaxId(raw.taxId, { countryCode: countryCode || 'PL', taxIdType: taxIdType || 'nip' });
  }

  set('regon', text(raw.regon, 40));
  set('krs', text(raw.krs, 40));
  set('email', text(raw.email, 320).toLowerCase());
  set('phone', text(raw.phone, 80));
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'address')) {
    out.address = {
      street: text(raw.address?.street, 250),
      postalCode: text(raw.address?.postalCode, 30),
      city: text(raw.address?.city, 120),
      countryCode: text(raw.address?.countryCode || countryCode || 'PL', 2).toUpperCase(),
    };
  }
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'bankAccounts')) {
    out.bankAccounts = (Array.isArray(raw.bankAccounts) ? raw.bankAccounts : []).map((entry) => ({
      label: text(entry?.label, 120),
      account: normalizeBankAccount(entry?.account),
      bankName: text(entry?.bankName, 160),
      swift: text(entry?.swift, 32).toUpperCase(),
      isDefault: entry?.isDefault === true,
    })).filter((entry) => entry.account);
  }
  set('defaultCurrency', text(raw.defaultCurrency || (partial ? '' : 'PLN'), 3).toUpperCase());
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'paymentDefaults')) {
    out.paymentDefaults = {
      method: text(raw.paymentDefaults?.method, 80).toLowerCase(),
      dueDays: Math.max(0, Math.min(3650, Number(raw.paymentDefaults?.dueDays || 0) || 0)),
      bankAccount: normalizeBankAccount(raw.paymentDefaults?.bankAccount),
    };
  }
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'numbering')) {
    const separator = text(raw.numbering?.separator || '/', 3);
    out.numbering = {
      invoiceSeries: text(raw.numbering?.invoiceSeries || 'FV', 40),
      correctionSeries: text(raw.numbering?.correctionSeries || 'FK', 40),
      separator: separator || '/',
      padding: Math.max(1, Math.min(12, Number(raw.numbering?.padding || 1) || 1)),
    };
  }
  set('isActive', raw.isActive !== false);
  set('isDefault', raw.isDefault === true);
  if (!partial || Object.prototype.hasOwnProperty.call(raw, 'metadata')) set('metadata', raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {});
  return out;
}

function validateNormalizedEntity(raw = {}) {
  if (!raw.name) throw appError('legal_entity_name_required');
  if (!raw.countryCode || raw.countryCode.length !== 2) throw appError('legal_entity_country_invalid');
  if (!raw.taxId) throw appError('legal_entity_tax_id_required');
  if (raw.countryCode === 'PL' && raw.taxIdType === 'nip' && !isValidPolishNip(raw.taxId)) throw appError('legal_entity_tax_id_invalid');
  if (!/^[A-Z]{3}$/.test(raw.defaultCurrency || '')) throw appError('legal_entity_currency_invalid');
  if (!raw.numbering?.invoiceSeries || !raw.numbering?.correctionSeries) throw appError('legal_entity_numbering_invalid');
  const defaults = (raw.bankAccounts || []).filter((entry) => entry.isDefault);
  if (defaults.length > 1) throw appError('legal_entity_bank_account_default_conflict');
}

async function createLegalEntity(input = {}) {
  const normalized = normalizeLegalEntityInput(input);
  validateNormalizedEntity(normalized);
  return withLock('invoice-legal-entity-default', async () => {
    const session = await mongoose.connection.startSession();
    let created;
    try {
      await session.withTransaction(async () => {
        if (normalized.isDefault) await LegalEntity.updateMany({ isDefault: true }, { $set: { isDefault: false } }, { session });
        [created] = await LegalEntity.create([normalized], { session });
      });
    } finally {
      await session.endSession();
    }
    return created;
  });
}

async function updateLegalEntity(id, patch = {}) {
  return withLock('invoice-legal-entity-default', async () => {
    const session = await mongoose.connection.startSession();
    let entity;
    try {
      await session.withTransaction(async () => {
        entity = await LegalEntity.findById(id).session(session);
        if (!entity) throw appError('legal_entity_not_found');
        const normalizedPatch = normalizeLegalEntityInput(patch, { partial: true });
        const merged = {
          ...entity.toObject(),
          ...normalizedPatch,
          address: normalizedPatch.address ?? entity.address?.toObject?.() ?? entity.address,
          bankAccounts: normalizedPatch.bankAccounts ?? entity.bankAccounts?.map?.((entry) => entry.toObject?.() || entry) ?? [],
          paymentDefaults: normalizedPatch.paymentDefaults ?? entity.paymentDefaults?.toObject?.() ?? entity.paymentDefaults,
          numbering: normalizedPatch.numbering ?? entity.numbering?.toObject?.() ?? entity.numbering,
        };
        validateNormalizedEntity(merged);
        if (normalizedPatch.isDefault === true) await LegalEntity.updateMany({ _id: { $ne: entity._id }, isDefault: true }, { $set: { isDefault: false } }, { session });
        Object.assign(entity, normalizedPatch);
        await entity.save({ session });
      });
    } finally {
      await session.endSession();
    }
    return entity;
  });
}

async function resolveLegalEntity(id, { allowDefault = true, requireActive = true, session = null } = {}) {
  let query;
  if (id) query = LegalEntity.findById(id);
  else if (allowDefault) query = LegalEntity.findOne({ isDefault: true });
  else throw appError('legal_entity_required');
  if (session) query = query.session(session);
  const entity = await query;
  if (!entity) throw appError(id ? 'legal_entity_not_found' : 'legal_entity_required');
  if (requireActive && !entity.isActive) throw appError('legal_entity_inactive');
  return entity;
}

function legalEntityToInvoiceParty(entityLike) {
  const entity = entityLike?.toObject ? entityLike.toObject() : entityLike || {};
  return {
    legalEntityId: entity._id ? String(entity._id) : String(entity.legalEntityId || ''),
    name: entity.name || '',
    taxId: entity.taxId || '',
    taxIdType: entity.taxIdType || '',
    email: entity.email || '',
    phone: entity.phone || '',
    address: {
      street: entity.address?.street || '',
      postalCode: entity.address?.postalCode || '',
      city: entity.address?.city || '',
      countryCode: entity.address?.countryCode || entity.countryCode || '',
    },
  };
}

async function listLegalEntities({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { isActive: true };
  return LegalEntity.find(filter).sort({ isDefault: -1, name: 1 }).lean();
}

module.exports = {
  normalizeLegalEntityInput,
  validateNormalizedEntity,
  createLegalEntity,
  updateLegalEntity,
  resolveLegalEntity,
  legalEntityToInvoiceParty,
  listLegalEntities,
};

'use strict';

const crypto = require('crypto');
const AllegroAccount = require('../models/AllegroAccount');
const { getBaseLinkerAccount } = require('./baseLinkerAccounts');
const { publicOAuthConfiguration } = require('./allegroOAuth');
const { appError } = require('../utils/errors');

function clean(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function publicAllegroAccount(account) {
  const row = typeof account?.toObject === 'function' ? account.toObject() : (account || {});
  return {
    accountId: clean(row.accountId, 64),
    baseLinkerAccountId: clean(row.baseLinkerAccountId, 64),
    name: clean(row.name, 160),
    color: clean(row.color, 32),
    enabled: row.enabled === true,
    authState: clean(row.authState, 64) || 'authorization_required',
    allegroUserId: clean(row.allegroUserId, 128),
    login: clean(row.login, 160),
    marketplaceIds: Array.isArray(row.marketplaceIds) ? row.marketplaceIds.map((value) => clean(value, 80)).filter(Boolean) : [],
    scopes: Array.isArray(row.scopes) ? row.scopes.map((value) => clean(value, 160)).filter(Boolean) : [],
    tokenExpiresAt: row.tokenExpiresAt || null,
    tokenRefreshedAt: row.tokenRefreshedAt || null,
    authConnectedAt: row.authConnectedAt || null,
    lastSuccessfulSyncAt: row.lastSuccessfulSyncAt || null,
    lastSyncError: clean(row.lastSyncError, 1000),
    lastConnectionCheckAt: row.lastConnectionCheckAt || null,
    lastConnectionError: clean(row.lastConnectionError, 1000),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function oauthConfiguration() {
  return publicOAuthConfiguration();
}

async function listAllegroAccounts({ baseLinkerAccountId = '', includeDisabled = true } = {}) {
  const query = {};
  const parentId = clean(baseLinkerAccountId, 64);
  if (parentId) query.baseLinkerAccountId = parentId;
  if (!includeDisabled) query.enabled = true;
  const rows = await AllegroAccount.find(query).sort({ baseLinkerAccountId: 1, createdAt: 1, accountId: 1 }).lean();
  return rows.map(publicAllegroAccount);
}

async function getAllegroAccount(accountId, { requireEnabled = false, lean = false } = {}) {
  const id = clean(accountId, 64);
  if (!id) throw appError('allegro_account_id_required');
  const query = AllegroAccount.findOne({ accountId: id });
  const row = lean ? await query.lean() : await query;
  if (!row) throw appError('allegro_account_not_found');
  if (requireEnabled && row.enabled !== true) throw appError('allegro_account_disabled');
  return row;
}

async function createAllegroAccountDraft({ baseLinkerAccountId, name, color = '' } = {}) {
  const parentId = clean(baseLinkerAccountId, 64);
  const normalizedName = clean(name, 160);
  if (!parentId) throw appError('allegro_baselinker_account_required');
  if (!normalizedName) throw appError('allegro_account_name_required');

  // Fail closed: a mapping may only point at a durable BaseLinker account that
  // actually exists. Disabled BaseLinker accounts are still valid parents.
  await getBaseLinkerAccount(parentId, { lean: true });

  const doc = await AllegroAccount.create({
    accountId: crypto.randomUUID(),
    baseLinkerAccountId: parentId,
    name: normalizedName,
    color: clean(color, 32),
    enabled: false,
    authState: 'authorization_required',
  });
  return publicAllegroAccount(doc);
}

async function updateAllegroAccount(accountId, patch = {}) {
  const row = await getAllegroAccount(accountId);
  if (patch.name !== undefined) {
    const name = clean(patch.name, 160);
    if (!name) throw appError('allegro_account_name_required');
    row.name = name;
  }
  if (patch.color !== undefined) row.color = clean(patch.color, 32);
  if (patch.enabled !== undefined) {
    const nextEnabled = patch.enabled === true;
    if (nextEnabled && row.authState !== 'connected') throw appError('allegro_account_authorization_required');
    row.enabled = nextEnabled;
  }
  await row.save();
  return publicAllegroAccount(row);
}

async function deleteAllegroAccountDraft(accountId) {
  const row = await getAllegroAccount(accountId);
  // A failed first OAuth attempt still has no durable Allegro identity and may
  // be removed as a draft. Once identity exists, later stages must run lifecycle
  // guards before deletion because orders/print jobs can refer to our UUID.
  if (clean(row.allegroUserId, 128) || !['authorization_required', 'error'].includes(row.authState)) {
    throw appError('allegro_account_delete_requires_lifecycle');
  }
  await AllegroAccount.deleteOne({ _id: row._id });
  return { deleted: true, accountId: clean(row.accountId, 64) };
}

module.exports = {
  publicAllegroAccount,
  oauthConfiguration,
  listAllegroAccounts,
  getAllegroAccount,
  createAllegroAccountDraft,
  updateAllegroAccount,
  deleteAllegroAccountDraft,
};

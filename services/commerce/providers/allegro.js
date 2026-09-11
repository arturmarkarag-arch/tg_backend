'use strict';

const { listAllegroAccounts } = require('../../allegroAccounts');
const {
  CAPABILITIES,
  IMPLEMENTATION,
  PROVIDER_TYPES,
  OPERATION_KINDS,
  createProviderAdapter,
} = require('./contract');

const LIVE = IMPLEMENTATION.LIVE;
const {
  text,
  issue,
  titleWordCount,
  effectivePrice,
  effectiveStock,
  isLikelyGtin,
} = require('../publicationPolicy');

function publicAllegroAccount(account = {}) {
  const capabilities = account.capabilities || {};
  const enabled = account.enabled === true;
  const connected = account.authState === 'connected';
  const publicationReady = enabled && connected && capabilities.saleOffersRead === true && capabilities.saleOffersWrite === true;
  return {
    accountId: String(account.accountId || ''),
    name: String(account.name || ''),
    enabled,
    authState: String(account.authState || 'authorization_required'),
    login: String(account.login || ''),
    scopesKnown: account.scopesKnown === true,
    scopes: Array.isArray(account.scopes) ? account.scopes : [],
    capabilities,
    publicationReady,
    publicationState: !enabled ? 'disabled' : !connected ? 'authorization_required' : publicationReady ? 'ready' : 'missing_capability',
    lastSuccessfulSyncAt: account.lastSuccessfulSyncAt || null,
    lastSyncError: String(account.lastSyncError || ''),
    lastConnectionCheckAt: account.lastConnectionCheckAt || null,
    lastConnectionError: String(account.lastConnectionError || ''),
  };
}

function validateAccount(account) {
  const issues = [];
  if (!account) {
    issues.push(issue('account_not_found', 'Allegro-акаунт не знайдено.'));
    return issues;
  }
  if (account.enabled !== true) issues.push(issue('account_disabled', 'Allegro-акаунт вимкнений.'));
  if (account.authState !== 'connected') issues.push(issue('oauth_required', 'Allegro-акаунт потрібно перепідключити через OAuth.'));
  if (account.scopesKnown === true && account.capabilities?.saleOffersWrite !== true) {
    issues.push(issue(
      'missing_sale_offers_write_scope',
      'Токен не має allegro:api:sale:offers:write. Перепідключіть магазин через OAuth.',
      'error',
      { scope: 'allegro:api:sale:offers:write' },
    ));
  }
  if (account.scopesKnown !== true) {
    issues.push(issue(
      'scope_state_unknown',
      'Список OAuth scope для цього підключення невідомий. Перед реальною публікацією акаунт треба перепідключити.',
      'error',
    ));
  }
  return issues;
}

function validateProduct(product, listing) {
  const issues = [];
  if (!product) {
    issues.push(issue('product_not_found', 'Товар Commerce Catalog не знайдено.'));
    return { issues, price: { value: 0, currency: 'PLN' }, stock: { available: 0 }, strategy: 'unknown' };
  }

  const title = text(listing?.titleOverride || product.name, 500);
  const price = effectivePrice(product, listing);
  const stock = effectiveStock(product, listing);
  const ean = text(product.ean, 120);
  const images = Array.isArray(product.media) ? product.media.filter((item) => text(item?.url, 2000)) : [];
  const gtinReady = isLikelyGtin(ean);
  const providerState = listing?.providerData?.allegro && typeof listing.providerData.allegro === 'object'
    ? listing.providerData.allegro
    : {};
  const mappingReady = providerState.mappingState === 'ready' && Boolean(text(listing?.category?.id, 100));
  const strategy = mappingReady
    ? (text(providerState.mappingStrategy, 40) || (text(providerState.catalogProductId, 160) ? 'catalog_product' : 'new_product'))
    : (gtinReady ? 'gtin' : 'category_mapping');

  if (product.status !== 'active') issues.push(issue('product_not_active', 'Товар має бути активним у Commerce Catalog перед публікацією.'));
  if (title.length < 12 || title.length > 75 || titleWordCount(title) < 3) {
    issues.push(issue('title_invalid', 'Для Allegro назва offer повинна мати 12–75 символів і щонайменше 3 слова.', 'error', { field: 'name' }));
  }
  if (!(price.value > 0)) issues.push(issue('price_required', 'Вкажіть ціну більшу за 0.', 'error', { field: 'price' }));
  if (price.currency !== 'PLN') {
    issues.push(issue('currency_not_supported_yet', 'Поточний Allegro adapter налаштований на базовий marketplace allegro-pl у PLN.', 'error', { field: 'currency' }));
  }
  if (!(stock.available > 0)) issues.push(issue('stock_required', 'Для публікації зараз немає доступного залишку.', 'error', { field: 'stock' }));

  if (!mappingReady) {
    if (!ean) {
      issues.push(issue('category_mapping_required', 'Немає GTIN/EAN. Потрібно вибрати категорію Allegro та заповнити її обов’язкові параметри.', 'error', { nextStage: 'category_mapping' }));
    } else if (!gtinReady) {
      issues.push(issue('gtin_invalid', 'EAN/GTIN має некоректний формат. Перевірте код або використайте шлях через категорію та параметри Allegro.', 'error', { field: 'ean', nextStage: 'category_mapping' }));
    } else {
      issues.push(issue('upstream_product_validation_pending', 'GTIN готовий для пошуку в Каталозі Allegro. Виконайте mapping продукту/категорії та параметрів.', 'warning', { nextStage: 'category_mapping' }));
    }
  }

  if (!images.length) {
    const catalogProductMapped = mappingReady && Boolean(text(providerState.catalogProductId, 160));
    issues.push(issue(
      'images_missing',
      catalogProductMapped ? 'У нашому каталозі немає фото. Для прив’язаного Allegro Catalog product фото можуть бути використані з каталогу Allegro.' : 'Для нового продукту потрібно додати хоча б одне фото.',
      catalogProductMapped ? 'warning' : 'error',
      { field: 'media' },
    ));
  }
  if (!text(listing?.descriptionOverride || product.description, 20000)) {
    issues.push(issue('description_missing', 'Опис не заповнений. Для відомого продукту Allegro може використати дані каталогу, але власний опис бажаний.', 'warning', { field: 'description' }));
  }

  return {
    issues,
    price,
    stock,
    strategy,
    mappingReady,
    mappingState: text(providerState.mappingState, 40) || 'never',
  };
}

function publicListing(listing) {
  if (!listing) return null;
  const state = listing?.providerData?.allegro && typeof listing.providerData.allegro === 'object'
    ? listing.providerData.allegro
    : {};
  const salesSettings = state.salesSettings && typeof state.salesSettings === 'object' ? state.salesSettings : null;
  return {
    id: String(listing._id),
    externalId: text(listing.externalId, 200),
    status: text(listing.status, 40) || 'draft',
    providerState: state,
    draftCreationState: text(state?.draftCreation?.state, 40),
    draftOperationPath: text(state?.draftCreation?.operationPath, 2048),
    draftExternalKey: text(state?.draftCreation?.externalKey, 100),
    reconciliation: state.reconciliation && typeof state.reconciliation === 'object' ? {
      state: text(state.reconciliation.state, 40),
      checkedAt: state.reconciliation.checkedAt || null,
      readyForNextStage: state.reconciliation.readyForNextStage === true,
      blockingCount: Number(state.reconciliation.blockingCount || 0),
      warningCount: Number(state.reconciliation.warningCount || 0),
      localChangedSinceCreate: state.reconciliation.localChangedSinceCreate === true,
      offer: state.reconciliation.offer || null,
      expected: state.reconciliation.expected || null,
      issues: Array.isArray(state.reconciliation.issues) ? state.reconciliation.issues.slice(0, 20) : [],
    } : null,
    salesSettings: salesSettings ? {
      state: text(salesSettings.state, 40),
      readyForApply: salesSettings.readyForApply === true,
      readyForActivation: salesSettings.readyForActivation === true,
      desiredHash: text(salesSettings.desiredHash, 100),
      appliedHash: text(salesSettings.appliedHash, 100),
      appliedAt: salesSettings.appliedAt || null,
      verifiedAt: salesSettings.verifiedAt || null,
      updatedAt: salesSettings.updatedAt || null,
      shippingRate: salesSettings.shippingRate || null,
      afterSalesServices: salesSettings.afterSalesServices || null,
      delivery: salesSettings.delivery || null,
      location: salesSettings.location || null,
      apply: salesSettings.apply && typeof salesSettings.apply === 'object' ? {
        state: text(salesSettings.apply.state, 40),
        jobId: text(salesSettings.apply.jobId, 100),
        operationPath: text(salesSettings.apply.operationPath, 2048),
        operationId: text(salesSettings.apply.operationId, 200),
        lastErrorCode: text(salesSettings.apply.lastErrorCode, 200),
        lastError: text(salesSettings.apply.lastError, 1500),
        issues: Array.isArray(salesSettings.apply.issues) ? salesSettings.apply.issues.slice(0, 20) : [],
      } : null,
    } : null,
    activation: state.activation && typeof state.activation === 'object' ? {
      state: text(state.activation.state, 40),
      publicationStatus: text(state.activation.publicationStatus, 40).toUpperCase(),
      jobId: text(state.activation.jobId, 100),
      operationPath: text(state.activation.operationPath, 2048),
      operationId: text(state.activation.operationId, 200),
      canRetry: state.activation.canRetry === true,
      activatedAt: state.activation.activatedAt || null,
      verifiedAt: state.activation.verifiedAt || null,
      lastErrorCode: text(state.activation.lastErrorCode, 200),
      lastError: text(state.activation.lastError, 1500),
    } : null,
    contentUpdate: state.contentUpdate && typeof state.contentUpdate === 'object' ? {
      state: text(state.contentUpdate.state, 40),
      jobId: text(state.contentUpdate.jobId, 100),
      desiredHash: text(state.contentUpdate.desiredHash, 128),
      appliedHash: text(state.contentUpdate.appliedHash, 128),
      operationPath: text(state.contentUpdate.operationPath, 2048),
      operationId: text(state.contentUpdate.operationId, 200),
      canRetry: state.contentUpdate.canRetry === true,
      stillCurrent: state.contentUpdate.stillCurrent === true,
      appliedAt: state.contentUpdate.appliedAt || null,
      verifiedAt: state.contentUpdate.verifiedAt || null,
      lastErrorCode: text(state.contentUpdate.lastErrorCode, 200),
      lastError: text(state.contentUpdate.lastError, 1500),
    } : null,
    priceSync: state.priceSync && typeof state.priceSync === 'object' ? {
      state: text(state.priceSync.state, 40),
      jobId: text(state.priceSync.jobId, 100),
      commandId: text(state.priceSync.commandId, 100),
      desiredHash: text(state.priceSync.desiredHash, 128),
      appliedHash: text(state.priceSync.appliedHash, 128),
      desiredPrice: state.priceSync.desiredPrice || null,
      actualPrice: state.priceSync.actualPrice || null,
      automationRule: state.priceSync.automationRule || null,
      canRetry: state.priceSync.canRetry === true,
      stillCurrent: state.priceSync.stillCurrent === true,
      appliedAt: state.priceSync.appliedAt || null,
      verifiedAt: state.priceSync.verifiedAt || null,
      lastErrorCode: text(state.priceSync.lastErrorCode, 200),
      lastError: text(state.priceSync.lastError, 1500),
    } : null,
    lifecycle: state.lifecycle && typeof state.lifecycle === 'object' ? {
      generation: Number(state.lifecycle.generation || 0),
      state: text(state.lifecycle.state, 40),
      action: text(state.lifecycle.action, 20),
      phase: text(state.lifecycle.phase, 40),
      jobId: text(state.lifecycle.jobId, 100),
      publicationStatus: text(state.lifecycle.publicationStatus, 40).toUpperCase(),
      desiredStock: state.lifecycle.desiredStock == null ? null : Number(state.lifecycle.desiredStock),
      quantityCommandId: text(state.lifecycle.quantityCommandId, 100),
      publicationCommandId: text(state.lifecycle.publicationCommandId, 100),
      verifiedAt: state.lifecycle.verifiedAt || null,
      lastErrorCode: text(state.lifecycle.lastErrorCode, 200),
      lastError: text(state.lifecycle.lastError, 1500),
    } : null,
  };
}

async function preparePublicationPreview() {
  const accounts = await listAllegroAccounts({ includeDisabled: true });
  return {
    accountById: new Map(accounts.map((item) => [String(item.accountId), item])),
  };
}

function previewPublicationRow({ product, listing, target, context }) {
  const account = context?.accountById?.get(target.accountId) || null;
  const validation = validateProduct(product, listing);
  const issues = [...validateAccount(account), ...validation.issues];
  const publicAccount = account ? publicAllegroAccount(account) : null;
  return {
    issues,
    target: {
      provider: 'allegro',
      accountId: target.accountId,
      accountName: publicAccount?.name || publicAccount?.login || target.accountId,
      connected: publicAccount?.authState === 'connected',
      enabled: publicAccount?.enabled === true,
      publicationReady: publicAccount?.publicationReady === true,
      capabilities: publicAccount?.capabilities || {},
      // compatibility aliases while provider-specific UI is migrated to generic capability checks
      saleOffersWrite: publicAccount?.capabilities?.saleOffersWrite === true,
    },
    listing: publicListing(listing),
    mode: listing?.externalId ? 'update' : 'create',
    strategy: validation.strategy,
    effectivePrice: validation.price,
    effectiveStock: validation.stock,
    mapping: {
      state: validation.mappingState || text(listing?.providerData?.allegro?.mappingState, 40) || 'never',
      ready: validation.mappingReady === true,
      categoryId: text(listing?.category?.id, 100),
      externalProductId: text(listing?.providerData?.allegro?.catalogProductId, 160),
      catalogProductId: text(listing?.providerData?.allegro?.catalogProductId, 160),
    },
    providerState: listing?.providerData?.allegro || {},
  };
}

function lazy(servicePath, exportName) {
  return async (payload) => {
    // Lazy require avoids a circular dependency during publicationPreview bootstrap:
    // several mature Allegro services still consume provider-neutral price/stock helpers.
    const service = require(servicePath);
    return service[exportName](payload || {});
  };
}

function pendingJobsStatus(result) {
  const pending = result?.jobs?.some?.((job) => ['reserved', 'sending', 'pending', 'unknown'].includes(job.state));
  return pending ? 202 : 200;
}

const integrationApi = [
  { id: 'auth.oauth', label: 'OAuth seller account', operation: 'OAuth 2.0', direction: 'auth', implementation: LIVE },
  { id: 'orders.read', label: 'Замовлення', operation: 'order checkout forms / events', direction: 'read', implementation: LIVE, capability: 'ordersRead', scope: 'allegro:api:orders:read' },
  { id: 'orders.write', label: 'Статус/fulfillment замовлення', operation: 'order fulfillment', direction: 'write', implementation: LIVE, capability: 'ordersWrite', scope: 'allegro:api:orders:write' },
  { id: 'offers.read', label: 'Offers / фото товарів', operation: 'sale offers', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read' },
  { id: 'offers.preflight', label: 'Preflight публікації', operation: 'Commerce Provider Core preview', direction: 'read', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Provider-neutral core викликає Allegro adapter; upstream write = 0.' },
  { id: 'catalog.products.search', label: 'Пошук товару в Каталозі Allegro', operation: 'GET /sale/products', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read' },
  { id: 'catalog.mapping', label: 'Категорії та параметри', operation: 'GET matching-categories/categories/parameters', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read' },
  { id: 'offers.draft.create', label: 'Створення draft offer', operation: 'POST /sale/product-offers (INACTIVE)', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3C: idempotent/recoverable create через стабільний external.id; ACTIVE не вмикається.' },
  { id: 'offers.draft.reconcile', label: 'Звірка draft offer', operation: 'GET /sale/product-offers/{offerId}', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.1: read-back і drift detection перед наступними write.' },
  { id: 'offers.sales-settings.read', label: 'Sales Settings', operation: 'shipping-rates + after-sales-service-conditions', direction: 'read', implementation: LIVE, capability: 'saleSettingsRead', scope: 'allegro:api:sale:settings:read', note: 'Stage 3D.2: provider mapping для delivery/returns/complaints/warranty/location.' },
  { id: 'offers.sales-settings.apply', label: 'Застосування Sales Settings', operation: 'PATCH /sale/product-offers/{offerId}', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.2.1: durable apply + read-back verification.' },
  { id: 'offers.publish', label: 'Активація offer', operation: 'PATCH publication.status=ACTIVE', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.3: окремого Allegro publish endpoint не використовуємо; мінімальний PATCH тільки publication.status=ACTIVE.' },
  { id: 'offers.update.preview', label: 'Preview змін ACTIVE offer', operation: 'GET /sale/product-offers/{offerId} + local diff', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.4A: read-only diff; price/stock відкладені в окремі sync.' },
  { id: 'offers.update', label: 'Редагування контенту offer', operation: 'PATCH /sale/product-offers/{offerId}', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.4.1: safe contentPatch (name/description/images), без price/stock/category/product.id.' },
  { id: 'offers.price.write', label: 'Синхронізація ціни', operation: 'POST /sale/offer-bulk-modification-commands + summary/tasks', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.5: різні FIXED prices, до 25 modifications/command; beta resource.' },
  { id: 'offers.stock.preview', label: 'Preview залишку', operation: 'Commerce Inventory + reservations + GET offers', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.6A/6C: online inventory окремий від main warehouse Product.quantity.' },
  { id: 'inventory.reservations', label: 'Central reservation ledger', operation: 'provider-neutral Commerce reservations', direction: 'internal', implementation: LIVE, note: 'Stage 3D.6B: provider-neutral order holds і fail-closed unknown reservations.' },
  { id: 'inventory.movements', label: 'Commerce Inventory movements', operation: 'provider-neutral inventory movements', direction: 'internal', implementation: LIVE, note: 'Stage 3D.6B.2: exactly-once списання лише з CommerceInventoryItem.onHand.' },
  { id: 'offers.stock.write', label: 'Синхронізація залишку', operation: 'POST /sale/offer-bulk-modification-commands (stock) + summary/tasks', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.6C: FIXED stock із Commerce Inventory мінус reservations; zero-stock confirmation; beta resource.' },
  { id: 'offers.lifecycle.read', label: 'Lifecycle preview', operation: 'GET product-offer + Commerce stock readiness', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.7A: ACTIVE/ENDED і reopen readiness.' },
  { id: 'offers.lifecycle.write', label: 'END / REOPEN offer', operation: 'PUT /sale/offer-publication-commands/{commandId}', direction: 'write', implementation: LIVE, capability: 'saleOffersWrite', scope: 'allegro:api:sale:offers:write', note: 'Stage 3D.7A: END/ACTIVATE lifecycle, quantity preparation before ENDED reopen when needed.' },
  { id: 'offers.health.read', label: 'Final health / reconciliation', operation: 'GET product-offer + offer-events', direction: 'read', implementation: LIVE, capability: 'saleOffersRead', scope: 'allegro:api:sale:offers:read', note: 'Stage 3D.7B: live read-back усіх керованих полів + recent events; upstream write = 0.' },
  { id: 'shipments.read', label: 'Відправлення / ТТН', operation: 'shipment-management', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
  { id: 'shipments.write', label: 'Wysyłam z Allegro', operation: 'shipment-management', direction: 'write', implementation: LIVE, capability: 'shipmentsWrite', scope: 'allegro:api:shipments:write' },
  { id: 'shipments.labels.read', label: 'Етикетка WzA', operation: 'shipment-management/label', direction: 'read', implementation: LIVE, capability: 'shipmentsRead', scope: 'allegro:api:shipments:read' },
];

const adapter = createProviderAdapter({
  id: 'allegro',
  name: 'Allegro',
  type: PROVIDER_TYPES.MARKETPLACE,
  implementation: IMPLEMENTATION.LIVE,
  description: 'Перший Commerce Provider adapter. Allegro-специфіка ізольована від Commerce Product/Core.',
  capabilities: {
    [CAPABILITIES.ACCOUNTS]: true,
    [CAPABILITIES.ORDERS_READ]: true,
    [CAPABILITIES.PRODUCT_MAPPING]: true,
    [CAPABILITIES.LISTING_PREVIEW]: true,
    [CAPABILITIES.LISTING_CREATE]: true,
    [CAPABILITIES.LISTING_UPDATE_CONTENT]: true,
    [CAPABILITIES.PRICE_SYNC]: true,
    [CAPABILITIES.STOCK_SYNC]: true,
    [CAPABILITIES.LIFECYCLE]: true,
    [CAPABILITIES.HEALTH]: true,
  },
  listAccounts: ({ includeDisabled = true } = {}) => listAllegroAccounts({ includeDisabled }),
  publicAccount: publicAllegroAccount,
  preparePublicationPreview,
  previewPublicationRow,
  integrationApi,
  metadata: {
    productModel: 'product_offer',
    providerStateNamespace: 'allegro',
  },
  operations: {
    'mapping.resolve': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.PRODUCT_MAPPING, execute: lazy('../allegroMapping', 'resolveAllegroMapping') },
    'mapping.save': { kind: OPERATION_KINDS.LOCAL_WRITE, capability: CAPABILITIES.PRODUCT_MAPPING, execute: lazy('../allegroMapping', 'saveAllegroMapping') },
    'draft.create': {
      kind: OPERATION_KINDS.PROVIDER_WRITE,
      capability: CAPABILITIES.LISTING_CREATE,
      execute: lazy('../allegroDraftOffer', 'createAllegroDraft'),
      httpStatus: (result) => result.state === 'confirmed' ? ((result.alreadyBound || result.recovered) ? 200 : 201) : 202,
    },
    'draft.refresh': {
      kind: OPERATION_KINDS.READ,
      capability: CAPABILITIES.LISTING_CREATE,
      execute: lazy('../allegroDraftOffer', 'refreshAllegroDraft'),
      httpStatus: (result) => result.state === 'confirmed' ? 200 : 202,
    },
    'draft.reconcile': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.HEALTH, execute: lazy('../allegroDraftReconciliation', 'reconcileAllegroDraft') },
    'sales-settings.resolve': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.PRODUCT_MAPPING, execute: lazy('../allegroSalesSettings', 'resolveAllegroSalesSettings') },
    'sales-settings.save': { kind: OPERATION_KINDS.LOCAL_WRITE, capability: CAPABILITIES.PRODUCT_MAPPING, execute: lazy('../allegroSalesSettings', 'saveAllegroSalesSettings') },
    'sales-settings.apply': {
      kind: OPERATION_KINDS.PROVIDER_WRITE,
      capability: CAPABILITIES.LISTING_UPDATE_CONTENT,
      execute: lazy('../allegroSalesSettingsApply', 'applyAllegroSalesSettings'),
      httpStatus: (result) => result.state === 'confirmed' ? 200 : 202,
    },
    'sales-settings.refresh': {
      kind: OPERATION_KINDS.READ,
      capability: CAPABILITIES.HEALTH,
      execute: lazy('../allegroSalesSettingsApply', 'refreshAllegroSalesSettingsApply'),
      httpStatus: (result) => result.state === 'confirmed' ? 200 : 202,
    },
    'listing.activate': {
      kind: OPERATION_KINDS.PROVIDER_WRITE,
      capability: CAPABILITIES.LIFECYCLE,
      execute: lazy('../allegroActivation', 'activateAllegroOffer'),
      httpStatus: (result) => result.state === 'confirmed' ? 200 : 202,
    },
    'content.preview': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.LISTING_UPDATE_CONTENT, execute: lazy('../allegroOfferUpdatePreview', 'previewAllegroOfferUpdate') },
    'content.apply': {
      kind: OPERATION_KINDS.PROVIDER_WRITE,
      capability: CAPABILITIES.LISTING_UPDATE_CONTENT,
      execute: lazy('../allegroOfferContentUpdate', 'applyAllegroOfferContent'),
      httpStatus: (result) => result.state === 'confirmed' ? 200 : 202,
    },
    'price.preview': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.PRICE_SYNC, execute: lazy('../allegroPriceSync', 'previewAllegroPriceSync') },
    'price.apply': { kind: OPERATION_KINDS.PROVIDER_WRITE, capability: CAPABILITIES.PRICE_SYNC, execute: lazy('../allegroPriceSync', 'applyAllegroPriceSync'), httpStatus: pendingJobsStatus },
    'stock.preview': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.STOCK_SYNC, execute: lazy('../allegroStockSync', 'previewAllegroStockSync') },
    'stock.apply': { kind: OPERATION_KINDS.PROVIDER_WRITE, capability: CAPABILITIES.STOCK_SYNC, execute: lazy('../allegroStockSyncApply', 'applyAllegroStockSync'), httpStatus: pendingJobsStatus },
    'lifecycle.preview': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.LIFECYCLE, execute: lazy('../allegroLifecycle', 'lifecyclePreview') },
    'lifecycle.apply': {
      kind: OPERATION_KINDS.PROVIDER_WRITE,
      capability: CAPABILITIES.LIFECYCLE,
      execute: lazy('../allegroLifecycle', 'manageAllegroLifecycle'),
      httpStatus: (result) => ['pending', 'sending', 'unknown'].includes(result.state) ? 202 : 200,
    },
    'health.scan': { kind: OPERATION_KINDS.READ, capability: CAPABILITIES.HEALTH, execute: lazy('../allegroListingHealth', 'scanAllegroListingHealth') },
  },
});

module.exports = adapter;

import React, { useEffect, useState } from 'react';
import { AlertTriangle, PackageSearch } from 'lucide-react';
import { PanelCard } from '../components/ui/panel-card.jsx';
import ActivePickingBanner from '../features/baseLinker/components/ActivePickingBanner.jsx';
import BaseLinkerFatalState from '../features/baseLinker/components/BaseLinkerFatalState.jsx';
import BaseLinkerOrderCard from '../features/baseLinker/components/BaseLinkerOrderCard.jsx';
import BaseLinkerPagination from '../features/baseLinker/components/BaseLinkerPagination.jsx';
import BaseLinkerToolbar from '../features/baseLinker/components/BaseLinkerToolbar.jsx';
import ThanosOrderList from '../features/baseLinker/components/ThanosOrderList.jsx';
import useBaseLinkerData from '../features/baseLinker/hooks/useBaseLinkerData.js';
import useBaseLinkerPickingActions from '../features/baseLinker/hooks/useBaseLinkerPickingActions.js';
import useBaseLinkerWorkflow from '../features/baseLinker/hooks/useBaseLinkerWorkflow.js';
import { displayStageForState } from '../features/baseLinker/displayState.js';
import { parseBaseLinkerSourceKey } from '../features/baseLinker/sourceFilter.js';

function BaseLinkerQueueSkeleton({ rows = 3 }) {
  const safeRows = Math.max(2, Math.min(4, Number(rows) || 3));
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Завантаження замовлень">
      {Array.from({ length: safeRows }, (_, index) => (
        <PanelCard key={index} className="overflow-hidden p-3">
          <div className="animate-pulse space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="h-5 w-32 rounded-md bg-slate-800" />
              <div className="h-7 w-24 rounded-lg bg-slate-800" />
            </div>
            <div className="flex gap-3">
              <div className="h-20 w-20 shrink-0 rounded-lg bg-slate-800" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="h-10 rounded-lg bg-slate-800" />
                  <div className="h-10 rounded-lg bg-slate-800" />
                </div>
                <div className="h-4 w-11/12 rounded bg-slate-800" />
                <div className="h-4 w-2/3 rounded bg-slate-800" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="h-9 rounded-lg bg-slate-800" />
              <div className="h-9 rounded-lg bg-slate-800" />
              <div className="h-9 rounded-lg bg-slate-800" />
            </div>
          </div>
        </PanelCard>
      ))}
    </div>
  );
}

const DEFAULT_BASELINKER_FILTERS = Object.freeze({
  accountId: 'all',
  sourceType: 'all',
  sourceKey: 'all',
  workflowFilter: 'processing',
  packedBy: 'all',
  sentBy: 'all',
  pageSize: '10',
});

export default function BaseLinkerPage({ telegramUser }) {
  const [accountId, setAccountId] = useState(DEFAULT_BASELINKER_FILTERS.accountId);
  const [sourceType, setSourceType] = useState(DEFAULT_BASELINKER_FILTERS.sourceType);
  const [sourceKey, setSourceKey] = useState(DEFAULT_BASELINKER_FILTERS.sourceKey);
  const [search, setSearch] = useState('');
  const [serverSearch, setServerSearch] = useState('');
  const [workflowFilter, setWorkflowFilter] = useState(DEFAULT_BASELINKER_FILTERS.workflowFilter);
  const [packedBy, setPackedBy] = useState(DEFAULT_BASELINKER_FILTERS.packedBy);
  const [sentBy, setSentBy] = useState(DEFAULT_BASELINKER_FILTERS.sentBy);
  const [pageSize, setPageSize] = useState(DEFAULT_BASELINKER_FILTERS.pageSize);
  const [currentPage, setCurrentPage] = useState(1);
  const me = String(telegramUser?.telegramId || '');

  useEffect(() => {
    const timer = setTimeout(() => {
      setServerSearch(search.trim());
      setCurrentPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);


  const handleAccountChange = (value) => {
    setAccountId(value || 'all');
    setSourceType('all');
    setSourceKey('all');
    setCurrentPage(1);
  };

  const handleSourceTypeChange = (value) => {
    setSourceType(value || 'all');
    setSourceKey('all');
    setCurrentPage(1);
  };

  const handleSourceChange = (value) => {
    const concrete = parseBaseLinkerSourceKey(value);
    if (!concrete) {
      setSourceKey('all');
      setCurrentPage(1);
      return;
    }
    setSourceType(concrete.sourceType);
    setSourceKey(concrete.key);
    setCurrentPage(1);
  };

  const handleWorkflowFilterChange = (value) => {
    setWorkflowFilter(value);
    if (value !== 'sent') {
      setPackedBy('all');
      setSentBy('all');
    }
    setCurrentPage(1);
  };

  const handlePackedByChange = (value) => {
    setPackedBy(value || 'all');
    setCurrentPage(1);
  };

  const handleSentByChange = (value) => {
    setSentBy(value || 'all');
    setCurrentPage(1);
  };

  const handlePageSizeChange = (value) => {
    setPageSize(value);
    setCurrentPage(1);
  };

  const handleClearSearch = () => {
    setSearch('');
    setServerSearch('');
    setCurrentPage(1);
  };

  const handleResetFilters = () => {
    setAccountId(DEFAULT_BASELINKER_FILTERS.accountId);
    setSourceType(DEFAULT_BASELINKER_FILTERS.sourceType);
    setSourceKey(DEFAULT_BASELINKER_FILTERS.sourceKey);
    setWorkflowFilter(DEFAULT_BASELINKER_FILTERS.workflowFilter);
    setPackedBy(DEFAULT_BASELINKER_FILTERS.packedBy);
    setSentBy(DEFAULT_BASELINKER_FILTERS.sentBy);
    setPageSize(DEFAULT_BASELINKER_FILTERS.pageSize);
    setCurrentPage(1);
  };

  const filtersAtDefault = accountId === DEFAULT_BASELINKER_FILTERS.accountId
    && sourceType === DEFAULT_BASELINKER_FILTERS.sourceType
    && sourceKey === DEFAULT_BASELINKER_FILTERS.sourceKey
    && workflowFilter === DEFAULT_BASELINKER_FILTERS.workflowFilter
    && packedBy === DEFAULT_BASELINKER_FILTERS.packedBy
    && sentBy === DEFAULT_BASELINKER_FILTERS.sentBy
    && pageSize === DEFAULT_BASELINKER_FILTERS.pageSize;

  const data = useBaseLinkerData({
    accountId,
    sourceType,
    sourceKey,
    workflowFilter,
    packedBy,
    sentBy,
    search: serverSearch,
    page: currentPage,
    pageSize,
  });
  useEffect(() => {
    if (sourceKey === 'all') return;
    const concrete = parseBaseLinkerSourceKey(sourceKey);
    const compatibleAccount = concrete && (accountId === 'all' || concrete.accountId === accountId);
    const stillExists = compatibleAccount && data.sourceOptions.some((option) => String(option.value) === concrete.key);
    if (!stillExists && !data.metaQuery.isLoading) {
      setSourceKey('all');
      setCurrentPage(1);
    }
  }, [accountId, data.metaQuery.isLoading, data.sourceOptions, sourceKey]);
  const sourceFilterInvalid = String(
    data.criticalFailure?.error?.code || data.criticalFailure?.error?.body?.error || '',
  ).trim() === 'baselinker_source_filter_invalid';

  useEffect(() => {
    if (!sourceFilterInvalid) return;
    setSourceType('all');
    setSourceKey('all');
    setCurrentPage(1);
  }, [sourceFilterInvalid]);

  const actions = useBaseLinkerPickingActions({
    myTelegramId: me,
    myActiveState: data.myActiveState,
  });
  const workflow = useBaseLinkerWorkflow({
    orders: data.allOrders,
    pickingStates: data.pickingStates,
    search: serverSearch,
    workflowFilter,
  });

  useEffect(() => {
    if (!data.ordersQuery.isFetching && data.page !== currentPage) setCurrentPage(data.page);
  }, [currentPage, data.ordersQuery.isFetching, data.page]);

  if (data.statusQuery.isLoading) {
    return <div className="p-6 text-sm text-slate-400">Перевіряю підключення BaseLinker…</div>;
  }

  if (data.statusQuery.error) {
    return (
      <BaseLinkerFatalState
        error={data.statusQuery.error}
        source="status"
        onRetry={data.refreshAll}
        retrying={data.refreshing}
      />
    );
  }

  if (data.statusQuery.data?.configured === false) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
        <PanelCard className="p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 text-amber-400" size={22} />
            <div>
              <h1 className="text-xl font-semibold text-slate-100">BaseLinker не налаштовано</h1>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Додайте BaseLinker-акаунт у Налаштуваннях: задайте нашу назву, API-ключ і три робочі статуси.
                API-ключ зберігається тільки на backend і не повертається в браузер.
              </p>
            </div>
          </div>
        </PanelCard>
      </div>
    );
  }

  if (data.criticalFailure && !sourceFilterInvalid) {
    return (
      <BaseLinkerFatalState
        error={data.criticalFailure.error}
        source={data.criticalFailure.source}
        onRetry={data.refreshAll}
        retrying={data.refreshing}
      />
    );
  }

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PackageSearch className="text-cyan-400" size={24} />
          <h1 className="text-2xl font-bold text-slate-100">BaseLinker</h1>
        </div>
      </div>

      <ActivePickingBanner
        state={data.myActiveState}
        busy={actions.hasPendingActions}
        onShow={() => {
          setAccountId(String(data.myActiveState?.baseLinkerAccountId || 'all'));
          setSourceType('all');
          setSourceKey('all');
          setWorkflowFilter(displayStageForState(data.myActiveState));
          setSearch(String(data.myActiveState?.orderId || ''));
          setCurrentPage(1);
        }}
        onRelease={actions.handleRelease}
      />

      <BaseLinkerToolbar
        accountId={accountId}
        onAccountChange={handleAccountChange}
        accounts={data.accounts}
        sourceType={sourceType}
        onSourceTypeChange={handleSourceTypeChange}
        sourceTypeOptions={data.sourceTypeOptions}
        sourceKey={sourceKey}
        onSourceChange={handleSourceChange}
        sourceOptions={data.sourceOptions}
        search={search}
        onSearchChange={setSearch}
        onClearSearch={handleClearSearch}
        workflowFilter={workflowFilter}
        onWorkflowFilterChange={handleWorkflowFilterChange}
        workflowCounts={data.workflowCounts}
        packedBy={packedBy}
        onPackedByChange={handlePackedByChange}
        packedByOptions={data.packedByOptions}
        sentBy={sentBy}
        onSentByChange={handleSentByChange}
        sentByOptions={data.sentByOptions}
        workflowCountsLoading={data.queuePending}
        onResetFilters={handleResetFilters}
        filtersAtDefault={filtersAtDefault}
      />

      {data.queuePending ? (
        <BaseLinkerQueueSkeleton rows={Number(pageSize) >= 20 ? 4 : 3} />
      ) : (
        <>
          {data.productCatalogStats?.requested > 0 && data.productCatalogStats.unresolved > 0 ? (
            <PanelCard className="border-amber-700/40 p-4">
              <div className="flex items-start gap-3 text-amber-300">
                <AlertTriangle size={18} className="mt-0.5" />
                <p className="text-sm leading-6">Для частини товарів немає фото.</p>
              </div>
            </PanelCard>
          ) : null}

          <div className={`space-y-4 transition-opacity ${data.queueTransitioning ? 'pointer-events-none opacity-60' : 'opacity-100'}`} aria-busy={data.queueTransitioning}>
            <ThanosOrderList
              groups={workflow.pagedGroups}
              allGroups={workflow.orderGroups}
              viewKey={`${accountId}|${sourceType}|${sourceKey}|${workflowFilter}|${packedBy}|${sentBy}|${serverSearch}|${currentPage}|${pageSize}`}
              emptyState={(
                <PanelCard className="p-8 text-center">
                  <PackageSearch className="mx-auto text-slate-600" size={34} />
                  <p className="mt-3 font-medium text-slate-300">Замовлень за цими умовами немає</p>
                </PanelCard>
              )}
              renderGroup={(group) => (
                <BaseLinkerOrderCard
                  order={group.order}
                  pickingState={group.pickingState}
                  telegramUser={telegramUser}
                  baseLinkerStatuses={data.accountMetaById[String(group.order?.baseLinkerAccountId || '')]?.statuses || []}
                  intakeStatusId={data.accountRuntimeById[String(group.order?.baseLinkerAccountId || '')]?.queue?.intakeStatusId}
                  intakeStatusName={data.accountRuntimeById[String(group.order?.baseLinkerAccountId || '')]?.queue?.intakeStatusName}
                  sentStatusId={data.accountRuntimeById[String(group.order?.baseLinkerAccountId || '')]?.queue?.sentStatusId}
                  cancelledStatusId={data.accountRuntimeById[String(group.order?.baseLinkerAccountId || '')]?.queue?.cancelledStatusId}
                  accountEnabled={data.accountRuntimeById[String(group.order?.baseLinkerAccountId || '')]?.enabled === true}
                  onClaim={actions.handleClaim}
                  onUpdateItem={actions.handleUpdateItem}
                  onRelease={actions.handleRelease}
                  onSent={actions.handleSent}
                  onUpstreamReviewed={actions.handleUpstreamReviewed}
                  onReopen={actions.handleReopen}
                />
              )}
            />

            {workflow.visibleGroups.length ? (
              <BaseLinkerPagination
                page={currentPage}
                pageCount={data.pageCount}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={handlePageSizeChange}
              />
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

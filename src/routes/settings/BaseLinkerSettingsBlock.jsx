import React, { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import {
  createBaseLinkerAccount,
  getBaseLinkerApiUsage,
  getBaseLinkerSettings,
  refreshBaseLinkerAccount,
  rotateBaseLinkerAccountToken,
  saveBaseLinkerAccountQueue,
  updateBaseLinkerAccount,
  validateBaseLinkerToken,
} from '../../api.js';
import { Button } from '../../components/ui/button.jsx';
import { Input } from '../../components/ui/input.jsx';
import { PanelCard } from '../../components/ui/panel-card.jsx';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../../components/ui/field.jsx';
import { SelectField } from '../../components/ui/select.jsx';
import { queryKeys } from '../../query/queryKeys.js';
import { mutationKeys } from '../../query/mutationKeys.js';
import toast from '../../utils/toast.js';

const EMPTY_ADD = {
  name: '',
  token: '',
  color: '#22d3ee',
  intakeStatusId: '',
  sentStatusId: '',
  cancelledStatusId: '',
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function metadataSummary(metadata = {}) {
  const statuses = Array.isArray(metadata?.statuses) ? metadata.statuses : [];
  const inventories = Array.isArray(metadata?.inventories) ? metadata.inventories : [];
  const sources = metadata?.sources && typeof metadata.sources === 'object' ? metadata.sources : {};
  const sourceCount = Object.values(sources).reduce((sum, rows) => (
    sum + (rows && typeof rows === 'object' ? Object.keys(rows).length : 0)
  ), 0);
  return { statuses: statuses.length, inventories: inventories.length, sources: sourceCount };
}

function statusesFrom(account) {
  return Array.isArray(account?.metadataSnapshot?.statuses) ? account.metadataSnapshot.statuses : [];
}

function statusOptions(statuses) {
  return statuses.map((status) => ({
    value: String(status.id),
    label: status.name || `Статус №${status.id}`,
  }));
}

function queueIsValid(form, statuses) {
  const values = [form.intakeStatusId, form.sentStatusId, form.cancelledStatusId].map(String).filter(Boolean);
  if (values.length !== 3 || new Set(values).size !== 3) return false;
  const ids = new Set(statuses.map((row) => String(row.id)));
  return values.every((value) => ids.has(value));
}

async function invalidateBaseLinker(qc) {
  await Promise.allSettled([
    qc.invalidateQueries({ queryKey: queryKeys.settings.baseLinker }),
    qc.invalidateQueries({ queryKey: queryKeys.baseLinker.status }),
    qc.invalidateQueries({ queryKey: queryKeys.baseLinker.meta }),
    qc.invalidateQueries({ queryKey: queryKeys.baseLinker.ordersAll }),
  ]);
}

function QueueEditor({ account, disabled, onSave }) {
  const statuses = statusesFrom(account);
  const [form, setForm] = useState(() => ({
    intakeStatusId: String(account?.queue?.intakeStatusId || ''),
    sentStatusId: String(account?.queue?.sentStatusId || ''),
    cancelledStatusId: String(account?.queue?.cancelledStatusId || ''),
  }));
  useEffect(() => {
    setForm({
      intakeStatusId: String(account?.queue?.intakeStatusId || ''),
      sentStatusId: String(account?.queue?.sentStatusId || ''),
      cancelledStatusId: String(account?.queue?.cancelledStatusId || ''),
    });
  }, [account?.queue?.intakeStatusId, account?.queue?.sentStatusId, account?.queue?.cancelledStatusId]);
  const options = statusOptions(statuses);
  const valid = queueIsValid(form, statuses);
  const dirty = form.intakeStatusId !== String(account?.queue?.intakeStatusId || '')
    || form.sentStatusId !== String(account?.queue?.sentStatusId || '')
    || form.cancelledStatusId !== String(account?.queue?.cancelledStatusId || '');

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Settings2 size={16} className="text-slate-400" />
        <h4 className="text-sm font-semibold text-slate-200">Робочі статуси цього акаунта</h4>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <SelectField
          label="Вхідні — готові до пакування"
          value={form.intakeStatusId}
          onValueChange={(value) => setForm((prev) => ({ ...prev, intakeStatusId: value }))}
          options={options}
          placeholder="Оберіть статус"
          disabled={disabled}
        />
        <SelectField
          label="Відправлені"
          value={form.sentStatusId}
          onValueChange={(value) => setForm((prev) => ({ ...prev, sentStatusId: value }))}
          options={options}
          placeholder="Оберіть статус"
          disabled={disabled}
        />
        <SelectField
          label="Анульовані"
          value={form.cancelledStatusId}
          onValueChange={(value) => setForm((prev) => ({ ...prev, cancelledStatusId: value }))}
          options={options}
          placeholder="Оберіть статус"
          disabled={disabled}
        />
      </div>
      {!valid ? <p className="mt-3 text-xs text-amber-300">Потрібні три різні статуси, які реально існують у цьому BaseLinker-акаунті.</p> : null}
      <div className="mt-3 flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !dirty || !valid}
          onClick={() => onSave(form)}
        >
          Зберегти статуси
        </Button>
      </div>
    </div>
  );
}

function AccountCard({ account, apiUsage, busy, onUpdate, onRefresh, onQueueSave, onRotate }) {
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [editForm, setEditForm] = useState({ name: account.name || '', color: account.color || '#22d3ee' });
  const [newToken, setNewToken] = useState('');
  const [confirmSameAccount, setConfirmSameAccount] = useState(false);
  useEffect(() => {
    setEditForm({ name: account.name || '', color: account.color || '#22d3ee' });
  }, [account.name, account.color]);
  const summary = metadataSummary(account.metadataSnapshot);
  const unhealthy = Boolean(account.lastConnectionError || account.lastSyncError);
  const lifecycle = account.lifecycle || {};
  const lifecycleBlockers = Math.max(0, Number(lifecycle.total || 0));
  const hasLifecycleWork = lifecycleBlockers > 0;
  const apiUsed = Number(apiUsage?.count || 0);
  const apiBudget = Number(apiUsage?.budget || 0);
  const apiUsageText = apiBudget > 0 ? `${apiUsed}/${apiBudget}` : '—';

  return (
    <PanelCard className="space-y-4 p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="h-3 w-3 shrink-0 rounded-full border border-white/15"
              style={{ backgroundColor: account.color || '#64748b' }}
              aria-hidden="true"
            />
            <h3 className="truncate text-lg font-semibold text-slate-100">{account.name}</h3>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${account.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/60 text-slate-400'}`}>
              {account.enabled ? 'Активний' : 'Вимкнений'}
            </span>
            {unhealthy ? (
              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-300">Є помилка</span>
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
            <span>API: {account.tokenHint || '—'}</span>
            <span>Запити 60с: <strong className="font-semibold tabular-nums text-slate-300">{apiUsageText}</strong></span>
            <span>UUID: <span className="font-mono text-slate-500">{account.accountId}</span></span>
            <span>Остання sync: {formatDate(account.lastSuccessfulSyncAt)}</span>
            <span>Metadata: {formatDate(account.metadataFetchedAt)}</span>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onRefresh}>
            <RefreshCw className={busy ? 'animate-spin' : ''} /> API-перевірка
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing((value) => !value)}>
            Редагувати
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => setRotating((value) => !value)}>
            <KeyRound /> Замінити ключ
          </Button>
          <Button
            type="button"
            variant={account.enabled ? 'destructive' : 'success'}
            disabled={busy || (account.enabled && hasLifecycleWork)}
            title={account.enabled && hasLifecycleWork ? 'Спочатку потрібно завершити всі замовлення цього BaseLinker-акаунта.' : undefined}
            onClick={() => onUpdate({ enabled: !account.enabled })}
          >
            {account.enabled ? 'Вимкнути' : 'Увімкнути'}
          </Button>
        </div>
      </div>

      {account.enabled && hasLifecycleWork ? (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-3 text-sm text-amber-200">
          Акаунт не можна вимкнути або змінити його виробничі статуси, поки є незавершена робота.
          <span className="ml-1 text-amber-100">
            Вхідні: {Number(lifecycle.intakeOrders || 0)} · workflow: {Number(lifecycle.unfinishedPicking || 0)} · друк: {Number(lifecycle.activePrintJobs || 0)}
          </span>
        </div>
      ) : null}

      {editing ? (
        <>
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
              <div className="text-xs text-slate-500">Статуси</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">{summary.statuses}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
              <div className="text-xs text-slate-500">Магазини / джерела</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">{summary.sources}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
              <div className="text-xs text-slate-500">Каталоги</div>
              <div className="mt-1 text-lg font-semibold text-slate-200">{summary.inventories}</div>
            </div>
          </div>

          {(account.lastConnectionError || account.lastSyncError) ? (
            <div className="rounded-xl border border-rose-900/60 bg-rose-950/20 p-3 text-sm text-rose-300">
              {account.lastConnectionError ? <div>Підключення: {account.lastConnectionError}</div> : null}
              {account.lastSyncError ? <div>Синхронізація: {account.lastSyncError}</div> : null}
            </div>
          ) : null}

          <div className="rounded-2xl border border-slate-800 bg-slate-950/45 p-4">
            <div className="grid gap-3 md:grid-cols-[1fr_180px_auto] md:items-end">
              <Field>
                <FieldLabel htmlFor={`baselinker-${account.accountId}-name`}>Наша назва акаунта</FieldLabel>
                <Input id={`baselinker-${account.accountId}-name`} value={editForm.name} onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))} disabled={busy} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`baselinker-${account.accountId}-color`}>Колір</FieldLabel>
                <Input id={`baselinker-${account.accountId}-color`} type="color" value={editForm.color || '#22d3ee'} onChange={(event) => setEditForm((prev) => ({ ...prev, color: event.target.value }))} className="px-2" disabled={busy} />
              </Field>
              <Button
                type="button"
                disabled={busy || !editForm.name.trim()}
                onClick={() => onUpdate({ name: editForm.name.trim(), color: editForm.color })}
              >
                Зберегти
              </Button>
            </div>
          </div>

          <QueueEditor account={account} disabled={busy || !account.enabled || hasLifecycleWork} onSave={onQueueSave} />
        </>
      ) : null}

      {rotating ? (
        <div className="rounded-2xl border border-amber-800/50 bg-amber-950/15 p-4">
          <div className="flex items-start gap-2 text-amber-200">
            <AlertTriangle className="mt-0.5 shrink-0" size={17} />
            <p className="text-sm leading-6">
              Використовуйте цю операцію тільки для перевипущеного ключа <strong>того самого реального BaseLinker-акаунта</strong>.
              Наш UUID не зміниться. Для іншого акаунта використовуйте «Додати акаунт».
            </p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <Field>
              <FieldLabel htmlFor={`baselinker-${account.accountId}-new-token`}>Новий API-ключ</FieldLabel>
              <Input id={`baselinker-${account.accountId}-new-token`} type="password" autoComplete="off" value={newToken} onChange={(event) => setNewToken(event.target.value)} disabled={busy} />
            </Field>
            <Button
              type="button"
              disabled={busy || !newToken.trim() || !confirmSameAccount}
              onClick={async () => {
                try {
                  await onRotate(newToken.trim(), confirmSameAccount);
                  setNewToken('');
                  setConfirmSameAccount(false);
                  setRotating(false);
                } catch (_) {
                  // The shared mutation error panel owns user-visible failure state.
                }
              }}
            >
              Замінити ключ
            </Button>
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={confirmSameAccount}
              onChange={(event) => setConfirmSameAccount(event.target.checked)}
              disabled={busy}
              className="mt-1"
            />
            <span>Підтверджую, що цей ключ належить тому самому BaseLinker-акаунту.</span>
          </label>
        </div>
      ) : null}
    </PanelCard>
  );
}

export default function BaseLinkerSettingsBlock() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_ADD);
  const [validated, setValidated] = useState(null);

  const settings = useQuery({
    queryKey: queryKeys.settings.baseLinker,
    queryFn: ({ signal }) => getBaseLinkerSettings({ signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const apiUsage = useQuery({
    queryKey: queryKeys.baseLinker.apiUsage,
    queryFn: ({ signal }) => getBaseLinkerApiUsage({ signal }),
    staleTime: 3_000,
    refetchInterval: 5_000,
    refetchOnWindowFocus: false,
  });

  const validateMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerToken,
    mutationFn: (token) => validateBaseLinkerToken(token),
    onSuccess: (data) => {
      setValidated(data);
      setAddForm((prev) => ({ ...prev, intakeStatusId: '', sentStatusId: '', cancelledStatusId: '' }));
      toast.success('BaseLinker API-ключ перевірено');
    },
  });

  const createMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerAccount,
    mutationFn: createBaseLinkerAccount,
    onSuccess: async () => {
      setAddForm(EMPTY_ADD);
      setValidated(null);
      setShowAdd(false);
      await invalidateBaseLinker(qc);
      toast.success('BaseLinker-акаунт додано');
    },
  });

  const updateMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerAccount,
    mutationFn: ({ accountId, patch }) => updateBaseLinkerAccount(accountId, patch),
    onSuccess: async () => {
      await invalidateBaseLinker(qc);
      toast.success('Акаунт оновлено');
    },
  });

  const refreshMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerAccount,
    mutationFn: refreshBaseLinkerAccount,
    onSuccess: async () => {
      await invalidateBaseLinker(qc);
      toast.success('Metadata BaseLinker оновлено');
    },
  });

  const queueMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerQueue,
    mutationFn: ({ accountId, queue }) => saveBaseLinkerAccountQueue(accountId, {
      intakeStatusId: Number(queue.intakeStatusId),
      sentStatusId: Number(queue.sentStatusId),
      cancelledStatusId: Number(queue.cancelledStatusId),
    }),
    onSuccess: async () => {
      await invalidateBaseLinker(qc);
      toast.success('Робочі статуси збережено');
    },
  });

  const rotateMutation = useMutation({
    mutationKey: mutationKeys.settings.baseLinkerToken,
    mutationFn: ({ accountId, token, confirmSameAccount }) => rotateBaseLinkerAccountToken(accountId, token, { confirmSameAccount }),
    onSuccess: async () => {
      await invalidateBaseLinker(qc);
      toast.success('API-ключ замінено без зміни UUID акаунта');
    },
  });

  const accounts = settings.data?.accounts || [];
  const validationStatuses = Array.isArray(validated?.metadata?.statuses) ? validated.metadata.statuses : [];
  const validationSummary = validated?.summary || null;
  const addQueueValid = queueIsValid(addForm, validationStatuses);
  const anyMutationPending = validateMutation.isPending || createMutation.isPending || updateMutation.isPending
    || refreshMutation.isPending || queueMutation.isPending || rotateMutation.isPending;
  const mutationError = validateMutation.error || createMutation.error || updateMutation.error || refreshMutation.error || queueMutation.error || rotateMutation.error;

  const connectedSummary = useMemo(() => ({
    total: accounts.length,
    active: accounts.filter((account) => account.enabled).length,
  }), [accounts]);
  const apiUsageByAccount = useMemo(() => new Map(
    (Array.isArray(apiUsage.data?.accounts) ? apiUsage.data.accounts : [])
      .map((row) => [String(row.baseLinkerAccountId || ''), row]),
  ), [apiUsage.data?.accounts]);

  return (
    <div className="space-y-5">
      <PanelCard className="p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="text-cyan-400" size={22} />
              <h2 className="text-2xl font-semibold">BaseLinker-акаунти</h2>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
              Кожен API-ключ — окреме наше підключення з власним UUID, статусами, магазинами, каталогами та синхронізацією.
              Назви й BaseLinker ID не використовуються як глобальна identity.
            </p>
            <p className="mt-2 text-xs text-slate-500">Підключено: {connectedSummary.total} · активних: {connectedSummary.active}</p>
          </div>
          <Button type="button" onClick={() => setShowAdd((value) => !value)} disabled={!settings.data?.tokenEncryptionConfigured || anyMutationPending}>
            <Plus /> Додати акаунт
          </Button>
        </div>

        {settings.data?.tokenEncryptionConfigured === false ? (
          <div className="mt-4 rounded-xl border border-amber-800/60 bg-amber-950/20 p-4 text-sm text-amber-200">
            На backend не задано <span className="font-mono">BASELINKER_TOKEN_ENCRYPTION_KEY</span>. Без нього система навмисно не приймає API-ключі.
          </div>
        ) : null}

        {showAdd ? (
          <div className="mt-5 rounded-2xl border border-cyan-900/50 bg-cyan-950/10 p-5">
            <h3 className="text-lg font-semibold text-slate-100">Нове підключення</h3>
            <p className="mt-1 text-sm text-slate-400">
              Якщо це лише перевипущений ключ існуючого акаунта — не створюйте нове підключення, використайте «Замінити ключ» на його картці.
            </p>

            <FieldGroup className="mt-4">
              <div className="grid gap-3 md:grid-cols-[1fr_180px]">
                <Field>
                  <FieldLabel htmlFor="baselinker-new-account-name">Наша назва</FieldLabel>
                  <Input
                    id="baselinker-new-account-name"
                    value={addForm.name}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, name: event.target.value }))}
                    placeholder="Напр. BL Allegro PL"
                    disabled={anyMutationPending}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="baselinker-new-account-color">Колір</FieldLabel>
                  <Input
                    id="baselinker-new-account-color"
                    type="color"
                    value={addForm.color}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, color: event.target.value }))}
                    className="px-2"
                    disabled={anyMutationPending}
                  />
                </Field>
              </div>

              <Field>
                <FieldLabel htmlFor="baselinker-new-account-token">BaseLinker API-ключ</FieldLabel>
                <div className="flex flex-col gap-2 md:flex-row">
                  <Input
                    id="baselinker-new-account-token"
                    type="password"
                    autoComplete="off"
                    value={addForm.token}
                    onChange={(event) => {
                      setAddForm((prev) => ({ ...prev, token: event.target.value }));
                      setValidated(null);
                    }}
                    placeholder="Ключ не буде повернутий назад у браузер після збереження"
                    disabled={anyMutationPending}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={anyMutationPending || !addForm.token.trim()}
                    onClick={() => validateMutation.mutate(addForm.token.trim())}
                  >
                    <RefreshCw className={validateMutation.isPending ? 'animate-spin' : ''} /> Перевірити API
                  </Button>
                </div>
                <FieldDescription>Перевірка читає getOrderStatusList, getOrderSources і getInventories через офіційний BaseLinker API.</FieldDescription>
              </Field>
            </FieldGroup>

            {validationSummary ? (
              <div className="mt-4 rounded-xl border border-emerald-800/50 bg-emerald-950/20 p-4">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 size={18} />
                  <strong>Підключення успішне</strong>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-300">
                  <span>Статусів: {validationSummary.statusCount || 0}</span>
                  <span>Джерел: {validationSummary.sources?.total || 0}</span>
                  <span>Каталогів: {validationSummary.inventoryCount || 0}</span>
                </div>
              </div>
            ) : null}

            {validated ? (
              <div className="mt-4 grid gap-3 lg:grid-cols-3">
                <SelectField
                  label="Вхідні — готові до пакування"
                  value={addForm.intakeStatusId}
                  onValueChange={(value) => setAddForm((prev) => ({ ...prev, intakeStatusId: value }))}
                  options={statusOptions(validationStatuses)}
                  placeholder="Оберіть статус"
                  disabled={anyMutationPending}
                />
                <SelectField
                  label="Відправлені"
                  value={addForm.sentStatusId}
                  onValueChange={(value) => setAddForm((prev) => ({ ...prev, sentStatusId: value }))}
                  options={statusOptions(validationStatuses)}
                  placeholder="Оберіть статус"
                  disabled={anyMutationPending}
                />
                <SelectField
                  label="Анульовані"
                  value={addForm.cancelledStatusId}
                  onValueChange={(value) => setAddForm((prev) => ({ ...prev, cancelledStatusId: value }))}
                  options={statusOptions(validationStatuses)}
                  placeholder="Оберіть статус"
                  disabled={anyMutationPending}
                />
              </div>
            ) : null}

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => { setShowAdd(false); setValidated(null); setAddForm(EMPTY_ADD); }} disabled={anyMutationPending}>
                Скасувати
              </Button>
              <Button
                type="button"
                disabled={anyMutationPending || !validated || !addForm.name.trim() || !addQueueValid}
                onClick={() => createMutation.mutate({
                  name: addForm.name.trim(),
                  color: addForm.color,
                  token: addForm.token.trim(),
                  intakeStatusId: Number(addForm.intakeStatusId),
                  sentStatusId: Number(addForm.sentStatusId),
                  cancelledStatusId: Number(addForm.cancelledStatusId),
                })}
              >
                Створити акаунт
              </Button>
            </div>
          </div>
        ) : null}
      </PanelCard>

      {settings.isPending ? <PanelCard className="p-5 text-sm text-slate-400">Завантаження BaseLinker-акаунтів…</PanelCard> : null}
      {settings.isError ? (
        <PanelCard className="p-5">
          <p role="alert" className="text-sm text-rose-300">{settings.error.message}</p>
          <Button className="mt-3" variant="outline" onClick={() => settings.refetch()} disabled={settings.isFetching}>Повторити</Button>
        </PanelCard>
      ) : null}

      {!settings.isPending && !settings.isError && accounts.length === 0 ? (
        <PanelCard className="p-6 text-center text-sm text-slate-400">
          BaseLinker-акаунтів ще немає. Додайте перше підключення.
        </PanelCard>
      ) : null}

      {accounts.map((account) => (
        <AccountCard
          key={account.accountId}
          account={account}
          apiUsage={apiUsageByAccount.get(String(account.accountId || ''))}
          busy={anyMutationPending}
          onUpdate={(patch) => updateMutation.mutate({ accountId: account.accountId, patch })}
          onRefresh={() => refreshMutation.mutate(account.accountId)}
          onQueueSave={(queue) => queueMutation.mutate({ accountId: account.accountId, queue })}
          onRotate={(token, confirmSameAccount) => new Promise((resolve, reject) => {
            rotateMutation.mutate({ accountId: account.accountId, token, confirmSameAccount }, { onSuccess: resolve, onError: reject });
          })}
        />
      ))}

      {mutationError ? (
        <PanelCard className="border-rose-900/60 p-4">
          <p role="alert" className="text-sm text-rose-300">{mutationError.message}</p>
        </PanelCard>
      ) : null}
    </div>
  );
}

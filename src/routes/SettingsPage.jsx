import React, { useEffect, useState } from 'react';
import {
  getDeliveryGroups,
  createDeliveryGroup,
  updateDeliveryGroup,
  deleteDeliveryGroup,
  getUsers,
  runLoadTest,
  downloadLoadTestReport,
} from '../api.js';
import Modal from '../components/Modal.jsx';
import { useConfirm } from '../components/ConfirmModal.jsx';
import toast from 'react-hot-toast';

import { DAY_NAMES } from '../utils/dayNames.js';

export default function SettingsPage() {
  const [groups, setGroups] = useState([]);
  const [sellers, setSellers] = useState([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editGroup, setEditGroup] = useState(null);
  const [form, setForm] = useState({ name: '', dayOfWeek: 1, members: [] });
  const [saving, setSaving] = useState(false);
  const [loadTestRunning, setLoadTestRunning] = useState(false);
  const [loadTestStatus, setLoadTestStatus] = useState('idle');
  const [loadTestError, setLoadTestError] = useState('');
  const [downloadLoading, setDownloadLoading] = useState(false);
  const confirm = useConfirm();

  const fetchGroups = () => {
    setLoadingGroups(true);
    getDeliveryGroups()
      .then(setGroups)
      .catch((err) => toast.error(err.message))
      .finally(() => setLoadingGroups(false));
  };

  const fetchSellers = () => {
    getUsers()
      .then((users) => setSellers(users.filter((u) => u.role === 'seller')))
      .catch(() => {});
  };

  useEffect(() => {
    fetchGroups();
    fetchSellers();
  }, []);

  const openCreate = () => {
    setEditGroup(null);
    setForm({ name: '', dayOfWeek: 1, members: [] });
    setModalOpen(true);
  };

  const openEdit = (group) => {
    setEditGroup(group);
    setForm({ name: group.name, dayOfWeek: group.dayOfWeek, members: group.members || [] });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editGroup) {
        await updateDeliveryGroup(editGroup._id, form);
        toast.success('Групу оновлено');
      } else {
        await createDeliveryGroup(form);
        toast.success('Групу створено');
      }
      setModalOpen(false);
      fetchGroups();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!(await confirm('Видалити цю групу доставки?'))) return;
    try {
      await deleteDeliveryGroup(id);
      toast.success('Групу видалено');
      fetchGroups();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleRunLoadTest = async () => {
    setLoadTestRunning(true);
    setLoadTestStatus('running');
    setLoadTestError('');
    try {
      await runLoadTest();
      setLoadTestStatus('done');
      toast.success('Load test завершено успішно');
    } catch (err) {
      setLoadTestStatus('error');
      setLoadTestError(err.message);
      toast.error(`Помилка load-test: ${err.message}`);
    } finally {
      setLoadTestRunning(false);
    }
  };

  const handleDownloadReport = async () => {
    setDownloadLoading(true);
    try {
      const blob = await downloadLoadTestReport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'load-test-report.html';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success('Звіт завантажено');
    } catch (err) {
      toast.error(`Не вдалося завантажити звіт: ${err.message}`);
    } finally {
      setDownloadLoading(false);
    }
  };

  const toggleMember = (telegramId) => {
    setForm((prev) => ({
      ...prev,
      members: prev.members.includes(telegramId)
        ? prev.members.filter((m) => m !== telegramId)
        : [...prev.members, telegramId],
    }));
  };

  const assignedIds = groups.flatMap((g) => (editGroup && g._id === editGroup._id ? [] : g.members || []));

  const inputClass =
    'w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-white placeholder-slate-500 outline-none transition focus:border-cyan-400';

  return (
    <div className="space-y-8">
      {/* Delivery groups */}
      <div className="space-y-6 rounded-[1.5rem] border border-slate-700 bg-slate-950/90 p-6 shadow-lg shadow-slate-950/20">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-cyan-300">Доставка</p>
            <h2 className="text-3xl font-semibold text-white">Групи доставки</h2>
            <p className="mt-2 text-slate-400">Розклад доставок по магазинах. Кожна група — окремий день тижня.</p>
          </div>
          <button
            onClick={openCreate}
            className="rounded-3xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-500"
          >
            + Додати групу
          </button>
        </div>

        {loadingGroups ? (
          <p className="text-slate-400">Завантаження...</p>
        ) : groups.length === 0 ? (
          <p className="text-slate-400">Груп доставки ще немає.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {groups.map((group) => (
              <div key={group._id} className="rounded-3xl border border-slate-700 bg-slate-900 p-5">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-lg font-semibold text-white">{group.name}</h3>
                  <span className="rounded-full bg-cyan-900/50 px-3 py-1 text-sm text-cyan-300">
                    {DAY_NAMES[group.dayOfWeek]}
                  </span>
                </div>
                <p className="mt-3 text-sm text-slate-400">
                  Учасників: {group.members?.length || 0}
                </p>
                {group.members?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {group.members.map((tid) => {
                      const seller = sellers.find((s) => s.telegramId === tid);
                      return (
                        <span key={tid} className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-300">
                          {seller ? [seller.firstName, seller.lastName].filter(Boolean).join(' ') || tid : tid}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => openEdit(group)}
                    className="rounded-2xl border border-slate-600 px-4 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
                  >
                    Редагувати
                  </button>
                  <button
                    onClick={() => handleDelete(group._id)}
                    className="rounded-2xl border border-rose-800 px-4 py-1.5 text-sm text-rose-400 transition hover:bg-rose-900/30"
                  >
                    Видалити
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-6 rounded-[1.5rem] border border-slate-700 bg-slate-950/90 p-6 shadow-lg shadow-slate-950/20">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-emerald-300">Тестування</p>
            <h2 className="text-3xl font-semibold text-white">Load test</h2>
            <p className="mt-2 text-slate-400">Запустіть тестування продуктивності на Render і згенеруйте HTML-звіт.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleRunLoadTest}
              disabled={loadTestRunning}
              className="rounded-3xl border border-emerald-500 bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {loadTestRunning ? 'Запуск...' : 'Запустити тест'}
            </button>
            <button
              type="button"
              onClick={handleDownloadReport}
              disabled={downloadLoading}
              className="rounded-3xl border border-slate-600 bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:border-cyan-500 hover:bg-slate-800 disabled:opacity-50"
            >
              {downloadLoading ? 'Завантаження...' : 'Завантажити звіт'}
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-3xl border border-slate-700 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Статус</p>
            <p className="mt-2 text-lg font-semibold text-white">
              {loadTestStatus === 'running'
                ? 'Виконується'
                : loadTestStatus === 'done'
                ? 'Готово'
                : loadTestStatus === 'error'
                ? 'Помилка'
                : 'Очікування'}
            </p>
          </div>
          <div className="rounded-3xl border border-slate-700 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Остання помилка</p>
            <p className="mt-2 text-sm text-rose-400">{loadTestError || 'немає'}</p>
          </div>
        </div>
      </div>

      {/* Modal for create / edit */}
      <Modal open={modalOpen} title={editGroup ? 'Редагувати групу' : 'Нова група доставки'} onClose={() => setModalOpen(false)}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm text-slate-400">Назва групи *</label>
            <input
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              required
              placeholder="Доставка Група 1"
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">День доставки *</label>
            <select
              value={form.dayOfWeek}
              onChange={(e) => setForm((p) => ({ ...p, dayOfWeek: Number(e.target.value) }))}
              className={inputClass}
            >
              {DAY_NAMES.map((day, i) => (
                <option key={i} value={i}>{day}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">Продавці в групі</label>
            {sellers.length === 0 ? (
              <p className="text-sm text-slate-500">Немає продавців для додавання</p>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-3">
                {sellers.map((seller) => {
                  const checked = form.members.includes(seller.telegramId);
                  const busy = assignedIds.includes(seller.telegramId);
                  return (
                    <label
                      key={seller.telegramId}
                      className={`flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition ${
                        checked ? 'bg-cyan-900/30' : 'hover:bg-slate-800'
                      } ${busy && !checked ? 'opacity-40' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy && !checked}
                        onChange={() => toggleMember(seller.telegramId)}
                        className="accent-cyan-500"
                      />
                      <span className="text-sm text-white">
                        {[seller.firstName, seller.lastName].filter(Boolean).join(' ') || seller.telegramId}
                      </span>
                      {seller.shopName && (
                        <span className="text-xs text-slate-500">({seller.shopName})</span>
                      )}
                      {busy && !checked && (
                        <span className="ml-auto text-xs text-slate-500">вже в іншій групі</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={saving || !form.name}
              className="rounded-3xl bg-cyan-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:opacity-50"
            >
              {saving ? 'Збереження...' : editGroup ? 'Зберегти зміни' : 'Створити групу'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

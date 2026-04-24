import { useEffect, useMemo, useState } from 'react';
import { getUsers, createUser, deleteUser, getDeliveryGroups, getRegistrationRequests, approveRegistrationRequest, rejectRegistrationRequest, getOrders, resolveImageUrl } from '../api.js';
import Modal from '../components/Modal.jsx';
import { useConfirm } from '../components/ConfirmModal.jsx';
import { DAY_SHORT } from '../utils/dayNames.js';

const emptyForm = {
  telegramId: '',
  role: 'seller',
  firstName: '',
  lastName: '',
  phoneNumber: '',
  shopNumber: '',
  shopName: '',
  shopAddress: '',
  shopCity: '',
  warehouseZone: '',
};

export default function UsersPage() {
  const [users, setUsers] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [requestError, setRequestError] = useState(null);
  const [processingRequestId, setProcessingRequestId] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deliveryGroups, setDeliveryGroups] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyUser, setHistoryUser] = useState(null);
  const [historyOrders, setHistoryOrders] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedDay, setExpandedDay] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [roleFilter, setRoleFilter] = useState('all');
  const [deliveryGroupFilter, setDeliveryGroupFilter] = useState('all');
  const confirm = useConfirm();

  const fetchUsers = () => {
    setLoading(true);
    getUsers()
      .then((data) => setUsers(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const fetchRequests = () => {
    setRequestsLoading(true);
    getRegistrationRequests()
      .then((data) => setRequests(data))
      .catch((err) => setRequestError(err.message))
      .finally(() => setRequestsLoading(false));
  };

  useEffect(() => {
    fetchUsers();
    fetchRequests();
    getDeliveryGroups().then(setDeliveryGroups).catch(() => {});
  }, []);

  const handleChange = (e) => {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const deliveryGroupsByName = deliveryGroups.reduce((acc, group) => {
    if (group?.name) acc[group.name] = group;
    return acc;
  }, {});

  const filteredUsers = users.filter((user) => {
    if (roleFilter !== 'all') {
      const role = user.role === 'seller' ? 'seller' : user.role;
      if (roleFilter !== role) return false;
    }

    if (roleFilter === 'seller' && deliveryGroupFilter !== 'all') {
      const groupName = user.warehouseZone || '';
      if (groupName !== deliveryGroupFilter) return false;
    }

    return true;
  });

  const openCreate = () => {
    setEditUser(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (user) => {
    setEditUser(user);
    setForm({
      telegramId: user.telegramId,
      role: user.role || 'seller',
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      phoneNumber: user.phoneNumber || '',
      shopNumber: user.shopNumber || '',
      shopName: user.shopName || '',
      shopAddress: user.shopAddress || '',
      shopCity: user.shopCity || '',
      warehouseZone: user.warehouseZone || '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await createUser(form);
      setForm(emptyForm);
      setModalOpen(false);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (telegramId) => {
    if (!(await confirm('Ви впевнені що хочете видалити цього користувача?'))) return;
    try {
      await deleteUser(telegramId);
      fetchUsers();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleApproveRequest = async (id) => {
    setProcessingRequestId(id);
    try {
      await approveRegistrationRequest(id);
      fetchRequests();
      fetchUsers();
    } catch (err) {
      setRequestError(err.message);
    } finally {
      setProcessingRequestId(null);
    }
  };

  const handleRejectRequest = async (id) => {
    if (!(await confirm('Ви впевнені що хочете відхилити цю заявку?'))) return;
    setProcessingRequestId(id);
    try {
      await rejectRegistrationRequest(id);
      fetchRequests();
    } catch (err) {
      setRequestError(err.message);
    } finally {
      setProcessingRequestId(null);
    }
  };

  const STATUS_LABELS = {
    new: 'Нове',
    confirmed: 'Підтверджено',
    fulfilled: 'Виконано',
    cancelled: 'Скасовано',
  };

  const openHistory = async (user) => {
    setHistoryUser(user);
    setHistoryOpen(true);
    setHistoryError(null);
    setHistoryOrders([]);
    setHistoryPage(1);
    setExpandedDay(null);
    setHistoryLoading(true);

    try {
      const result = await getOrders({ page: 1, pageSize: 200, buyerTelegramId: user.telegramId, status: 'all' });
      setHistoryOrders(result.orders || []);
    } catch (err) {
      setHistoryError(err.message);
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleExpandedDay = (day) => {
    setExpandedDay((prev) => (prev === day ? null : day));
  };

  const formatOrderTime = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString('uk-UA', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const HISTORY_GROUPS_PER_PAGE = 5;

  const historyGroups = useMemo(() => {
    const groups = {};
    (historyOrders || []).forEach((order) => {
      const day = new Date(order.createdAt).toLocaleDateString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      });
      if (!groups[day]) groups[day] = [];
      groups[day].push(order);
    });
    return Object.entries(groups).sort(([, aOrders], [, bOrders]) => new Date(bOrders[0].createdAt) - new Date(aOrders[0].createdAt));
  }, [historyOrders]);

  const historyPageCount = Math.max(1, Math.ceil(historyGroups.length / HISTORY_GROUPS_PER_PAGE));
  const pagedHistoryGroups = useMemo(
    () => historyGroups.slice((historyPage - 1) * HISTORY_GROUPS_PER_PAGE, historyPage * HISTORY_GROUPS_PER_PAGE),
    [historyGroups, historyPage]
  );

  useEffect(() => {
    setExpandedDay(null);
  }, [historyPage]);

  const inputClass =
    'w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-white placeholder-slate-500 outline-none transition focus:border-emerald-400';

  const roleLabel = (role) => {
    if (role === 'admin') return 'Адмін';
    if (role === 'warehouse') return 'Склад';
    return 'Продавець';
  };

  const dayName = (day) => DAY_SHORT[day] || 'невідомо';

  return (
    <div className="space-y-6 rounded-[1.5rem] border border-slate-700 bg-slate-950/90 p-6 shadow-lg shadow-slate-950/20">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-emerald-300">Користувачі</p>
          <h2 className="text-3xl font-semibold text-white">Список користувачів</h2>
          <p className="mt-2 text-slate-400">Перелік користувачів з Telegram ID та ролями.</p>
        </div>
        <button
          onClick={openCreate}
          className="rounded-3xl border border-emerald-500 bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500"
        >
          + Додати користувача
        </button>
      </div>

      <div className="rounded-3xl border border-slate-700 bg-slate-900/80 p-5">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[240px_1fr] xl:grid-cols-[320px_1fr] items-end">
          <div>
            <label className="mb-1 block text-sm text-slate-400">Роль</label>
            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              className={inputClass}
            >
              <option value="all">Усі</option>
              <option value="admin">Адміни</option>
              <option value="warehouse">Склад</option>
              <option value="seller">Продавець</option>
            </select>
          </div>

          {roleFilter === 'seller' && (
            <div>
              <label className="mb-1 block text-sm text-slate-400">Група доставки</label>
              <select
                value={deliveryGroupFilter}
                onChange={(e) => setDeliveryGroupFilter(e.target.value)}
                className={inputClass}
              >
                <option value="all">Усі групи</option>
                {deliveryGroups.map((group) => (
                  <option key={group._id} value={group.name}>{group.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-3xl border border-slate-700 bg-slate-900/80 p-5">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.35em] text-cyan-300">Заявки на реєстрацію</p>
            <h3 className="text-xl font-semibold text-white">Нові заявки</h3>
          </div>
          {requestError && <p className="text-sm text-rose-400">Помилка: {requestError}</p>}
        </div>
        {requestsLoading ? (
          <p>Завантаження заявок...</p>
        ) : requests.length === 0 ? (
          <p className="text-slate-400">Немає нових заявок.</p>
        ) : (
          <div className="space-y-4">
            {requests.map((request) => (
              <div key={request._id} className="rounded-3xl border border-slate-700 bg-slate-950 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-sm text-slate-400">Telegram ID: {request.telegramId}</p>
                    <p className="mt-1 text-lg font-semibold text-white">{[request.firstName, request.lastName].filter(Boolean).join(' ') || 'Без імені'}</p>
                    <p className="text-sm">
                      <span className="inline-flex rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-white">
                        {request.role === 'warehouse' ? 'СКЛАД' : 'ПРОДАВЕЦЬ'}
                      </span>
                    </p>
                    <p className="text-sm text-slate-400">Місто: {request.shopCity}</p>
                    <p className="text-sm text-slate-400">Магазин: {request.shopName}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-3 sm:pt-0">
                    <button
                      type="button"
                      onClick={() => handleApproveRequest(request._id)}
                      disabled={processingRequestId === request._id}
                      className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {processingRequestId === request._id ? 'Обробка...' : 'Підтвердити'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRejectRequest(request._id)}
                      disabled={processingRequestId === request._id}
                      className="rounded-2xl border border-rose-600 bg-rose-600/10 px-4 py-2 text-sm font-medium text-rose-200 transition hover:bg-rose-600/20 disabled:opacity-50"
                    >
                      {processingRequestId === request._id ? 'Обробка...' : 'Відхилити'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} title={editUser ? 'Редагувати користувача' : 'Новий користувач'} onClose={() => setModalOpen(false)}>
        <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm text-slate-400">Telegram ID *</label>
            <input name="telegramId" value={form.telegramId} onChange={handleChange} required disabled={!!editUser} placeholder="123456789" className={`${inputClass} ${editUser ? 'opacity-50' : ''}`} />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">Ім'я</label>
            <input name="firstName" value={form.firstName} onChange={handleChange} placeholder="Іван" className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Прізвище</label>
            <input name="lastName" value={form.lastName} onChange={handleChange} placeholder="Петренко" className={inputClass} />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">Телефон</label>
            <input name="phoneNumber" value={form.phoneNumber} onChange={handleChange} placeholder="+380..." className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Роль</label>
            <select name="role" value={form.role} onChange={handleChange} className={inputClass}>
              <option value="seller">Продавець</option>
              <option value="warehouse">Склад</option>
              <option value="admin">Адмін</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">Номер магазину</label>
            <input name="shopNumber" value={form.shopNumber} onChange={handleChange} placeholder="12" className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Назва магазину</label>
            <input name="shopName" value={form.shopName} onChange={handleChange} placeholder="Магазин" className={inputClass} />
          </div>

          <div>
            <label className="mb-1 block text-sm text-slate-400">Адреса магазину</label>
            <input name="shopAddress" value={form.shopAddress} onChange={handleChange} placeholder="вул. Центральна, 1" className={inputClass} />
          </div>
          <div>
            <label className="mb-1 block text-sm text-slate-400">Місто</label>
            <input name="shopCity" value={form.shopCity} onChange={handleChange} placeholder="Київ" className={inputClass} />
          </div>

          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm text-slate-400">Група доставки</label>
            <select name="warehouseZone" value={form.warehouseZone} onChange={handleChange} className={inputClass}>
              <option value="">— Не обрано —</option>
              {deliveryGroups.map((g) => (
                <option key={g._id} value={g.name}>{g.name}</option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-2 flex justify-end pt-2">
            <button
              type="submit"
              disabled={saving || !form.telegramId}
              className="rounded-3xl bg-emerald-600 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {saving ? 'Збереження...' : editUser ? 'Зберегти зміни' : 'Створити користувача'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={historyOpen}
        title={historyUser ? `Історія замовлень ${[historyUser.firstName, historyUser.lastName].filter(Boolean).join(' ') || historyUser.shopName || historyUser.telegramId}` : 'Історія замовлень'}
        onClose={() => {
          setHistoryOpen(false);
          setHistoryUser(null);
          setHistoryOrders([]);
          setHistoryError(null);
        }}
      >
        <div className="space-y-4">
          {historyLoading ? (
            <p className="text-slate-400">Завантаження історії...</p>
          ) : historyError ? (
            <p className="text-rose-400">Помилка: {historyError}</p>
          ) : historyOrders.length === 0 ? (
            <p className="text-slate-400">Замовлень не знайдено.</p>
          ) : (
            <div className="space-y-6">
              {pagedHistoryGroups.map(([day, orders]) => (
                <div key={day} className="space-y-4">
                  <div className="flex flex-col gap-3 rounded-3xl border border-slate-700 bg-slate-900 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm uppercase tracking-[0.35em] text-cyan-300">{day}</p>
                      <p className="mt-1 text-sm text-slate-400">{orders.length} замовлень</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleExpandedDay(day)}
                      className="rounded-2xl border border-cyan-600 bg-cyan-600/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-600/20"
                    >
                      {expandedDay === day ? 'Сховати' : 'Детальніше'}
                    </button>
                  </div>

                  {expandedDay === day && (
                    <div className="space-y-4">
                      {orders.map((order) => (
                        <div key={order._id} className="rounded-3xl border border-slate-700 bg-slate-950 p-4">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">{STATUS_LABELS[order.status] || order.status}</p>
                              <h3 className="text-lg font-semibold text-white">Замовлення #{order._id.slice(-6)}</h3>
                              <p className="text-sm text-slate-400">{formatOrderTime(order.createdAt)} • {order.items.reduce((sum, item) => sum + (item.quantity || 0), 0)} шт</p>
                            </div>
                          </div>
                          <div className="mt-4 space-y-3">
                            {order.items.map((item, index) => {
                              const product = item.productId;
                              const imageUrl = resolveImageUrl(product?.imageUrls?.[0] || '');
                              return (
                                <div key={index} className="flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-3">
                                  <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-slate-950">
                                    {imageUrl ? (
                                      <img src={imageUrl} alt={product?.name || item.name || 'Товар'} className="h-full w-full object-cover" />
                                    ) : (
                                      <span className="text-xs text-slate-500">Немає фото</span>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-semibold text-white">{product?.name || item.name || 'Товар'}</p>
                                    <p className="text-xs text-slate-400">Кількість: {item.quantity}</p>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {historyPageCount > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-slate-700 bg-slate-900 p-4">
                  <button
                    type="button"
                    onClick={() => setHistoryPage((prev) => Math.max(1, prev - 1))}
                    disabled={historyPage === 1}
                    className="rounded-2xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-900 disabled:opacity-50"
                  >
                    Попередня
                  </button>
                  <p className="text-sm text-slate-400">Сторінка {historyPage} з {historyPageCount}</p>
                  <button
                    type="button"
                    onClick={() => setHistoryPage((prev) => Math.min(historyPageCount, prev + 1))}
                    disabled={historyPage === historyPageCount}
                    className="rounded-2xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-200 transition hover:bg-slate-900 disabled:opacity-50"
                  >
                    Наступна
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      {loading ? (
        <p>Завантаження користувачів...</p>
      ) : error ? (
        <p className="text-rose-400">Помилка: {error}</p>
      ) : users.length === 0 ? (
        <p>Користувачів поки що немає.</p>
      ) : filteredUsers.length === 0 ? (
        <p>Немає користувачів за поточними фільтрами.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredUsers.map((user) => (
            <div key={user._id} className="min-w-0 rounded-3xl border border-slate-700 bg-slate-900 p-4 break-words">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <h3 className="min-w-0 text-lg font-semibold text-white">
                  {[user.firstName, user.lastName].filter(Boolean).join(' ') || 'Без імені'}
                </h3>
                <span className="rounded-full bg-slate-800 px-3 py-1 text-sm text-slate-300">{roleLabel(user.role)}</span>
              </div>
              <p className="mt-3 text-slate-300">Telegram ID: {user.telegramId}</p>
              <p className="mt-2 text-slate-400">Телефон: {user.phoneNumber || '---'}</p>
              <p className="mt-2 text-slate-400">
                Доступ до бота:{' '}
                <span className={user.botBlocked ? 'text-rose-300' : 'text-emerald-300'}>
                  {user.botBlocked ? 'Заблоковано' : 'Доступний'}
                </span>
              </p>
              <p className="mt-2 text-slate-400">Остання активність в боті: {user.botLastActivityAt ? new Date(user.botLastActivityAt).toLocaleString('uk-UA') : 'нема'}</p>
              <p className="mt-2 text-slate-400">Останній сеанс бота: {user.botLastSessionAt ? new Date(user.botLastSessionAt).toLocaleString('uk-UA') : 'нема'}</p>
              {user.role === 'seller' && deliveryGroupsByName[user.warehouseZone] && (
                <p className="mt-2 text-slate-400">День доставки: {dayName(deliveryGroupsByName[user.warehouseZone].dayOfWeek)}</p>
              )}
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <button
                  onClick={() => openEdit(user)}
                  className="rounded-2xl border border-slate-600 px-4 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
                >
                  Редагувати
                </button>
                {user.role === 'seller' && (
                  <button
                    onClick={() => openHistory(user)}
                    className="rounded-2xl border border-cyan-600 px-4 py-1.5 text-sm text-cyan-200 transition hover:bg-cyan-600/20"
                  >
                    Історія замовлень
                  </button>
                )}
                <button
                  onClick={() => handleDelete(user.telegramId)}
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
  );
}

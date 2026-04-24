import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getOrder, resolveImageUrl } from '../api.js';

export default function OrderSummaryPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getOrder(id)
      .then((data) => setOrder(data))
      .catch((err) => setError(err?.message || 'Не вдалося завантажити замовлення'))
      .finally(() => setLoading(false));
  }, [id]);

  const formatDate = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleDateString('uk-UA');
  };

  const formatTime = (value) => {
    if (!value) return '';
    return new Date(value).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  };

  const getImage = (item) => {
    const product = item.productId;
    return product?.imageUrls?.[0] || product?.image_url || '';
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
          <div className="rounded-3xl border border-slate-700 bg-slate-900/90 p-10 text-center text-slate-200">Завантаження замовлення...</div>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10">
          <div className="rounded-3xl border border-slate-700 bg-slate-900/90 p-10 text-center text-slate-200">
            <h2 className="text-2xl font-semibold text-white">Не вдалося відкрити замовлення</h2>
            <p className="mt-3 text-slate-400">{error || 'Замовлення не знайдено.'}</p>
            <Link to="/mini-app" className="mt-6 inline-block rounded-3xl border border-slate-700 bg-slate-950 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:border-cyan-500 hover:text-white">
              Повернутися до мініапу
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="rounded-3xl border border-slate-700 bg-slate-900/90 p-6 shadow-xl shadow-slate-950/20">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold text-white">Підсумок замовлення</h1>
              <p className="mt-2 text-sm text-slate-400">Замовлення #{order._id}</p>
            </div>
            <div className="space-y-2 text-right text-slate-400 sm:space-y-0 sm:text-left">
              <div>Дата: {formatDate(order.createdAt)}</div>
              <div>Статус: {order.status || 'new'}</div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-3xl border border-slate-700 bg-slate-950/80 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">Товари</h2>
              <div className="space-y-3">
                {order.items.map((item) => (
                  <div key={item._id || `${item.productId?._id}-${item.name}`} className="rounded-3xl border border-slate-800 bg-slate-900/80 p-3">
                    <div className="flex items-center gap-3">
                      <div className="h-16 w-16 overflow-hidden rounded-2xl bg-slate-950">
                        {getImage(item)
                          ? <img src={resolveImageUrl(getImage(item))} alt={item.name || 'NoName'} className="h-full w-full object-cover" />
                          : <div className="flex h-full items-center justify-center text-[10px] text-slate-500">Фото</div>}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-white">{item.name || 'NoName'}</div>
                        <div className="mt-1 text-sm text-slate-400">Кількість: {item.quantity} шт</div>
                        <div className="mt-1 text-sm text-slate-400">Ціна: {item.price} zł</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-700 bg-slate-950/80 p-4">
              <h2 className="mb-3 text-lg font-semibold text-white">Підсумок</h2>
              <div className="space-y-3 text-sm text-slate-300">
                <div className="flex justify-between border-b border-slate-800 pb-2">
                  <span>Кількість позицій</span>
                  <span>{order.items.length}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800 pb-2">
                  <span>Сума</span>
                  <span>{order.totalPrice} zł</span>
                </div>
                <div className="flex justify-between border-slate-800 pb-2 pt-2 text-white">
                  <span className="font-semibold">Разом</span>
                  <span className="font-semibold">{order.totalPrice} zł</span>
                </div>
              </div>
              <div className="mt-6 space-y-3 rounded-3xl border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-400">
                <div>Дата: {formatDate(order.createdAt)}</div>
                <div>Час: {formatTime(order.createdAt)}</div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <Link to="/mini-app" className="rounded-3xl border border-slate-700 bg-slate-950 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:border-cyan-500 hover:text-white">
              Повернутися до мініапу
            </Link>
            <div className="text-sm text-slate-400">Щоб побачити більше деталей, оновіть замовлення в адміністрації або перевірте чат Telegram.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import Pagination from '../components/Pagination.jsx';
import { useConfirm } from '../components/ConfirmModal.jsx';
import { getArchive, resolveImageUrl, restoreFromArchive, permanentlyDeleteArchived } from '../api.js';

function formatDay(dayStr) {
  if (!dayStr || dayStr === 'невідомо') return 'Невідома дата';
  const [year, month, day] = dayStr.split('-');
  return `${day}.${month}.${year}`;
}

export default function ArchivePage({ onRestoreSuccess }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const queryClient = useQueryClient();
  const confirm = useConfirm();

  const { data, isLoading, error } = useQuery({
    queryKey: ['archive', page, pageSize],
    queryFn: () => getArchive({ page, pageSize }),
    staleTime: 1000 * 30,
    keepPreviousData: true,
  });

  const restoreMutation = useMutation({
    mutationFn: restoreFromArchive,
    onSuccess: () => {
      toast.success('Товар відновлено на полицю');
      queryClient.invalidateQueries({ queryKey: ['archive'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      if (typeof onRestoreSuccess === 'function') onRestoreSuccess();
    },
    onError: (err) => toast.error(err?.message || 'Не вдалося відновити'),
  });

  const deleteMutation = useMutation({
    mutationFn: permanentlyDeleteArchived,
    onSuccess: () => {
      toast.success('Товар видалено назавжди');
      queryClient.invalidateQueries({ queryKey: ['archive'] });
    },
    onError: (err) => toast.error(err?.message || 'Не вдалося видалити'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
        Завантаження архіву...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-3xl border border-red-700 bg-red-900/20 p-6 text-red-400">
        Помилка завантаження архіву: {error.message}
      </div>
    );
  }

  const { groups = [], total = 0, pageCount = 1 } = data ?? {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Архів товарів</h1>
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">
          {total} позицій за 30 днів
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-3xl border border-slate-700 bg-slate-900 p-10 text-center text-slate-500 text-sm">
          Архів порожній — видалених товарів за останні 30 днів немає.
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map(({ day, items }) => (
            <div key={day} className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-cyan-400">
                {formatDay(day)}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((product) => (
                  <div
                    key={product._id}
                    className="flex gap-3 rounded-2xl border border-slate-700 bg-slate-900 p-4"
                  >
                    {product.imageUrls?.[0] ? (
                      <img
                        src={resolveImageUrl(product.imageUrls[0])}
                        alt={product.name}
                        className="h-20 w-20 flex-shrink-0 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-xl bg-slate-800 text-slate-600 text-xs">
                        Без фото
                      </div>
                    )}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="truncate text-sm font-medium text-slate-100">{product.name}</p>
                      <p className="text-xs text-slate-400">Позиція: {product.orderNumber}</p>
                      <p className="text-xs text-slate-400">Ціна: {product.price} zł</p>
                      <p className="text-xs text-slate-400">К-сть: {product.quantity} шт</p>
                      {product.archivedAt && (
                        <p className="text-xs text-slate-500">
                          {new Date(product.archivedAt).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                      <div className="flex gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => restoreMutation.mutate(product._id)}
                          disabled={restoreMutation.isPending}
                          className="rounded-2xl bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                        >
                          Відновити
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            if (await confirm('Видалити товар назавжди? Цю операцію не можна скасувати.')) {
                              deleteMutation.mutate(product._id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                          className="rounded-2xl bg-slate-700 px-3 py-1 text-xs font-semibold text-slate-300 transition hover:bg-red-600 hover:text-white disabled:opacity-50"
                        >
                          Видалити
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
        />
      )}
    </div>
  );
}

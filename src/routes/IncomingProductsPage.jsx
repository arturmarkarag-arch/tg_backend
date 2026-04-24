import React, { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getIncomingProducts, deleteProduct, resolveImageUrl } from '../api';

export default function IncomingProductsPage() {
  const queryClient = useQueryClient();

  const { data: incomingProducts = [], isLoading, isError, error } = useQuery({
    queryKey: ['incoming-products'],
    queryFn: getIncomingProducts,
    refetchInterval: 15_000,
  });

  const newProducts = incomingProducts.filter((product) => !product.restoredFromArchive);

  const handleArchive = useCallback(async (productId) => {
    try {
      await deleteProduct(productId);
      toast.success('Товар заархівовано');
      queryClient.invalidateQueries({ queryKey: ['incoming-products'] });
      queryClient.invalidateQueries({ queryKey: ['blocks'] });
      queryClient.invalidateQueries({ queryKey: ['block'] });
    } catch (err) {
      toast.error(err?.message || 'Не вдалося архівувати товар');
    }
  }, [queryClient]);

  if (isLoading) {
    return <p className="text-slate-400">Завантаження нових товарів...</p>;
  }

  if (isError) {
    return <p className="text-rose-400">Помилка: {error?.message || 'Не вдалося завантажити надходження'}</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm uppercase tracking-[0.35em] text-cyan-300">Надходження</p>
          <h1 className="text-2xl font-semibold text-white">Нові товари</h1>
          <p className="mt-2 text-sm text-slate-400">Тут можна редагувати надходження та переносити товар в архів.</p>
        </div>
        <div className="rounded-2xl border border-slate-700 bg-slate-900/80 px-4 py-3 text-sm text-slate-300">
          {newProducts.length} нових товарів
        </div>
      </div>

      {newProducts.length === 0 ? (
        <div className="rounded-3xl border border-slate-700 bg-slate-950/80 p-6 text-slate-400">
          Немає нових товарів для обробки.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {newProducts.map((product) => (
              <div key={product._id} className="rounded-3xl border border-slate-700 bg-slate-950/90 p-4">
                <div className="flex items-start gap-4">
                  <div className="h-20 w-20 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
                    {product.localImageUrl || product.imageUrls?.[0] ? (
                      <img
                        src={resolveImageUrl(product.localImageUrl || product.imageUrls?.[0])}
                        alt={product.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center bg-slate-800 text-slate-500">
                        {product.name?.charAt(0) || '?'}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-lg font-semibold text-white">{product.name}</h2>
                    {product.brand && <p className="text-sm text-slate-400">{product.brand}</p>}
                    <p className="mt-2 text-sm text-slate-300">{product.quantity ?? 0} шт • {product.price ?? 0} zł</p>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleArchive(product._id)}
                      className="rounded-3xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-100 transition hover:border-red-300 hover:bg-red-500/20"
                    >
                      Архівувати
                    </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

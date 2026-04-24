import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getBlocks, getBlock, getIncomingProducts, addToBlock, createBlock, deleteProduct } from '../api';
import { resolveImageUrl } from '../api';
import { useSocket } from '../hooks/useSocket';
import ProductTile from '../components/ProductTile';
import NumpadModal from '../components/NumpadModal';
import BlockInsertionView from '../components/BlockInsertionView';

const BLOCKS_REFETCH_INTERVAL = 30_000;
// ВИПРАВЛЕНО: USER_NAME можна зробити налаштовуваним через store
const USER_NAME = 'Оператор';

export default function WarehouseBoardPage() {
  // ВИПРАВЛЕНО: useRef — стабільний між ре-рендерами, не перегенерується
  const userIdRef = useRef(null);
  if (!userIdRef.current) {
    // Спробувати відновити з sessionStorage щоб пережити F5,
    // але не HMR (sessionStorage очищається при закритті вкладки)
    userIdRef.current = sessionStorage.getItem('warehouse_user_id')
      || `user_${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem('warehouse_user_id', userIdRef.current);
  }
  const USER_ID = userIdRef.current;
  const { emit, on } = useSocket();
  const queryClient = useQueryClient();

  // --- State ---
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [sourceBlock, setSourceBlock] = useState(null); // null for incoming products
  const [isIncoming, setIsIncoming] = useState(false);  // product from incoming strip
  const [serialMode, setSerialMode] = useState(false);  // stay in block for next incoming
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [targetBlock, setTargetBlock] = useState(null);
  const [locks, setLocks] = useState({});
  const [searchQuery, setSearchQuery] = useState('');

  // --- Data fetching ---
  const [isCreatingBlock, setIsCreatingBlock] = useState(false);

  const { data: blocks = [], refetch: refetchBlocks } = useQuery({
    queryKey: ['blocks'],
    queryFn: getBlocks,
    refetchInterval: BLOCKS_REFETCH_INTERVAL,
  });

  const { data: incomingProducts = [], refetch: refetchIncoming } = useQuery({
    queryKey: ['incoming-products'],
    queryFn: getIncomingProducts,
    refetchInterval: 15_000,
  });

  const { data: targetBlockData, refetch: refetchTarget } = useQuery({
    queryKey: ['block', targetBlock],
    queryFn: () => getBlock(targetBlock),
    enabled: !!targetBlock,
  });

  const handleCreateBlock = useCallback(async () => {
    setIsCreatingBlock(true);
    try {
      await createBlock();
      toast.success('Новий блок створено');
      refetchBlocks();
    } catch (err) {
      toast.error(`Помилка: ${err.message}`);
    } finally {
      setIsCreatingBlock(false);
    }
  }, [refetchBlocks]);

  // --- Socket listeners ---
  useEffect(() => {
    const unsubs = [
      on('item_locked', ({ productId, userId, userName }) => {
        setLocks((prev) => ({ ...prev, [productId]: { userId, userName } }));
      }),
      on('item_unlocked', ({ productId }) => {
        setLocks((prev) => {
          const next = { ...prev };
          delete next[productId];
          return next;
        });
      }),
      on('current_locks', (serverLocks) => {
        setLocks(serverLocks);
      }),
      on('block_updated', (updatedBlock) => {
        // Instantly patch the blocks cache so all users see the move
        queryClient.setQueryData(['blocks'], (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((b) => (b.blockId === updatedBlock.blockId ? updatedBlock : b));
        });
        // Also refetch incoming since a product may have been placed
        refetchIncoming();
        if (targetBlock === updatedBlock.blockId) {
          queryClient.setQueryData(['block', targetBlock], updatedBlock);
        }
      }),
      on('move_success', ({ source, target }) => {
        toast.success('Товар переміщено');
        refetchBlocks();
        refetchIncoming();

        if (source?.blockId !== target?.blockId || !selectedProduct) {
          // Inter-block move done
          setSelectedProduct(null);
          setSourceBlock(null);
          setIsIncoming(false);
          setTargetBlock(null);
        } else {
          // Same block reorder — keep view open
          refetchTarget();
        }
      }),
      on('blocks_updated', () => {
        refetchBlocks();
      }),
      on('move_error', ({ error }) => {
        toast.error(`Помилка: ${error}`);
      }),
      on('lock_denied', ({ productId, lockedBy }) => {
        toast.error(`Товар заблоковано: ${lockedBy}`);
      }),
    ];

    emit('get_locks');

    return () => unsubs.forEach((u) => typeof u === 'function' && u());
  }, [on, emit, refetchBlocks, refetchTarget, targetBlock]);

  // Join target block room
  useEffect(() => {
    if (targetBlock) {
      emit('join_block', targetBlock);
      return () => emit('leave_block', targetBlock);
    }
  }, [targetBlock, emit]);

  // --- Handlers ---
  const handleSelectProduct = useCallback((product, blockNumber) => {
    if (selectedProduct?._id === product._id) {
      emit('unlock_item', { productId: product._id, userId: USER_ID });
      setSelectedProduct(null);
      setSourceBlock(null);
      setIsIncoming(false);
      return;
    }

    emit('lock_item', { productId: product._id, userId: USER_ID, userName: USER_NAME });
    setSelectedProduct(product);
    setSourceBlock(blockNumber);
    setIsIncoming(false);
    setNumpadOpen(true);
  }, [selectedProduct, emit]);

  const handleSelectIncoming = useCallback((product) => {
    if (selectedProduct?._id === product._id) {
      emit('unlock_item', { productId: product._id, userId: USER_ID });
      setSelectedProduct(null);
      setSourceBlock(null);
      setIsIncoming(false);
      return;
    }

    emit('lock_item', { productId: product._id, userId: USER_ID, userName: USER_NAME });
    setSelectedProduct(product);
    setSourceBlock(null);
    setIsIncoming(true);
    setNumpadOpen(true);
  }, [selectedProduct, emit]);

  const handleNumpadConfirm = useCallback((blockNumber) => {
    setNumpadOpen(false);
    setTargetBlock(blockNumber);
  }, []);

  const handleNumpadClose = useCallback(() => {
    setNumpadOpen(false);
    if (selectedProduct) {
      emit('unlock_item', { productId: selectedProduct._id, userId: USER_ID });
      setSelectedProduct(null);
      setSourceBlock(null);
      setIsIncoming(false);
      setSerialMode(false);
    }
  }, [selectedProduct, emit]);

  const handleInsert = useCallback(async (index) => {
    if (!selectedProduct || !targetBlock) return;

    if (isIncoming) {
      try {
        await addToBlock(targetBlock, selectedProduct._id, index);
        toast.success('Товар розміщено');
        refetchBlocks();
        refetchIncoming();
        refetchTarget();

        if (serialMode && incomingProducts.length > 1) {
          const next = incomingProducts.find((p) => p._id !== selectedProduct._id);
          if (next) {
            emit('unlock_item', { productId: selectedProduct._id, userId: USER_ID });
            emit('lock_item', { productId: next._id, userId: USER_ID, userName: USER_NAME });
            setSelectedProduct(next);
            return;
          }
        }

        emit('unlock_item', { productId: selectedProduct._id, userId: USER_ID });
        setSelectedProduct(null);
        setSourceBlock(null);
        setIsIncoming(false);
        setSerialMode(false);
        setTargetBlock(null);
      } catch (err) {
        toast.error(`Помилка: ${err.message}`);
      }
    } else {
      if (!sourceBlock) return;
      emit('move_item', {
        productId: selectedProduct._id,
        fromBlock: sourceBlock,
        toBlock: targetBlock,
        toIndex: index,
        userId: USER_ID,
      });
    }
  }, [selectedProduct, sourceBlock, targetBlock, isIncoming, serialMode, incomingProducts, emit, refetchBlocks, refetchIncoming, refetchTarget]);

  const handleArchiveProduct = useCallback(async (product) => {
    if (!product?._id) return;
    try {
      await deleteProduct(product._id);
      toast.success('Товар заархівовано');
      refetchBlocks();
      refetchTarget();
      refetchIncoming();

      if (selectedProduct?._id === product._id) {
        emit('unlock_item', { productId: product._id, userId: USER_ID });
        setSelectedProduct(null);
        setSourceBlock(null);
        setIsIncoming(false);
        setSerialMode(false);
        setTargetBlock(null);
        setNumpadOpen(false);
      }
    } catch (err) {
      toast.error(err?.message || 'Не вдалося архівувати товар');
    }
  }, [deleteProduct, emit, refetchBlocks, refetchIncoming, refetchTarget, selectedProduct]);

  const handleReorder = useCallback((productId, newIndex) => {
    if (!targetBlock) return;

    emit('move_item', {
      productId,
      fromBlock: targetBlock,
      toBlock: targetBlock,
      toIndex: newIndex,
      userId: USER_ID,
    });
  }, [targetBlock, emit]);

  const handleCloseInsertion = useCallback(() => {
    if (selectedProduct) {
      emit('unlock_item', { productId: selectedProduct._id, userId: USER_ID });
    }
    setSelectedProduct(null);
    setSourceBlock(null);
    setTargetBlock(null);
    setIsIncoming(false);
    setSerialMode(false);
  }, [selectedProduct, emit]);

  const productsInBlocksCount = useMemo(() => {
    const ids = new Set();
    for (const block of blocks) {
      for (const product of block.productIds || []) {
        if (!product) continue;
        ids.add(typeof product === 'object' ? product._id : product);
      }
    }
    return ids.size;
  }, [blocks]);

  // --- Filtering ---
  const filteredBlocks = useMemo(() => {
    if (!searchQuery.trim()) return blocks;
    const q = searchQuery.trim().toLowerCase();
    const isNumeric = /^\d+$/.test(q);
    return blocks.filter((b) => {
      if (isNumeric && String(b.blockId) === q) return true;
      if (!isNumeric && b.productIds?.some((p) =>
        typeof p === 'object' && (p.name?.toLowerCase().includes(q) || p.brand?.toLowerCase().includes(q))
      )) return true;
      return false;
    });
  }, [blocks, searchQuery]);



  return (
    <div className="space-y-4">
      {/* Header / selected product bar */}
      {selectedProduct && !targetBlock && (
        <div className={`sticky top-0 z-30 flex items-center gap-3 rounded-2xl border ${isIncoming ? 'border-amber-500/30' : 'border-cyan-500/30'} bg-slate-900/95 px-4 py-3 backdrop-blur-sm shadow-lg`}>
          <div className={`h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border ${isIncoming ? 'border-amber-500' : 'border-cyan-500'}`}>
            {selectedProduct.localImageUrl || selectedProduct.imageUrls?.[0] ? (
              <img
                src={resolveImageUrl(selectedProduct.localImageUrl || selectedProduct.imageUrls?.[0])}
                alt={selectedProduct.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-slate-800 text-slate-500">
                {selectedProduct.name?.charAt(0)}
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className={`truncate text-sm font-semibold ${isIncoming ? 'text-amber-300' : 'text-cyan-300'}`}>{selectedProduct.name}</p>
            <p className="text-xs text-slate-400">
              {isIncoming ? 'Нове надходження → Введіть номер блоку' : `З блоку #${sourceBlock} → Введіть номер блоку`}
            </p>
          </div>
          {isIncoming && (
            <label className="flex items-center gap-1.5 text-xs text-amber-400 cursor-pointer">
              <input
                type="checkbox"
                checked={serialMode}
                onChange={(e) => setSerialMode(e.target.checked)}
                className="rounded border-amber-500 bg-slate-800 text-amber-500 focus:ring-amber-500"
              />
              Серія
            </label>
          )}
          <button
            onClick={handleNumpadClose}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-800 hover:text-red-400 transition"
          >
            ✕
          </button>
        </div>
      )}

      {/* Title + Search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="space-y-2">
            <h1 className="text-2xl font-bold text-slate-100">Склад</h1>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">{blocks.length} блоків</span>
              <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-400">У блоках: {productsInBlocksCount} товарів</span>
            </div>
          </div>
          <button
            type="button"
            onClick={handleCreateBlock}
            disabled={isCreatingBlock}
            className="inline-flex items-center justify-center rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreatingBlock ? 'Створюємо...' : 'Додати блок'}
          </button>
        </div>
        <input
          type="text"
          placeholder="Пошук блоку або товару..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full max-w-xs rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500 transition"
        />
      </div>

      {/* Incoming products strip */}
      {incomingProducts.length > 0 && (
        <div className="rounded-2xl border border-amber-500/30 bg-slate-900/80 p-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-xs font-bold text-amber-400">
              📦 Надходження
              <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-slate-900">
                {incomingProducts.length}
              </span>
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {incomingProducts.map((product) => {
              const lock = locks[product._id];
              const isLocked = lock && lock.userId !== USER_ID;
              const isSelected = selectedProduct?._id === product._id;

              return (
                <ProductTile
                  key={product._id}
                  product={product}
                  isSelected={isSelected}
                  isLocked={isLocked}
                  lockedBy={lock?.userName}
                  onClick={handleSelectIncoming}
                  accentColor="amber"
                />
              );
            })}
          </div>
        </div>
      )}

      {/* Blocks grid */}
      {filteredBlocks.length > 0 && (
        <div className="space-y-3">
          {filteredBlocks.map((block) => (
            <BlockRow
              key={block._id}
              block={block}
              selectedProduct={selectedProduct}
              locks={locks}
              userId={USER_ID}
              onSelectProduct={handleSelectProduct}
              onEditBlock={() => setTargetBlock(block.blockId)}
            />
          ))}
        </div>
      )}

      {/* Numpad modal */}
      <NumpadModal
        open={numpadOpen}
        onConfirm={handleNumpadConfirm}
        onClose={handleNumpadClose}
      />

      {/* Block insertion view */}
      {targetBlock && targetBlockData && (
        <BlockInsertionView
          block={targetBlockData}
          selectedProduct={selectedProduct}
          onInsert={handleInsert}
          onReorder={handleReorder}
          onClose={handleCloseInsertion}
          onArchiveProduct={handleArchiveProduct}
        />
      )}
    </div>
  );
}

// --- BlockRow sub-component ---
const BlockRow = React.memo(function BlockRow({ block, selectedProduct, locks, userId, onSelectProduct, onEditBlock }) {
  const products = block.productIds || [];
  const isEmpty = products.length === 0;

  return (
    <div className={`rounded-2xl border p-3 ${
      isEmpty ? 'border-slate-700/30 bg-slate-900/40' : 'border-slate-700 bg-slate-900/80'
    }`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`inline-flex h-7 min-w-[28px] items-center justify-center rounded-lg px-1.5 text-xs font-bold ${
            isEmpty ? 'bg-slate-700/30 text-slate-600' : 'bg-cyan-500/10 text-cyan-400'
          }`}>
            {block.blockId}
          </span>
          {isEmpty
            ? <span className="text-xs text-slate-600">Порожньо</span>
            : <span className="text-xs text-slate-500">{products.length} товарів</span>
          }
        </div>
        <button
          type="button"
          onClick={onEditBlock}
          className="rounded-full border border-slate-700 px-3 py-1 text-xs font-medium text-slate-300 hover:border-cyan-500 hover:text-cyan-300 transition"
        >
          Редагувати
        </button>
      </div>
      {!isEmpty && (
        <div className="flex flex-wrap gap-1.5">
          {products.map((product) => {
            if (!product || typeof product !== 'object') return null;
            const productId = product._id;
            const lock = locks[productId];
            const isLocked = lock && lock.userId !== userId;
            const isSelected = selectedProduct?._id === productId;

            return (
              <ProductTile
                key={productId}
                product={product}
                isSelected={isSelected}
                isLocked={isLocked}
                lockedBy={lock?.userName}
                onClick={(p) => onSelectProduct(p, block.blockId)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

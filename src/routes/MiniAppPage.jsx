import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../components/Modal.jsx';
import { getProductsPage, resolveImageUrl, createOrder, saveMiniAppState, resetMiniAppState, registerTelegramUser, getDeliveryGroups } from '../api.js';
import { DAY_SHORT } from '../utils/dayNames.js';
import UsersPage from './UsersPage.jsx';
import WarehouseBoardPage from './WarehouseBoardPage.jsx';
import IncomingProductsPage from './IncomingProductsPage.jsx';
import SettingsPage from './SettingsPage.jsx';
import ArchivePage from './ArchivePage.jsx';

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';

// ---------- Константи ----------
const PAGE_SIZE = 24;
const WINDOW_PAGES = 5;   // скільки сторінок тримати по кожен бік від поточної
const PREFETCH_AHEAD = 2; // підвантажувати вперед за N сторінок до краю вікна
const DOUBLE_TAP_DELAY = 320;
const SWIPE_MIN_DISTANCE = 50;

// ---------- Telegram helpers ----------
async function fetchUserProfile(initData) {
  const res = await fetch(`${BASE_URL}/v1/telegram/me`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    const err = Object.assign(new Error(data.message || 'not_registered'), {
      code: data.error === 'pending_registration' ? 'pending_registration' : 'not_registered',
    });
    if (data.telegramId) err.telegramId = data.telegramId;
    throw err;
  }
  if (!res.ok) throw new Error('auth_failed');
  return res.json();
}

function parseTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData || '');
    const parsed = {};
    for (const [key, value] of params.entries()) {
      try { parsed[key] = JSON.parse(value); } catch { parsed[key] = value; }
    }
    return parsed;
  } catch { return {}; }
}

function getTelegramUser() {
  try {
    const tg = window?.Telegram?.WebApp;
    if (!tg) return null;
    tg.ready();
    if (!tg.initData) return null;
    const user = tg.initDataUnsafe?.user || parseTelegramInitData(tg.initData)?.user;
    if (user?.id) return { id: String(user.id), firstName: user.first_name || '', initData: tg.initData };
    return null;
  } catch { return null; }
}

// Низькорівневий fetch без жодних блокувань
async function fetchPage(offset) {
  const page = await getProductsPage({ limit: PAGE_SIZE, offset });
  if (!page?.items) throw new Error('Не вдалося завантажити товари');
  return page;
}

// ---------- Скелетон ----------
function ProductSkeleton() {
  return (
    <div className="relative flex h-full flex-col animate-pulse">
      <div className="relative flex-1 bg-slate-800" />
      <div className="space-y-3 border-t border-slate-800 bg-slate-950/90 px-5 py-5">
        <div className="h-6 w-2/3 rounded-xl bg-slate-700" />
        <div className="h-4 w-1/3 rounded-xl bg-slate-800" />
      </div>
    </div>
  );
}

// ============================================================
export default function MiniAppPage() {

  // ---------- Розріджений Map: абсолютний індекс → товар ----------
  // Дірки (відсутні ключі) = ще не завантажено
  const [productMap, setProductMap] = useState(() => new Map());
  const [loadedPages, setLoadedPages] = useState(() => new Set());
  const loadingPagesRef = useRef(new Set()); // не потребує ре-рендеру

  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const hasMoreRef = useRef(true);

  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [sessionRestored, setSessionRestored] = useState(false);

  // UI
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedQty, setSelectedQty] = useState(1);
  const [orderItems, setOrderItems] = useState({});
  const [viewMode, setViewMode] = useState('carousel');
  const [imageIndexes, setImageIndexes] = useState({});
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);
  const [activeMiniAppPage, setActiveMiniAppPage] = useState('orders');

  // Auth
  const [telegramUser, setTelegramUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('checking');
  const [authMessage, setAuthMessage] = useState('');

  // Реєстрація
  const [registrationFields, setRegistrationFields] = useState({
    firstName: '', lastName: '',
    shopName: '', deliveryGroupId: '',
    role: 'seller',
  });
  const [registrationStatus, setRegistrationStatus] = useState('idle');
  const [registrationError, setRegistrationError] = useState('');
  const [deliveryGroups, setDeliveryGroups] = useState([]);
  const [deliveryGroupsLoading, setDeliveryGroupsLoading] = useState(false);

  // Refs
  const imageCacheRef = useRef(new Map());
  const lastTapRef = useRef({ time: 0, productId: null });
  const pointerRef = useRef({ startX: 0, startY: 0, startTime: 0 });
  const saveTimeoutRef = useRef(null);
  const gridPageTopRef = useRef(null);
  const lastSaveTsRef = useRef(0);
  const pendingSaveRef = useRef(false);
  const needsSaveRef = useRef(false);
  const lastSavedStateRef = useRef(null);

  // ---------- Похідні ----------
  const currentProduct = productMap.get(currentIndex) ?? null;
  const isCurrentLoading = !productMap.has(currentIndex);
  const currentPageProducts = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    const products = [];
    for (let i = start; i < start + PAGE_SIZE; i += 1) {
      const product = productMap.get(i);
      if (product) products.push({ index: i, product });
    }
    return products;
  }, [productMap, currentPage]);

  const isAdmin = telegramUser?.role === 'admin';
  const isWarehouse = telegramUser?.role === 'warehouse';
  const miniAppPages = isAdmin
    ? [{ id: 'orders', label: 'Замовлення' }, { id: 'warehouse', label: 'Склад' }, { id: 'new-products', label: 'Нові товари' }, { id: 'archive', label: 'Архів' }, { id: 'users', label: 'Користувачі' }, { id: 'settings', label: 'Налаштування' }]
    : isWarehouse ? [{ id: 'warehouse', label: 'Склад' }, { id: 'new-products', label: 'Нові товари' }, { id: 'archive', label: 'Архів' }]
    : [{ id: 'orders', label: 'Замовлення' }];

  const orderCount = Object.values(orderItems).reduce((s, q) => s + q, 0);

  // ---------- Завантаження однієї сторінки ----------
  const loadPage = useCallback(async (pageNum) => {
    if (loadingPagesRef.current.has(pageNum)) return;
    loadingPagesRef.current.add(pageNum);
    try {
      const page = await fetchPage(pageNum * PAGE_SIZE);
      const items = page.items || [];
      const offset = pageNum * PAGE_SIZE;

      setProductMap((prev) => {
        const next = new Map(prev);
        items.forEach((item, i) => next.set(offset + i, item));
        return next;
      });
      setLoadedPages((prev) => { const next = new Set(prev); next.add(pageNum); return next; });
      const newHasMore = Boolean(page.hasMore);
      hasMoreRef.current = newHasMore;
      setHasMore(newHasMore);
      if (typeof page.total === 'number') setTotalCount(page.total);
      else setTotalCount((p) => Math.max(p, offset + items.length));
    } catch (err) {
      toast.error(err?.message || 'Помилка завантаження');
    } finally {
      loadingPagesRef.current.delete(pageNum);
    }
  }, []);

  // ---------- Вивантаження далеких сторінок (±WINDOW_PAGES) ----------
  const evictFarPages = useCallback((centerPage) => {
    const min = centerPage - WINDOW_PAGES;
    const max = centerPage + WINDOW_PAGES;
    setLoadedPages((prev) => {
      const toEvict = [...prev].filter((p) => p < min || p > max);
      if (!toEvict.length) return prev;
      setProductMap((prevMap) => {
        const next = new Map(prevMap);
        for (const p of toEvict) {
          for (let i = p * PAGE_SIZE; i < (p + 1) * PAGE_SIZE; i += 1) {
            const product = prevMap.get(i);
            if (product?.id) {
              imageCacheRef.current.delete(String(product.id));
            }
            next.delete(i);
          }
        }
        return next;
      });
      const next = new Set(prev);
      toEvict.forEach((p) => next.delete(p));
      return next;
    });
  }, []);

  // ---------- Підтримка вікна: завантажити потрібне, вивантажити далеке ----------
  const ensureWindow = useCallback((centerPage) => {
    evictFarPages(centerPage);
    const from = Math.max(0, centerPage - PREFETCH_AHEAD);
    const to = centerPage + PREFETCH_AHEAD;
    for (let p = from; p <= to; p++) {
      if (!hasMoreRef.current && p * PAGE_SIZE >= totalCount) break;
      setLoadedPages((prev) => {
        if (!prev.has(p) && !loadingPagesRef.current.has(p)) loadPage(p);
        return prev;
      });
    }
  }, [evictFarPages, loadPage, totalCount]);

  // ---------- Навігація ----------
  const goNext = useCallback(() => {
    setCurrentIndex((prev) => {
      const next = prev + 1;
      if (!hasMoreRef.current && next >= totalCount) return prev;
      return next;
    });
  }, [totalCount]);

  const goPrevious = useCallback(() => {
    setCurrentIndex((prev) => Math.max(0, prev - 1));
  }, []);

  // ---------- Auth ----------
  useEffect(() => {
    async function checkAuth() {
      const tgUser = getTelegramUser();
      if (!tgUser) { setAuthStatus('no_telegram'); return; }
      setTelegramUser(tgUser);
      try {
        const profile = await fetchUserProfile(tgUser.initData);
        setTelegramUser({ ...tgUser, ...profile });
        setAuthStatus('ok');
      } catch (err) {
        if (err.code === 'pending_registration') {
          setAuthStatus('pending_registration');
          setAuthMessage('Ваша заявка прийнята, очікуйте підтвердження.');
          if (err.telegramId) setTelegramUser({ ...tgUser, id: err.telegramId });
        } else if (err.code === 'not_registered') {
          setAuthStatus('not_registered');
          setAuthMessage(err.message);
          if (err.telegramId) setTelegramUser({ ...tgUser, id: err.telegramId });
        } else {
          setAuthStatus('error');
          setAuthMessage('Помилка перевірки авторизації');
        }
      }
    }
    checkAuth();
  }, []);

  useEffect(() => {
    if (!telegramUser || telegramUser.role === 'admin') return;
    setActiveMiniAppPage(telegramUser.role === 'warehouse' ? 'warehouse' : 'orders');
  }, [telegramUser?.role]);

  useEffect(() => {
    async function loadGroups() {
      if (authStatus !== 'not_registered') return;
      setDeliveryGroupsLoading(true);
      try { const g = await getDeliveryGroups(); setDeliveryGroups(g || []); }
      catch { /* ignore */ }
      finally { setDeliveryGroupsLoading(false); }
    }
    loadGroups();
  }, [authStatus]);

  // ---------- Відновлення сесії ----------
  // Головна ідея: знаємо targetIndex → рахуємо targetPage = floor(targetIndex / PAGE_SIZE)
  // → завантажуємо тільки потрібну сторінку + сусідні для prefetch
  // → НЕ завантажуємо 0..targetPage-1 (вони завантажаться лінива при гортанні назад)
  useEffect(() => {
    if (sessionRestored || authStatus !== 'ok' || !telegramUser) return;

    const miniAppState = telegramUser.miniAppState || {};
    const botShopState = telegramUser.lastBotState?.shop || {};

    const savedIndex = Number.isInteger(miniAppState.currentIndex) ? miniAppState.currentIndex : 0;
    const shopIndex = Number.isInteger(botShopState.currentIndex) ? botShopState.currentIndex : 0;
    const targetIndex = Math.max(
      0,
      botShopState.updatedAt && miniAppState.updatedAt
        ? new Date(botShopState.updatedAt) > new Date(miniAppState.updatedAt) ? shopIndex : savedIndex
        : botShopState.updatedAt ? shopIndex : savedIndex,
    );
    const targetProductId = miniAppState.lastViewedProductId ? String(miniAppState.lastViewedProductId) : null;
    const targetPage = Number.isInteger(miniAppState.currentPage) && miniAppState.currentPage >= 0
      ? miniAppState.currentPage
      : Math.floor(targetIndex / PAGE_SIZE);

    setSessionRestored(true);
    setOrderItems(miniAppState.orderItems || {});
    setViewMode(['grid', 'carousel'].includes(miniAppState.viewMode) ? miniAppState.viewMode : 'carousel');
    setCurrentPage(targetPage);

    async function doRestore() {
      // Завантажуємо вікно навколо потрібної сторінки паралельно
      const from = Math.max(0, targetPage - PREFETCH_AHEAD);
      const to = targetPage + PREFETCH_AHEAD;
      await Promise.all(
        Array.from({ length: to - from + 1 }, (_, i) => loadPage(from + i)),
      );

      // Якщо є productId — шукаємо точну позицію
      if (targetProductId) {
        setProductMap((map) => {
          for (const [idx, product] of map.entries()) {
            if (String(product.id) === targetProductId) {
              setCurrentIndex(idx);
              return map;
            }
          }
          setCurrentIndex(targetIndex);
          return map;
        });
      } else {
        setCurrentIndex(targetIndex);
      }
    }

    doRestore();
  }, [authStatus, sessionRestored, telegramUser, loadPage]);

  // ---------- Початкове завантаження (без авторизації) ----------
  useEffect(() => {
    if (authStatus === 'ok') return; // відновлення вище
    if (loadedPages.has(0) || loadingPagesRef.current.has(0)) return;
    loadPage(0);
  }, [authStatus, loadedPages, loadPage]);

  // ---------- Вікно при переміщенні ----------
  useEffect(() => {
    ensureWindow(currentPage);
  }, [currentPage, ensureWindow]);

  useEffect(() => {
    const pageForIndex = Math.floor(currentIndex / PAGE_SIZE);
    if (pageForIndex !== currentPage) {
      setCurrentPage(pageForIndex);
    }
    if (!loadedPages.has(pageForIndex) && !loadingPagesRef.current.has(pageForIndex)) {
      loadPage(pageForIndex);
    }
  }, [currentIndex, currentPage, loadedPages, loadPage]);

  useEffect(() => {
    if (viewMode !== 'grid') return;
    if (!gridPageTopRef.current) return;
    gridPageTopRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [currentPage, viewMode]);

  // ---------- Збереження ----------
  const serializeOrderItems = useCallback((items) => {
    if (!items || typeof items !== 'object') return '';
    return JSON.stringify(
      Object.entries(items).sort(([a], [b]) => String(a).localeCompare(String(b))).map(([k, v]) => [String(k), Number(v) || 0]),
    );
  }, []);

  const getSaveState = useCallback(() => ({
    currentIndex,
    currentPage,
    currentProductId: String(currentProduct?.id || ''),
    orderItems: serializeOrderItems(orderItems),
    viewMode,
  }), [currentIndex, currentPage, currentProduct?.id, orderItems, serializeOrderItems, viewMode]);

  const hasStateChanged = useCallback(() => {
    const cur = getSaveState();
    const last = lastSavedStateRef.current;
    return !last || cur.currentIndex !== last.currentIndex || cur.currentPage !== last.currentPage || cur.currentProductId !== last.currentProductId || cur.orderItems !== last.orderItems || cur.viewMode !== last.viewMode;
  }, [getSaveState]);

  const saveMiniAppStateToServer = useCallback(async () => {
    if (authStatus !== 'ok' || !telegramUser?.initData || !currentProduct) return;
    if (pendingSaveRef.current) { needsSaveRef.current = true; return; }
    pendingSaveRef.current = true;
    try {
      const result = await saveMiniAppState({ initData: telegramUser.initData, currentIndex, currentPage, productId: String(currentProduct.id), orderItems, viewMode });
      if (result?.miniAppState || result?.lastBotState) {
        setTelegramUser((u) => ({ ...u, miniAppState: result.miniAppState ?? u.miniAppState, lastBotState: result.lastBotState ?? u.lastBotState }));
      }
      lastSavedStateRef.current = getSaveState();
    } catch { /* ignore */ }
    finally {
      pendingSaveRef.current = false;
      lastSaveTsRef.current = Date.now();
      if (needsSaveRef.current) { needsSaveRef.current = false; saveMiniAppStateToServer(); }
    }
  }, [authStatus, currentIndex, currentProduct, orderItems, telegramUser, getSaveState]);

  const handleResetMiniAppState = useCallback(async () => {
    if (authStatus !== 'ok' || !telegramUser?.initData) return;
    try {
      const result = await resetMiniAppState();
      setCurrentIndex(0);
      setCurrentPage(0);
      setOrderItems({});
      setTelegramUser((u) => ({
        ...u,
        miniAppState: result?.miniAppState ?? u.miniAppState,
        lastBotState: result?.lastBotState ?? u.lastBotState,
      }));
    } catch (err) {
      console.error('Failed to reset mini app state', err);
    }
  }, [authStatus, telegramUser?.initData, telegramUser]);

  useEffect(() => {
    if (!sessionRestored || authStatus !== 'ok' || !telegramUser?.initData || !currentProduct) return;
    if (!hasStateChanged()) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const elapsed = Date.now() - lastSaveTsRef.current;
    const delay = Math.max(400, 800 - Math.min(elapsed, 800));
    saveTimeoutRef.current = setTimeout(() => { saveMiniAppStateToServer(); saveTimeoutRef.current = null; }, delay);
    return () => { if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null; } };
  }, [authStatus, currentIndex, currentProduct, orderItems, sessionRestored, saveMiniAppStateToServer, telegramUser?.initData, hasStateChanged]);

  useEffect(() => {
    const saveOnClose = () => {
      if (authStatus !== 'ok' || !telegramUser?.initData || !currentProduct) return;
      const body = JSON.stringify({ initData: telegramUser.initData, currentIndex, currentPage, productId: String(currentProduct.id), orderItems, viewMode });
      try {
        if (navigator.sendBeacon) { navigator.sendBeacon(`${BASE_URL}/v1/telegram/mini-app/state`, new Blob([body], { type: 'application/json' })); return; }
      } catch { /* ignore */ }
      try { fetch(`${BASE_URL}/v1/telegram/mini-app/state`, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }); } catch { /* ignore */ }
    };
    window.addEventListener('pagehide', saveOnClose);
    window.addEventListener('beforeunload', saveOnClose);
    return () => { window.removeEventListener('pagehide', saveOnClose); window.removeEventListener('beforeunload', saveOnClose); };
  }, [authStatus, currentIndex, currentPage, currentProduct, orderItems, telegramUser?.initData, viewMode]);

  // ---------- Зображення ----------
  const getProductImagePath = useCallback((product) => (
    product?.image_url || product?.imageUrls?.[0] || product?.localImageUrl || ''
  ), []);

  const getCurrentImageSrc = useCallback((product) => {
    if (!product) return '';
    const cached = imageCacheRef.current.get(String(product.id));
    return cached?.src || resolveImageUrl(getProductImagePath(product));
  }, [getProductImagePath]);

  const getProductGridImagePath = useCallback((product) => {
    if (!product) return '';
    const id = String(product.id);
    const idx = Number(imageIndexes[id] || 0);
    if (Array.isArray(product.imageUrls) && product.imageUrls[idx]) {
      return product.imageUrls[idx];
    }
    return product?.image_url || product?.imageUrls?.[0] || product?.localImageUrl || '';
  }, [imageIndexes]);

  const handleNextProductImage = useCallback((product) => {
    if (!product || !Array.isArray(product.imageUrls) || product.imageUrls.length <= 1) return;
    const id = String(product.id);
    setImageIndexes((prev) => {
      const current = Number(prev[id] || 0);
      const next = (current + 1) % product.imageUrls.length;
      return { ...prev, [id]: next };
    });
  }, []);

  useEffect(() => {
    for (let i = currentIndex + 1; i <= currentIndex + 6; i++) {
      const p = productMap.get(i);
      if (!p) continue;
      const id = String(p.id);
      if (imageCacheRef.current.has(id)) continue;
      const src = resolveImageUrl(getProductImagePath(p));
      if (!src) continue;
      const img = new Image();
      img.onload = () => imageCacheRef.current.set(id, { src, loaded: true });
      img.onerror = () => imageCacheRef.current.delete(id);
      imageCacheRef.current.set(id, { src, loaded: false });
      img.src = src;
    }
  }, [currentIndex, productMap, getProductImagePath]);

  // ---------- Жести ----------
  const openQuantityModal = useCallback((product) => {
    setSelectedProduct(product);
    setSelectedQty(orderItems[String(product.id)] || 1);
    setIsModalOpen(true);
  }, [orderItems]);

  const handleTap = useCallback(() => {
    if (!currentProduct) return;
    const now = Date.now();
    const productId = String(currentProduct.id);
    if (lastTapRef.current.productId === productId && now - lastTapRef.current.time <= DOUBLE_TAP_DELAY) {
      openQuantityModal(currentProduct);
      lastTapRef.current = { time: 0, productId: null };
      return;
    }
    lastTapRef.current = { time: now, productId };
  }, [currentProduct, openQuantityModal]);

  const onPointerDown = useCallback((event) => {
    pointerRef.current = {
      startX: event.clientX ?? event.touches?.[0]?.clientX ?? 0,
      startY: event.clientY ?? event.touches?.[0]?.clientY ?? 0,
      startTime: Date.now(),
    };
  }, []);

  const onPointerUp = useCallback((event) => {
    const endX = event.clientX ?? event.changedTouches?.[0]?.clientX ?? 0;
    const endY = event.clientY ?? event.changedTouches?.[0]?.clientY ?? 0;
    const dx = endX - pointerRef.current.startX;
    const dy = endY - pointerRef.current.startY;
    const dt = Date.now() - pointerRef.current.startTime;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SWIPE_MIN_DISTANCE && dt < 500) {
      if (dx < 0) goNext(); else goPrevious();
      return;
    }
    if (dt < 400 && Math.abs(dx) < 20 && Math.abs(dy) < 20) handleTap();
  }, [goNext, goPrevious, handleTap]);

  // ---------- Замовлення ----------
  const handleQuantitySubmit = () => {
    if (!selectedProduct) return;
    const quantity = Number(selectedQty);
    if (!quantity || quantity < 1) { toast.error('Вкажіть кількість більше 0'); return; }
    const productId = String(selectedProduct.id);
    const isEditing = Boolean(orderItems[productId]);
    setOrderItems((prev) => ({ ...prev, [productId]: quantity }));
    setIsModalOpen(false);
    toast.success(isEditing
      ? `Змінено кількість на ${quantity} шт.`
      : `Додано ${quantity} шт. до замовлення`);
  };

  const handleEditOrderItem = useCallback((productId) => {
    const product = [...productMap.values()].find((p) => String(p.id) === String(productId));
    if (!product) return;
    setSelectedProduct(product);
    setSelectedQty(orderItems[String(product.id)] || 1);
    setIsModalOpen(true);
  }, [orderItems, productMap]);

  const handleRemoveOrderItem = useCallback((productId) => {
    setOrderItems((prev) => {
      const next = { ...prev };
      delete next[String(productId)];
      return next;
    });
    toast.success('Позицію видалено з замовлення');
  }, []);

  const handleQuantityChange = (event) => {
    const value = event.target.value;
    if (!/^[0-9]*$/.test(value)) return;
    setSelectedQty(value === '' ? '' : Number(value));
  };

  const handlePlaceOrder = async () => {
    if (authStatus !== 'ok') { toast.error('Авторизація не пройдена'); return; }
    if (orderCount === 0) { toast.error('Додайте товари до замовлення'); return; }
    setIsSubmittingOrder(true);
    try {
      const items = [...productMap.values()]
        .filter((p) => orderItems[String(p.id)] > 0)
        .map((p) => ({ productId: String(p.id), name: p?.title || p?.name || 'Товар', price: p?.price || 0, quantity: orderItems[String(p.id)] }));
      await createOrder({ buyerTelegramId: telegramUser.id, initData: telegramUser.initData, items });
      setOrderItems({});
      setIsOrderModalOpen(false);
      toast.success('Замовлення оформлено!');
    } catch (err) { toast.error(err?.message || 'Помилка при оформленні замовлення'); }
    finally { setIsSubmittingOrder(false); }
  };

  const orderSummaryLines = [...productMap.values()]
    .filter((p) => orderItems[String(p.id)] > 0)
    .map((p) => ({ id: String(p.id), product: p, thumbnail: resolveImageUrl(getProductImagePath(p)), title: p?.title || p?.name || 'Товар', price: p?.price || 0, qty: orderItems[String(p.id)] }));
  const orderTotal = orderSummaryLines.reduce((s, { price, qty }) => s + price * qty, 0);

  // ---------- Реєстрація ----------
  const handleRegistrationFieldChange = (e) => {
    const { name, value } = e.target;
    setRegistrationFields((prev) => ({ ...prev, [name]: value }));
  };

  const handleRegisterSubmit = async (e) => {
    e.preventDefault();
    if (!telegramUser?.initData) { setRegistrationError('Telegram initData відсутній.'); return; }
    const { firstName, lastName, shopName, deliveryGroupId, role } = registrationFields;
    if (!firstName || !lastName || !role) {
      setRegistrationError('Будь ласка, заповніть всі обов’язкові поля.'); return;
    }
    if (role === 'seller' && !deliveryGroupId) {
      setRegistrationError('Оберіть групу доставки для продавця.'); return;
    }
    if (role === 'seller' && !shopName) {
      setRegistrationError('Назва магазину є обов’язковою для продавця.'); return;
    }
    setRegistrationStatus('submitting'); setRegistrationError('');
    try {
      await registerTelegramUser({ initData: telegramUser.initData, firstName, lastName, shopName, deliveryGroupId, role });
      setRegistrationStatus('submitted');
      toast.success('Заявку відправлено. Адміністратор отримає повідомлення.');
    } catch (err) {
      setRegistrationStatus('error');
      const message = err?.message === 'Registration request already exists'
        ? 'У вас вже є заявка, зачекайте на відповідь адміністратора.'
        : err?.message || 'Не вдалося надіслати заявку';
      setRegistrationError(message); toast.error(message);
    }
  };

  // ============================================================
  // RENDER
  // ============================================================
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 sm:px-6 lg:px-8">

        {/* Auth банери */}
        {authStatus === 'checking' && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-slate-700 bg-slate-800/50 px-4 py-3 text-sm text-slate-400">
            <span className="animate-pulse">⏳</span><span>Перевірка авторизації...</span>
          </div>
        )}
        {authStatus === 'ok' && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            <span>✅</span>
            <div>
              <span className="font-medium">Авторизовано</span>
              <span className="ml-2 text-emerald-400/70">{telegramUser?.firstName} · {telegramUser?.shopName || telegramUser?.role}</span>
            </div>
          </div>
        )}
        {authStatus === 'pending_registration' && (
          <div className="mb-6 rounded-3xl border border-amber-500/30 bg-amber-500/10 p-5 text-sm text-amber-300">
            <div className="flex items-start gap-3">
              <span className="mt-1">⏳</span>
              <div>
                <p className="font-medium text-white">Ваша заявка прийнята.</p>
                <p className="mt-1">Очікуйте підтвердження від адміністратора.</p>
              </div>
            </div>
          </div>
        )}
        {authStatus === 'not_registered' && (
          <div className="mb-6 grid gap-4 rounded-3xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-300">
            <div className="flex items-start gap-3">
              <span className="mt-1">🚫</span>
              <div>
                <p className="font-medium text-white">Ваш акаунт не зареєстрований.</p>
                <p className="mt-1">Ваш ідентифікатор: <span className="font-semibold text-white">{telegramUser?.id || 'невідомий'}</span> не зареєстровано в системі.</p>
              </div>
            </div>
            {registrationStatus === 'submitted' ? (
              <div className="rounded-3xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-200">Заявку відправлено. Адміністратор отримає повідомлення в Telegram.</div>
            ) : (
              <form className="grid gap-4" onSubmit={handleRegisterSubmit}>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block text-left text-xs uppercase tracking-[0.18em] text-slate-400">
                    Роль
                    <select name="role" value={registrationFields.role} onChange={handleRegistrationFieldChange}
                      className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-cyan-500">
                      <option value="seller">Продавець</option>
                      <option value="warehouse">Склад</option>
                    </select>
                  </label>
                  {registrationFields.role === 'seller' && (
                    <label className="block text-left text-xs uppercase tracking-[0.18em] text-slate-400">
                      Група доставки
                      <select name="deliveryGroupId" value={registrationFields.deliveryGroupId} onChange={handleRegistrationFieldChange}
                        className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-cyan-500">
                        <option value="">Оберіть групу доставки</option>
                        {deliveryGroupsLoading ? <option disabled>Завантаження...</option>
                          : deliveryGroups.map((g) => <option key={g._id} value={g._id}>{g.name} — {DAY_SHORT[g.dayOfWeek] || 'День'}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {[["firstName","Ім'я","Ім'я"],["lastName","Прізвище","Прізвище"]].map(([name, label, placeholder]) => (
                    <label key={name} className="block text-left text-xs uppercase tracking-[0.18em] text-slate-400">
                      {label}
                      <input name={name} value={registrationFields[name]} onChange={handleRegistrationFieldChange} placeholder={placeholder}
                        className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-cyan-500" />
                    </label>
                  ))}
                  {registrationFields.role === 'seller' && (
                    <label className="block text-left text-xs uppercase tracking-[0.18em] text-slate-400">
                      Назва магазину
                      <input name="shopName" value={registrationFields.shopName} onChange={handleRegistrationFieldChange} placeholder="Назва магазину"
                        className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white outline-none focus:border-cyan-500" />
                    </label>
                  )}
                </div>
                {registrationError && <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{registrationError}</div>}
                <button type="submit" disabled={registrationStatus === 'submitting'}
                  className="w-full rounded-3xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:opacity-50">
                  {registrationStatus === 'submitting' ? 'Відправка...' : 'Надіслати заявку на реєстрацію'}
                </button>
              </form>
            )}
          </div>
        )}
        {authStatus === 'no_telegram' && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            <span>⚠️</span><span>Відкрийте через Telegram, щоб оформити замовлення</span>
          </div>
        )}
        {authStatus === 'error' && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <span>❌</span><span>{authMessage}</span>
          </div>
        )}

        {authStatus === 'ok' && (
          <>
            {(isAdmin || isWarehouse) && (
              <div className="mb-4 flex flex-wrap gap-2">
                {miniAppPages.map((p) => (
                  <button key={p.id} type="button" onClick={() => setActiveMiniAppPage(p.id)}
                    className={`rounded-3xl border px-4 py-2 text-sm font-medium transition ${activeMiniAppPage === p.id ? 'border-cyan-500 bg-cyan-500 text-slate-950' : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:bg-slate-900'}`}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            {activeMiniAppPage === 'orders' ? (
              <>
                <div className="mb-4 flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setViewMode('carousel')}
                    aria-label="Карусель"
                    className={`rounded-3xl border px-4 py-2 text-sm font-medium transition ${viewMode === 'carousel' ? 'border-cyan-500 bg-cyan-500 text-slate-950' : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:bg-slate-900'}`}>
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 6h16M4 12h16M4 18h16" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('grid')}
                    aria-label="Плитка"
                    className={`rounded-3xl border px-4 py-2 text-sm font-medium transition ${viewMode === 'grid' ? 'border-cyan-500 bg-cyan-500 text-slate-950' : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500 hover:bg-slate-900'}`}>
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="8" height="8" />
                      <rect x="13" y="3" width="8" height="8" />
                      <rect x="3" y="13" width="8" height="8" />
                      <rect x="13" y="13" width="8" height="8" />
                    </svg>
                  </button>
                </div>
                {viewMode === 'carousel' ? (
                  <div className="relative flex-1 overflow-hidden rounded-[2rem] border border-slate-800 bg-slate-900 shadow-2xl shadow-slate-950/40">
                  {isCurrentLoading ? (
                    <ProductSkeleton />
                  ) : currentProduct ? (
                    <div className="relative flex h-full flex-col"
                      onTouchStart={onPointerDown} onTouchEnd={onPointerUp}
                      onMouseDown={onPointerDown} onMouseUp={onPointerUp}
                      style={{ touchAction: 'pan-y' }}>
                      <div className="relative flex-1 bg-slate-950 flex items-center justify-center">
                        <img className="max-h-full max-w-full object-contain" src={getCurrentImageSrc(currentProduct)} alt={currentProduct.name || 'Товар'} draggable={false} />
                        <div className="absolute inset-x-0 top-4 flex items-center justify-center px-4">
                          <span className="rounded-3xl border border-slate-700 bg-slate-900/75 px-4 py-2 text-sm text-slate-100">
                            {currentIndex + 1} / {totalCount || '…'}
                          </span>
                        </div>
                      </div>
                      <div className="space-y-4 border-t border-slate-800 bg-slate-950/90 px-5 py-5 text-slate-200">
                        <div className="flex flex-wrap items-center justify-between gap-4">
                          <div>
                            <h2 className="text-xl font-semibold text-white">{currentProduct.name || ''}</h2>
                            {Number(orderItems[String(currentProduct.id)]) > 0 ? (
                              <div className="mt-2 text-sm font-semibold text-amber-300">Вже в кошику - {orderItems[String(currentProduct.id)]} шт.</div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[420px] items-center justify-center px-6 py-10 text-center text-slate-400">Товарів поки що немає.</div>
                  )}
                </div>
                ) : (
                  <>
                    <div ref={gridPageTopRef} />
                  <div className="grid gap-3 sm:grid-cols-2">
                      {currentPageProducts.length ? currentPageProducts.map(({ index, product }) => {
                        const isSelected = index === currentIndex;
                        const imageSrc = resolveImageUrl(getProductGridImagePath(product));
                        const imageCount = Array.isArray(product.imageUrls) ? product.imageUrls.length : 0;
                        return (
                          <div
                            key={index}
                            role="button"
                            tabIndex={0}
                            onClick={() => { setCurrentIndex(index); openQuantityModal(product); }}
                            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCurrentIndex(index); openQuantityModal(product); } }}
                            className={`flex flex-col rounded-2xl border p-3 text-left transition ${isSelected ? 'border-cyan-500 bg-slate-900' : 'border-slate-700 bg-slate-950 hover:border-cyan-500 hover:bg-slate-900'}`}>
                            <div className="relative mb-3 w-full overflow-hidden rounded-2xl bg-slate-800 flex items-center justify-center">
                              {imageSrc ? (
                                <img src={imageSrc} alt={product.name || 'Товар'} className="max-w-full h-auto object-contain" />
                              ) : (
                                <div className="flex min-h-[160px] w-full items-center justify-center text-sm text-slate-500">Фото</div>
                              )}
                              {imageCount > 1 && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleNextProductImage(product); }}
                                  className="absolute right-3 top-3 rounded-full border border-slate-600 bg-slate-950/80 px-3 py-1 text-[10px] text-slate-200 hover:border-cyan-500">
                                  Наступне фото
                                </button>
                              )}
                            </div>
                            <div className="min-h-[44px]">
                              {Number(orderItems[String(product.id)]) > 0 ? (
                                <div className="text-sm font-semibold text-amber-300">Вже в кошику - {orderItems[String(product.id)]} шт.</div>
                              ) : null}
                            </div>
                          </div>
                        );
                      }) : (
                        <div className="col-span-2 flex min-h-[240px] items-center justify-center text-slate-400">Завантаження товарів...</div>
                      )}
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          if (currentPage > 0) {
                            const nextPage = currentPage - 1;
                            setCurrentPage(nextPage);
                            setCurrentIndex(nextPage * PAGE_SIZE);
                          }
                        }}
                        className="rounded-3xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:border-cyan-500 hover:bg-slate-900"
                        disabled={currentPage === 0}>
                        Назад
                      </button>
                      <div className="text-sm text-slate-400">Сторінка {currentPage + 1}</div>
                      <button
                        type="button"
                        onClick={() => {
                          if (hasMore || currentPageProducts.length === PAGE_SIZE) {
                            const nextPage = currentPage + 1;
                            setCurrentPage(nextPage);
                            setCurrentIndex(nextPage * PAGE_SIZE);
                          }
                        }}
                        className="rounded-3xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:border-cyan-500 hover:bg-slate-900"
                        disabled={!hasMore && currentPageProducts.length < PAGE_SIZE}>
                        Далі
                      </button>
                    </div>
                  </>
                )}
                <div className="mt-4 flex justify-end">
                  <button type="button" onClick={handleResetMiniAppState}
                    className="rounded-3xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition hover:border-cyan-500 hover:bg-slate-900">
                    Почати спочатку
                  </button>
                </div>
              </>
            ) : activeMiniAppPage === 'warehouse' ? <WarehouseBoardPage />              : activeMiniAppPage === 'new-products' ? <IncomingProductsPage />              : activeMiniAppPage === 'archive' ? <ArchivePage onRestoreSuccess={() => setActiveMiniAppPage('warehouse')} />
              : activeMiniAppPage === 'users' ? <UsersPage />
              : activeMiniAppPage === 'settings' ? <SettingsPage />
              : null}

            {activeMiniAppPage === 'orders' && orderCount > 0 && (
              <div className="mt-6">
                <button type="button" onClick={() => setIsOrderModalOpen(true)}
                  className="w-full rounded-3xl bg-emerald-500 px-6 py-4 text-base font-semibold text-white transition hover:bg-emerald-400">
                  Замовити 
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Модалка кількості */}
      <Modal open={isModalOpen} title={selectedProduct ? 'Замовити' : 'Кількість'} onClose={() => setIsModalOpen(false)} zIndex={60}>
        <div className="space-y-4">
          <p className="text-slate-300">Введіть нову кількість.</p>
          <input className="w-full rounded-3xl border border-slate-700 bg-slate-950 px-4 py-3 text-lg text-white outline-none focus:border-cyan-500"
            type="number" min="1" value={selectedQty} onChange={handleQuantityChange} />
          <button type="button" onClick={handleQuantitySubmit}
            className="w-full rounded-3xl bg-cyan-500 px-4 py-3 text-base font-semibold text-slate-950 transition hover:bg-cyan-400">
            {selectedProduct && orderItems[String(selectedProduct.id)] ? 'Змінити кількість' : 'Додати в кошик'}
          </button>
        </div>
      </Modal>

      {/* Модалка замовлення */}
      <Modal open={isOrderModalOpen} title="Підтвердити замовлення" onClose={() => setIsOrderModalOpen(false)}>
        <div className="space-y-4">
          <div className="overflow-hidden rounded-2xl border border-slate-700 bg-slate-900">
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-sm text-slate-200">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-950/80 text-xs uppercase tracking-[0.18em] text-slate-500">
                    <th className="px-4 py-3 text-center w-[40px]">Фото</th>
                    <th className="px-4 py-3 text-center">Кількість</th>
                    <th className="px-4 py-3 text-center">Ціна</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {orderSummaryLines.map(({ id, product, thumbnail, title, price, qty }) => (
                    <tr key={id} className="bg-slate-900">
                      <td className="px-4 py-3 align-top text-center">
                        <div className="mx-auto h-[40px] w-[40px] overflow-hidden rounded-xl bg-slate-950" title={title}>
                          {thumbnail ? <img src={thumbnail} alt={title} className="h-full w-full object-cover" />
                            : <div className="flex h-full items-center justify-center text-[10px] text-slate-500">Фото</div>}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-center text-slate-200">
                        <div>{qty} шт</div>
                        <div className="mt-3 flex justify-center gap-2">
                          <button type="button" onClick={() => handleEditOrderItem(id)}
                            className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[11px] font-semibold text-slate-200 transition hover:border-cyan-500 hover:text-white whitespace-nowrap">
                            Редагувати
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-center text-slate-400">
                        <div>{price * qty} zł</div>
                        <div className="mt-3 flex justify-center">
                          <button type="button" onClick={() => handleRemoveOrderItem(id)}
                            className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-[11px] font-semibold text-slate-200 transition hover:border-rose-500 hover:text-rose-200 whitespace-nowrap">
                            Видалити
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-2xl bg-slate-800/60 px-4 py-3 text-sm font-semibold">
            <span className="text-slate-300">Разом</span><span className="text-white">{orderTotal} zł</span>
          </div>
          {telegramUser && <p className="text-xs text-slate-500">Замовлення буде пов'язано з Telegram ID {telegramUser.id}</p>}
          <button type="button" onClick={handlePlaceOrder} disabled={isSubmittingOrder || authStatus !== 'ok'}
            className="w-full rounded-3xl bg-emerald-500 px-4 py-3 text-base font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50">
            {isSubmittingOrder ? 'Відправляємо...' : 'Підтвердити замовлення'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
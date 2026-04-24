const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:5000/api';
const SERVER_URL = BASE_URL.replace(/\/api$/, '');

function getTelegramInitData() {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp?.initData || null;
}

export function resolveImageUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${SERVER_URL}${url}`;
}

async function request(path, options = {}) {
  const telegramInitData = getTelegramInitData();
  const headers = {
    ...(options.headers || {}),
    ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(telegramInitData ? { 'x-telegram-initdata': telegramInitData } : {}),
  };

  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const payload = await response.json().catch(async () => {
      const text = await response.text().catch(() => response.statusText);
      return { message: text };
    });
    const message = payload?.message || payload?.error || response.statusText;
    throw new Error(message || 'API request failed');
  }

  return response.json();
}

export const getProducts = () => request('/products').then((data) => data?.items || data);
export const getProductsPage = (params = {}) => {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', params.limit);
  if (params.offset !== undefined && params.offset !== null) q.set('offset', params.offset);
  if (params.date_filter) q.set('date_filter', params.date_filter);
  const qs = q.toString();
  return request(`/v1/products${qs ? `?${qs}` : ''}`);
};
export const getPendingProducts = () => request('/products/pending');
export const getOrders = (params = {}) => {
  const q = new URLSearchParams();
  if (params.page) q.set('page', params.page);
  if (params.pageSize) q.set('pageSize', params.pageSize);
  if (params.status) q.set('status', params.status);
  if (params.buyerTelegramId) q.set('buyerTelegramId', params.buyerTelegramId);
  const qs = q.toString();
  return request(`/orders${qs ? `?${qs}` : ''}`);
};
export const updateOrder = (id, payload) => request(`/orders/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const getUsers = () => request('/users');
export const resetMiniAppState = () => request('/v1/telegram/mini-app/reset-state', { method: 'POST' });
export const getRegistrationRequests = () => request('/v1/telegram/register-requests');
export const approveRegistrationRequest = (id) => request(`/v1/telegram/register-requests/${id}/approve`, { method: 'POST' });
export const rejectRegistrationRequest = (id) => request(`/v1/telegram/register-requests/${id}/reject`, { method: 'POST' });
export const getBotStatus = () => request('/bot-status');
export const getOpenAIStatus = () => request('/openai-status');
export const runLoadTest = () => request('/admin/load-test', { method: 'POST' });
export const downloadLoadTestReport = async () => {
  const telegramInitData = getTelegramInitData();
  const response = await fetch(`${BASE_URL}/admin/load-test-report`, {
    method: 'GET',
    headers: {
      ...(telegramInitData ? { 'x-telegram-initdata': telegramInitData } : {}),
    },
  });

  if (!response.ok) {
    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new Error(response.statusText || 'Failed to download report');
    }
    throw new Error(payload?.message || payload?.error || response.statusText || 'Failed to download report');
  }

  const blob = await response.blob();
  return blob;
};
export const createProduct = (payload) => {
  if (payload instanceof FormData) {
    const telegramInitData = getTelegramInitData();
    return fetch(`${BASE_URL}/products`, {
      method: 'POST',
      body: payload,
      headers: {
        ...(telegramInitData ? { 'x-telegram-initdata': telegramInitData } : {}),
      },
    }).then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(error.message || 'API request failed');
      }
      return response.json();
    });
  }

  return request('/products', { method: 'POST', body: JSON.stringify(payload) });
};
export const updateProduct = (id, payload) => {
  if (payload instanceof FormData) {
    const telegramInitData = getTelegramInitData();
    return fetch(`${BASE_URL}/products/${id}`, {
      method: 'PATCH',
      body: payload,
      headers: {
        ...(telegramInitData ? { 'x-telegram-initdata': telegramInitData } : {}),
      },
    }).then(async (response) => {
      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(error.message || 'API request failed');
      }
      return response.json();
    });
  }

  return request(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
};
export const deleteProduct = (id) => request(`/products/${id}`, { method: 'DELETE' });
export const createUser = (payload) => request('/users', { method: 'POST', body: JSON.stringify(payload) });
export const deleteUser = (telegramId) => request(`/users/${telegramId}`, { method: 'DELETE' });
export const createOrder = (payload) => request('/v1/orders', { method: 'POST', body: JSON.stringify(payload) });
export const getOrder = (id) => request(`/v1/orders/${id}`);
export const validateTelegramInitData = (initData) => request('/v1/telegram/validate', { method: 'POST', body: JSON.stringify({ initData }) });
export const saveMiniAppState = (payload) => request('/v1/telegram/mini-app/state', { method: 'POST', body: JSON.stringify(payload) });
export const registerTelegramUser = (payload) => request('/v1/telegram/register-request', { method: 'POST', body: JSON.stringify(payload) });

export const getDeliveryGroups = () => request('/delivery-groups');
export const createDeliveryGroup = (payload) => request('/delivery-groups', { method: 'POST', body: JSON.stringify(payload) });
export const updateDeliveryGroup = (id, payload) => request(`/delivery-groups/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
export const deleteDeliveryGroup = (id) => request(`/delivery-groups/${id}`, { method: 'DELETE' });
export const broadcastToGroup = (id) => request(`/delivery-groups/${id}/broadcast`, { method: 'POST' });

export const getArchive = ({ page = 1, pageSize = 20 } = {}) =>
  request(`/archive?page=${page}&pageSize=${pageSize}`);

export const restoreFromArchive = (id) =>
  request(`/archive/${id}/restore`, { method: 'POST' });

export const permanentlyDeleteArchived = (id) =>
  request(`/archive/${id}`, { method: 'DELETE' });

// Blocks / Warehouse Board
export const getBlocks = () => request('/blocks');
export const getBlock = (number) => request(`/blocks/${number}`);
export const createBlock = () => request('/blocks', { method: 'POST' });
export const moveBlock = (payload) => request('/blocks/move', { method: 'POST', body: JSON.stringify(payload) });
export const getIncomingProducts = () => request('/blocks/incoming/products');
export const addToBlock = (blockNumber, productId, index) =>
  request(`/blocks/${blockNumber}/add`, { method: 'POST', body: JSON.stringify({ productId, index }) });
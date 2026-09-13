'use strict';

const { appError } = require('../../../utils/errors');
const { getEnvironment } = require('./config');

function extractProviderCode(body) {
  const values = [body?.exception?.exceptionCode, body?.exceptionCode, body?.code, body?.status?.code];
  for (const value of values) if (value !== undefined && value !== null && String(value)) return String(value);
  return '';
}
function extractMessage(body, status) {
  return String(body?.title || body?.detail || body?.message || body?.exception?.exceptionDescription || `KSeF HTTP ${status}`).slice(0, 1000);
}
async function ksefRequest(environment, path, { method = 'GET', token = '', body, timeoutMs = 15000 } = {}) {
  const env = getEnvironment(environment);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-Error-Format': 'problem-details',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text.slice(0, 4000) }; } }
    if (!response.ok) {
      const providerCode = extractProviderCode(parsed);
      const details = { httpStatus: response.status, providerCode, retryAfter: response.headers.get('retry-after') || '', providerMessage: extractMessage(parsed, response.status) };
      if (response.status === 429) throw appError('ksef_rate_limited', details);
      if (response.status === 401 || response.status === 403) throw appError('ksef_auth_failed', details);
      const error = appError('ksef_api_error', details);
      error.ksef = details;
      throw error;
    }
    return { status: response.status, body: parsed, headers: response.headers };
  } catch (error) {
    if (error?.name === 'AbortError') throw appError('ksef_api_timeout');
    if (error?.code && String(error.code).startsWith('ksef_')) throw error;
    throw appError('ksef_api_unavailable', { cause: String(error?.message || error).slice(0, 500) });
  } finally { clearTimeout(timer); }
}

module.exports = { ksefRequest, extractProviderCode };

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
function parseJsonText(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return { raw: String(text).slice(0, 4000) }; }
}
async function ksefRequest(environment, path, {
  method = 'GET', token = '', body, rawBody, contentType = '', timeoutMs = 15000, responseType = 'json', accept = '', headers = {},
} = {}) {
  const env = getEnvironment(environment);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    if (body !== undefined && rawBody !== undefined) throw appError('ksef_http_body_conflict');
    const hasBody = body !== undefined || rawBody !== undefined;
    const response = await fetch(`${env.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: accept || (['text', 'buffer'].includes(responseType) ? 'application/xml,text/xml;q=0.9,*/*;q=0.1' : 'application/json'),
        'X-Error-Format': 'problem-details',
        ...(hasBody ? { 'Content-Type': contentType || (rawBody !== undefined ? 'application/octet-stream' : 'application/json') } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      const errorBody = parseJsonText(text);
      const providerCode = extractProviderCode(errorBody);
      const details = {
        httpStatus: response.status,
        providerCode,
        retryAfter: response.headers.get('retry-after') || '',
        providerMessage: extractMessage(errorBody, response.status),
      };
      if (response.status === 429) throw appError('ksef_rate_limited', details);
      if (response.status === 401 || response.status === 403) throw appError('ksef_auth_failed', details);
      const error = appError('ksef_api_error', details);
      error.ksef = details;
      throw error;
    }
    if (responseType === 'buffer') {
      const bytes = Buffer.from(await response.arrayBuffer());
      return { status: response.status, body: bytes, headers: response.headers };
    }
    const text = await response.text();
    const parsed = responseType === 'text' ? text : parseJsonText(text);
    return { status: response.status, body: parsed, headers: response.headers };
  } catch (error) {
    if (error?.name === 'AbortError') throw appError('ksef_api_timeout');
    if (error?.code && String(error.code).startsWith('ksef_')) throw error;
    throw appError('ksef_api_unavailable', { cause: String(error?.message || error).slice(0, 500) });
  } finally { clearTimeout(timer); }
}

module.exports = { ksefRequest, extractProviderCode };

const { appError } = require('../utils/errors');

const BASELINKER_API_URL = process.env.BASELINKER_API_URL || 'https://api.baselinker.com/connector.php';
const BASELINKER_TIMEOUT_MS = Math.min(30000, Math.max(3000, Number(process.env.BASELINKER_TIMEOUT_MS) || 15000));

function getBaseLinkerToken() {
  return String(process.env.BASELINKER_API_TOKEN || '').trim();
}

function isBaseLinkerConfigured() {
  return Boolean(getBaseLinkerToken());
}

function cleanUpstreamText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

async function callBaseLinker(method, parameters = {}) {
  const token = getBaseLinkerToken();
  if (!token) throw appError('baselinker_not_configured');

  const upstreamMethod = cleanUpstreamText(method, 80) || 'unknown';
  const body = new URLSearchParams();
  body.set('method', upstreamMethod);
  body.set('parameters', JSON.stringify(parameters || {}));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BASELINKER_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(BASELINKER_API_URL, {
      method: 'POST',
      headers: {
        'X-BLToken': token,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw appError('baselinker_timeout', { upstreamMethod });
    }
    throw appError('baselinker_network_error', {
      upstreamMethod,
      upstreamMessage: cleanUpstreamText(error?.message),
    });
  } finally {
    clearTimeout(timer);
  }

  // Read the body once even for non-2xx responses. If BaseLinker supplied its own
  // error_code/error_message we keep them all the way to the operator instead of
  // collapsing every upstream failure into one generic sentence.
  let rawText = '';
  let payload = null;
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw appError('baselinker_http_error', {
      upstreamMethod,
      upstreamStatus: response.status,
      upstreamCode: cleanUpstreamText(payload?.error_code, 120),
      upstreamMessage: cleanUpstreamText(payload?.error_message || rawText),
    });
  }

  if (!payload || typeof payload !== 'object') {
    throw appError('baselinker_invalid_response', {
      upstreamMethod,
      upstreamStatus: response.status,
    });
  }

  if (payload.status !== 'SUCCESS') {
    throw appError('baselinker_api_error', {
      upstreamMethod,
      upstreamCode: cleanUpstreamText(payload?.error_code, 120),
      upstreamMessage: cleanUpstreamText(payload?.error_message),
    });
  }

  return payload;
}

module.exports = {
  callBaseLinker,
  isBaseLinkerConfigured,
};

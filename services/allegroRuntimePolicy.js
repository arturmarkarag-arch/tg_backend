'use strict';

function isMissingOptionalNumber(value) {
  return value === null
    || value === undefined
    || (typeof value === 'string' && value.trim() === '');
}

function parseOptionalNonNegativeNumber(value) {
  if (isMissingOptionalNumber(value)) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function parseOptionalNonNegativeInteger(value) {
  const numeric = parseOptionalNonNegativeNumber(value);
  return numeric !== null && Number.isInteger(numeric) ? numeric : null;
}

function retryDelayMs({ attempt, retryAfterMs = null, random = Math.random } = {}) {
  const explicitDelay = parseOptionalNonNegativeNumber(retryAfterMs);
  if (explicitDelay !== null) return explicitDelay;

  const safeAttempt = Math.max(1, Number(attempt) || 1);
  const base = Math.min(2000, 250 * (2 ** Math.max(0, safeAttempt - 1)));
  const jitterWindow = Math.max(1, Math.floor(base / 2));
  const randomValue = typeof random === 'function' ? Number(random()) : Math.random();
  const normalizedRandom = Number.isFinite(randomValue)
    ? Math.min(0.999999999, Math.max(0, randomValue))
    : Math.random();
  return base + Math.floor(normalizedRandom * jitterWindow);
}

function shouldReuseRotatedTokenAfterForcedRefresh({
  forceRefresh = false,
  rejectedTokenRevision = null,
  currentTokenRevision = 0,
  tokenUsable = false,
} = {}) {
  if (!forceRefresh || !tokenUsable) return false;
  const rejectedRevision = parseOptionalNonNegativeInteger(rejectedTokenRevision);
  if (rejectedRevision === null) return false;
  const currentRevision = parseOptionalNonNegativeInteger(currentTokenRevision);
  return currentRevision !== null && currentRevision > rejectedRevision;
}

module.exports = {
  parseOptionalNonNegativeNumber,
  parseOptionalNonNegativeInteger,
  retryDelayMs,
  shouldReuseRotatedTokenAfterForcedRefresh,
};

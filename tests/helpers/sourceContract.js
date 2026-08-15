'use strict';

function indexOrThrow(source, token, { from = 0, label = token } = {}) {
  const index = source.indexOf(token, from);
  if (index < 0) throw new Error(`Source-contract anchor missing: ${label}`);
  return index;
}

function sliceIndexesOrThrow(source, start, end, { label = 'source slice' } = {}) {
  if (!Number.isInteger(start) || start < 0) throw new Error(`Source-contract start index missing: ${label}`);
  if (!Number.isInteger(end) || end < 0) throw new Error(`Source-contract end index missing: ${label}`);
  if (end <= start) throw new Error(`Source-contract anchors out of order: ${label}`);
  return source.slice(start, end);
}

function sliceFromOrThrow(source, startToken, { from = 0, label = startToken } = {}) {
  const start = indexOrThrow(source, startToken, { from, label: `${label} start` });
  return source.slice(start);
}

function sliceBetweenOrThrow(source, startToken, endToken, { from = 0, label = `${startToken} -> ${endToken}` } = {}) {
  const start = indexOrThrow(source, startToken, { from, label: `${label} start` });
  const end = indexOrThrow(source, endToken, { from: start + startToken.length, label: `${label} end` });
  if (end <= start) throw new Error(`Source-contract anchors out of order: ${label}`);
  return source.slice(start, end);
}

module.exports = { indexOrThrow, sliceIndexesOrThrow, sliceFromOrThrow, sliceBetweenOrThrow };

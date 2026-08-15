'use strict';

const MAX_COMMENTS = 12;
const MAX_COMMENT_LENGTH = 500;

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizePos(pos, fallback = { x: 0.5, y: 0.5 }) {
  if (!pos || typeof pos !== 'object') return { ...fallback };
  return {
    x: clamp01(pos.x, fallback.x),
    y: clamp01(pos.y, fallback.y),
  };
}

function normalizeOptionalPos(pos) {
  if (!pos || typeof pos !== 'object') return null;
  return normalizePos(pos);
}

function normalizePhotoComments(photoMeta) {
  const pm = photoMeta && typeof photoMeta === 'object' ? photoMeta : {};
  const rawComments = Array.isArray(pm.comments) ? pm.comments : [];
  const comments = [];

  for (let i = 0; i < rawComments.length && comments.length < MAX_COMMENTS; i += 1) {
    const row = rawComments[i];
    if (!row || typeof row !== 'object') continue;
    const text = String(row.text ?? row.comment ?? '').trim().slice(0, MAX_COMMENT_LENGTH);
    if (!text) continue;
    const id = String(row.id || `comment-${i + 1}`).slice(0, 80);
    comments.push({
      id,
      text,
      pos: normalizePos(row.pos || row.commentPos),
    });
  }

  // Backward compatibility: old ReceiptItem rows only have comment/commentPos.
  if (comments.length === 0) {
    const legacyText = String(pm.comment || '').trim().slice(0, MAX_COMMENT_LENGTH);
    if (legacyText) {
      comments.push({
        id: 'legacy-comment',
        text: legacyText,
        pos: normalizePos(pm.commentPos),
      });
    }
  }

  return comments;
}

function normalizeReceiptPhotoMeta(photoMeta) {
  if (!photoMeta || typeof photoMeta !== 'object') return null;
  const comments = normalizePhotoComments(photoMeta);
  const first = comments[0] || null;
  return {
    // Keep the original single-comment fields populated so cached/legacy clients
    // and old Product.labelPositions code continue to read the first annotation.
    comment: first?.text || '',
    commentPos: first?.pos || { x: 0.5, y: 0.5 },
    comments,
    pricePos: normalizeOptionalPos(photoMeta.pricePos),
    qtyPos: normalizeOptionalPos(photoMeta.qtyPos),
  };
}

function labelPositionsFromPhotoMeta(photoMeta) {
  const pm = normalizeReceiptPhotoMeta(photoMeta) || {
    comments: [],
    pricePos: null,
    qtyPos: null,
  };
  const out = {};
  if (pm.comments.length > 0) {
    const first = pm.comments[0];
    out.commentX = first.pos.x;
    out.commentY = first.pos.y;
    out.comments = pm.comments.map((comment) => ({
      id: comment.id,
      text: comment.text,
      x: comment.pos.x,
      y: comment.pos.y,
    }));
  }
  if (pm.pricePos) { out.priceX = pm.pricePos.x; out.priceY = pm.pricePos.y; }
  if (pm.qtyPos)   { out.qtyX = pm.qtyPos.x;     out.qtyY = pm.qtyPos.y; }
  return out;
}

function photoCommentsText(photoMeta) {
  return normalizePhotoComments(photoMeta).map((comment) => comment.text).join('\n');
}

module.exports = {
  MAX_COMMENTS,
  normalizePhotoComments,
  normalizeReceiptPhotoMeta,
  labelPositionsFromPhotoMeta,
  photoCommentsText,
};

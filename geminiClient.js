'use strict';

// ─── Gemini Embedding 2 client ──────────────────────────────────────────────
// Multimodal embeddings (gemini-embedding-2). Replaces the OpenAI two-step
// (gpt-4o-mini descriptor → text-embedding-3-small) with a single native
// image→vector call: the photo's pixels are embedded directly.
//
// We talk to the REST API over axios (already a dependency) instead of pulling
// in @google/genai — zero new deps, no ESM/CJS friction, and the request shape
// is tiny. Endpoint: POST {BASE}/models/{model}:embedContent
//
// Notes baked into this module:
//   • gemini-embedding-2 is multimodal — `content.parts` may mix text + inline
//     image data and produces ONE aggregated vector.
//   • Output dimensionality is configurable (128–3072; we default to 3072).
//     The model AUTO-NORMALIZES truncated dims, so no manual L2 norm needed.
//   • Unlike v1 (gemini-embedding-001), gemini-embedding-2 does NOT accept a
//     taskType field — task context, if any, is folded into the text part.

const axios = require('axios');

const GEMINI_BASE_URL =
  process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_EMBEDDING_MODEL =
  process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const GEMINI_EMBEDDING_DIMENSIONS =
  Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 3072;

let apiKey = null;
let geminiStatus = { connected: false, error: 'GEMINI_API_KEY not configured' };

function initGemini(key) {
  apiKey = key || null;
  if (!apiKey) {
    geminiStatus = { connected: false, error: 'GEMINI_API_KEY not configured' };
    console.warn(geminiStatus.error);
    return;
  }
  // We can't verify the key without a network call; mark configured and let the
  // first real request (or verifyGeminiConnection) surface auth errors.
  geminiStatus = { connected: true, error: null };
}

function getGeminiStatus() {
  return { connected: geminiStatus.connected, error: geminiStatus.error };
}

// Low-level embedContent call. `parts` is the Gemini content.parts array.
async function embedParts(parts) {
  if (!apiKey) throw new Error(geminiStatus.error || 'GEMINI_API_KEY not configured');
  const url = `${GEMINI_BASE_URL}/models/${GEMINI_EMBEDDING_MODEL}:embedContent`;
  const body = {
    model: `models/${GEMINI_EMBEDDING_MODEL}`,
    content: { parts },
    outputDimensionality: GEMINI_EMBEDDING_DIMENSIONS,
  };
  const res = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    timeout: 30000,
  });
  // embedContent (singular) → { embedding: { values: [...] } }.
  const values =
    res.data?.embedding?.values || res.data?.embeddings?.[0]?.values || null;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('gemini_empty_embedding');
  }
  return values;
}

// Embeds a raw image buffer. `extraText` is optional reinforcing text (e.g. a
// product name) folded into the same vector; leave empty for pure image↔image.
async function embedImageBuffer(buffer, mimeType = 'image/jpeg', { extraText = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { embedding: null, model: GEMINI_EMBEDDING_MODEL, dimensions: GEMINI_EMBEDDING_DIMENSIONS };
  }
  const parts = [];
  const text = String(extraText || '').trim();
  if (text) parts.push({ text });
  parts.push({ inline_data: { mime_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } });
  const embedding = await embedParts(parts);
  return { embedding, model: GEMINI_EMBEDDING_MODEL, dimensions: embedding.length };
}

// Fetches an image by URL (e.g. an R2 public original) and embeds it. Unlike the
// old OpenAI path, Gemini's embedContent has no "fetch by URL" mode — we must
// pull the bytes ourselves and inline them, so the image DOES transit our server.
async function embedImageUrl(imageUrl, { extraText = '' } = {}) {
  if (!apiKey) throw new Error(geminiStatus.error || 'GEMINI_API_KEY not configured');
  if (!imageUrl) {
    return { embedding: null, model: GEMINI_EMBEDDING_MODEL, dimensions: GEMINI_EMBEDDING_DIMENSIONS };
  }
  const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(imgRes.data);
  const mimeType = imgRes.headers?.['content-type'] || guessMimeFromUrl(imageUrl);
  return embedImageBuffer(buffer, mimeType, { extraText });
}

// Pure-text embedding — same vector space as images. Used by the (future) text
// query path so a typed query and a product photo are directly comparable.
async function embedText(text) {
  if (!apiKey) throw new Error(geminiStatus.error || 'GEMINI_API_KEY not configured');
  const clean = String(text || '').trim();
  if (!clean) return { embedding: null, model: GEMINI_EMBEDDING_MODEL, dimensions: GEMINI_EMBEDDING_DIMENSIONS };
  const embedding = await embedParts([{ text: clean }]);
  return { embedding, model: GEMINI_EMBEDDING_MODEL, dimensions: embedding.length };
}

function guessMimeFromUrl(url) {
  const u = String(url).toLowerCase();
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.webp')) return 'image/webp';
  if (u.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

// Light connectivity/auth check — embeds a 1-token string. Cheap, within free tier.
async function verifyGeminiConnection() {
  if (!apiKey) throw new Error(geminiStatus.error || 'GEMINI_API_KEY not configured');
  const { embedding } = await embedText('ping');
  return {
    status: 'ok',
    model: GEMINI_EMBEDDING_MODEL,
    dimensions: Array.isArray(embedding) ? embedding.length : GEMINI_EMBEDDING_DIMENSIONS,
  };
}

module.exports = {
  GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_DIMENSIONS,
  initGemini,
  getGeminiStatus,
  verifyGeminiConnection,
  embedImageBuffer,
  embedImageUrl,
  embedText,
};

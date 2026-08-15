'use strict';

/**
 * Live capability/egress probe. ALWAYS run through ../dev-use-test-db.js.
 * Dry-run by default. --execute uploads one tiny temporary PNG to vision-tmp/,
 * compares current inline/base64 Gemini requests with direct external-URL forms,
 * and deletes the object in finally.
 */

const crypto = require('crypto');
const { presignPutUrl, deleteObject, publicUrl } = require('../utils/r2');
const { assertEnvUriAllowed } = require('../utils/liveE2EDbGuard');

const EXECUTE = process.argv.includes('--execute');
if (!process.env.TEST_ENV_LOADED) {
  console.error('⛔ TEST_ENV_LOADED відсутній. Запускай тільки через npm run test:egress:photo:preflight/live.');
  process.exit(2);
}
if (process.env.MONGODB_URI) {
  try { assertEnvUriAllowed(process.env.MONGODB_URI); }
  catch (err) { console.error(`⛔ ${err.message}`); process.exit(3); }
}
for (const k of ['GEMINI_API_KEY', 'R2_PUBLIC_URL', 'R2_BUCKET_NAME', 'R2_ENDPOINT']) {
  if (!process.env[k]) { console.error(`❌ ${k} missing`); process.exit(4); }
}

const EMBED_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2';
const EMBED_DIM = Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 3072;
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash';
const BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

// 64×64 checker PNG, 184 bytes, generated specifically for this probe.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAf0lEQVR4nO3XwQmAMBQFQRX7sERrsUQriQ3E8xDYOX5yWQTh7WOMbeZ6puftved39f6Yn9dRgFaAVoB2rvK//3u//BcoQCtAK0Db2wNYAVoBWgFae0ArQCtAK0BrD2gFaAVoBWjtAa0ArQCtAK09oBWgFaAVoLUHtAK0ArQCtA/dKkc5lDZ1fQAAAABJRU5ErkJggg==', 'base64');

function requestBytes(body) { return Buffer.byteLength(JSON.stringify(body)); }
async function googlePost(name, url, body) {
  const bytes = requestBytes(body);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    const embedding = data?.embedding?.values || data?.embeddings?.[0]?.values;
    const interactionText = (Array.isArray(data?.steps) ? data.steps : [])
      .filter((step) => step?.type === 'model_output' && Array.isArray(step.content))
      .flatMap((step) => step.content)
      .filter((part) => part?.type === 'text')
      .map((part) => part.text || '')
      .join('')
      .trim();
    const outText = interactionText
      || (data?.candidates?.[0]?.content?.parts || []).map((x) => x?.text || '').join('').trim();
    const row = {
      name, status: res.status, requestBytes: bytes, responseBytes: Buffer.byteLength(text),
      ms: Date.now() - started,
      embeddingDims: Array.isArray(embedding) ? embedding.length : 0,
      textSample: outText.slice(0, 80),
      error: res.ok ? '' : String(data?.error?.message || text).slice(0, 220),
    };
    console.log(JSON.stringify(row));
    return row;
  } catch (err) {
    const row = { name, status: 0, requestBytes: bytes, ms: Date.now() - started, error: String(err?.message || err).slice(0, 220) };
    console.log(JSON.stringify(row));
    return row;
  }
}

(async () => {
  console.log('V48.11 LIVE PHOTO EGRESS PROBE');
  console.log(`mode=${EXECUTE ? 'EXECUTE' : 'PREFLIGHT'} testEnv=${Boolean(process.env.TEST_ENV_LOADED)} embedModel=${EMBED_MODEL} textModel=${TEXT_MODEL}`);
  if (!EXECUTE) {
    console.log('✅ safety/config preflight complete; no object uploaded and no Gemini request sent');
    return;
  }

  const key = `vision-tmp/egress-probe-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`;
  const url = publicUrl(key);
  const results = [];
  try {
    const signed = await presignPutUrl(key, 'image/png', 300);
    const put = await fetch(signed, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG, signal: AbortSignal.timeout(30000) });
    if (!put.ok) throw new Error(`R2 PUT failed ${put.status}`);
    const publicGet = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const got = Buffer.from(await publicGet.arrayBuffer());
    console.log(JSON.stringify({ name: 'r2_public_get', status: publicGet.status, bytes: got.length, urlHost: new URL(url).host }));
    if (!publicGet.ok || got.length !== PNG.length) throw new Error('R2 public URL is not readable or byte length mismatched');

    const inlineBody = {
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG.toString('base64') } }] },
      outputDimensionality: EMBED_DIM,
    };
    results.push(await googlePost('embedding_inline_current', `${BASE}/models/${EMBED_MODEL}:embedContent`, inlineBody));

    const externalSnake = {
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ file_data: { mime_type: 'image/png', file_uri: url } }] },
      outputDimensionality: EMBED_DIM,
    };
    results.push(await googlePost('embedding_external_url_snake', `${BASE}/models/${EMBED_MODEL}:embedContent`, externalSnake));

    const externalCamel = {
      model: `models/${EMBED_MODEL}`,
      content: { parts: [{ fileData: { mimeType: 'image/png', fileUri: url } }] },
      outputDimensionality: EMBED_DIM,
    };
    results.push(await googlePost('embedding_external_url_camel', `${BASE}/models/${EMBED_MODEL}:embedContent`, externalCamel));

    const genContentExternal = {
      contents: [{ parts: [
        { text: 'Reply with exactly IMAGE_OK if you can read the image.' },
        { file_data: { mime_type: 'image/png', file_uri: url } },
      ] }],
    };
    results.push(await googlePost('generateContent_external_url', `${BASE}/models/${TEXT_MODEL}:generateContent`, genContentExternal));

    const interactionsExternal = {
      model: TEXT_MODEL,
      input: [
        { type: 'text', text: 'Reply with exactly IMAGE_OK if you can read the image.' },
        { type: 'image', uri: url, mime_type: 'image/png' },
      ],
    };
    results.push(await googlePost('interactions_external_url', `${BASE}/interactions`, interactionsExternal));

    const inline = results.find((x) => x.name === 'embedding_inline_current');
    const externalEmbeds = results.filter((x) => x.name.startsWith('embedding_external'));
    const directEmbed = externalEmbeds.find((x) => x.status >= 200 && x.status < 300 && x.embeddingDims > 0);
    const directVision = results.filter((x) => /external_url/.test(x.name) && !x.name.startsWith('embedding_')).find((x) => x.status >= 200 && x.status < 300 && x.textSample);
    const authBlocked = [inline, ...externalEmbeds].filter(Boolean).some((x) => x.status === 401 || x.status === 403);
    console.log('--- capability summary ---');
    console.log(`current inline embedding: ${inline?.status || 0}, payload=${inline?.requestBytes || 0} B`);
    console.log(`direct URL embedding: ${directEmbed ? `YES (${directEmbed.name}, payload=${directEmbed.requestBytes} B)` : authBlocked ? 'UNKNOWN (auth rejected before capability could be tested)' : 'NO'}`);
    console.log(`direct URL vision/text: ${directVision ? `YES (${directVision.name}, payload=${directVision.requestBytes} B, sample=${JSON.stringify(directVision.textSample)})` : 'NO'}`);
    if (inline && directEmbed) {
      console.log(`embedding request-body reduction: ${(100 * (1 - directEmbed.requestBytes / inline.requestBytes)).toFixed(1)}% on probe image`);
    }
  } finally {
    await deleteObject(key);
    console.log(`cleanup: ${key}`);
  }
})().catch((err) => { console.error(`❌ ${err?.stack || err}`); process.exit(1); });

'use strict';

/**
 * Audit Gemini / Atlas Vector Search without modifying data by default.
 *
 * Put this file in: scripts/auditVectorSearch.js
 * Run from the backend root:
 *   node scripts/auditVectorSearch.js
 *   node scripts/auditVectorSearch.js --productId=OBJECT_ID
 *   node scripts/auditVectorSearch.js --productId=OBJECT_ID --repair
 *   node scripts/auditVectorSearch.js --repair-missing
 *
 * The script intentionally does not require dotenv. It reads MONGODB_URI and
 * GEMINI_* from the first .env it finds in cwd, backend root, or its parent.
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(__dirname, '../.env'),
    path.resolve(__dirname, '../../.env'),
  ];
  const envPath = candidates.find((p) => fs.existsSync(p));
  if (!envPath) return null;

  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
  return envPath;
}

const envPath = loadEnvFile();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductVector = require('../models/ProductVector');
const ShopProduct = require('../models/ShopProduct');
const {
  initGemini,
  getGeminiStatus,
  embedImageUrl,
  GEMINI_EMBEDDING_MODEL,
  GEMINI_EMBEDDING_DIMENSIONS,
} = require('../geminiClient');
const { embedProduct } = require('../utils/productEmbedding');
const { syncMirror } = require('../utils/upsertShopProduct');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const p = args.find((x) => x.startsWith(`${name}=`));
  return p ? p.slice(name.length + 1) : '';
};

const PRODUCT_ID = value('--productId');
const REPAIR_ONE = flag('--repair');
const REPAIR_MISSING = flag('--repair-missing');
const DELAY_MS = Math.max(1100, Number(value('--delay')) || 1100);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return null;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  if (!aa || !bb) return null;
  return dot / Math.sqrt(aa * bb);
}

function photoOf(product) {
  const labeled = product?.imageUrls?.[0] || product?.localImageUrl || '';
  return product?.originalImageUrl || labeled || '';
}

async function inspectIndex() {
  try {
    const indexes = await ProductVector.collection.listSearchIndexes().toArray();
    const index = indexes.find((i) => i.name === 'gemini_vector');
    if (!index) {
      console.log('❌ Atlas index "gemini_vector" не знайдено.');
      return;
    }
    console.log(`Atlas index: gemini_vector | status=${index.status || index.queryable || 'unknown'} | queryable=${index.queryable ?? 'unknown'}`);
    const fields = index.latestDefinition?.fields || index.definition?.fields || [];
    const vectorField = fields.find((f) => f.type === 'vector' && f.path === 'geminiVector');
    if (vectorField) {
      console.log(`Atlas definition: path=${vectorField.path}, dims=${vectorField.numDimensions}, similarity=${vectorField.similarity}`);
    }
  } catch (err) {
    console.log(`⚠️ Не вдалося прочитати Atlas Search indexes: ${err.message}`);
  }
}

async function catalogueAudit() {
  const candidates = await Product.find({
    status: { $ne: 'archived' },
    $or: [
      { originalImageUrl: { $type: 'string', $ne: '' } },
      { 'imageUrls.0': { $type: 'string', $ne: '' } },
      { localImageUrl: { $type: 'string', $ne: '' } },
    ],
  }, '_id name orderNumber source originalImageUrl imageUrls localImageUrl').lean();

  const ids = candidates.map((p) => p._id);
  const meta = ids.length ? await ProductVector.aggregate([
    { $match: { productId: { $in: ids } } },
    { $project: {
      productId: 1,
      model: '$geminiEmbeddingModel',
      declaredDim: '$geminiEmbeddingDim',
      actualDim: { $size: { $ifNull: ['$geminiVector', []] } },
      embeddedAt: '$geminiEmbeddedAt',
    } },
  ]) : [];

  const byId = new Map(meta.map((v) => [String(v.productId), v]));
  const missing = [];
  const invalid = [];
  const valid = [];

  for (const p of candidates) {
    const row = byId.get(String(p._id));
    if (!row) {
      missing.push(p);
      continue;
    }
    const reason = [];
    if (row.model !== GEMINI_EMBEDDING_MODEL) reason.push(`model=${row.model || '(empty)'}`);
    if (row.declaredDim !== GEMINI_EMBEDDING_DIMENSIONS) reason.push(`declaredDim=${row.declaredDim}`);
    if (row.actualDim !== GEMINI_EMBEDDING_DIMENSIONS) reason.push(`actualDim=${row.actualDim}`);
    if (reason.length) invalid.push({ product: p, row, reason });
    else valid.push(p);
  }

  const orphanCount = await ProductVector.countDocuments({
    productId: { $exists: true, $nin: ids },
  });

  const mirrorRows = ids.length
    ? await ShopProduct.find({ linkedProductId: { $in: ids } }, 'linkedProductId').lean()
    : [];
  const mirrorIds = new Set(mirrorRows.map((m) => String(m.linkedProductId)));
  const missingMirrors = candidates.filter((p) => !mirrorIds.has(String(p._id)));

  console.log('\n=== Каталог ===');
  console.log(`Активних товарів із фото: ${candidates.length}`);
  console.log(`Коректних актуальних векторів: ${valid.length}`);
  console.log(`Без вектора: ${missing.length}`);
  console.log(`Старий/пошкоджений вектор: ${invalid.length}`);
  console.log(`Векторів поза активним фотокаталогом (архів/сироти): ${orphanCount}`);
  console.log(`Товарів без ShopProduct-mirror: ${missingMirrors.length}`);

  if (missing.length) {
    console.log('\nПерші товари БЕЗ вектора:');
    for (const p of missing.slice(0, 20)) {
      console.log(`  ${p._id} | #${p.orderNumber || '-'} | ${p.source || '-'} | ${p.name || '(без назви)'} | ${photoOf(p)}`);
    }
  }
  if (missingMirrors.length) {
    console.log('\nПерші товари БЕЗ ShopProduct-mirror (загальний пошук по фото їх відкине):');
    for (const p of missingMirrors.slice(0, 20)) {
      console.log(`  ${p._id} | #${p.orderNumber || '-'} | ${p.source || '-'} | ${p.name || '(без назви)'}`);
    }
  }
  if (invalid.length) {
    console.log('\nПерші НЕАКТУАЛЬНІ/ПОШКОДЖЕНІ вектори:');
    for (const item of invalid.slice(0, 20)) {
      console.log(`  ${item.product._id} | ${item.product.name || '(без назви)'} | ${item.reason.join(', ')}`);
    }
  }

  return { candidates, missing, invalid, missingMirrors };
}

async function inspectProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) throw new Error(`Некоректний productId: ${productId}`);
  const product = await Product.findById(productId).lean();
  if (!product) throw new Error('Товар не знайдено');
  const row = await ProductVector.findOne({ productId: product._id }).lean();
  const url = photoOf(product);

  console.log('\n=== Один товар ===');
  console.log(`ID: ${product._id}`);
  console.log(`Назва: ${product.name || '(без назви)'}`);
  console.log(`Джерело: ${product.source || '-'}`);
  console.log(`Фото: ${url || '(немає)'}`);
  console.log(`Vector row: ${row ? 'є' : 'НЕМАЄ'}`);
  if (row) {
    console.log(`Vector model: ${row.geminiEmbeddingModel || '(empty)'}`);
    console.log(`Vector declared dim: ${row.geminiEmbeddingDim || 0}`);
    console.log(`Vector actual dim: ${Array.isArray(row.geminiVector) ? row.geminiVector.length : 0}`);
    console.log(`Embedded at: ${row.geminiEmbeddedAt || '-'}`);
  }

  if (REPAIR_ONE) {
    console.log('\nПерегенеровую вектор цього товару...');
    const ok = await embedProduct(product, { force: true });
    console.log(ok ? '✅ Вектор перезаписано.' : '❌ Вектор не створено.');
  }

  if (!url) return;
  if (!getGeminiStatus().connected) {
    console.log(`⚠️ Gemini не підключено: ${getGeminiStatus().error}`);
    return;
  }

  console.log('\nГенерую свіжий вектор з поточного фото...');
  const fresh = await embedImageUrl(url);
  console.log(`Fresh model=${fresh.model}, dims=${fresh.dimensions}`);

  const currentRow = REPAIR_ONE
    ? await ProductVector.findOne({ productId: product._id }).lean()
    : row;
  if (currentRow?.geminiVector) {
    const sim = cosine(fresh.embedding, currentRow.geminiVector);
    console.log(`Cosine fresh ↔ stored: ${sim == null ? 'n/a' : sim.toFixed(6)}`);
    if (sim != null && sim < 0.98) {
      console.log('⚠️ Той самий файл має суттєво інший вектор: запис старий, модель змінилась або індексувалось інше фото.');
    }
  }

  console.log('\nAtlas top-10 для цього самого фото:');
  try {
    const rows = await ProductVector.aggregate([
      { $vectorSearch: {
        index: 'gemini_vector',
        path: 'geminiVector',
        queryVector: fresh.embedding,
        numCandidates: 300,
        limit: 10,
      } },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { productId: 1, shopProductId: 1, score: 1, model: '$geminiEmbeddingModel', dim: '$geminiEmbeddingDim' } },
    ]);
    rows.forEach((r, i) => {
      const marker = String(r.productId || '') === String(product._id) ? '  <== ЦЕЙ ТОВАР' : '';
      console.log(`${i + 1}. productId=${r.productId || '-'} shopProductId=${r.shopProductId || '-'} atlas=${Number(r.score || 0).toFixed(6)}${marker}`);
    });
    if (!rows.some((r) => String(r.productId || '') === String(product._id))) {
      console.log('❌ Вектор товару не потрапив у top-10 Atlas для власного фото.');
    }
  } catch (err) {
    console.log(`❌ Atlas vector query failed: ${err.message}`);
  }
}

async function repairMissing(audit) {
  if (audit.missingMirrors.length) {
    console.log(`\nСтворюю ${audit.missingMirrors.length} відсутній ShopProduct-mirror...`);
    let mirrorOk = 0;
    let mirrorFailed = 0;
    for (const p of audit.missingMirrors) {
      try {
        await syncMirror(p);
        mirrorOk += 1;
      } catch (err) {
        mirrorFailed += 1;
        console.log(`  MIRROR FAIL ${p._id}: ${err.message}`);
      }
    }
    console.log(`Mirrors: ok=${mirrorOk}, failed=${mirrorFailed}`);
  }

  const unique = new Map();
  for (const p of audit.missing) unique.set(String(p._id), p);
  for (const x of audit.invalid) unique.set(String(x.product._id), x.product);
  const todo = [...unique.values()];

  if (!todo.length) {
    console.log('\nВідсутніх/пошкоджених векторів немає.');
    return;
  }
  if (!getGeminiStatus().connected) throw new Error(getGeminiStatus().error || 'Gemini not configured');

  console.log(`\nПерегенеровую ${todo.length} вектор(ів)...`);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < todo.length; i += 1) {
    const p = todo[i];
    try {
      if (await embedProduct(p, { force: true })) ok += 1;
      else failed += 1;
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${p._id}: ${err.message}`);
    }
    console.log(`  ${i + 1}/${todo.length} | ok=${ok} failed=${failed}`);
    if (i < todo.length - 1) await sleep(DELAY_MS);
  }
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error(`MONGODB_URI не знайдений${envPath ? ` у ${envPath}` : ''}`);
  initGemini(process.env.GEMINI_API_KEY);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`ENV: ${envPath || 'process environment'}`);
  console.log(`Gemini model: ${GEMINI_EMBEDDING_MODEL}, dims=${GEMINI_EMBEDDING_DIMENSIONS}`);
  await inspectIndex();
  const audit = await catalogueAudit();
  if (PRODUCT_ID) await inspectProduct(PRODUCT_ID);
  if (REPAIR_MISSING) await repairMissing(audit);
}

main()
  .catch((err) => {
    console.error('\nFATAL:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });

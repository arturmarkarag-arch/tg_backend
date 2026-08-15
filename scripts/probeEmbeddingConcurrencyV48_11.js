'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

async function probe({ moduleRel, vectorKey, idField, force = false }) {
  const geminiPath = require.resolve(path.join(ROOT, 'geminiClient.js'));
  const vectorPath = require.resolve(path.join(ROOT, 'models/ProductVector.js'));
  const modulePath = require.resolve(path.join(ROOT, moduleRel));

  delete require.cache[modulePath];
  const oldGemini = require.cache[geminiPath];
  const oldVector = require.cache[vectorPath];

  let geminiCalls = 0;
  let exists = false;
  require.cache[geminiPath] = {
    id: geminiPath, filename: geminiPath, loaded: true,
    exports: {
      getGeminiStatus: () => ({ connected: true }),
      embedImageUrl: async () => {
        geminiCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { embedding: [1, 2, 3], model: 'probe', dimensions: 3 };
      },
    },
  };
  require.cache[vectorPath] = {
    id: vectorPath, filename: vectorPath, loaded: true,
    exports: {
      exists: async () => { await new Promise((r) => setTimeout(r, 5)); return exists; },
      updateOne: async () => { await new Promise((r) => setTimeout(r, 20)); exists = true; return {}; },
    },
  };

  try {
    const mod = require(modulePath);
    const fn = idField === 'productId' ? mod.embedProduct : mod.embedShopProduct;
    const doc = idField === 'productId'
      ? { _id: 'probe-product', originalImageUrl: 'https://example.test/a.jpg', imageUrls: ['https://example.test/a.jpg'] }
      : { _id: 'probe-shop-product', originalImageUrl: 'https://example.test/a.jpg', imageUrl: 'https://example.test/a.jpg' };
    const results = await Promise.all([fn(doc, { force }), fn(doc, { force })]);
    return { vectorKey, force, results, geminiCalls, duplicate: geminiCalls > 1 };
  } finally {
    delete require.cache[modulePath];
    if (oldGemini) require.cache[geminiPath] = oldGemini; else delete require.cache[geminiPath];
    if (oldVector) require.cache[vectorPath] = oldVector; else delete require.cache[vectorPath];
  }
}

(async () => {
  const rows = [
    await probe({ moduleRel: 'utils/productEmbedding.js', vectorKey: 'warehouse', idField: 'productId', force: false }),
    await probe({ moduleRel: 'utils/productEmbedding.js', vectorKey: 'warehouse', idField: 'productId', force: true }),
    await probe({ moduleRel: 'utils/shopProductEmbedding.js', vectorKey: 'shop-owned', idField: 'shopProductId', force: false }),
    await probe({ moduleRel: 'utils/shopProductEmbedding.js', vectorKey: 'shop-owned', idField: 'shopProductId', force: true }),
  ];
  console.log('V48.12 EMBEDDING SINGLE-FLIGHT PROBE');
  let failed = false;
  for (const row of rows) {
    console.log(`${row.vectorKey} force=${row.force}: parallel=2, Gemini calls=${row.geminiCalls}, duplicate=${row.duplicate ? 'YES' : 'NO'}`);
    if (row.duplicate || row.geminiCalls !== 1) failed = true;
  }
  if (failed) {
    console.error('❌ duplicate concurrent Gemini egress detected');
    process.exit(1);
  }
  console.log('✅ same owner/source/mode is single-flight for warehouse + shop-owned embeddings');
})().catch((err) => { console.error(err); process.exit(1); });

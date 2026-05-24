const { OpenAI } = require('openai');
const AppSetting = require('./models/AppSetting');

const OPENAI_MODEL_SETTING_KEY = 'openai.defaultModel';

// Models with their vision support flags and metadata.
// listOpenAIModels() pulls the real available list from OpenAI API and enriches
// it using this table. A model absent from this table still appears in the full
// list but gets imageInput:false and won't show in the supportsImage filter.
const OPENAI_MODEL_METADATA = {
  // ── GPT-5 family (patch-based tokenization, detail: low/high/original/auto) ─
  'gpt-5.5': {
    imageInput: true,
    textOutput: true,
    price: '$5.00 / 1M input',
    description: 'GPT-5.5 — найновіша топова модель, підтримує detail:original',
  },
  'gpt-5.4': {
    imageInput: true,
    textOutput: true,
    price: '$2.50',
    description: 'GPT-5.4 — підтримує detail:original для точного розпізнавання',
  },
  'gpt-5.4-mini': {
    imageInput: true,
    textOutput: true,
    price: '$0.75',
    description: 'GPT-5.4 mini — patch-based, множник токенів ×1.62',
  },
  'gpt-5.4-nano': {
    imageInput: true,
    textOutput: true,
    price: '$0.20',
    description: 'GPT-5.4 nano — patch-based, множник токенів ×2.46',
  },
  'gpt-5': {
    imageInput: true,
    textOutput: true,
    price: '$1.25',
    description: 'GPT-5 — флагманська модель, tile-based 70+140 токенів за тайл',
  },
  'gpt-5-chat-latest': {
    imageInput: true,
    textOutput: true,
    price: '$1.25',
    description: 'GPT-5 chat latest — актуальний аліас GPT-5',
  },
  'gpt-5-mini': {
    imageInput: true,
    textOutput: true,
    price: '$0.25',
    description: 'GPT-5 mini — patch-based, множник токенів ×1.62',
  },
  'gpt-5-nano': {
    imageInput: true,
    textOutput: true,
    price: '$0.05',
    description: 'GPT-5 nano — patch-based, множник токенів ×2.46',
  },
  'gpt-5.2': {
    imageInput: true,
    textOutput: true,
    price: '$1.75',
    description: 'GPT-5.2 з підтримкою зображень',
  },
  'gpt-5.2-chat-latest': {
    imageInput: true,
    textOutput: true,
    price: '$1.75',
    description: 'GPT-5.2 chat latest — patch-based',
  },
  // ── GPT-4.x family (tile-based tokenization) ──────────────────────────────
  'gpt-4.5': {
    imageInput: true,
    textOutput: true,
    price: '$2.50',
    description: 'GPT-4.5 — tile-based, 85 base + 170 токенів за тайл',
  },
  'gpt-4o': {
    imageInput: true,
    textOutput: true,
    price: '$2.50',
    description: 'GPT-4o — tile-based, 85 base + 170 токенів за тайл',
  },
  'gpt-4o-mini': {
    imageInput: true,
    textOutput: true,
    price: '$0.15',
    description: 'GPT-4o mini — рекомендована для фото-пошуку, 2833 base + 5667/тайл',
  },
  'gpt-4.1': {
    imageInput: true,
    textOutput: true,
    price: '$2.00',
    description: 'GPT-4.1 — tile-based з підтримкою зображень',
  },
  'gpt-4.1-mini': {
    imageInput: true,
    textOutput: true,
    price: '$0.40',
    description: 'GPT-4.1 mini — patch-based, множник токенів ×1.62',
  },
  'gpt-4.1-nano': {
    imageInput: true,
    textOutput: true,
    price: '$0.10',
    description: 'GPT-4.1 nano — patch-based, множник токенів ×2.46',
  },
  // ── o-series ──────────────────────────────────────────────────────────────
  'o4-mini': {
    imageInput: true,
    textOutput: true,
    price: '$1.10',
    description: 'o4-mini — reasoning модель, patch-based ×1.72',
  },
  'o3': {
    imageInput: true,
    textOutput: true,
    price: '$2.00',
    description: 'o3 — reasoning модель з vision, tile-based 75+150/тайл',
  },
  'o1': {
    imageInput: true,
    textOutput: true,
    price: '$15.00',
    description: 'o1 — reasoning модель з vision, tile-based 75+150/тайл',
  },
  // ── Текстові (без vision) ─────────────────────────────────────────────────
  'gpt-3.5-turbo': {
    imageInput: false,
    textOutput: true,
    price: '$0.50 / 1M input',
    description: 'GPT-3.5 Turbo — тільки текст, без зображень',
  },
};

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

let openai = null;
let openaiStatus = { connected: false, error: null };

function initOpenAI(apiKey) {
  if (!apiKey) {
    openaiStatus = { connected: false, error: 'OPENAI_API_KEY not configured' };
    console.warn(openaiStatus.error);
    return null;
  }
  try {
    openai = new OpenAI({ apiKey });
    openaiStatus = { connected: true, error: null };
    return openai;
  } catch (error) {
    openai = null;
    openaiStatus = { connected: false, error: error.message || String(error) };
    console.error('Failed to initialize OpenAI client:', error);
    return null;
  }
}

function getOpenAIStatus() {
  return { connected: openaiStatus.connected, error: openaiStatus.error };
}

function enrichOpenAIModel(model) {
  const meta = OPENAI_MODEL_METADATA[model.id] || {};
  return {
    id: model.id,
    owned_by: model.owned_by,
    description: meta.description || model.description || '',
    imageInput: Boolean(meta.imageInput),
    textOutput: meta.textOutput !== false,
    price: meta.price || 'unknown',
  };
}

async function listOpenAIModels({ supportsImage } = {}) {
  if (!openai) throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  const result = await openai.models.list();
  let models = Array.isArray(result.data) ? result.data.map(enrichOpenAIModel) : [];
  if (supportsImage) models = models.filter((m) => m.imageInput);
  return models;
}

async function getSelectedOpenAIModel() {
  const setting = await AppSetting.findOne({ key: OPENAI_MODEL_SETTING_KEY }).lean();
  return setting?.value || DEFAULT_MODEL;
}

async function verifyOpenAIConnection() {
  if (!openai) throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  const result = await openai.models.list();
  return {
    status: 'ok',
    modelCount: Array.isArray(result.data) ? result.data.length : undefined,
    sampleModels: Array.isArray(result.data) ? result.data.slice(0, 5).map((m) => m.id) : [],
  };
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function buildUsageInfo(response) {
  const usage = response?.usage || {};
  return {
    inputTokens:  Number(usage.input_tokens  || usage.prompt_tokens     || 0),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens  || 0),
    totalTokens:  Number(usage.total_tokens  || 0),
  };
}

function extractOutputText(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string' && block.text.trim()) parts.push(block.text.trim());
    }
  }
  if (parts.length) return parts.join('\n').trim();
  return String(response?.output_text || '').trim();
}

function parseJsonObject(rawText) {
  if (!rawText) return {};
  const text = String(rawText).trim();
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch (_) {}
  }
  return {};
}

// ─── Barcode reading ──────────────────────────────────────────────────────────

async function analyzeBarcodeImage(imageBuffer, { model = null } = {}) {
  if (!openai) return { scannedBarcode: '', digitsOnBarcode: '', rawText: '', usage: {} };

  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Read the barcode image. Return strict JSON only with keys: scannedBarcode, digitsOnBarcode, rawText. scannedBarcode should be machine-readable barcode value if visible. digitsOnBarcode should be printed digits near barcode if visible. rawText should contain short visible text from image. Use empty strings if unknown.',
        },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${Buffer.from(imageBuffer).toString('base64')}`,
        },
      ],
    }],
  });

  const rawText = extractOutputText(response);
  const parsed  = parseJsonObject(rawText);
  return {
    scannedBarcode:  String(parsed.scannedBarcode  || '').trim(),
    digitsOnBarcode: String(parsed.digitsOnBarcode || '').trim(),
    rawText:         String(parsed.rawText || rawText || '').trim(),
    usage:           buildUsageInfo(response),
  };
}

// ─── Product image metadata extraction ───────────────────────────────────────

async function analyzeProductImage(imageBuffer, { model = null } = {}) {
  if (!openai) return { parsed: {}, usage: {} };

  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'Analyze product image and return strict JSON only with keys: title, brand, model, category, barcode, qrCode, description, textOnImage. Keep concise values. Use empty string when unknown.',
        },
        {
          type: 'input_image',
          image_url: `data:image/jpeg;base64,${Buffer.from(imageBuffer).toString('base64')}`,
        },
      ],
    }],
  });

  const rawText = extractOutputText(response);
  const parsed  = parseJsonObject(rawText);
  return {
    parsed: {
      title:       String(parsed.title       || '').trim(),
      brand:       String(parsed.brand       || '').trim(),
      model:       String(parsed.model       || '').trim(),
      category:    String(parsed.category    || '').trim(),
      barcode:     String(parsed.barcode     || '').trim(),
      qrCode:      String(parsed.qrCode      || '').trim(),
      description: String(parsed.description || '').trim(),
      textOnImage: String(parsed.textOnImage || '').trim(),
    },
    usage: buildUsageInfo(response),
  };
}

// ─── Text completion (generic) ────────────────────────────────────────────────

async function createChatCompletion(prompt, { model = null } = {}) {
  if (!openai) throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({ model: selectedModel, input: prompt });
  return extractOutputText(response) || '';
}

// ─── Vector search helpers ─────────────────────────────────────────────────────

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

// Turns a product photo into a compact, factual text descriptor. The descriptor
// (not the raw image) is what gets embedded — both for the catalog and for the
// query photo — so the wording must be consistent between the two. Label text is
// kept verbatim in its original language: brand/product names are the strongest
// matching signal, and translating them photo-to-photo introduces variance.
const PRODUCT_DESCRIBE_PROMPT =
  'Опиши товар на фото для каталожного співставлення. Дай стислий фактичний опис ОДНИМ абзацом: ' +
  'бренд, тип товару, варіант/смак, обʼєм/розмір/вагу, колір, тип упаковки та видимий текст на етикетці. ' +
  'Текст з етикетки — бренд, назву, написи — наводь ДОСЛІВНО мовою оригіналу, не перекладай і не транслітеруй. ' +
  'Тільки факти, без вступних слів і без здогадок про те, чого не видно.';

async function describeProductImage(imageBuffer, mimeType, { model = null } = {}) {
  if (!openai) return { descriptor: '', usage: {} };
  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: PRODUCT_DESCRIBE_PROMPT },
        {
          type: 'input_image',
          image_url: `data:${mimeType || 'image/jpeg'};base64,${Buffer.from(imageBuffer).toString('base64')}`,
          detail: 'high',
        },
      ],
    }],
  });
  return { descriptor: extractOutputText(response), usage: buildUsageInfo(response) };
}

// Same as describeProductImage but takes a public image URL. OpenAI fetches the
// image itself, so the bytes never pass through our server — used to embed the
// catalog (images already live in R2) without burning Render egress bandwidth.
async function describeProductImageUrl(imageUrl, { model = null } = {}) {
  if (!openai || !imageUrl) return { descriptor: '', usage: {} };
  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: PRODUCT_DESCRIBE_PROMPT },
        { type: 'input_image', image_url: imageUrl, detail: 'high' },
      ],
    }],
  });
  return { descriptor: extractOutputText(response), usage: buildUsageInfo(response) };
}

// Friendly product explainer for shop staff who don't know the item. Returns a
// plain-language Ukrainian description — distinct from describeProductImage,
// whose terse output is tuned for embeddings.
const PRODUCT_EXPLAIN_PROMPT =
  'Ти пояснюєш товар працівнику магазину, який не знає цей продукт і не розуміє написів на упаковці. ' +
  'Відповідай УКРАЇНСЬКОЮ мовою, просто і ДУЖЕ СТИСЛО. ' +
  'Опиши: що це за товар, для чого він, бренд/виробника (якщо видно), основні характеристики, обʼєм/вагу/розмір, як використовувати (коротко), важливий текст з етикетки (якщо є). ' +
  'Не вигадуй інформацію, якої не видно на фото. ' +
  'Не додавай зайвих пояснень, припущень чи рекламних фраз. ' +
  'Якщо текст або товар погано видно — так і напиши.';

async function explainProductImage(imageBuffer, mimeType, { model = null } = {}) {
  if (!openai) return { text: '', usage: {} };
  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: PRODUCT_EXPLAIN_PROMPT },
        {
          type: 'input_image',
          image_url: `data:${mimeType || 'image/jpeg'};base64,${Buffer.from(imageBuffer).toString('base64')}`,
          detail: 'high',
        },
      ],
    }],
  });
  return { text: extractOutputText(response), usage: buildUsageInfo(response) };
}

// URL variant of explainProductImage — OpenAI fetches the image itself (no bytes
// through our server). Used by the vision /describe R2 cycle.
async function explainProductImageUrl(imageUrl, { model = null } = {}) {
  if (!openai || !imageUrl) return { text: '', usage: {} };
  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: PRODUCT_EXPLAIN_PROMPT },
        { type: 'input_image', image_url: imageUrl, detail: 'high' },
      ],
    }],
  });
  return { text: extractOutputText(response), usage: buildUsageInfo(response) };
}

async function embedText(text) {
  if (!openai) throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  const clean = String(text || '').trim();
  if (!clean) return { embedding: null, model: EMBEDDING_MODEL, usage: {} };
  const res = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: clean });
  return {
    embedding: res.data?.[0]?.embedding || null,
    model: EMBEDDING_MODEL,
    usage: { inputTokens: Number(res.usage?.prompt_tokens || 0), totalTokens: Number(res.usage?.total_tokens || 0) },
  };
}

module.exports = {
  EMBEDDING_MODEL,
  initOpenAI,
  verifyOpenAIConnection,
  getOpenAIStatus,
  listOpenAIModels,
  getSelectedOpenAIModel,
  createChatCompletion,
  analyzeBarcodeImage,
  analyzeProductImage,
  describeProductImage,
  describeProductImageUrl,
  explainProductImage,
  explainProductImageUrl,
  embedText,
};

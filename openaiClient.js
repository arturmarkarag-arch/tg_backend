const { OpenAI } = require('openai');
const AppSetting = require('./models/AppSetting');

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-nano';
const OPENAI_MODEL_SETTING_KEY = 'openai.defaultModel';

const OPENAI_MODEL_METADATA = {
  'gpt-5.4-nano': {
    imageInput: true,
    textOutput: true,
    price: '$0.05 / 1K',
    description: 'GPT-5.4 nano з підтримкою зображень',
  },
  'gpt-5-nano': {
    imageInput: true,
    textOutput: true,
    price: 'unknown',
    description: 'Мультимодальна nano модель GPT-5',
  },
  'gpt-4.1': {
    imageInput: true,
    textOutput: true,
    price: 'unknown',
    description: 'GPT-4.1 з підтримкою зображень',
  },
  'gpt-4.1-mini': {
    imageInput: true,
    textOutput: true,
    price: 'unknown',
    description: 'Менша версія GPT-4.1',
  },
  'gpt-3.5-turbo': {
    imageInput: false,
    textOutput: true,
    price: 'unknown',
    description: 'Текстова GPT-3.5 turbo модель',
  },
};

let openai = null;
let openaiStatus = {
  connected: false,
  error: null,
};

function initOpenAI(apiKey) {
  if (!apiKey) {
    openaiStatus = {
      connected: false,
      error: 'OPENAI_API_KEY not configured',
    };
    console.warn(openaiStatus.error);
    return null;
  }

  try {
    openai = new OpenAI({ apiKey });
    openaiStatus = {
      connected: true,
      error: null,
    };
    return openai;
  } catch (error) {
    openai = null;
    openaiStatus = {
      connected: false,
      error: error.message || String(error),
    };
    console.error('Failed to initialize OpenAI client:', error);
    return null;
  }
}

function getOpenAIStatus() {
  return {
    connected: openaiStatus.connected,
    error: openaiStatus.error,
  };
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
  if (!openai) {
    throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  }

  const result = await openai.models.list();
  let models = Array.isArray(result.data) ? result.data.map(enrichOpenAIModel) : [];
  if (supportsImage) {
    models = models.filter((model) => model.imageInput);
  }
  return models;
}

async function getSelectedOpenAIModel() {
  const setting = await AppSetting.findOne({ key: OPENAI_MODEL_SETTING_KEY }).lean();
  return setting?.value || OPENAI_MODEL;
}

async function verifyOpenAIConnection() {
  if (!openai) {
    throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  }

  const result = await openai.models.list();
  return {
    status: 'ok',
    modelCount: Array.isArray(result.data) ? result.data.length : undefined,
    sampleModels: Array.isArray(result.data) ? result.data.slice(0, 5).map((model) => model.id) : [],
  };
}

async function createChatCompletion(prompt, { model = null } = {}) {
  if (!openai) {
    throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  }

  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: prompt,
  });

  const output = response.output?.[0]?.content?.find((item) => item.type === 'output_text');
  if (output?.text) {
    return output.text;
  }

  return response.output?.[0]?.content?.[0]?.text || '';
}

function buildUsageInfo(response) {
  const usage = response?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens || usage.prompt_tokens || 0),
    outputTokens: Number(usage.output_tokens || usage.completion_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
  };
}

function extractOutputText(response) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (typeof block?.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  if (parts.length) {
    return parts.join('\n').trim();
  }
  return String(response?.output_text || '').trim();
}

function parseJsonObject(rawText) {
  if (!rawText) return {};
  const text = String(rawText).trim();
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (_) {}
    }
  }
  return {};
}

async function analyzeBarcodeImage(imageBuffer, { model = null } = {}) {
  if (!openai) {
    return { scannedBarcode: '', digitsOnBarcode: '', rawText: '', usage: {} };
  }

  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'Read the barcode image. Return strict JSON only with keys: scannedBarcode, digitsOnBarcode, rawText. scannedBarcode should be machine-readable barcode value if visible. digitsOnBarcode should be printed digits near barcode if visible. rawText should contain short visible text from image. Use empty strings if unknown.',
          },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${Buffer.from(imageBuffer).toString('base64')}`,
          },
        ],
      },
    ],
  });

  const rawText = extractOutputText(response);
  const parsed = parseJsonObject(rawText);
  return {
    scannedBarcode: String(parsed.scannedBarcode || '').trim(),
    digitsOnBarcode: String(parsed.digitsOnBarcode || '').trim(),
    rawText: String(parsed.rawText || rawText || '').trim(),
    usage: buildUsageInfo(response),
  };
}

async function analyzeProductImage(imageBuffer, { model = null } = {}) {
  if (!openai) {
    return { parsed: {}, usage: {} };
  }

  const selectedModel = model || (await getSelectedOpenAIModel());
  const response = await openai.responses.create({
    model: selectedModel,
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'Analyze product image and return strict JSON only with keys: title, brand, model, category, barcode, qrCode, description, textOnImage. Keep concise values. Use empty string when unknown.',
          },
          {
            type: 'input_image',
            image_url: `data:image/jpeg;base64,${Buffer.from(imageBuffer).toString('base64')}`,
          },
        ],
      },
    ],
  });

  const rawText = extractOutputText(response);
  const parsed = parseJsonObject(rawText);
  return {
    parsed: {
      title: String(parsed.title || '').trim(),
      brand: String(parsed.brand || '').trim(),
      model: String(parsed.model || '').trim(),
      category: String(parsed.category || '').trim(),
      barcode: String(parsed.barcode || '').trim(),
      qrCode: String(parsed.qrCode || '').trim(),
      description: String(parsed.description || '').trim(),
      textOnImage: String(parsed.textOnImage || '').trim(),
    },
    usage: buildUsageInfo(response),
  };
}

module.exports = {
  initOpenAI,
  verifyOpenAIConnection,
  createChatCompletion,
  getOpenAIStatus,
  listOpenAIModels,
  analyzeBarcodeImage,
  analyzeProductImage,
};

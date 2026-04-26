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

module.exports = {
  initOpenAI,
  verifyOpenAIConnection,
  createChatCompletion,
  getOpenAIStatus,
  listOpenAIModels,
};

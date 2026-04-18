const { OpenAI } = require('openai');

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

async function createChatCompletion(prompt) {
  if (!openai) {
    throw new Error(openaiStatus.error || 'OPENAI_API_KEY not configured');
  }

  const response = await openai.responses.create({
    model: 'gpt-3.5-turbo',
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
};

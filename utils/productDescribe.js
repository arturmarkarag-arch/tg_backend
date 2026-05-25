'use strict';

// Plain-language "what is this product?" description from a photo. This is a
// GENERATIVE task (image → text), so it uses a generative model — NOT the
// embedding model (embeddings can't produce text). Default provider is the free
// Gemini Flash; OpenAI is used only as a fallback, or when DESCRIBE_PROVIDER=openai.

const { explainProductImageUrl, getOpenAIStatus } = require('../openaiClient');
const { generateTextFromImageUrl, getGeminiStatus } = require('../geminiClient');

const DESCRIBE_PROVIDER = String(process.env.DESCRIBE_PROVIDER || 'gemini').toLowerCase();

// Same intent/wording as the OpenAI explainer so output style stays consistent.
const PRODUCT_EXPLAIN_PROMPT =
  'Ти пояснюєш товар працівнику магазину, який не знає цей продукт і не розуміє написів на упаковці. ' +
  'Відповідай УКРАЇНСЬКОЮ мовою, просто і ДУЖЕ СТИСЛО. ' +
  'Опиши: що це за товар, для чого він, бренд/виробника (якщо видно), основні характеристики, обʼєм/вагу/розмір, як використовувати (коротко), важливий текст з етикетки (якщо є). ' +
  'Не вигадуй інформацію, якої не видно на фото. ' +
  'Не додавай зайвих пояснень, припущень чи рекламних фраз. ' +
  'Якщо текст або товар погано видно — так і напиши.';

// Returns { text, usage }. usage is {} for Gemini (free / not token-metered here).
async function describeImageUrl(url) {
  if (!url) return { text: '', usage: {} };

  const preferGemini = DESCRIBE_PROVIDER !== 'openai' && getGeminiStatus().connected;

  if (preferGemini) {
    try {
      const { text } = await generateTextFromImageUrl(url, PRODUCT_EXPLAIN_PROMPT);
      if (text) return { text, usage: {} };
    } catch (err) {
      console.error('[describe:gemini]', err.message);
      if (!getOpenAIStatus().connected) throw err; // no fallback available
    }
  }

  // OpenAI path (explicit choice, or Gemini unavailable/empty).
  if (getOpenAIStatus().connected) {
    return explainProductImageUrl(url);
  }

  // Last resort: Gemini even if it wasn't preferred (e.g. OpenAI off).
  const { text } = await generateTextFromImageUrl(url, PRODUCT_EXPLAIN_PROMPT);
  return { text, usage: {} };
}

module.exports = { describeImageUrl };

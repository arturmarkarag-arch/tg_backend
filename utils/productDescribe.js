'use strict';

// Plain-language "what is this product?" description from a photo. This is a
// GENERATIVE task (image → text), so it uses a generative model — NOT the
// embedding model (embeddings can't produce text). Default provider is the free
// Gemini Flash; OpenAI is used only as a fallback, or when DESCRIBE_PROVIDER=openai.

const { explainProductImageUrl, getOpenAIStatus } = require('../openaiClient');
const { generateTextFromImageUrl, getGeminiStatus } = require('../geminiClient');

const DESCRIBE_PROVIDER = String(process.env.DESCRIBE_PROVIDER || 'gemini').toLowerCase();

const PRODUCT_EXPLAIN_PROMPT =
  'Ти аналізуєш фото товару для працівника магазину, який не знає цей продукт і не розуміє написів на упаковці. ' +
  'Відповідай ТІЛЬКИ валідним JSON без зайвого тексту, у форматі: {"name":"...","description":"..."}. ' +
  'name — коротка назва товару УКРАЇНСЬКОЮ (2-5 слів, наприклад "Шампунь Head & Shoulders 400мл"). ' +
  'description — детальний опис УКРАЇНСЬКОЮ: що це за товар, для чого він, бренд/виробник (якщо видно), основні характеристики, обʼєм/вага/розмір, як використовувати (коротко), важливий текст з етикетки. ' +
  'Не вигадуй інформацію, якої не видно на фото. Не додавай рекламних фраз. ' +
  'Якщо товар погано видно — зазнач це у description, name залиш найкращим здогадом.';

// Strips optional ```json ... ``` fences that some models wrap around JSON output.
function parseDescribeResponse(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      name:        (parsed.name        || '').trim(),
      description: (parsed.description || '').trim(),
    };
  } catch {
    // Model returned plain text instead of JSON — treat the whole response as description.
    return { name: '', description: raw.trim() };
  }
}

// Returns { text, name, usage }.
// text   — human-readable description (saved to aiDescription)
// name   — short product name extracted by the model (empty string if unavailable)
// usage  — token usage or {} for Gemini
async function describeImageUrl(url) {
  if (!url) return { text: '', name: '', usage: {} };

  const preferGemini = DESCRIBE_PROVIDER !== 'openai' && getGeminiStatus().connected;

  if (preferGemini) {
    try {
      const { text: raw } = await generateTextFromImageUrl(url, PRODUCT_EXPLAIN_PROMPT);
      if (raw) {
        const { name, description } = parseDescribeResponse(raw);
        return { text: description || raw, name, usage: {} };
      }
    } catch (err) {
      console.error('[describe:gemini]', err.message);
      if (!getOpenAIStatus().connected) throw err;
    }
  }

  if (getOpenAIStatus().connected) {
    const { text: raw, usage } = await explainProductImageUrl(url);
    const { name, description } = parseDescribeResponse(raw || '');
    return { text: description || raw, name, usage };
  }

  const { text: raw } = await generateTextFromImageUrl(url, PRODUCT_EXPLAIN_PROMPT);
  const { name, description } = parseDescribeResponse(raw || '');
  return { text: description || raw, name, usage: {} };
}

module.exports = { describeImageUrl };

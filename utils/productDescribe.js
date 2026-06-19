'use strict';

// Plain-language "what is this product?" description from a photo. This is a
// GENERATIVE task (image → text), so it uses a generative model — NOT the
// embedding model (embeddings can't produce text). Default provider is the free
// Gemini Flash; OpenAI is used only as a fallback, or when DESCRIBE_PROVIDER=openai.

const {
  explainProductImageUrl,
  getOpenAIStatus,
  generateTextFromImageUrl: openaiTextFromImageUrl,
} = require('../openaiClient');
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

// ── Label translation ────────────────────────────────────────────────────────
// User photographs the back / label of a product (often a foreign language) and
// needs a faithful Ukrainian translation — NOT a generated description. The hard
// requirement: the model must translate ONLY what is actually printed and invent
// nothing. Sections with no text on the label come back EMPTY.

const LABEL_TRANSLATE_PROMPT =
  'Ти — перекладач тексту з етикетки / упаковки товару. ' +
  'На фото — етикетка, задня сторона або інструкція товару. ' +
  'Твоє завдання: ПЕРЕКЛАСТИ УКРАЇНСЬКОЮ те, що РЕАЛЬНО написано на упаковці. ' +
  'Відповідай ТІЛЬКИ валідним JSON без зайвого тексту, у форматі: ' +
  '{"product":"...","usage":"...","warnings":"...","readable":true}. ' +
  'product — що це за товар і ключова інформація про нього з етикетки (склад, призначення, обʼєм/вага, виробник) — лише те, що написано. ' +
  'usage — спосіб застосування / інструкція використання, ПЕРЕКЛАДЕНА з етикетки. Якщо такого тексту на фото НЕМАЄ — постав порожній рядок "". ' +
  'warnings — застереження, попередження, протипоказання з етикетки. Якщо їх НЕМАЄ на фото — постав порожній рядок "". ' +
  'readable — true якщо текст видно і його вдалося прочитати, false якщо фото нечітке або тексту не видно. ' +
  'КРИТИЧНО: НЕ вигадуй, НЕ додавай інформацію, якої немає на фото, НЕ давай власних порад чи припущень. ' +
  'Перекладай дослівно за змістом, нічого не додаючи від себе. ' +
  'Якщо якоїсь секції на етикетці немає — залиш її порожнім рядком, не заповнюй здогадами. ' +
  'Власні назви та бренди можеш лишати мовою оригіналу.';

function parseTranslateResponse(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      product:  (parsed.product  || '').trim(),
      usage:    (parsed.usage    || '').trim(),
      warnings: (parsed.warnings || '').trim(),
      readable: parsed.readable !== false,
    };
  } catch {
    // Model returned plain text instead of JSON — surface it as the product body.
    return { product: raw.trim(), usage: '', warnings: '', readable: true };
  }
}

// Returns { product, usage, warnings, readable, usage: tokenUsage }.
async function translateLabelImageUrl(url) {
  if (!url) return { product: '', usage: '', warnings: '', readable: false, tokenUsage: {} };

  const preferGemini = DESCRIBE_PROVIDER !== 'openai' && getGeminiStatus().connected;

  if (preferGemini) {
    try {
      const { text: raw } = await generateTextFromImageUrl(url, LABEL_TRANSLATE_PROMPT);
      if (raw) return { ...parseTranslateResponse(raw), tokenUsage: {} };
    } catch (err) {
      console.error('[translateLabel:gemini]', err.message);
      if (!getOpenAIStatus().connected) throw err;
    }
  }

  if (getOpenAIStatus().connected) {
    const { text: raw, usage } = await openaiTextFromImageUrl(url, LABEL_TRANSLATE_PROMPT);
    return { ...parseTranslateResponse(raw || ''), tokenUsage: usage };
  }

  const { text: raw } = await generateTextFromImageUrl(url, LABEL_TRANSLATE_PROMPT);
  return { ...parseTranslateResponse(raw || ''), tokenUsage: {} };
}

module.exports = { describeImageUrl, translateLabelImageUrl };

'use strict';

// Plain-language "what is this product?" description from a photo. This is a
// GENERATIVE task (image → text), so it uses a generative model — NOT the
// embedding model (embeddings can't produce text). Gemini-only: OpenAI was
// retired project-wide, so there is no fallback — a Gemini failure surfaces as
// itself (a transient 503/429 from Gemini) instead of being masked by a stale
// OpenAI 429.

const { generateTextFromImageUrl, getGeminiStatus } = require('../geminiClient');

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
// usage  — always {} (kept for call-site compatibility)
async function describeImageUrl(url) {
  if (!url) return { text: '', name: '', usage: {} };
  if (!getGeminiStatus().connected) throw new Error('gemini_not_configured');
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

// Returns { product, usage, warnings, readable, tokenUsage }.
async function translateLabelImageUrl(url) {
  if (!url) return { product: '', usage: '', warnings: '', readable: false, tokenUsage: {} };
  if (!getGeminiStatus().connected) throw new Error('gemini_not_configured');
  const { text: raw } = await generateTextFromImageUrl(url, LABEL_TRANSLATE_PROMPT);
  return { ...parseTranslateResponse(raw || ''), tokenUsage: {} };
}

// ── Follow-up questions about the photo ──────────────────────────────────────
// After the description / translation the user may ask clarifying questions about
// the SAME photo ("чи є тут цукор?", "скільки штук в упаковці?"). We re-send the
// photo plus the prior Q&A so the answer stays grounded in what is actually
// visible — the model must NOT invent anything beyond the image.

const ASK_PHOTO_PROMPT =
  'Ти — корисний помічник для працівника магазину. На ФОТО — товар (етикетка / упаковка / задня сторона). ' +
  'Спочатку уважно роздивись фото: прочитай весь текст на упаковці, включно з дрібним шрифтом та написами іншими мовами, і визнач, що це за товар. ' +
  'Далі ПОВНОЦІННО відповідай на запитання працівника УКРАЇНСЬКОЮ мовою — як обізнаний консультант. ' +
  'Можеш вільно використовувати свої загальні знання про такий товар: пояснювати, для чого він, як ним користуватися, з чим поєднується, на що звернути увагу, давати поради та контекст. ' +
  'Коли наводиш конкретні дані саме з упаковки (склад, обʼєм, дати, попередження) — бери їх з фото. ' +
  'Якщо чогось не видно на фото, а ти не впевнений — так і скажи, не вигадуй конкретних цифр чи фактів. ' +
  'Відповідай по суті й корисно, без зайвої води та рекламних фраз. Власні назви та бренди можеш лишати мовою оригіналу.';

// history: [{ question, answer }] — prior turns about the same photo.
function buildAskPrompt(question, history = []) {
  let prompt = ASK_PHOTO_PROMPT;
  const turns = Array.isArray(history) ? history.filter((h) => h && h.question) : [];
  if (turns.length) {
    prompt += '\n\nПопередні запитання та відповіді про це фото:';
    for (const t of turns) {
      prompt += `\nПитання: ${String(t.question).trim()}`;
      prompt += `\nВідповідь: ${String(t.answer || '').trim()}`;
    }
  }
  prompt += `\n\nНове запитання: ${String(question).trim()}`;
  return prompt;
}

// Returns { answer, tokenUsage }.
async function answerPhotoQuestionImageUrl(url, question, history = []) {
  if (!url || !String(question || '').trim()) return { answer: '', tokenUsage: {} };
  if (!getGeminiStatus().connected) throw new Error('gemini_not_configured');
  const prompt = buildAskPrompt(question, history);
  const { text } = await generateTextFromImageUrl(url, prompt);
  return { answer: (text || '').trim(), tokenUsage: {} };
}

module.exports = { describeImageUrl, translateLabelImageUrl, answerPhotoQuestionImageUrl };

'use strict';

const TITLE_MATCH_THRESHOLD = Math.min(
  0.99,
  Math.max(0.70, Number(process.env.ALLEGRO_BASELINKER_IMAGE_TITLE_MATCH_THRESHOLD) || 0.82),
);

function clean(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeImageUrls(values) {
  const out = [];
  const push = (value) => {
    const url = clean(typeof value === 'string' ? value : value?.url, 4096);
    if (!/^https:\/\//i.test(url) || out.includes(url)) return;
    out.push(url);
  };
  if (Array.isArray(values)) values.forEach(push);
  else if (values && typeof values === 'object') Object.values(values).forEach(push);
  else push(values);
  return out.slice(0, 8);
}

function normalizeName(value) {
  return clean(value, 1000)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nameTokens(value) {
  return [...new Set(normalizeName(value).split(' ').filter((token) => token.length >= 2))];
}

function scoreProductName(queryName, candidateName) {
  const query = normalizeName(queryName);
  const candidate = normalizeName(candidateName);
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;

  const queryTokens = nameTokens(query);
  const candidateTokens = nameTokens(candidate);
  if (!queryTokens.length || !candidateTokens.length) return 0;
  const candidateSet = new Set(candidateTokens);
  const intersection = queryTokens.filter((token) => candidateSet.has(token)).length;
  const union = new Set([...queryTokens, ...candidateTokens]).size;
  const coverage = intersection / queryTokens.length;
  const jaccard = union > 0 ? intersection / union : 0;
  const containmentBonus = (candidate.includes(query) || query.includes(candidate)) ? 0.08 : 0;
  return Math.min(1, (coverage * 0.68) + (jaccard * 0.32) + containmentBonus);
}

function productsFromPayload(payload) {
  if (Array.isArray(payload?.products)) return payload.products;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function selectBestCatalogProduct(payload, queryName, { exactIdentity = false } = {}) {
  const candidates = productsFromPayload(payload)
    .map((product, index) => ({
      product,
      index,
      images: normalizeImageUrls(product?.images),
      score: exactIdentity ? (index === 0 ? 1 : 0.999 - (index * 0.001)) : scoreProductName(queryName, product?.name),
    }))
    .filter((row) => row.images.length > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (!candidates.length) return null;
  const best = candidates[0];
  if (!exactIdentity && best.score < TITLE_MATCH_THRESHOLD) return null;
  return { product: best.product, images: best.images, score: best.score };
}

module.exports = {
  TITLE_MATCH_THRESHOLD,
  normalizeImageUrls,
  normalizeName,
  scoreProductName,
  selectBestCatalogProduct,
};

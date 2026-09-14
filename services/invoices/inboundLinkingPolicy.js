'use strict';

function clean(value, max = 512) { return String(value ?? '').trim().slice(0, max); }
function normalizeName(value) {
  return clean(value, 512).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^0-9A-ZĄĆĘŁŃÓŚŹŻ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function normalizeTaxId(value) { return clean(value, 64).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^PL(?=\d{10}$)/, ''); }
function normalizeCountry(value) { return clean(value, 8).toUpperCase() || 'PL'; }

function pickFirst(object, keys) {
  if (!object || typeof object !== 'object') return '';
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function normalizePartyIdentity(party = {}) {
  const identifier = party.identifier && typeof party.identifier === 'object' ? party.identifier : {};
  const taxId = normalizeTaxId(pickFirst(party, ['nip', 'NIP', 'taxId', 'identifierValue', 'id']) || pickFirst(identifier, ['value', 'nip', 'taxId']));
  const name = clean(pickFirst(party, ['name', 'fullName', 'Nazwa', 'companyName']), 512);
  const countryCode = normalizeCountry(pickFirst(party, ['countryCode', 'country', 'KodKraju']) || pickFirst(identifier, ['countryCode', 'country']));
  let taxIdType = clean(pickFirst(party, ['taxIdType', 'identifierType']), 32).toLowerCase();
  if (!taxIdType && countryCode === 'PL' && /^\d{10}$/.test(taxId)) taxIdType = 'nip';
  return { name, normalizedName: normalizeName(name), countryCode, taxIdType, taxId };
}

function confidenceForScore(score) {
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  if (n >= 95) return 'exact';
  if (n >= 80) return 'high';
  if (n >= 55) return 'medium';
  return 'low';
}

function scoreCounterpartyCandidate(seller, counterparty) {
  const source = normalizePartyIdentity(seller);
  const target = {
    name: clean(counterparty?.legalName || counterparty?.name, 512),
    normalizedName: normalizeName(counterparty?.normalizedName || counterparty?.legalName || counterparty?.name),
    countryCode: normalizeCountry(counterparty?.countryCode),
    taxIdType: clean(counterparty?.taxIdType, 32).toLowerCase(),
    taxId: normalizeTaxId(counterparty?.taxId),
  };
  const evidence = [];
  let score = 0;
  if (source.taxId && target.taxId) {
    if (source.taxId !== target.taxId) return { score: 0, confidence: 'low', evidence: [{ code: 'tax_id_conflict', weight: -100 }] };
    score += 85; evidence.push({ code: 'tax_id_exact', weight: 85, value: source.taxId });
  }
  if (source.normalizedName && target.normalizedName && source.normalizedName === target.normalizedName) {
    score += 10; evidence.push({ code: 'name_exact', weight: 10 });
  }
  if (source.countryCode && target.countryCode && source.countryCode === target.countryCode) {
    score += 5; evidence.push({ code: 'country_exact', weight: 5, value: source.countryCode });
  }
  score = Math.min(100, score);
  const hasExactTaxIdentity = evidence.some((item) => item.code === 'tax_id_exact');
  return { score, confidence: hasExactTaxIdentity ? 'exact' : confidenceForScore(score), evidence };
}

function asDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function dayDistance(left, right) {
  const a = asDate(left); const b = asDate(right);
  if (!a || !b) return null;
  return Math.abs(a.getTime() - b.getTime()) / 86400000;
}

function xmlDecode(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}
function tag(block, name) {
  const match = String(block || '').match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? xmlDecode(match[1].replace(/<[^>]+>/g, '')) : '';
}
function extractFa3BusinessFacts(xml) {
  const source = String(xml || '');
  const lines = [];
  for (const match of source.matchAll(/<FaWiersz(?:\s[^>]*)?>([\s\S]*?)<\/FaWiersz>/gi)) {
    const block = match[1];
    const name = tag(block, 'P_7');
    const quantityRaw = tag(block, 'P_8B');
    const quantity = quantityRaw !== '' && Number.isFinite(Number(quantityRaw.replace(',', '.'))) ? Number(quantityRaw.replace(',', '.')) : null;
    if (name || quantity != null) lines.push({ name, normalizedName: normalizeName(name), quantity });
    if (lines.length >= 1000) break;
  }
  return { lines };
}

function tokenSet(value) { return new Set(normalizeName(value).split(' ').filter((x) => x.length >= 3)); }
function overlapRatio(a, b) {
  const left = tokenSet(a); const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0; for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function scoreReceiptCandidate({ invoiceDate, invoiceLines = [], receipt = {}, receiptItems = [] } = {}) {
  const evidence = [];
  let score = 0;
  const distance = dayDistance(invoiceDate, receipt.completedAt || receipt.createdAt || receipt.startedAt);
  if (distance != null) {
    let weight = 0;
    if (distance <= 1) weight = 30;
    else if (distance <= 3) weight = 24;
    else if (distance <= 7) weight = 15;
    else if (distance <= 14) weight = 6;
    if (weight) { score += weight; evidence.push({ code: 'date_proximity', weight, value: Number(distance.toFixed(2)) }); }
  }

  const inv = Array.isArray(invoiceLines) ? invoiceLines.filter((line) => line?.name || line?.quantity != null) : [];
  const rec = Array.isArray(receiptItems) ? receiptItems : [];
  if (inv.length && rec.length) {
    const diff = Math.abs(inv.length - rec.length);
    const lineWeight = diff === 0 ? 10 : diff === 1 ? 7 : diff <= Math.max(2, Math.ceil(inv.length * 0.25)) ? 4 : 0;
    if (lineWeight) { score += lineWeight; evidence.push({ code: 'line_count_close', weight: lineWeight, value: `${inv.length}/${rec.length}` }); }

    const invQty = inv.reduce((sum, line) => sum + (Number.isFinite(Number(line.quantity)) ? Number(line.quantity) : 0), 0);
    const recQty = rec.reduce((sum, item) => sum + (Number.isFinite(Number(item.totalQty)) ? Number(item.totalQty) : 0), 0);
    if (invQty > 0 && recQty > 0) {
      const ratio = Math.min(invQty, recQty) / Math.max(invQty, recQty);
      const qtyWeight = ratio >= 0.98 ? 20 : ratio >= 0.9 ? 15 : ratio >= 0.75 ? 8 : 0;
      if (qtyWeight) { score += qtyWeight; evidence.push({ code: 'quantity_close', weight: qtyWeight, value: `${invQty}/${recQty}` }); }
    }

    let overlap = 0;
    for (const line of inv) {
      let best = 0;
      for (const item of rec) best = Math.max(best, overlapRatio(line.name, item.name));
      overlap += best;
    }
    const avg = overlap / inv.length;
    const nameWeight = Math.round(Math.min(35, avg * 35));
    if (nameWeight >= 5) { score += nameWeight; evidence.push({ code: 'item_name_overlap', weight: nameWeight, value: Number(avg.toFixed(3)) }); }
  }
  score = Math.min(100, score);
  const confidence = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low';
  return { score, confidence, evidence };
}

module.exports = {
  normalizeName, normalizeTaxId, normalizePartyIdentity, confidenceForScore,
  scoreCounterpartyCandidate, scoreReceiptCandidate, extractFa3BusinessFacts,
};

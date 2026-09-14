'use strict';

const { appError } = require('../../../utils/errors');
const { addMoney } = require('../decimal');
const { isValidPolishNip } = require('../taxId');
const { KSEF_SCHEMA } = require('./config');

const FA3_NAMESPACE = 'http://crd.gov.pl/wzor/2025/06/25/13775/';
const SUPPORTED_RATES = new Set(['23', '8', '5']);

function xml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function addressLine(address = {}) { return [address.street, address.postalCode, address.city].map((v) => String(v || '').trim()).filter(Boolean).join(' '); }
function normalizeTaxId(value) { return String(value || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase(); }
function normalizeRate(item) {
  const raw = String(item?.vat?.rate ?? item?.vat?.code ?? '').trim().replace('%', '');
  if (SUPPORTED_RATES.has(raw)) return raw;
  return '';
}
function providerBlockers(snapshot = {}) {
  const blockers = [];
  if (!['invoice', 'correction'].includes(snapshot.type)) blockers.push('ksef_invoice_type_not_supported');
  if (snapshot.currency !== 'PLN') blockers.push('ksef_stage3_currency_not_supported');
  if (!snapshot.invoiceNumber) blockers.push('invoice_number_required');
  if (!snapshot.issueDate) blockers.push('issue_date_required');
  if (!snapshot.seller?.name) blockers.push('seller_name_required');
  if (snapshot.seller?.address?.countryCode !== 'PL' || snapshot.seller?.taxIdType !== 'nip' || !isValidPolishNip(snapshot.seller?.taxId)) blockers.push('ksef_seller_nip_required');
  if (!addressLine(snapshot.seller?.address)) blockers.push('ksef_seller_address_required');
  if (!snapshot.buyer?.name) blockers.push('ksef_buyer_name_required');
  if (!addressLine(snapshot.buyer?.address)) blockers.push('ksef_buyer_address_required');
  if (snapshot.buyer?.taxId && snapshot.buyer?.address?.countryCode && snapshot.buyer.address.countryCode !== 'PL') blockers.push('ksef_stage3_foreign_buyer_not_supported');
  if (snapshot.buyer?.taxId && String(snapshot.buyer?.address?.countryCode || 'PL').toUpperCase() === 'PL'
      && (String(snapshot.buyer?.taxIdType || '').toLowerCase() !== 'nip' || !isValidPolishNip(snapshot.buyer.taxId))) {
    blockers.push('ksef_stage3_buyer_nip_invalid');
  }
  if (snapshot.type === 'correction') {
    const ref = snapshot.references?.correction;
    if (!ref?.originalInvoiceNumber || !ref?.originalIssueDate || !ref?.originalFiscalReference) blockers.push('ksef_correction_original_reference_required');
    if (!String(ref?.reason || '').trim()) blockers.push('ksef_correction_reason_required');
    if (!['1', '2', '3'].includes(String(ref?.correctionType || ''))) blockers.push('ksef_correction_type_invalid');
    if (String(ref?.lineMode || '') !== 'delta') blockers.push('ksef_correction_line_mode_not_supported');
  }
  for (const [i, item] of (snapshot.items || []).entries()) {
    if (!SUPPORTED_RATES.has(normalizeRate(item))) blockers.push(`ksef_item_${i}_vat_rate_not_supported`);
    if (!item.amounts?.net || !item.amounts?.vat || !item.amounts?.gross) blockers.push(`ksef_item_${i}_amounts_required`);
  }
  return [...new Set(blockers)];
}

function decimalParts(value) {
  const s = String(value || '0').trim();
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [whole='0', frac=''] = body.split('.');
  return { n: BigInt(`${whole || '0'}${frac}` || '0') * (neg ? -1n : 1n), scale: frac.length };
}
function pow10(n) { return 10n ** BigInt(n); }
function divideDecimal(numerator, denominator, scale = 8) {
  const a = decimalParts(numerator); const b = decimalParts(denominator);
  if (b.n === 0n) throw appError('ksef_invoice_xml_invalid', { reason: 'quantity_zero' });
  let top = a.n * pow10(b.scale + scale); let bottom = b.n * pow10(a.scale);
  const negative = (top < 0n) !== (bottom < 0n); top = top < 0n ? -top : top; bottom = bottom < 0n ? -bottom : bottom;
  let q = top / bottom; const r = top % bottom; if (r * 2n >= bottom) q += 1n; if (negative) q = -q;
  const sign = q < 0n ? '-' : ''; let digits = (q < 0n ? -q : q).toString().padStart(scale + 1, '0');
  const out = scale ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}` : `${sign}${digits}`;
  return out.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function totalsByRate(items = []) {
  const out = {};
  for (const item of items) {
    const rate = normalizeRate(item);
    if (!out[rate]) out[rate] = { net: [], vat: [] };
    out[rate].net.push(item.amounts.net); out[rate].vat.push(item.amounts.vat);
  }
  return Object.fromEntries(Object.entries(out).map(([rate, v]) => [rate, { net: addMoney(v.net), vat: addMoney(v.vat) }]));
}
function paymentMethodCode(method) {
  const value = String(method || '').toLowerCase();
  if (['cash', 'gotowka', 'gotówka', 'cod'].includes(value)) return '1';
  if (['card', 'karta'].includes(value)) return '2';
  if (['cheque', 'check', 'czek'].includes(value)) return '4';
  if (['transfer', 'bank_transfer', 'bacs', 'przelew'].includes(value)) return '6';
  return '7';
}
function partyId(party = {}) {
  const taxId = normalizeTaxId(party.taxId);
  if (taxId && String(party.address?.countryCode || 'PL').toUpperCase() === 'PL' && String(party.taxIdType || '').toLowerCase() === 'nip') return `<NIP>${xml(taxId)}</NIP>`;
  return taxId ? `<NrID>${xml(taxId)}</NrID>` : '<BrakID>1</BrakID>';
}

function generateFa3Xml(snapshot = {}, { systemInfo = 'Zlotoweczka ERP', generatedAt = null } = {}) {
  const blockers = providerBlockers(snapshot);
  if (blockers.length) throw appError('ksef_invoice_not_supported', { blockers });
  const rates = totalsByRate(snapshot.items);
  const taxSummary = [];
  if (rates['23']) taxSummary.push(`<P_13_1>${xml(rates['23'].net)}</P_13_1><P_14_1>${xml(rates['23'].vat)}</P_14_1>`);
  if (rates['8']) taxSummary.push(`<P_13_2>${xml(rates['8'].net)}</P_13_2><P_14_2>${xml(rates['8'].vat)}</P_14_2>`);
  if (rates['5']) taxSummary.push(`<P_13_3>${xml(rates['5'].net)}</P_13_3><P_14_3>${xml(rates['5'].vat)}</P_14_3>`);

  const rows = snapshot.items.map((item, index) => {
    const netUnit = item.priceBasis === 'net' ? item.unitPrice : divideDecimal(item.amounts.net, item.quantity, 8);
    return `<FaWiersz><NrWierszaFa>${index + 1}</NrWierszaFa><P_7>${xml(item.name)}</P_7><P_8A>${xml(String(item.unit || 'szt.').replace(/\./g, ''))}</P_8A><P_8B>${xml(item.quantity)}</P_8B><P_9A>${xml(netUnit)}</P_9A><P_11>${xml(item.amounts.net)}</P_11><P_12>${xml(normalizeRate(item))}</P_12></FaWiersz>`;
  }).join('');

  const sellerAddress = addressLine(snapshot.seller.address);
  const buyerAddress = addressLine(snapshot.buyer.address);
  const saleDate = snapshot.saleDate && snapshot.saleDate !== snapshot.issueDate ? `<P_6>${xml(snapshot.saleDate)}</P_6>` : '';
  const paymentCode = paymentMethodCode(snapshot.payment?.method);
  let payment = '';
  if (snapshot.payment?.paid) {
    const paidDate = String(snapshot.payment.paidAt || snapshot.issueDate).slice(0, 10);
    payment = `<Platnosc><Zaplacono>1</Zaplacono><DataZaplaty>${xml(paidDate)}</DataZaplaty><FormaPlatnosci>${paymentCode}</FormaPlatnosci>${paymentCode === '6' && snapshot.payment.bankAccount ? `<RachunekBankowy><NrRB>${xml(snapshot.payment.bankAccount)}</NrRB></RachunekBankowy>` : ''}</Platnosc>`;
  } else {
    payment = `<Platnosc>${snapshot.payment?.dueDate ? `<TerminPlatnosci><Termin>${xml(snapshot.payment.dueDate)}</Termin></TerminPlatnosci>` : ''}<FormaPlatnosci>${paymentCode}</FormaPlatnosci>${paymentCode === '6' && snapshot.payment?.bankAccount ? `<RachunekBankowy><NrRB>${xml(snapshot.payment.bankAccount)}</NrRB></RachunekBankowy>` : ''}</Platnosc>`;
  }
  const orderRef = snapshot.type === 'invoice' && snapshot.source?.externalNumber ? `<WarunkiTransakcji><Zamowienia><NrZamowienia>${xml(snapshot.source.externalNumber)}</NrZamowienia></Zamowienia></WarunkiTransakcji>` : '';
  const footer = snapshot.notes ? `<Stopka><Informacje><StopkaFaktury>${xml(snapshot.notes)}</StopkaFaktury></Informacje></Stopka>` : '';
  const generatedAtValue = new Date(generatedAt || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const correctionRef = snapshot.type === 'correction' ? snapshot.references?.correction : null;
  const correctionBlock = correctionRef
    ? `<PrzyczynaKorekty>${xml(correctionRef.reason)}</PrzyczynaKorekty><TypKorekty>${xml(correctionRef.correctionType)}</TypKorekty><DaneFaKorygowanej><DataWystFaKorygowanej>${xml(correctionRef.originalIssueDate)}</DataWystFaKorygowanej><NrFaKorygowanej>${xml(correctionRef.originalInvoiceNumber)}</NrFaKorygowanej><NrKSeF>1</NrKSeF><NrKSeFFaKorygowanej>${xml(correctionRef.originalFiscalReference)}</NrKSeFFaKorygowanej></DaneFaKorygowanej>`
    : '';
  const invoiceKind = correctionRef ? 'KOR' : 'VAT';

  return `<?xml version="1.0" encoding="UTF-8"?><Faktura xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns="${FA3_NAMESPACE}"><Naglowek><KodFormularza kodSystemowy="${KSEF_SCHEMA.systemCode}" wersjaSchemy="${KSEF_SCHEMA.schemaVersion}">${KSEF_SCHEMA.value}</KodFormularza><WariantFormularza>3</WariantFormularza><DataWytworzeniaFa>${generatedAtValue}</DataWytworzeniaFa><SystemInfo>${xml(systemInfo)}</SystemInfo></Naglowek><Podmiot1><DaneIdentyfikacyjne><NIP>${xml(normalizeTaxId(snapshot.seller.taxId))}</NIP><Nazwa>${xml(snapshot.seller.name)}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>PL</KodKraju><AdresL1>${xml(sellerAddress)}</AdresL1></Adres></Podmiot1><Podmiot2><DaneIdentyfikacyjne>${partyId(snapshot.buyer)}<Nazwa>${xml(snapshot.buyer.name)}</Nazwa></DaneIdentyfikacyjne><Adres><KodKraju>${xml(snapshot.buyer.address?.countryCode || 'PL')}</KodKraju><AdresL1>${xml(buyerAddress)}</AdresL1></Adres><JST>2</JST><GV>2</GV></Podmiot2><Fa><KodWaluty>PLN</KodWaluty><P_1>${xml(snapshot.issueDate)}</P_1><P_2>${xml(snapshot.invoiceNumber)}</P_2>${saleDate}${taxSummary.join('')}<P_15>${xml(snapshot.totals.gross)}</P_15><Adnotacje><P_16>2</P_16><P_17>2</P_17><P_18>2</P_18><P_18A>2</P_18A><Zwolnienie><P_19N>1</P_19N></Zwolnienie><NoweSrodkiTransportu><P_22N>1</P_22N></NoweSrodkiTransportu><P_23>2</P_23><PMarzy><P_PMarzyN>1</P_PMarzyN></PMarzy></Adnotacje><RodzajFaktury>${invoiceKind}</RodzajFaktury>${correctionBlock}${rows}${payment}${orderRef}</Fa>${footer}</Faktura>`;
}

module.exports = { FA3_NAMESPACE, SUPPORTED_RATES, providerBlockers, generateFa3Xml, divideDecimal, paymentMethodCode };

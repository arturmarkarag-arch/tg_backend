'use strict';

const Counter = require('../../models/Counter');
const { appError } = require('../../utils/errors');

function cleanSegment(value, max = 40) {
  const out = String(value ?? '').trim().slice(0, max);
  if (!out || /[\r\n\t]/.test(out)) throw appError('legal_entity_numbering_invalid');
  return out;
}

function formatInvoiceNumber({ series, sequence, year, separator = '/', padding = 1 }) {
  const sep = cleanSegment(separator, 3);
  const cleanSeries = cleanSegment(series, 40);
  const seq = Number(sequence);
  const numericYear = Number(year);
  const pad = Math.max(1, Math.min(12, Number(padding) || 1));
  if (!Number.isInteger(seq) || seq < 1 || !Number.isInteger(numericYear) || numericYear < 2000 || numericYear > 9999) {
    throw appError('invoice_numbering_failed');
  }
  return `${cleanSeries}${sep}${String(seq).padStart(pad, '0')}${sep}${numericYear}`;
}

function issueYear(issueDate) {
  const match = String(issueDate || '').match(/^(\d{4})-/);
  if (!match) throw appError('invoice_issue_date_required_for_numbering');
  return Number(match[1]);
}

async function allocateInvoiceNumber({ legalEntity, invoiceType, issueDate, session }) {
  if (!legalEntity?._id) throw appError('legal_entity_required');
  const numbering = legalEntity.numbering || {};
  const series = invoiceType === 'correction' ? numbering.correctionSeries : numbering.invoiceSeries;
  if (!series) throw appError('legal_entity_numbering_invalid');
  const year = issueYear(issueDate);
  const counterName = `invoice:${String(legalEntity._id)}:${invoiceType}:${year}:${String(series)}`;
  const query = Counter.findOneAndUpdate(
    { name: counterName },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );
  const counter = await query;
  const sequence = Number(counter?.seq || 0);
  return {
    invoiceNumber: formatInvoiceNumber({
      series,
      sequence,
      year,
      separator: numbering.separator || '/',
      padding: numbering.padding || 1,
    }),
    allocation: { series: String(series), sequence, year },
  };
}

module.exports = { formatInvoiceNumber, allocateInvoiceNumber };

'use strict';

/**
 * @file fee-receipt.template.js — HTML of the fee payment receipt.
 *
 * Pure, like `fee-status.js` and `fee-reminder-kind.js`: no database, no
 * Puppeteer, no campus lookup. It takes the payment, its debt, the student and
 * the campus branding, and returns a self-contained HTML string. The service
 * hands that string to the platform's single PDF pool
 * (`modules/academic-print` facade → `renderPdf`).
 *
 * Everything a human reads comes from `shared/i18n/catalogs/finance.js`, and the
 * amounts and dates are formatted with the recipient's own locale table
 * (`shared/i18n/languages.js`) — the same one the transcripts use, so two
 * documents issued by the same campus never disagree on how a date is written.
 *
 * WHY NO ASSET IS FETCHED HERE
 * The campus logo arrives already inlined as a `data:` URL by
 * `getCampusBranding()`. A template that fetched anything would make the render
 * depend on the network at print time, which is exactly what the academic
 * renderer took pains to avoid.
 */

const { pick, localeContext } = require('../../shared/i18n');
const { escapeHtml } = require('../../shared/utils/html');
const catalog = require('../../shared/i18n/catalogs/finance');

/** Palette kept in step with the academic prints (same campus, same paper). */
const INK        = '#1a1a1a';
const MUTED      = '#666';
const ACCENT     = '#003366';
const RULE       = '#d8d8d8';

/**
 * Formats an amount in its own currency. `Intl` renders XAF without decimals and
 * EUR/USD with two — the debt's currency decides, never a hard-coded suffix.
 * Falls back to a plain grouped number if the runtime rejects the currency code.
 */
const money = (amount, currency, dateLocale) => {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(dateLocale, { style: 'currency', currency }).format(value);
  } catch {
    return `${new Intl.NumberFormat(dateLocale).format(value)} ${currency ?? ''}`.trim();
  }
};

/** Long-form date in the reader's locale; an absent date renders as an em dash. */
const longDate = (value, dateLocale) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' });
};

/**
 * The number printed on the receipt.
 *
 * `FeePayment.reference` is the encashment reference the operator typed and the
 * only receipt number this platform has; it is optional, so a payment recorded
 * without one falls back to a short form of its immutable id. That fallback is a
 * RENDERING of the id, not a second counter: nothing is stored, and two receipts
 * of the same payment always print the same string.
 */
const receiptNumberOf = (payment) =>
  payment.reference || `PAY-${String(payment._id).slice(-8).toUpperCase()}`;

/** One `label — value` row of the identity block. */
const row = (label, value) => `
  <tr>
    <td style="padding:2.5mm 0;color:${MUTED};white-space:nowrap;">${escapeHtml(label)}</td>
    <td style="padding:2.5mm 0 2.5mm 8mm;color:${INK};font-weight:600;">${escapeHtml(value)}</td>
  </tr>`;

/**
 * Builds the receipt HTML.
 *
 * @param {Object}  input
 * @param {Object}  input.payment   FeePayment (lean) — amount, currency, method, reference, paidAt
 * @param {Object}  input.fee       StudentFee (lean) — label, academicYear, amountDue, amountPaid, currency
 * @param {Object}  [input.student] { firstName, lastName, matricule }
 * @param {Object}  [input.branding] { campus_name, location, logoDataUrl }
 * @param {string}  [input.locale]  recipient language (defaults to English)
 * @param {Date}    [input.issuedAt] print timestamp (injectable for tests)
 * @returns {string} self-contained HTML
 */
function buildReceiptHtml({ payment, fee, student = {}, branding = {}, locale, issuedAt = new Date() }) {
  const { lang, htmlLang, dateLocale, dir } = localeContext(locale);
  const label = (key) => pick(catalog[key], lang);

  const currency = payment.currency || fee?.currency;
  // The debt's running totals, taken from the debt itself rather than recomputed
  // from the payment lines: `amountPaid` is the figure the ledger and the
  // reminders already use, and a receipt that disagreed with the ledger would be
  // the document the student brings to the desk.
  const amountDue  = Number(fee?.amountDue) || 0;
  const amountPaid = Number(fee?.amountPaid) || 0;
  const balance    = Math.max(0, amountDue - amountPaid);

  const fullName = [student.firstName, student.lastName].filter(Boolean).join(' ');
  const methodLabel = pick(catalog.methods[payment.method], lang) || payment.method || '—';

  const logo = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="" style="width:16mm;height:16mm;border-radius:50%;object-fit:cover;" />`
    : `<div style="width:16mm;height:16mm;border-radius:50%;background:${ACCENT};"></div>`;

  const city = [branding.location?.city, branding.location?.country].filter(Boolean).join(', ');

  const identityRows = [
    row(label('receiptNumber'), receiptNumberOf(payment)),
    row(label('paidOn'), longDate(payment.paidAt, dateLocale)),
    fullName ? row(label('student'), fullName) : '',
    student.matricule ? row(label('matricule'), student.matricule) : '',
    fee?.label ? row(label('feeLabel'), fee.label) : '',
    fee?.academicYear ? row(label('academicYear'), fee.academicYear) : '',
    row(label('method'), methodLabel),
    // Printed only when it differs from the receipt number above, so a payment
    // that carries a reference does not show the same string twice.
    payment.reference && payment.reference !== receiptNumberOf(payment)
      ? row(label('reference'), payment.reference)
      : '',
  ].join('');

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="${dir}">
<head><meta charset="utf-8" />
<style>
  *    { box-sizing:border-box; }
  body { margin:0; font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
         color:${INK}; font-size:10.5pt; line-height:1.45; }
  .sheet  { padding:0; }
  .header { display:flex; align-items:center; gap:6mm; border-bottom:2px solid ${ACCENT};
            padding-bottom:5mm; }
  .campus { font-size:14pt; font-weight:700; color:${ACCENT}; }
  .title  { margin:9mm 0 6mm; font-size:16pt; font-weight:700; letter-spacing:.4pt;
            text-transform:uppercase; }
  .amount { margin:7mm 0; padding:6mm; background:#f4f7fb; border-${dir === 'rtl' ? 'right' : 'left'}:3px solid ${ACCENT}; }
  .amount .value { font-size:20pt; font-weight:700; color:${ACCENT}; }
  .totals { width:100%; margin-top:8mm; border-top:1px solid ${RULE}; }
  .totals td { padding:2.5mm 0; }
  .foot   { margin-top:12mm; padding-top:4mm; border-top:1px solid ${RULE};
            color:${MUTED}; font-size:8.5pt; display:flex; justify-content:space-between; gap:6mm; }
</style></head>
<body><div class="sheet">

  <div class="header">
    ${logo}
    <div>
      <div class="campus">${escapeHtml(branding.campus_name || '')}</div>
      ${city ? `<div style="color:${MUTED};font-size:9pt;">${escapeHtml(city)}</div>` : ''}
    </div>
  </div>

  <div class="title">${escapeHtml(label('receiptTitle'))}</div>

  <table style="width:100%;border-collapse:collapse;">${identityRows}</table>

  <div class="amount">
    <div style="color:${MUTED};font-size:9pt;">${escapeHtml(label('amountPaid'))}</div>
    <div class="value">${escapeHtml(money(payment.amount, currency, dateLocale))}</div>
  </div>

  <table class="totals">
    <tr>
      <td style="color:${MUTED};">${escapeHtml(label('totalDue'))}</td>
      <td style="text-align:${dir === 'rtl' ? 'left' : 'right'};font-weight:600;">${escapeHtml(money(amountDue, currency, dateLocale))}</td>
    </tr>
    <tr>
      <td style="color:${MUTED};">${escapeHtml(label('totalPaid'))}</td>
      <td style="text-align:${dir === 'rtl' ? 'left' : 'right'};font-weight:600;">${escapeHtml(money(amountPaid, currency, dateLocale))}</td>
    </tr>
    <tr>
      <td style="color:${MUTED};font-weight:700;">${escapeHtml(label('balance'))}</td>
      <td style="text-align:${dir === 'rtl' ? 'left' : 'right'};font-weight:700;color:${balance > 0 ? INK : '#1b7f4d'};">
        ${escapeHtml(balance > 0 ? money(balance, currency, dateLocale) : label('settled'))}
      </td>
    </tr>
  </table>

  <div class="foot">
    <span>${escapeHtml(label('issuedOn'))} ${escapeHtml(longDate(issuedAt, dateLocale))}</span>
    <span>${escapeHtml(label('computerGenerated'))}</span>
  </div>

</div></body></html>`;
}

module.exports = { buildReceiptHtml, receiptNumberOf };

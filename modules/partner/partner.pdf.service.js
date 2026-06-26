'use strict';

/**
 * @file partner.pdf.service.js
 * @description Self-contained PDF generation for the partner module.
 *
 * Uses `pdf-lib` (pure JS — no headless browser, no pool) so commission
 * receipts and affiliate flyers can be produced inline in the request handler
 * without the Puppeteer footprint used by the academic-print / document modules.
 *
 * Exposed:
 *   - generateCommissionReceiptPdf(commission, { campusName }) → Buffer
 *   - generatePartnerFlyerPdf(partner, { campusName })         → Buffer
 *
 * Fonts: StandardFonts (Helvetica) encode WinAnsi (Latin-1). All dynamic text
 * is passed through `safe()` which strips characters outside that range so a
 * stray emoji / CJK name can never throw "WinAnsi cannot encode".
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const QRCode = require('qrcode');

const { buildReferralUrl } = require('../../shared/utils/referral');

// ── Palette (mirrors theme/partnerTokens BRAND_ORANGE) ─────────────────────────
const BRAND = rgb(1, 0.498, 0.243); // #ff7f3e
const DARK  = rgb(0.13, 0.13, 0.13);
const GREY  = rgb(0.45, 0.45, 0.45);
const WHITE = rgb(1, 1, 1);

const A4 = [595.28, 841.89];
const M  = 50;

// Strip anything outside WinAnsi (Latin-1) — see file header.
const safe = (v) => String(v ?? '').replace(/[^\x00-\xFF]/g, '');

const fmtDate  = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
const fmtMoney = (n) => Number(n || 0).toLocaleString('en-US');

const CHANNEL_LABELS = {
  momo_mtn:      'MTN Mobile Money',
  momo_orange:   'Orange Money',
  bank_transfer: 'Bank Transfer',
  cash:          'Cash',
  other:         'Other',
};

// ── Commission receipt ─────────────────────────────────────────────────────────

/**
 * Builds a one-page A4 commission payment receipt.
 * @param {Object} commission — lean doc with partner & lead populated.
 * @param {{ campusName?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
const generateCommissionReceiptPdf = async (commission, { campusName } = {}) => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();

  // Header band
  page.drawRectangle({ x: 0, y: height - 90, width, height: 90, color: BRAND });
  page.drawText(safe(campusName || 'Partner Program'), { x: M, y: height - 48, size: 18, font: bold, color: WHITE });
  page.drawText('Commission Payment Receipt', { x: M, y: height - 70, size: 11, font, color: WHITE });

  let y = height - 130;
  const row = (label, value, opts = {}) => {
    page.drawText(safe(label), { x: M, y, size: 10, font, color: GREY });
    page.drawText(safe(value), { x: M + 175, y, size: 10, font: opts.bold ? bold : font, color: opts.color || DARK });
    y -= 24;
  };

  const partner = commission.partner;
  const lead    = commission.lead;

  row('Receipt No', String(commission._id));
  row('Issued on', fmtDate(commission.paidAt || commission.createdAt));
  y -= 6;
  row('Partner', partner ? `${partner.firstName} ${partner.lastName}` : '-', { bold: true });
  row('Partner code', partner?.partnerCode || '-');
  row('Referred prospect', lead ? `${lead.firstName} ${lead.lastName}` : '-');
  if (lead?.email) row('Prospect email', lead.email);
  y -= 6;
  row('Payment channel', CHANNEL_LABELS[commission.paymentChannel] || commission.paymentChannel || '-');
  if (commission.paymentRef) row('Payment reference', commission.paymentRef);
  row('Status', String(commission.status).toUpperCase());

  // Amount highlight box
  y -= 10;
  const boxH = 60;
  page.drawRectangle({ x: M, y: y - boxH + 18, width: width - 2 * M, height: boxH, color: rgb(0.97, 0.97, 0.97) });
  page.drawText('AMOUNT PAID', { x: M + 16, y: y - 4, size: 10, font, color: GREY });
  page.drawText(`${fmtMoney(commission.amount)} ${safe(commission.currency || 'XAF')}`, {
    x: M + 16, y: y - 28, size: 22, font: bold, color: BRAND,
  });

  // Footer
  page.drawText(
    safe('This is a computer-generated receipt and does not require a signature.'),
    { x: M, y: 60, size: 8, font, color: GREY },
  );
  page.drawText(`Generated on ${fmtDate(new Date())}`, { x: M, y: 46, size: 8, font, color: GREY });

  return Buffer.from(await doc.save());
};

// ── Affiliate flyer ────────────────────────────────────────────────────────────

/**
 * Builds a one-page A4 affiliate flyer with the partner's QR code, referral link
 * and code, ready to print and share.
 * @param {Object} partner — lean doc (referralLink, partnerCode, names).
 * @param {{ campusName?: string }} [opts]
 * @returns {Promise<Buffer>}
 */
const generatePartnerFlyerPdf = async (partner, { campusName } = {}) => {
  const doc  = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();

  // Header band
  page.drawRectangle({ x: 0, y: height - 100, width, height: 100, color: BRAND });
  page.drawText(safe(campusName || 'Join our school'), { x: M, y: height - 55, size: 20, font: bold, color: WHITE });
  page.drawText('Pre-register today with my referral', { x: M, y: height - 80, size: 12, font, color: WHITE });

  // QR code — encodes the `src=qr` variant so scans are attributable; the link
  // shown as text below stays the plain (clickable) referral URL.
  const link    = partner.referralLink || '';
  const qrTarget = buildReferralUrl(partner.partnerCode, { src: 'qr' });
  if (qrTarget) {
    const qrBuffer = await QRCode.toBuffer(qrTarget, { type: 'png', width: 600, margin: 1, errorCorrectionLevel: 'M' });
    const qrImg = await doc.embedPng(qrBuffer);
    const qrSize = 240;
    page.drawImage(qrImg, { x: (width - qrSize) / 2, y: height - 400, width: qrSize, height: qrSize });
  }

  // Instructions
  let y = height - 440;
  const center = (text, size, f, color) => {
    const t = safe(text);
    const w = f.widthOfTextAtSize(t, size);
    page.drawText(t, { x: (width - w) / 2, y, size, font: f, color });
    y -= size + 12;
  };

  center('Scan the QR code with your phone camera', 13, bold, DARK);
  center('or use my referral link below', 11, font, GREY);
  y -= 8;

  if (partner.partnerCode) {
    center(`Partner code: ${partner.partnerCode}`, 14, bold, BRAND);
  }
  if (link) {
    // Link can be long — draw smaller and let it center; truncate display if huge.
    const shown = link.length > 80 ? `${link.slice(0, 77)}...` : link;
    center(shown, 10, font, GREY);
  }

  y -= 6;
  if (partner.firstName) {
    center(`Referred by ${partner.firstName} ${partner.lastName || ''}`.trim(), 11, font, DARK);
  }

  // Footer
  page.drawText(safe('Powered by the Partner Program'), { x: M, y: 46, size: 8, font, color: GREY });

  return Buffer.from(await doc.save());
};

module.exports = {
  generateCommissionReceiptPdf,
  generatePartnerFlyerPdf,
};

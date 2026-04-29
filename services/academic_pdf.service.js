'use strict';

/**
 * @file academic_pdf.service.js
 * @description PDF generation for 4 academic document types:
 *   - STUDENT_CARD  : CR80 ID card (85.6×54mm, front + back)
 *   - TRANSCRIPT    : Semester bulletin A4 (MINESUP-style)
 *   - ENROLLMENT    : Enrollment certificate A4
 *   - TIMETABLE     : Class weekly timetable A4 landscape
 *
 * Uses the existing Puppeteer installation (shared with document.pdf.service.js).
 * Maintains its own singleton browser to avoid pool contention.
 * QR codes reuse the existing document.qr.service.js (qrcode package).
 * Campus branding (logo as base64) is cached in memory with a 10-min TTL.
 */

const puppeteer = require('puppeteer');
const chromium  = require('@sparticuz/chromium');
const path      = require('path');
const fs        = require('fs').promises;

const { generateQrCodeDataUrl } = require('./document-services/document.qr.service');

// ── Config ────────────────────────────────────────────────────────────────────

const TIMEOUT_MS = parseInt(process.env.PUPPETEER_TIMEOUT_MS || '45000', 10);
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'print')
  : path.join(__dirname, '..', 'uploads', 'print');

// ── XSS-safe HTML escape ──────────────────────────────────────────────────────

const esc = (str) =>
  String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// ── Branding Cache (10-min TTL) ───────────────────────────────────────────────

const brandingCache = new Map(); // campusId → { logoDataUrl, campus_name, location, cachedAt }
const CACHE_TTL_MS  = 10 * 60 * 1000;

const getCampusBranding = async (campusId) => {
  const key    = String(campusId);
  const cached = brandingCache.get(key);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) return cached;

  const Campus = require('../models/campus.model');
  const campus = await Campus.findById(campusId)
    .select('campus_name campus_image location')
    .lean();

  if (!campus) throw Object.assign(new Error('Campus not found'), { statusCode: 404 });

  let logoDataUrl = null;
  if (campus.campus_image) {
    if (campus.campus_image.startsWith('http')) {
      // Cloudinary / external URL — use directly in img src
      logoDataUrl = campus.campus_image;
    } else {
      try {
        const absPath = path.join(__dirname, '..', 'uploads', campus.campus_image);
        const buf     = await fs.readFile(absPath);
        const ext     = path.extname(campus.campus_image).replace('.', '') || 'png';
        logoDataUrl   = `data:image/${ext};base64,${buf.toString('base64')}`;
      } catch {
        logoDataUrl = null;
      }
    }
  }

  const branding = { campus_name: campus.campus_name, location: campus.location || {}, logoDataUrl, cachedAt: Date.now() };
  brandingCache.set(key, branding);
  return branding;
};

// ── Singleton Puppeteer Browser ───────────────────────────────────────────────
// Uses a launch-promise to prevent the race condition where two concurrent
// callers both see _browser=null and both call puppeteer.launch().

let _browser        = null;
let _launchPromise  = null;

// Resolve the Chrome executable path for both cloud and local environments.
// Priority: explicit env var → @sparticuz/chromium (cloud) → puppeteer cache (local dev)
const resolveChromePath = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try   { return await chromium.executablePath(); }
  catch { return puppeteer.executablePath(); }
};

const getBrowser = async () => {
  if (_browser) return _browser;
  if (_launchPromise) return _launchPromise;

  _launchPromise = resolveChromePath().then((executablePath) =>
    puppeteer.launch({
      headless:        chromium.headless ?? true,
      executablePath,
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
    })
  ).then((browser) => {
    _browser       = browser;
    _launchPromise = null;
    _browser.on('disconnected', () => {
      _browser = null;
      console.warn('[AcademicPDF] Browser disconnected — will re-launch on next request.');
    });
    return _browser;
  }).catch((err) => {
    _launchPromise = null;
    throw Object.assign(new Error(`PDF engine unavailable: ${err.message}`), { statusCode: 503 });
  });

  return _launchPromise;
};

const shutdownAcademicPool = async () => {
  if (_launchPromise) await _launchPromise.catch(() => {});
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser        = null;
    _launchPromise  = null;
  }
};

// ── PDF Renderer ──────────────────────────────────────────────────────────────

const renderPdf = async (html, { format, width, height, landscape = false, margins = {} } = {}) => {
  const browser = await getBrowser();
  const page    = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: TIMEOUT_MS });
    return await page.pdf({
      format:         format || (width && height ? undefined : 'A4'),
      width,
      height,
      landscape,
      margin: {
        top:    margins.top    ?? '15mm',
        right:  margins.right  ?? '15mm',
        bottom: margins.bottom ?? '15mm',
        left:   margins.left   ?? '15mm',
      },
      printBackground: true,
    });
  } finally {
    await page.close().catch(() => {});
  }
};

// ── Template 1 — STUDENT ID CARD (CR80) ───────────────────────────────────────

const buildStudentCardHtml = async (student, branding, params = {}) => {
  const { academicYear, cardNumber, cardValidUntil } = params;

  const BASE_URL    = process.env.QR_VERIFICATION_BASE_URL || 'https://app.yourdomain.com';
  const qrPayload   = `${BASE_URL}/verify-card/${esc(student.matricule || String(student._id))}`;
  const qrDataUrl   = await generateQrCodeDataUrl(qrPayload, 80).catch(() => null);

  const cardNo      = cardNumber || student.matricule || `ID-${String(student._id).slice(-6).toUpperCase()}`;
  const validYear   = cardValidUntil
    ? new Date(cardValidUntil).getFullYear()
    : (academicYear ? academicYear.split('-')[1] : String(new Date().getFullYear() + 1));

  const logoHtml = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="logo" style="height:14mm;max-width:16mm;object-fit:contain;" />`
    : `<div style="width:14mm;height:14mm;background:#003366;border-radius:3px;"></div>`;

  const photoHtml = student.profileImage
    ? `<img src="${esc(student.profileImage)}" alt="photo" style="width:22mm;height:28mm;object-fit:cover;border:0.5mm solid rgba(255,255,255,0.4);border-radius:1mm;" />`
    : `<div style="width:22mm;height:28mm;background:#dde3ec;display:flex;align-items:center;justify-content:center;font-size:6pt;color:#888;border-radius:1mm;">No Photo</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  html,body{width:85.6mm;background:#fff;font-family:Arial,Helvetica,sans-serif;}
  @page{size:85.6mm 54mm;margin:0;}
  .card-front{
    width:85.6mm;height:54mm;overflow:hidden;
    background:linear-gradient(135deg,#00204a 0%,#003366 55%,#0055aa 100%);
    color:#fff;position:relative;page-break-after:always;
  }
  .diagonal-bg{
    position:absolute;top:0;right:0;width:38mm;height:100%;
    background:rgba(255,255,255,0.05);
    clip-path:polygon(25% 0%,100% 0%,100% 100%,0% 100%);
  }
  .card-header{display:flex;align-items:center;gap:2mm;padding:2.5mm 3mm 2mm;border-bottom:0.4mm solid rgba(255,255,255,0.25);}
  .school-info{flex:1;min-width:0;}
  .school-name{font-size:6pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.3px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .school-sub{font-size:5pt;opacity:0.75;margin-top:0.5mm;}
  .card-label{font-size:4.5pt;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;border:0.3mm solid rgba(255,255,255,0.5);padding:0.5mm 1.5mm;border-radius:1mm;white-space:nowrap;flex-shrink:0;}
  .card-body{display:flex;gap:2.5mm;padding:2mm 3mm;}
  .info{flex:1;min-width:0;}
  .full-name{font-size:7pt;font-weight:bold;line-height:1.2;margin-bottom:1.5mm;}
  .info-label{font-size:4pt;opacity:0.65;text-transform:uppercase;letter-spacing:0.3px;margin-top:1mm;}
  .info-value{font-size:5.5pt;opacity:0.95;}
  .card-footer{
    position:absolute;bottom:0;left:0;right:0;
    display:flex;align-items:center;justify-content:space-between;
    padding:1.5mm 3mm;background:rgba(0,0,0,0.3);
  }
  .card-no{font-size:4.5pt;font-family:'Courier New',monospace;letter-spacing:1px;opacity:0.85;}
  .card-back{width:85.6mm;height:54mm;background:#fff;display:flex;flex-direction:column;font-family:Arial,Helvetica,sans-serif;}
  .back-stripe{background:#003366;height:8mm;width:100%;}
  .back-mag{background:#111;height:6.5mm;width:100%;margin-top:3.5mm;}
  .back-body{display:flex;gap:3mm;padding:2mm 3mm;flex:1;}
  .back-col{flex:1;font-size:5pt;color:#444;line-height:1.6;}
  .back-label{font-weight:bold;font-size:4.5pt;text-transform:uppercase;color:#003366;margin-bottom:0.5mm;}
  .back-footer{font-size:4pt;color:#888;padding:1mm 3mm 2mm;border-top:0.3mm solid #ddd;text-align:center;line-height:1.5;}
</style>
</head>
<body>
<!-- FRONT -->
<div class="card-front">
  <div class="diagonal-bg"></div>
  <div class="card-header">
    ${logoHtml}
    <div class="school-info">
      <div class="school-name">${esc(branding.campus_name)}</div>
      <div class="school-sub">${esc(branding.location?.city || '')}${branding.location?.country ? ', ' + esc(branding.location.country) : ''}</div>
    </div>
    <div class="card-label">Student ID</div>
  </div>
  <div class="card-body">
    ${photoHtml}
    <div class="info">
      <div class="full-name">${esc(student.firstName)} ${esc(student.lastName)}</div>
      <div class="info-label">Matricule</div>
      <div class="info-value">${esc(student.matricule || '—')}</div>
      <div class="info-label">Class</div>
      <div class="info-value">${esc(student._className || '—')}</div>
      <div class="info-label">Academic Year</div>
      <div class="info-value">${esc(academicYear || '—')}</div>
    </div>
  </div>
  <div class="card-footer">
    <div>
      <div style="font-size:3.5pt;opacity:0.6;text-transform:uppercase;">Valid Until</div>
      <div class="card-no">${esc(String(validYear))}</div>
    </div>
    <div class="card-no">${esc(cardNo)}</div>
    ${qrDataUrl ? `<img src="${qrDataUrl}" alt="QR" style="width:9mm;height:9mm;" />` : ''}
  </div>
</div>
<!-- BACK -->
<div class="card-back">
  <div class="back-stripe"></div>
  <div class="back-mag"></div>
  <div class="back-body">
    <div class="back-col">
      <div class="back-label">${esc(branding.campus_name)}</div>
      ${branding.location?.address ? `<div>${esc(branding.location.address)}</div>` : ''}
      ${branding.location?.city ? `<div>${esc(branding.location.city)}${branding.location?.country ? ', ' + esc(branding.location.country) : ''}</div>` : ''}
    </div>
    <div class="back-col">
      <div class="back-label">If found, please return to:</div>
      <div>${esc(branding.campus_name)}</div>
      <div>Campus Administration</div>
    </div>
  </div>
  <div class="back-footer">
    This card is the property of ${esc(branding.campus_name)}. It is non-transferable and must be carried at all times on campus.
    Any loss must be reported immediately to the administration. Valid for ${esc(academicYear || 'current academic year')}.
  </div>
</div>
</body>
</html>`;
};

// ── Template 2 — ACADEMIC TRANSCRIPT (A4) ─────────────────────────────────────

const buildTranscriptHtml = async (transcript, student, branding, params = {}) => {
  const { academicYear, semester } = params;

  const BASE_URL  = process.env.QR_VERIFICATION_BASE_URL || 'https://app.yourdomain.com';
  const token     = transcript.verificationToken || String(transcript._id);
  const qrPayload = `${BASE_URL}/verify-transcript/${token}`;
  const qrDataUrl = await generateQrCodeDataUrl(qrPayload, 120).catch(() => null);

  const logoHtml  = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="logo" style="height:18mm;max-width:28mm;object-fit:contain;" />`
    : '';

  const avgColor = (avg) => avg >= 16 ? '#1b5e20' : avg >= 12 ? '#33691e' : avg >= 10 ? '#e65100' : '#b71c1c';

  const subjectRows = (transcript.subjects || []).map((s, i) => {
    const avg     = Number(s.average ?? 0);
    const passing = avg >= 10;
    return `<tr${i % 2 === 0 ? ' class="alt"' : ''}>
      <td class="td-left">${esc(s.subjectName || '—')}</td>
      <td class="td-center">${esc(s.subjectCode || '—')}</td>
      <td class="td-center">${esc(String(s.coefficient ?? 1))}</td>
      <td class="td-center" style="font-weight:bold;color:${avgColor(avg)};">${avg.toFixed(2)}</td>
      <td class="td-center">${esc(s.gradeBand?.letterGrade || '—')}</td>
      <td class="td-center" style="color:${passing ? '#2e7d32' : '#c62828'};font-weight:bold;">${passing ? 'PASS' : 'FAIL'}</td>
      <td class="td-left" style="font-size:8pt;font-style:italic;color:#555;">${esc(s.classManagerRemarks || '')}</td>
    </tr>`;
  }).join('');

  const ga      = Number(transcript.generalAverage ?? 0);
  const passing = ga >= 10;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  @page{size:A4;margin:15mm 15mm 20mm 15mm;}
  body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#1a1a1a;}
  .watermark{
    position:fixed;top:50%;left:50%;
    transform:translate(-50%,-50%) rotate(-35deg);
    font-size:72pt;color:rgba(0,51,102,0.05);font-weight:900;
    pointer-events:none;z-index:1000;white-space:nowrap;letter-spacing:8px;
    -webkit-print-color-adjust:exact;print-color-adjust:exact;
  }
  .page-header{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2.5px solid #003366;padding-bottom:6mm;margin-bottom:5mm;}
  .campus-name{font-size:13pt;font-weight:bold;color:#003366;text-transform:uppercase;letter-spacing:0.5px;}
  .campus-sub{font-size:8.5pt;color:#666;margin-top:1mm;}
  .doc-badge{display:inline-block;font-size:10pt;font-weight:bold;color:#003366;border:1.5px solid #003366;padding:1.5mm 5mm;border-radius:2mm;margin:4mm 0 2mm;}
  .doc-sub{font-size:8.5pt;color:#555;}
  .student-box{display:grid;grid-template-columns:1fr 1fr 1fr;gap:2mm 8mm;background:#f5f7fa;border:1px solid #e0e0e0;border-radius:3mm;padding:4mm 6mm;margin-bottom:5mm;}
  .s-label{font-size:7.5pt;color:#777;text-transform:uppercase;letter-spacing:0.3px;}
  .s-val{font-size:9.5pt;color:#1a1a1a;margin-top:0.5mm;}
  table{width:100%;border-collapse:collapse;margin-bottom:5mm;}
  thead{background:#003366;color:#fff;}
  thead th{padding:3.5px 5px;font-size:8.5pt;font-weight:bold;}
  .td-left{padding:3px 5px;font-size:8.5pt;}
  .td-center{padding:3px 5px;font-size:8.5pt;text-align:center;}
  tr.alt td{background:#f9f9f9;}
  tbody td{border-bottom:1px solid #e8e8e8;}
  .summary-bar{background:#003366;color:#fff;border-radius:3mm;padding:4mm 6mm;display:flex;justify-content:space-between;align-items:center;margin-bottom:5mm;}
  .sum-label{font-size:8pt;opacity:0.8;}
  .sum-val{font-size:14pt;font-weight:bold;}
  .decision-box{border:1.5px solid #c5cae9;background:#e8eaf6;border-radius:3mm;padding:4mm 6mm;margin-bottom:6mm;}
  .dec-title{font-size:8.5pt;font-weight:bold;color:#283593;text-transform:uppercase;margin-bottom:1.5mm;}
  .dec-text{font-size:9.5pt;color:#1a1a1a;}
  .signatures{display:flex;justify-content:space-around;margin-top:14mm;}
  .sig-block{text-align:center;}
  .sig-line{border-bottom:1px solid #555;width:45mm;margin:18mm auto 3mm;}
  .sig-label{font-size:8pt;color:#555;}
  .qr-section{text-align:center;}
  .footer{position:fixed;bottom:0;left:0;right:0;border-top:1px solid #ddd;padding-top:3mm;font-size:7pt;color:#888;display:flex;justify-content:space-between;}
</style>
</head>
<body>
<div class="watermark">${esc(branding.campus_name)}</div>

<div class="page-header">
  <div>
    ${logoHtml}
    <div class="campus-name">${esc(branding.campus_name)}</div>
    <div class="campus-sub">${esc(branding.location?.address || '')}${branding.location?.city ? ', ' + esc(branding.location.city) : ''}${branding.location?.country ? ', ' + esc(branding.location.country) : ''}</div>
    <div class="doc-badge">Academic Transcript — ${esc(semester || '')}</div>
    <div class="doc-sub">Academic Year: ${esc(academicYear || '')}</div>
  </div>
  ${qrDataUrl ? `<div class="qr-section"><img src="${qrDataUrl}" alt="QR" style="width:22mm;height:22mm;" /><div style="font-size:6pt;color:#888;margin-top:1mm;">Scan to verify</div><div style="font-size:5.5pt;color:#aaa;">${token.slice(0, 14)}...</div></div>` : ''}
</div>

<div class="student-box">
  <div><div class="s-label">Student Name</div><div class="s-val" style="font-weight:bold;">${esc(student.firstName)} ${esc(student.lastName)}</div></div>
  <div><div class="s-label">Matricule</div><div class="s-val">${esc(student.matricule || '—')}</div></div>
  <div><div class="s-label">Class</div><div class="s-val">${esc(student._className || '—')}</div></div>
  <div><div class="s-label">Date of Birth</div><div class="s-val">${student.dateOfBirth ? new Date(student.dateOfBirth).toLocaleDateString('en-GB') : '—'}</div></div>
  <div><div class="s-label">Gender</div><div class="s-val" style="text-transform:capitalize;">${esc(student.gender || '—')}</div></div>
  <div><div class="s-label">Print Date</div><div class="s-val">${new Date().toLocaleDateString('en-GB')}</div></div>
</div>

<table>
  <thead>
    <tr>
      <th style="text-align:left;width:28%;">Subject</th>
      <th style="text-align:center;width:9%;">Code</th>
      <th style="text-align:center;width:8%;">Coeff.</th>
      <th style="text-align:center;width:10%;">Avg/20</th>
      <th style="text-align:center;width:8%;">Grade</th>
      <th style="text-align:center;width:8%;">Result</th>
      <th style="text-align:left;width:29%;">Remarks</th>
    </tr>
  </thead>
  <tbody>
    ${subjectRows || '<tr><td colspan="7" style="padding:10px;text-align:center;color:#aaa;">No results recorded</td></tr>'}
  </tbody>
</table>

<div class="summary-bar">
  <div><div class="sum-label">General Average</div><div class="sum-val">${ga.toFixed(2)} / 20</div></div>
  <div><div class="sum-label">Class Rank</div><div class="sum-val">${esc(String(transcript.classRank || '—'))} / ${esc(String(transcript.classTotal || '—'))}</div></div>
  <div><div class="sum-label">Status</div><div class="sum-val" style="color:${passing ? '#a5d6a7' : '#ef9a9a'};">${passing ? 'ADMITTED ✓' : 'NOT ADMITTED ✗'}</div></div>
</div>

${transcript.decision || transcript.generalAppreciation ? `<div class="decision-box">
  ${transcript.decision ? `<div class="dec-title">Decision</div><div class="dec-text">${esc(transcript.decision)}</div>` : ''}
  ${transcript.generalAppreciation ? `<div class="dec-title" style="margin-top:${transcript.decision ? '3mm' : '0'};">Appreciation</div><div class="dec-text" style="font-style:italic;">${esc(transcript.generalAppreciation)}</div>` : ''}
</div>` : ''}

<div class="signatures">
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Class Manager</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Campus Manager</div></div>
  <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Parent / Guardian</div></div>
</div>

<div class="footer">
  <span>Generated: ${new Date().toLocaleString('en-GB')}</span>
  <span>${esc(branding.campus_name)} — Official Transcript</span>
  <span>Ref: ${esc(token.slice(0, 16))}</span>
</div>
</body>
</html>`;
};

// ── Template 3 — ENROLLMENT CERTIFICATE (A4) ──────────────────────────────────

const buildEnrollmentCertHtml = async (student, branding, params = {}) => {
  const { academicYear, semester } = params;

  const BASE_URL  = process.env.QR_VERIFICATION_BASE_URL || 'https://app.yourdomain.com';
  const certRef   = `CERT-${(student.matricule || String(student._id).slice(-8)).toUpperCase()}-${(academicYear || String(new Date().getFullYear())).replace('-', '')}`;
  const qrPayload = `${BASE_URL}/verify-cert/${certRef}`;
  const qrDataUrl = await generateQrCodeDataUrl(qrPayload, 120).catch(() => null);

  const logoHtml  = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="logo" style="height:20mm;max-width:30mm;object-fit:contain;" />`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  @page{size:A4;margin:18mm;}
  body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#1a1a1a;}
  .outer{border:3px solid #003366;padding:7mm;min-height:240mm;position:relative;}
  .inner{border:1px solid #c5cae9;padding:6mm;min-height:226mm;position:relative;}
  .corner{position:absolute;width:7mm;height:7mm;border-color:#003366;border-style:solid;}
  .tl{top:2mm;left:2mm;border-width:2px 0 0 2px;} .tr{top:2mm;right:2mm;border-width:2px 2px 0 0;}
  .bl{bottom:2mm;left:2mm;border-width:0 0 2px 2px;} .br{bottom:2mm;right:2mm;border-width:0 2px 2px 0;}
  .cert-header{text-align:center;border-bottom:2px solid #003366;padding-bottom:6mm;margin-bottom:7mm;}
  .campus-name{font-size:15pt;font-weight:bold;color:#003366;text-transform:uppercase;letter-spacing:1px;margin:3mm 0 1mm;}
  .campus-sub{font-size:9pt;color:#666;}
  .cert-title{font-size:17pt;font-weight:bold;color:#003366;text-transform:uppercase;letter-spacing:2.5px;margin:7mm 0 2mm;}
  .cert-subtitle{font-size:10pt;color:#888;letter-spacing:0.5px;font-style:italic;}
  .cert-body{text-align:center;line-height:2.4;margin:7mm 0;}
  .cert-body p{font-size:11.5pt;}
  .highlight{font-size:14pt;font-weight:bold;color:#003366;text-decoration:underline;text-underline-offset:2px;}
  .ref-tag{display:inline-block;background:#f5f7fa;border:1px solid #e0e0e0;border-radius:2mm;padding:1.5mm 5mm;font-size:8.5pt;color:#666;font-family:monospace;margin-top:5mm;}
  .signatures{display:flex;justify-content:space-around;margin-top:18mm;}
  .sig-block{text-align:center;}
  .sig-line{border-bottom:1.5px solid #555;width:48mm;margin:20mm auto 3mm;}
  .sig-label{font-size:8.5pt;color:#555;}
  .qr-wrap{text-align:center;margin-top:7mm;}
  .qr-wrap img{width:22mm;height:22mm;}
  .qr-label{font-size:7pt;color:#aaa;margin-top:1.5mm;}
  .cert-footer{position:absolute;bottom:3mm;left:3mm;right:3mm;border-top:1px solid #ddd;padding-top:2mm;font-size:7pt;color:#999;text-align:center;}
</style>
</head>
<body>
<div class="outer">
  <div class="inner">
    <div class="corner tl"></div><div class="corner tr"></div>
    <div class="corner bl"></div><div class="corner br"></div>

    <div class="cert-header">
      ${logoHtml}
      <div class="campus-name">${esc(branding.campus_name)}</div>
      <div class="campus-sub">${esc(branding.location?.address || '')}${branding.location?.city ? ', ' + esc(branding.location.city) : ''}${branding.location?.country ? ', ' + esc(branding.location.country) : ''}</div>
      <div class="cert-title">Certificate of Enrollment</div>
      <div class="cert-subtitle">Attestation d'Inscription</div>
    </div>

    <div class="cert-body">
      <p>We, the undersigned, Academic Authorities of</p>
      <p class="highlight">${esc(branding.campus_name)}</p>
      <p>hereby certify that</p>
      <p class="highlight">${esc(student.firstName)} ${esc(student.lastName)}</p>
      <p>born on <strong>${student.dateOfBirth ? new Date(student.dateOfBirth).toLocaleDateString('en-GB') : '—'}</strong>${student.gender ? ` (${esc(student.gender)})` : ''}</p>
      <p>holding matricule number <strong>${esc(student.matricule || '—')}</strong></p>
      <p>is duly enrolled in class <strong>${esc(student._className || '—')}</strong></p>
      <p>for the academic year <strong>${esc(academicYear || '—')}</strong>${semester ? `, <strong>${esc(semester)}</strong>` : ''}</p>
      <p style="font-size:10pt;color:#666;margin-top:4mm;">This certificate is issued upon request for any legitimate academic or administrative purpose.</p>
      <div class="ref-tag">Ref: ${esc(certRef)} | Issued: ${new Date().toLocaleDateString('en-GB')}</div>
    </div>

    ${qrDataUrl ? `<div class="qr-wrap"><img src="${qrDataUrl}" alt="QR"/><div class="qr-label">Scan to verify authenticity</div></div>` : ''}

    <div class="signatures">
      <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Campus Manager</div><div class="sig-label">Directeur(trice) du Campus</div></div>
      <div class="sig-block"><div class="sig-line"></div><div class="sig-label">Official Stamp</div><div class="sig-label">Cachet Officiel</div></div>
    </div>

    <div class="cert-footer">
      ${esc(branding.campus_name)} — Official Document | Generated: ${new Date().toLocaleString('en-GB')} | Ref: ${esc(certRef)}
    </div>
  </div>
</div>
</body>
</html>`;
};

// ── Template 4 — CLASS TIMETABLE (A4 Landscape) ───────────────────────────────

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PALETTE = ['#1565c0', '#4527a0', '#2e7d32', '#bf360c', '#6a1b9a', '#00695c', '#00838f', '#37474f', '#c62828', '#558b2f'];

const buildTimetableHtml = async (sessions, cls, branding, params = {}) => {
  const { weekStart, academicYear, semester } = params;

  const logoHtml = branding.logoDataUrl
    ? `<img src="${branding.logoDataUrl}" alt="logo" style="height:11mm;max-width:20mm;object-fit:contain;" />`
    : '';

  // Build time slots (sorted) from session boundaries
  const slotSet = new Set();
  sessions.forEach((s) => {
    const st = new Date(s.startTime);
    const et = new Date(s.endTime);
    const slot = `${st.getHours().toString().padStart(2,'0')}:${st.getMinutes().toString().padStart(2,'0')}-${et.getHours().toString().padStart(2,'0')}:${et.getMinutes().toString().padStart(2,'0')}`;
    slotSet.add(slot);
  });
  const timeSlots = [...slotSet].sort();

  // Map sessions → grid cell (dayIndex-slot)
  const grid = {};
  sessions.forEach((s) => {
    const st   = new Date(s.startTime);
    const et   = new Date(s.endTime);
    const di   = (st.getDay() + 6) % 7; // 0=Mon…5=Sat
    const slot = `${st.getHours().toString().padStart(2,'0')}:${st.getMinutes().toString().padStart(2,'0')}-${et.getHours().toString().padStart(2,'0')}:${et.getMinutes().toString().padStart(2,'0')}`;
    grid[`${di}-${slot}`] = s;
  });

  // Active days
  const daySet = new Set(sessions.map((s) => (new Date(s.startTime).getDay() + 6) % 7));
  const activeDays = daySet.size > 0 ? [...daySet].sort() : [0, 1, 2, 3, 4];

  // Subject → color mapping
  const subjectColors = {};
  let ci = 0;
  sessions.forEach((s) => {
    const k = String(s.subject?.subjectId || s.subject?.subject_name || 'unknown');
    if (!subjectColors[k]) subjectColors[k] = PALETTE[ci++ % PALETTE.length];
  });

  const headerCells = activeDays.map((d) =>
    `<th style="background:#003366;color:#fff;padding:3px 4px;font-size:7.5pt;text-align:center;">${DAYS[d]}</th>`
  ).join('');

  const bodyRows = timeSlots.map((slot) => {
    const [startStr, endStr] = slot.split('-');
    const dataCells = activeDays.map((d) => {
      const s = grid[`${d}-${slot}`];
      if (!s) return '<td style="background:#fafafa;border:1px solid #eeeeee;height:8mm;"></td>';
      const k      = String(s.subject?.subjectId || s.subject?.subject_name || 'unknown');
      const color  = subjectColors[k] || '#1565c0';
      const room   = s.room?.code || s.room?.name || '';
      const tName  = s.teacher?.fullName || (s.teacher?.firstName ? `${s.teacher.firstName} ${s.teacher.lastName || ''}`.trim() : '');
      return `<td style="background:${color}18;border:1px solid ${color}44;padding:2px 4px;vertical-align:top;">
        <div style="font-weight:bold;font-size:7pt;color:${color};line-height:1.3;">${esc(s.subject?.subject_name || s.subject?.subject_code || '—')}</div>
        ${tName ? `<div style="font-size:6pt;color:#555;">${esc(tName)}</div>` : ''}
        ${room ? `<div style="font-size:5.5pt;color:#888;font-style:italic;">${esc(room)}</div>` : ''}
      </td>`;
    }).join('');

    return `<tr>
      <td style="background:#f0f4f8;border:1px solid #e0e0e0;padding:2px 4px;font-size:7pt;font-weight:bold;color:#003366;text-align:center;white-space:nowrap;">
        ${esc(startStr)}<br/><span style="font-weight:normal;color:#888;font-size:6.5pt;">${esc(endStr)}</span>
      </td>
      ${dataCells}
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  @page{size:A4 landscape;margin:10mm 12mm;}
  body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#1a1a1a;}
  .hdr{display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2px solid #003366;padding-bottom:4mm;margin-bottom:4mm;}
  .campus-name{font-size:12pt;font-weight:bold;color:#003366;}
  .doc-title{font-size:9pt;color:#555;margin-top:1mm;}
  table{width:100%;border-collapse:collapse;}
  th{border:1px solid #003366;}
  td{border:1px solid #e0e0e0;}
</style>
</head>
<body>
<div class="hdr">
  <div>
    ${logoHtml}
    <div class="campus-name">${esc(branding.campus_name)}</div>
    <div class="doc-title">Class Timetable — <strong>${esc(cls?.className || '—')}</strong>${academicYear ? ' | ' + esc(academicYear) : ''}${semester ? ' | ' + esc(semester) : ''}</div>
    ${weekStart ? `<div style="font-size:8pt;color:#888;margin-top:1mm;">Week of ${new Date(weekStart).toLocaleDateString('en-GB')}</div>` : ''}
  </div>
  <div style="font-size:7.5pt;color:#888;text-align:right;">
    <div>Printed: ${new Date().toLocaleDateString('en-GB')}</div>
    <div style="margin-top:1mm;">${sessions.length} session${sessions.length !== 1 ? 's' : ''}</div>
  </div>
</div>
<table>
  <thead><tr><th style="background:#003366;color:#fff;padding:3px 5px;font-size:7.5pt;width:16mm;text-align:center;">Time</th>${headerCells}</tr></thead>
  <tbody>
    ${bodyRows || `<tr><td colspan="${activeDays.length + 1}" style="padding:15px;text-align:center;color:#aaa;">No sessions scheduled for this period.</td></tr>`}
  </tbody>
</table>
</body>
</html>`;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a PDF buffer for the given academic document type.
 *
 * @param {object} opts
 * @param {'STUDENT_CARD'|'TRANSCRIPT'|'ENROLLMENT'|'TIMETABLE'} opts.type
 * @param {object} opts.data        - { student, transcript, sessions, cls }
 * @param {string} opts.campusId
 * @param {object} opts.params      - { academicYear, semester, weekStart, cardNumber, cardValidUntil }
 * @returns {Promise<Buffer>}
 */
const generateAcademicPdf = async ({ type, data, campusId, params = {} }) => {
  const branding = await getCampusBranding(campusId);

  switch (type) {
    case 'STUDENT_CARD':
      return renderPdf(
        await buildStudentCardHtml(data.student, branding, params),
        { width: '85.6mm', height: '54mm', margins: { top: '0', right: '0', bottom: '0', left: '0' } }
      );

    case 'TRANSCRIPT':
      return renderPdf(
        await buildTranscriptHtml(data.transcript, data.student, branding, params),
        { format: 'A4', margins: { top: '15mm', right: '15mm', bottom: '20mm', left: '15mm' } }
      );

    case 'ENROLLMENT':
      return renderPdf(
        await buildEnrollmentCertHtml(data.student, branding, params),
        { format: 'A4', margins: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' } }
      );

    case 'TIMETABLE':
      return renderPdf(
        await buildTimetableHtml(data.sessions || [], data.cls, branding, params),
        { format: 'A4', landscape: true, margins: { top: '10mm', right: '12mm', bottom: '10mm', left: '12mm' } }
      );

    default:
      throw Object.assign(new Error(`Unknown document type: ${type}`), { statusCode: 400 });
  }
};

/**
 * Save a generated PDF buffer to campus-scoped print storage.
 * @returns {Promise<string>} Absolute file path
 */
const savePrintPdf = async (buffer, campusId, fileName) => {
  const dir = path.join(UPLOAD_DIR, String(campusId));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
};

/**
 * Read a saved print PDF from campus-scoped storage.
 * @returns {Promise<Buffer>}
 */
const readPrintPdf = async (campusId, fileName) => {
  const filePath = path.join(UPLOAD_DIR, String(campusId), fileName);
  try {
    return await fs.readFile(filePath);
  } catch {
    throw Object.assign(new Error('PDF file not found or expired'), { statusCode: 404 });
  }
};

/**
 * Delete print PDF files older than ttlDays. Called by the retention cron.
 * @param {number} ttlDays
 */
const cleanupExpiredPrintFiles = async (ttlDays = 30) => {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  let removed  = 0;
  try {
    const campusDirs = await fs.readdir(UPLOAD_DIR, { withFileTypes: true });
    for (const entry of campusDirs) {
      if (!entry.isDirectory()) continue;
      const dir   = path.join(UPLOAD_DIR, entry.name);
      const files = await fs.readdir(dir).catch(() => []);
      for (const file of files) {
        const fp   = path.join(dir, file);
        const stat = await fs.stat(fp).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) {
          await fs.unlink(fp).catch(() => {});
          removed++;
        }
      }
    }
  } catch { /* UPLOAD_DIR may not exist yet */ }
  return removed;
};

module.exports = {
  generateAcademicPdf,
  savePrintPdf,
  readPrintPdf,
  cleanupExpiredPrintFiles,
  shutdownAcademicPool,
};

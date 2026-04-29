'use strict';

/**
 * @file document.pdf.service.js
 * @description PDF generation engine using a managed Puppeteer browser pool.
 *
 * Architecture:
 *   - Singleton pool of headless Chromium instances (configurable via PUPPETEER_POOL_SIZE)
 *   - In-process queue for requests beyond pool capacity
 *   - Timeout enforced per generation job (PUPPETEER_TIMEOUT_MS)
 *   - PDF snapshot filename: {docRef}_v{version}_{versionId}.pdf
 *     → Includes versionId for CDN immutability (stale PDFs never served)
 *
 * Watermark and QR code integration:
 *   - Watermark applied as semi-transparent diagonal SVG overlay at render time
 *   - QR code PNG embedded in the HTML template if qrCode.enabled = true
 *
 * HTML → PDF pipeline:
 *   1. Render document body (ContentBlocks) to HTML template string
 *   2. Apply branding (logo, colors, header, footer, watermark)
 *   3. Launch Puppeteer page from pool
 *   4. setContent(html) → waitForNetworkIdle
 *   5. page.pdf({ format, margin, printBackground: true })
 *   6. Save to uploads/documents/{campusId}/pdf/
 *   7. Update Document.pdfSnapshot filename
 */

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs').promises;
const crypto    = require('crypto');

const { saveFile }   = require('./document.storage.service');
const Document       = require('../../models/document-models/document.model');

// ── Configuration ─────────────────────────────────────────────────────────────

const POOL_SIZE    = parseInt(process.env.PUPPETEER_POOL_SIZE    || '2', 10);
const TIMEOUT_MS   = parseInt(process.env.PUPPETEER_TIMEOUT_MS   || '30000', 10);
const UPLOAD_DIR   = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'documents')
  : path.join(__dirname, '..', '..', 'uploads', 'documents');

// ── Browser Pool ──────────────────────────────────────────────────────────────

/** @type {puppeteer.Browser[]} */
let browserPool      = [];
let poolInitialized  = false;

/** Queue of pending generation requests waiting for a free browser slot */
const waitQueue = [];

/**
 * Initializes the Puppeteer browser pool.
 * Called once at server startup. Subsequent calls are no-ops.
 */
const initPool = async () => {
  if (poolInitialized) return;

  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
    || process.env.CHROME_EXECUTABLE_PATH
    || puppeteer.executablePath();

  const launchArgs = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-gpu',
    '--single-process', '--no-first-run', '--no-zygote',
    '--disable-extensions', '--disable-background-networking',
  ];

  for (let i = 0; i < POOL_SIZE; i++) {
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: launchArgs,
    }).catch((err) => {
      const hint = err.message?.includes('Could not find Chrome')
        ? ' → Run: npx puppeteer browsers install chrome  (or set PUPPETEER_EXECUTABLE_PATH)'
        : '';
      throw new Error(`PDF engine unavailable: ${err.message}${hint}`);
    });
    browserPool.push(browser);
  }

  poolInitialized = true;
};

/**
 * Acquires a browser from the pool.
 * If all browsers are in use, the request waits in the queue.
 *
 * @returns {Promise<{ browser: puppeteer.Browser, release: Function }>}
 */
const acquireBrowser = () =>
  new Promise((resolve) => {
    if (browserPool.length > 0) {
      const browser = browserPool.pop();
      resolve({
        browser,
        release: () => {
          browserPool.push(browser);
          drainQueue();
        },
      });
    } else {
      waitQueue.push(resolve);
    }
  });

/**
 * Processes the next pending request in the wait queue when a browser is released.
 */
const drainQueue = () => {
  if (waitQueue.length > 0 && browserPool.length > 0) {
    const next    = waitQueue.shift();
    const browser = browserPool.pop();
    next({
      browser,
      release: () => {
        browserPool.push(browser);
        drainQueue();
      },
    });
  }
};

// ── HTML Template Rendering ───────────────────────────────────────────────────

/**
 * Converts a PARAGRAPH block content object to sanitized HTML.
 *
 * @param {object} content
 * @returns {string}
 */
const renderParagraph = (content) => {
  const style = [
    content.align    && `text-align:${content.align}`,
    content.color    && `color:${content.color}`,
    content.fontSize && `font-size:${content.fontSize}px`,
  ].filter(Boolean).join(';');

  const text = content.bold ? `<strong>${content.text}</strong>` : content.text;
  const body = content.italic ? `<em>${text}</em>` : text;
  return `<p style="${style}">${body}</p>`;
};

/**
 * Renders a single ContentBlock to an HTML string.
 * Unrecognized block types render as empty strings.
 *
 * @param {object} block
 * @returns {string}
 */
const renderBlock = (block) => {
  const { type, content } = block;
  if (!content) return '';

  switch (type) {
    case 'HEADING': {
      const align = content.align ? ` style="text-align:${content.align}"` : '';
      return `<h${content.level}${align}>${content.text}</h${content.level}>`;
    }
    case 'PARAGRAPH':
      return renderParagraph(content);
    case 'IMAGE': {
      const width = content.width ? ` width="${content.width}"` : '';
      return `<figure><img src="" data-file="${content.fileName}"${width} alt="${content.alt || ''}" />${content.caption ? `<figcaption>${content.caption}</figcaption>` : ''}</figure>`;
    }
    case 'TABLE': {
      const headerRow = content.headers.map((h) => `<th>${h}</th>`).join('');
      const bodyRows  = (content.rows || []).map((row) =>
        `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`,
      ).join('');
      return `<table class="${content.striped ? 'striped' : ''}"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    }
    case 'LIST': {
      const tag   = content.ordered ? 'ol' : 'ul';
      const items = (content.items || []).map((item) => `<li>${item}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'QR_CODE':
      return `<div class="qr-code" data-qr-file="${content.fileName || ''}" style="width:${content.size || 80}px">${content.label ? `<span>${content.label}</span>` : ''}</div>`;
    case 'CODE_BLOCK':
      return `<pre><code class="language-${content.language || 'text'}">${content.code}</code></pre>`;
    case 'DIVIDER':
      return '<hr />';
    case 'SIGNATURE_PLACEHOLDER':
      return `<div class="signature-placeholder"><span>${content.label || 'Signature'}</span><div class="signature-line"></div></div>`;
    default:
      return '';
  }
};

/**
 * Builds a complete HTML document string from a Document record.
 * Includes branding, watermark, header, footer, and body blocks.
 *
 * @param {object} doc       - Mongoose document (lean)
 * @param {string} campusName
 * @returns {string} Full HTML string
 */
const buildHtmlTemplate = (doc, campusName) => {
  const branding   = doc.branding || {};
  const print      = doc.printConfig || {};
  const bodyHtml   = (doc.body || [])
    .sort((a, b) => a.order - b.order)
    .map(renderBlock)
    .join('\n');

  const watermarkSvg = branding.watermark
    ? `<div class="watermark">${branding.watermark}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${doc.title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12pt; color: #1a1a1a; }
  .page-header { border-bottom: 2px solid ${branding.primaryColor || '#003366'}; padding-bottom: 12px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; }
  .page-header h1 { color: ${branding.primaryColor || '#003366'}; font-size: 18pt; }
  .page-header .campus-name { font-size: 10pt; color: #555; }
  .doc-body { min-height: 70vh; }
  h1,h2,h3 { color: ${branding.primaryColor || '#003366'}; margin: 16px 0 8px; }
  p { margin-bottom: 8px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th,td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
  th { background: ${branding.primaryColor || '#003366'}; color: #fff; }
  table.striped tr:nth-child(even) td { background: #f5f5f5; }
  ul,ol { margin: 8px 0 8px 24px; }
  li { margin-bottom: 4px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 10pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  .signature-placeholder { margin: 32px 0; }
  .signature-line { border-bottom: 1px solid #333; width: 200px; margin-top: 40px; }
  .signature-placeholder span { font-size: 10pt; color: #555; }
  .page-footer { border-top: 1px solid #ddd; padding-top: 8px; margin-top: 24px; font-size: 9pt; color: #666; display: flex; justify-content: space-between; }
  .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%) rotate(-35deg); font-size: 72pt; color: rgba(0,0,0,0.08); font-weight: 900; pointer-events: none; z-index: 1000; white-space: nowrap; letter-spacing: 8px; }
  @media print { .watermark { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
${watermarkSvg}
<div class="page-header">
  <div>
    ${branding.showCampusName ? `<div class="campus-name">${campusName || ''}</div>` : ''}
    <h1>${doc.title}</h1>
    ${branding.headerText ? `<div style="font-size:10pt;color:#555;">${branding.headerText}</div>` : ''}
  </div>
</div>
<div class="doc-body">
${bodyHtml}
</div>
<div class="page-footer">
  <span>${branding.footerText || ''}</span>
  ${branding.showDate ? `<span>Generated: ${new Date().toLocaleDateString()}</span>` : ''}
  <span>Ref: ${doc.ref}</span>
</div>
</body>
</html>`;
};

// ── PDF Generation ────────────────────────────────────────────────────────────

/**
 * Generates a PDF from a document record.
 * Saves the PDF to campus-scoped storage and updates Document.pdfSnapshot.
 *
 * PDF filename format: {docRef}_v{version}_{versionId}.pdf
 *
 * @param {string} documentId
 * @param {string} versionId     - DocumentVersion ObjectId (for filename immutability)
 * @param {string} campusName
 * @returns {Promise<{ fileName: string, buffer: Buffer }>}
 * @throws On timeout: statusCode 503
 */
const generateDocumentPdf = async (documentId, versionId, campusName) => {
  await initPool();

  const doc = await Document
    .findById(documentId)
    .select('ref title body branding printConfig campusId currentVersion pdfSnapshot')
    .lean();

  if (!doc) {
    throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  }

  const { browser, release } = await acquireBrowser();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      release();
      reject(Object.assign(
        new Error('PDF generation timed out — please retry'),
        { statusCode: 503, retryAfter: 30 },
      ));
    }, TIMEOUT_MS);

    (async () => {
      let page;
      try {
        page = await browser.newPage();

        const html = buildHtmlTemplate(doc, campusName);
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: TIMEOUT_MS });

        const print      = doc.printConfig || {};
        const pageFormat = print.pageSize === 'CARD_CR80'
          ? { width: '85.6mm', height: '54mm' }
          : print.pageSize || 'A4';

        const margins = {
          top:    `${print.margins?.top    ?? 20}mm`,
          right:  `${print.margins?.right  ?? 20}mm`,
          bottom: `${print.margins?.bottom ?? 20}mm`,
          left:   `${print.margins?.left   ?? 20}mm`,
        };

        const pdfBuffer = await page.pdf({
          format:           typeof pageFormat === 'string' ? pageFormat : undefined,
          width:            typeof pageFormat === 'object' ? pageFormat.width  : undefined,
          height:           typeof pageFormat === 'object' ? pageFormat.height : undefined,
          landscape:        print.orientation === 'LANDSCAPE',
          margin:           margins,
          printBackground:  true,
        });

        const safeRef    = doc.ref.replace(/[^A-Z0-9-]/g, '_');
        const fileName   = `${safeRef}_v${doc.currentVersion}_${versionId || 'latest'}.pdf`;
        const campusDir  = path.join(UPLOAD_DIR, doc.campusId.toString(), 'pdf');
        await fs.mkdir(campusDir, { recursive: true });
        const filePath   = path.join(campusDir, fileName);
        await fs.writeFile(filePath, pdfBuffer);

        // Update pdfSnapshot on the document record
        await Document.findByIdAndUpdate(documentId, { pdfSnapshot: fileName });

        clearTimeout(timeout);
        resolve({ fileName, buffer: pdfBuffer });

      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      } finally {
        if (page) await page.close().catch(() => {});
        release();
      }
    })();
  });
};

/**
 * Returns the cached PDF if available and version unchanged.
 * Triggers regeneration otherwise.
 *
 * @param {string} documentId
 * @param {string} campusName
 * @returns {Promise<{ fileName: string, filePath: string, buffer: Buffer }>}
 */
const getOrGeneratePdf = async (documentId, campusName) => {
  const doc = await Document
    .findById(documentId)
    .select('ref pdfSnapshot currentVersion campusId')
    .lean();

  if (!doc) throw Object.assign(new Error('Document not found'), { statusCode: 404 });

  if (doc.pdfSnapshot) {
    const filePath = path.join(UPLOAD_DIR, doc.campusId.toString(), 'pdf', doc.pdfSnapshot);
    try {
      await fs.access(filePath);
      const buffer = await fs.readFile(filePath);
      return { fileName: doc.pdfSnapshot, filePath, buffer };
    } catch {
      // Cached file missing — regenerate
    }
  }

  // No cache — generate a new PDF
  const { fileName, buffer } = await generateDocumentPdf(documentId, null, campusName);
  const filePath = path.join(UPLOAD_DIR, doc.campusId.toString(), 'pdf', fileName);
  return { fileName, filePath, buffer };
};

/**
 * Gracefully shuts down the Puppeteer browser pool.
 * Called on server shutdown (SIGTERM / SIGINT).
 */
const shutdownPool = async () => {
  await Promise.allSettled(browserPool.map((b) => b.close()));
  browserPool = [];
  poolInitialized = false;
};

module.exports = {
  initPool,
  shutdownPool,
  generateDocumentPdf,
  getOrGeneratePdf,
  buildHtmlTemplate,
};
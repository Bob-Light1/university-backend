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
 *   6. Save through document.storage.service (category 'pdf') — never to the filesystem
 *      directly, so the snapshot follows whichever backend is active (B8-①)
 *   7. Update Document.pdfSnapshot filename
 */

const puppeteer = require('puppeteer-core');
const chromium  = require('@sparticuz/chromium');
const path      = require('path');

const sanitizeHtml   = require('sanitize-html');

const storage        = require('./document.storage.service');
const { generateQrCodeDataUrl } = require('./document.qr.service');
const { HTML_SANITIZE_OPTIONS } = require('./document.validation.service');
const repo           = require('../document.repository');

// ── Configuration ─────────────────────────────────────────────────────────────

const POOL_SIZE    = parseInt(process.env.PUPPETEER_POOL_SIZE    || '2', 10);
const TIMEOUT_MS   = parseInt(process.env.PUPPETEER_TIMEOUT_MS   || '30000', 10);

// ── Browser Pool ──────────────────────────────────────────────────────────────

/** @type {puppeteer.Browser[]} */
let browserPool      = [];
let poolInitialized  = false;

/** Queue of pending generation requests waiting for a free browser slot */
const waitQueue = [];

/** Resolves the Chromium executable, preferring an explicitly configured path. */
const resolveChromePath = async () => {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  // @sparticuz/chromium extracts the binary to /tmp/chromium on first call
  return chromium.executablePath();
};

/**
 * Initializes the Puppeteer browser pool. Subsequent calls are no-ops.
 *
 * Despite the export, nothing calls this at server startup (B8-④): the first
 * `generateDocumentPdf` awaits it, so the pool is built lazily on the first
 * request — which is why that request pays the Chromium launch cost. The export
 * is kept so a boot-time warm-up can be wired without changing this file.
 */
const initPool = async () => {
  if (poolInitialized) return;

  const executablePath = await resolveChromePath();

  for (let i = 0; i < POOL_SIZE; i++) {
    const browser = await puppeteer.launch({
      headless:        chromium.headless ?? true,
      executablePath,
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
    }).catch((err) => {
      throw new Error(`PDF engine unavailable: ${err.message}`);
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

// ── Binary asset resolution (inlined into the HTML) ───────────────────────────

/**
 * Puppeteer loads the template via `setContent`, which has no base URL: a relative
 * or API-authenticated `src` resolves to nothing. Every binary the document needs
 * is therefore inlined as a `data:` URI before the HTML is built — the same
 * approach `academic-pdf.service.js` takes for ID cards.
 *
 * The template used to emit `data-file` / `data-qr-file` attributes for a
 * post-processing step that was never written, leaving `<img src="">` and an empty
 * `<div>`: every image and every verification QR in every generated document PDF
 * came out blank.
 */

/** Extensions inlineable into an <img>, with the MIME type each data: URI declares. */
const INLINE_IMAGE_MIME = Object.freeze({
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
});

/** Upper bound per inlined image. Base64 inflates by ~33% and the HTML is held in memory. */
const MAX_INLINE_ASSET_BYTES = 5 * 1024 * 1024;

/**
 * Reads one content-block image from campus-scoped storage and returns it as a
 * data: URI, or null when it cannot be inlined.
 *
 * Returns null rather than throwing: a missing asset must degrade to a visible
 * placeholder in the PDF, never abort the generation of an otherwise valid document.
 *
 * @param {string} campusId
 * @param {string} fileName  UUID-based storage filename
 * @returns {Promise<string|null>}
 */
const readImageDataUri = async (campusId, fileName) => {
  if (!campusId || !fileName) return null;

  // The stored name is a UUID, but it reaches us through document content — a
  // separator or `..` here would read outside the campus directory.
  if (path.basename(fileName) !== fileName) return null;

  const mime = INLINE_IMAGE_MIME[path.extname(fileName).toLowerCase()];
  if (!mime) return null;

  // Through the storage service rather than the filesystem: reading images directly
  // is what would have left every content-block image on an ephemeral disk while the
  // imported file moved to the object store (B8-①).
  const buffer = await storage.readFile(
    campusId, 'images', fileName, { maxBytes: MAX_INLINE_ASSET_BYTES },
  );
  if (!buffer) return null;

  return `data:${mime};base64,${buffer.toString('base64')}`;
};

/**
 * Resolves every binary a document's body blocks reference, in parallel.
 *
 * QR codes are regenerated from `doc.ref` rather than read from disk: the payload
 * is the verification URL and nothing else, `generateQrCodeDataUrl` exists for
 * exactly this ("for inline embedding in HTML templates"), and it keeps a rendered
 * QR correct even when the stored PNG is missing.
 *
 * @param {object} doc  lean document — needs `body`, `campusId`, `ref`
 * @returns {Promise<{ images: Map<string, string>, qrCodes: Map<number, string> }>}
 */
const resolveDocumentAssets = async (doc) => {
  const images   = new Map();
  const qrCodes  = new Map();
  const blocks   = doc?.body || [];

  const imageNames = new Set();
  const qrSizes    = new Set();

  for (const block of blocks) {
    if (block?.type === 'IMAGE' && block.content?.fileName) imageNames.add(block.content.fileName);
    if (block?.type === 'QR_CODE') qrSizes.add(qrSize(block.content));
  }

  await Promise.all([
    ...[...imageNames].map(async (fileName) => {
      const uri = await readImageDataUri(doc.campusId, fileName);
      if (uri) images.set(fileName, uri);
    }),
    ...[...qrSizes].map(async (size) => {
      // A document with no ref (template preview) has no verification URL to encode.
      if (!doc?.ref) return;
      const uri = await generateQrCodeDataUrl(doc.ref, size).catch(() => null);
      if (uri) qrCodes.set(size, uri);
    }),
  ]);

  return { images, qrCodes };
};

// ── HTML Template Rendering ───────────────────────────────────────────────────

/**
 * Escapes HTML special characters to prevent injection.
 *
 * Document content (headings, table cells, code, titles, branding text, …) is
 * user-controlled and is rendered into an HTML string that Puppeteer loads via
 * setContent — which executes any embedded <script>. Without escaping, a crafted
 * document body could run arbitrary JavaScript inside the headless browser
 * (SSRF / local file read) or, via the template preview endpoint, deliver a
 * stored XSS payload to the browser. Every dynamic value MUST pass through here.
 *
 * Safe for both text nodes and double-quoted attribute values.
 *
 * @param {*} value
 * @returns {string}
 */
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Converts a PARAGRAPH block content object to sanitized HTML.
 *
 * content.text is sanitized at write time by document.validation.service
 * (sanitize-html whitelist) but NOT for the template-preview path, which renders
 * unsaved layout blocks. It is re-sanitized here with the same whitelist so the
 * allowed formatting tags survive while any script/handler is stripped — safe and
 * idempotent for both the PDF and preview paths.
 *
 * @param {object} content
 * @returns {string}
 */
const renderParagraph = (content) => {
  const style = [
    content.align    && /^(left|right|center|justify)$/.test(content.align) && `text-align:${content.align}`,
    content.color    && /^#[0-9A-Fa-f]{6}$/.test(content.color) && `color:${content.color}`,
    content.fontSize && Number.isFinite(+content.fontSize) && `font-size:${+content.fontSize}px`,
  ].filter(Boolean).join(';');

  const safeText = sanitizeHtml(String(content.text ?? ''), HTML_SANITIZE_OPTIONS);
  const text = content.bold ? `<strong>${safeText}</strong>` : safeText;
  const body = content.italic ? `<em>${text}</em>` : text;
  return `<p style="${escapeHtml(style)}">${body}</p>`;
};

/** Rendered pixel size of a QR block, shared by the resolver and the renderer. */
const qrSize = (content) => (Number.isFinite(+content?.size) ? +content.size : 80);

/**
 * Renders a single ContentBlock to an HTML string.
 * Unrecognized block types render as empty strings.
 *
 * @param {object} block
 * @param {{ images: Map<string, string>, qrCodes: Map<number, string> }} [assets]
 *        Binary assets already resolved to data: URIs by `resolveDocumentAssets`.
 * @returns {string}
 */
const renderBlock = (block, assets = { images: new Map(), qrCodes: new Map() }) => {
  const { type, content } = block;
  if (!content) return '';

  switch (type) {
    case 'HEADING': {
      const level = [1, 2, 3].includes(content.level) ? content.level : 2;
      const align = content.align ? ` style="text-align:${escapeHtml(content.align)}"` : '';
      return `<h${level}${align}>${escapeHtml(content.text)}</h${level}>`;
    }
    case 'PARAGRAPH':
      return renderParagraph(content);
    case 'IMAGE': {
      const width   = Number.isFinite(+content.width) ? ` width="${+content.width}"` : '';
      const caption = content.caption ? `<figcaption>${escapeHtml(content.caption)}</figcaption>` : '';
      const dataUri = assets.images.get(content.fileName);

      // A missing asset renders as a visible placeholder carrying its filename.
      // The previous `<img src="">` was indistinguishable from a broken upload —
      // and, since nothing ever filled it, indistinguishable from a working one.
      if (!dataUri) {
        return `<figure class="asset-missing"><span>Image unavailable</span><small>${escapeHtml(content.fileName || '—')}</small>${caption}</figure>`;
      }

      return `<figure><img src="${dataUri}"${width} alt="${escapeHtml(content.alt || '')}" />${caption}</figure>`;
    }
    case 'TABLE': {
      const headerRow = (content.headers || []).map((h) => `<th>${escapeHtml(h)}</th>`).join('');
      const bodyRows  = (content.rows || []).map((row) =>
        `<tr>${(row || []).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
      ).join('');
      return `<table class="${content.striped ? 'striped' : ''}"><thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
    }
    case 'LIST': {
      const tag   = content.ordered ? 'ol' : 'ul';
      const items = (content.items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'QR_CODE': {
      const size    = qrSize(content);
      const label   = content.label ? `<span>${escapeHtml(content.label)}</span>` : '';
      const dataUri = assets.qrCodes.get(size);

      if (!dataUri) {
        return `<div class="qr-code asset-missing" style="width:${size}px"><span>QR unavailable</span>${label}</div>`;
      }

      return `<div class="qr-code" style="width:${size}px"><img src="${dataUri}" width="${size}" height="${size}" alt="${escapeHtml(content.label || 'Verification QR code')}" />${label}</div>`;
    }
    case 'CODE_BLOCK':
      return `<pre><code class="language-${escapeHtml(content.language || 'text')}">${escapeHtml(content.code)}</code></pre>`;
    case 'DIVIDER':
      return '<hr />';
    case 'SIGNATURE_PLACEHOLDER':
      return `<div class="signature-placeholder"><span>${escapeHtml(content.label || 'Signature')}</span><div class="signature-line"></div></div>`;
    default:
      return '';
  }
};

/**
 * Builds a complete HTML document string from a Document record.
 * Includes branding, watermark, header, footer, and body blocks.
 *
 * Binary assets must already be resolved — `setContent` has no base URL, so an
 * `src` that is not a data: URI renders nothing. Callers pass the result of
 * `resolveDocumentAssets(doc)`; omitting it renders the placeholders.
 *
 * @param {object} doc       - Mongoose document (lean)
 * @param {string} campusName
 * @param {{ images: Map<string, string>, qrCodes: Map<number, string> }} [assets]
 * @returns {string} Full HTML string
 */
const buildHtmlTemplate = (doc, campusName, assets = { images: new Map(), qrCodes: new Map() }) => {
  const branding   = doc.branding || {};
  const bodyHtml   = (doc.body || [])
    .sort((a, b) => a.order - b.order)
    .map((block) => renderBlock(block, assets))
    .join('\n');

  // Colors flow into CSS — constrain to a strict hex pattern to prevent CSS injection.
  const hex = (value, fallback) => (/^#[0-9A-Fa-f]{6}$/.test(value || '') ? value : fallback);
  const primaryColor = hex(branding.primaryColor, '#003366');

  const watermarkSvg = branding.watermark
    ? `<div class="watermark">${escapeHtml(branding.watermark)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${escapeHtml(doc.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 12pt; color: #1a1a1a; }
  .page-header { border-bottom: 2px solid ${primaryColor}; padding-bottom: 12px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; }
  .page-header h1 { color: ${primaryColor}; font-size: 18pt; }
  .page-header .campus-name { font-size: 10pt; color: #555; }
  .doc-body { min-height: 70vh; }
  h1,h2,h3 { color: ${primaryColor}; margin: 16px 0 8px; }
  p { margin-bottom: 8px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin: 16px 0; }
  th,td { border: 1px solid #ccc; padding: 8px 12px; text-align: left; }
  th { background: ${primaryColor}; color: #fff; }
  table.striped tr:nth-child(even) td { background: #f5f5f5; }
  ul,ol { margin: 8px 0 8px 24px; }
  li { margin-bottom: 4px; }
  pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 10pt; }
  hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
  figure { margin: 16px 0; text-align: center; }
  figure img { max-width: 100%; height: auto; }
  figcaption { font-size: 9pt; color: #666; margin-top: 6px; }
  .qr-code { display: inline-block; text-align: center; }
  .qr-code img { display: block; }
  .qr-code span { font-size: 8pt; color: #555; display: block; margin-top: 4px; }
  /* A binary that could not be inlined is shown, not silently blank. */
  .asset-missing { border: 1px dashed #bbb; padding: 12px; color: #999; font-size: 9pt; }
  .asset-missing small { display: block; font-size: 7pt; word-break: break-all; }
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
    ${branding.showCampusName ? `<div class="campus-name">${escapeHtml(campusName || '')}</div>` : ''}
    <h1>${escapeHtml(doc.title)}</h1>
    ${branding.headerText ? `<div style="font-size:10pt;color:#555;">${escapeHtml(branding.headerText)}</div>` : ''}
  </div>
</div>
<div class="doc-body">
${bodyHtml}
</div>
<div class="page-footer">
  <span>${escapeHtml(branding.footerText || '')}</span>
  ${branding.showDate ? `<span>Generated: ${escapeHtml(new Date().toLocaleDateString())}</span>` : ''}
  <span>Ref: ${escapeHtml(doc.ref)}</span>
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
 * Timeout semantics — the two rules this function exists to keep:
 *   1. The browser is released EXACTLY ONCE, and only after the page work has
 *      actually stopped. Releasing on the timeout path *and* in the `finally`
 *      pushed the same browser twice: the pool grew past POOL_SIZE holding
 *      duplicate references, and two concurrent generations then drove one
 *      browser. A pool whose bound is not enforced is not a pool.
 *   2. A timed-out generation performs NO write. Rejecting the caller's promise
 *      does not stop the async work behind it — the old version went on to write
 *      the PDF and call `setPdfSnapshot` seconds after the caller had been told
 *      the generation failed, leaving the record pointing at a file nobody was
 *      told existed. The timeout therefore CANCELS the work (closing the page
 *      makes the pending Puppeteer call reject) rather than merely reporting it.
 *
 * @param {string} documentId
 * @param {string} versionId     - DocumentVersion ObjectId (for filename immutability)
 * @param {string} campusName
 * @returns {Promise<{ fileName: string, buffer: Buffer }>}
 * @throws On timeout: statusCode 503
 */
const generateDocumentPdf = async (documentId, versionId, campusName) => {
  await initPool();

  const doc = await repo.findDocumentForPdf(documentId);

  if (!doc) {
    throw Object.assign(new Error('Document not found'), { statusCode: 404 });
  }

  const { browser, release } = await acquireBrowser();

  return new Promise((resolve, reject) => {
    let page;
    let settled  = false;   // the caller's promise has been resolved or rejected
    let released = false;   // this browser has gone back to the pool

    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Cancel, do not merely report: closing the page rejects whatever
      // setContent/pdf call is in flight, so the `finally` below runs promptly
      // and nothing downstream writes a file or touches the document record.
      if (page) page.close().catch(() => {});
      reject(Object.assign(
        new Error('PDF generation timed out — please retry'),
        { statusCode: 503, retryAfter: 30 },
      ));
    }, TIMEOUT_MS);

    (async () => {
      try {
        page = await browser.newPage();

        const assets = await resolveDocumentAssets(doc);
        const html   = buildHtmlTemplate(doc, campusName, assets);

        // Every binary is a data: URI, so the page issues no network request.
        // 'networkidle0' would wait out its 500 ms idle detector for traffic that
        // can never happen — it was chosen for the URL-fetching template that the
        // missing resolution step implied, and never revisited.
        await page.setContent(html, { waitUntil: 'load', timeout: TIMEOUT_MS });

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

        // Last check before anything leaves this function's memory. The caller may
        // already have been handed a 503; writing the PDF and the snapshot now
        // would contradict what it was told.
        if (settled) return;

        const safeRef  = doc.ref.replace(/[^A-Z0-9-]/g, '_');
        const fileName = `${safeRef}_v${doc.currentVersion}_${versionId || 'latest'}.pdf`;

        await storage.saveBuffer(pdfBuffer, {
          campusId: doc.campusId,
          category: 'pdf',
          fileName,
          mimeType: 'application/pdf',
        });

        // Update pdfSnapshot on the document record
        await repo.setPdfSnapshot(documentId, fileName);

        settled = true;
        resolve({ fileName, buffer: pdfBuffer });

      } catch (err) {
        // A rejection caused BY the timeout's page.close() must not overwrite the
        // 503 the caller already has.
        if (settled) return;
        settled = true;
        reject(err);
      } finally {
        clearTimeout(timeout);
        if (page) await page.close().catch(() => {});
        // The single release, and only once the page work has actually stopped —
        // returning a browser that is still rendering is what handed one browser
        // to two concurrent generations.
        releaseOnce();
      }
    })();
  });
};

/**
 * Returns the cached PDF if available and version unchanged.
 * Triggers regeneration otherwise.
 *
 * `filePath` is deliberately NOT returned any more: no caller ever read it, and an
 * absolute local path is a lie as soon as the bytes live in an object store.
 *
 * @param {string} documentId
 * @param {string} campusName
 * @returns {Promise<{ fileName: string, buffer: Buffer }>}
 */
const getOrGeneratePdf = async (documentId, campusName) => {
  const doc = await repo.findDocumentForPdfCache(documentId);

  if (!doc) throw Object.assign(new Error('Document not found'), { statusCode: 404 });

  if (doc.pdfSnapshot) {
    const buffer = await storage.readFile(doc.campusId, 'pdf', doc.pdfSnapshot);
    // A null buffer means the cached snapshot is gone — fall through and regenerate.
    if (buffer) return { fileName: doc.pdfSnapshot, buffer };
  }

  // No cache — generate a new PDF
  return generateDocumentPdf(documentId, null, campusName);
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
  resolveDocumentAssets,
  renderBlock,
};
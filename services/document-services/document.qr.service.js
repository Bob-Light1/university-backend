'use strict';

/**
 * @file document.qr.service.js
 * @description QR code generation for document verification.
 *
 * QR codes encode the public verification URL:
 *   https://{QR_VERIFICATION_BASE_URL}/verify/{doc.ref}
 *
 * doc.ref format: DOC-{YEAR}-{CAMPUS_CODE}-{nanoid(8)}
 * → The nanoid suffix provides ~281 trillion combinations — immune to sequential scanning.
 *
 * Generated QR PNGs are stored under:
 *   uploads/documents/{campusId}/qrcodes/{fileName}
 *
 * The verification endpoint (GET /api/documents/verify/:ref) is public and rate-limited.
 * It returns minimal metadata only — never document content or internal IDs.
 */

const QRCode = require('qrcode');
const path   = require('path');
const fs     = require('fs').promises;

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.join(process.env.UPLOAD_DIR, 'documents')
  : path.join(__dirname, '..', '..', 'uploads', 'documents');

const BASE_URL = process.env.QR_VERIFICATION_BASE_URL || 'https://app.yourdomain.com';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a QR code PNG for a document and saves it to campus-scoped storage.
 *
 * @param {string} docRef    - Document reference (e.g., DOC-2025-UNIV-AB12CD34)
 * @param {string} campusId
 * @param {object} options   - { size?: number (default 80), errorCorrectionLevel?: 'L'|'M'|'Q'|'H' }
 * @returns {Promise<{ fileName: string, data: string, generatedAt: Date }>}
 */
const generateQrCode = async (docRef, campusId, options = {}) => {
  const {
    size = 80,
    errorCorrectionLevel = 'M',
  } = options;

  const verificationUrl = `${BASE_URL}/verify/${docRef}`;

  // Generate QR as PNG buffer
  const buffer = await QRCode.toBuffer(verificationUrl, {
    type:                 'png',
    width:                size,
    errorCorrectionLevel,
    margin:               2,
    color: {
      dark:  '#000000',
      light: '#FFFFFF',
    },
  });

  // Save to campus-scoped qrcodes directory
  const qrcodeDir = path.join(UPLOAD_DIR, campusId.toString(), 'qrcodes');
  await fs.mkdir(qrcodeDir, { recursive: true });

  const fileName = `qr_${docRef.replace(/[^A-Z0-9-]/g, '_').toLowerCase()}.png`;
  const filePath = path.join(qrcodeDir, fileName);

  await fs.writeFile(filePath, buffer);

  return {
    fileName,
    data:        verificationUrl,
    generatedAt: new Date(),
  };
};

/**
 * Generates a QR code as a base64 data URL (for inline embedding in HTML templates).
 * Does not write to disk.
 *
 * @param {string} docRef
 * @param {number} size
 * @returns {Promise<string>} Base64 data URL
 */
const generateQrCodeDataUrl = async (docRef, size = 80) => {
  const verificationUrl = `${BASE_URL}/verify/${docRef}`;

  return QRCode.toDataURL(verificationUrl, {
    type:                 'image/png',
    width:                size,
    errorCorrectionLevel: 'M',
    margin:               2,
  });
};

module.exports = {
  generateQrCode,
  generateQrCodeDataUrl,
};